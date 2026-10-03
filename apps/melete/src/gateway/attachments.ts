/**
 * The files a person sent, shown to the model as files where it can see them.
 *
 * The prompt carries each file as a fenced block of text (`attachments/render.ts`):
 * a document's words, or a sentence where a picture is. Here, after the privacy
 * router has decided where the request goes and what it may carry, a block is
 * swapped for the file itself when that destination may have it:
 *
 * - a picture, as a picture, when the model reads pictures (the owner's
 *   setting, else Melete's list; off unless one of them says so);
 * - a PDF, as a document, when the model reads pictures and its provider takes
 *   PDFs in the request (Anthropic, OpenAI); elsewhere its extracted text stays.
 *
 * A private conversation's files never go to an outside model as files: the
 * router keeps pictures from a cloud model there, since pixels cannot have
 * details swapped out, and the extracted text it does let go has been redacted.
 * The person's own model (local or on their machine) gets the picture when it
 * reads pictures.
 *
 * Only files of the job the request belongs to are swapped in; a block naming
 * any other file stays text. The gateway's own limits hold: no more pictures
 * than a request may carry, each within the per-picture size, and the whole
 * body within the request limit. Newest files are shown first; one that does
 * not fit keeps its text.
 */
import { type AttachmentKind, MAX_REQUEST_IMAGES, modelSupportsVision } from '@melete/contracts';
import { blockIntact, FILE_BLOCK, PICTURE_NOT_SHOWN } from '../attachments/render.ts';
import { countImages, imageTokens } from './images.ts';
import type { GatewayPrincipal, GatewayProtocol } from './types.ts';

/** A file as the gateway may show it: a picture's small copy, or a PDF's bytes. */
export type ModelFile = {
  id: string;
  kind: Extract<AttachmentKind, 'image' | 'pdf'>;
  name: string;
  mediaType: string;
  data: Uint8Array;
  pages: number | null;
};

/** Where the gateway reads files and the vision setting from. */
export interface GatewayAttachments {
  /**
   * The files of this job among `ids`, of the kinds asked for. A PDF larger
   * than `maxPdfBytes` is left out. Any other job's file is never returned.
   */
  files(
    jobId: string,
    ids: readonly string[],
    kinds: { image: boolean; pdf: boolean; maxPdfBytes: number },
  ): Promise<Map<string, ModelFile>>;
  /** Whether this model reads pictures: the owner's word, else the operator's, else the list's. */
  vision(provider: string, model: string): Promise<boolean>;
}

/** Where the router sent the request, as far as files are concerned. */
export type AttachmentRoute =
  | { kind: 'cloud'; private: boolean }
  | { kind: 'on_device' }
  | { kind: 'local'; model: string };

/** Providers that take a PDF in the request body itself. */
const PDF_PROVIDERS = new Set(['anthropic', 'openai']);

/**
 * What a PDF page is charged as, in input tokens. Providers read each page as
 * its text and a picture of it, roughly 1,500 to 3,000 tokens a page.
 */
export const PDF_PAGE_INPUT_TOKENS = 3000;

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** One place a block sits: the user text that holds it, and the block's extent. */
type Found = { id: string; start: number; end: number; holder: TextHolder };

/** A piece of user text in the body, and how to put parts in its place. */
type TextHolder = { text: string; replace: (parts: Node[]) => void };

/** Every piece of text the person's turns carry, per protocol. */
function userTexts(body: Node, protocol: GatewayProtocol): TextHolder[] {
  const holders: TextHolder[] = [];
  const textType = protocol === 'responses' ? 'input_text' : 'text';
  const fromContent = (owner: Node, key: string) => {
    const content = owner[key];
    if (typeof content === 'string') {
      holders.push({
        text: content,
        replace: (parts) => {
          owner[key] = parts;
        },
      });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const [index, part] of content.entries()) {
      if (!isNode(part) || part.type !== textType || typeof part.text !== 'string') continue;
      holders.push({
        text: part.text,
        replace: (parts) => {
          const current = owner[key] as unknown[];
          const at = current.indexOf(part);
          if (at >= 0) current.splice(at, 1, ...parts);
          else current.splice(index, 1, ...parts);
        },
      });
    }
  };
  if (protocol === 'responses') {
    if (typeof body.input === 'string') {
      holders.push({
        text: body.input,
        replace: (parts) => {
          body.input = [{ role: 'user', content: parts }];
        },
      });
      return holders;
    }
    if (!Array.isArray(body.input)) return holders;
    for (const item of body.input)
      if (isNode(item) && item.role === 'user') fromContent(item, 'content');
    return holders;
  }
  if (!Array.isArray(body.messages)) return holders;
  for (const message of body.messages)
    if (isNode(message) && message.role === 'user') fromContent(message, 'content');
  return holders;
}

const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

/** The file as a part of this protocol. */
function filePart(file: ModelFile, protocol: GatewayProtocol, provider: string): Node {
  const data = base64(file.data);
  if (file.kind === 'image') {
    if (protocol === 'messages')
      return { type: 'image', source: { type: 'base64', media_type: file.mediaType, data } };
    if (protocol === 'responses')
      return { type: 'input_image', image_url: `data:${file.mediaType};base64,${data}` };
    return { type: 'image_url', image_url: { url: `data:${file.mediaType};base64,${data}` } };
  }
  if (protocol === 'messages')
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
      title: file.name,
    };
  if (protocol === 'responses')
    return {
      type: 'input_file',
      filename: file.name,
      file_data: `data:application/pdf;base64,${data}`,
    };
  // Chat completions: OpenAI's file part. Only offered where PDF_PROVIDERS says so.
  void provider;
  return {
    type: 'file',
    file: { filename: file.name, file_data: `data:application/pdf;base64,${data}` },
  };
}

const textPart = (text: string, protocol: GatewayProtocol): Node => ({
  type: protocol === 'responses' ? 'input_text' : 'text',
  text,
});

/**
 * The body with the blocks of files this destination may see swapped for the
 * files. The input is not modified. Answers the body unchanged when nothing
 * is to be swapped.
 */
export async function withAttachedFiles(input: {
  body: Record<string, unknown>;
  protocol: GatewayProtocol;
  provider: string;
  model: string;
  principal: GatewayPrincipal;
  route: AttachmentRoute;
  source: GatewayAttachments | undefined;
  maxRequestBytes: number;
}): Promise<Record<string, unknown>> {
  const { protocol, provider, principal, route, source } = input;
  if (!source || principal.privacy.kind !== 'job') return input.body;
  if (!JSON.stringify(input.body).includes('[[melete-file ')) return input.body;
  let images: boolean;
  if (route.kind === 'local') images = modelSupportsVision('openai-compatible', route.model);
  else if (route.kind === 'cloud' && route.private) images = false;
  else images = await source.vision(provider, input.model);
  if (!images) return input.body;
  const pdf =
    route.kind !== 'local' &&
    PDF_PROVIDERS.has(provider) &&
    (protocol === 'messages' || protocol === 'responses' || provider === 'openai');

  const body = structuredClone(input.body);
  const holders = userTexts(body, protocol);
  const found: Found[] = [];
  for (const holder of holders)
    for (const match of holder.text.matchAll(FILE_BLOCK)) {
      // A block the redactor (or anything else) changed keeps its text: the
      // file's own bytes would carry back what the redaction took out.
      if (!blockIntact(match[0], match[1] as string, match[2] as string)) continue;
      found.push({
        id: match[1] as string,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        holder,
      });
    }
  if (!found.length) return input.body;

  let size = Buffer.byteLength(JSON.stringify(body));
  let files: Map<string, ModelFile>;
  try {
    files = await source.files(principal.jobId, [...new Set(found.map((entry) => entry.id))], {
      image: true,
      pdf,
      maxPdfBytes: Math.floor(((input.maxRequestBytes - size) * 3) / 4),
    });
  } catch (error) {
    // The files stay as their text; the call goes on, and the operator hears why.
    console.error(
      `model gateway: the files of ${principal.jobId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return input.body;
  }
  let pictures = MAX_REQUEST_IMAGES - countImages(body);
  // Newest first; a file named twice is shown at its latest place only.
  const chosen = new Map<TextHolder, Found[]>();
  const shown = new Set<string>();
  for (const entry of [...found].reverse()) {
    const file = files.get(entry.id);
    if (!file || shown.has(entry.id)) continue;
    if (file.kind === 'image' && pictures <= 0) continue;
    const added = Math.ceil((file.data.length * 4) / 3) + 200 - (entry.end - entry.start);
    if (size + added > input.maxRequestBytes) continue;
    size += added;
    if (file.kind === 'image') pictures--;
    shown.add(entry.id);
    chosen.set(entry.holder, [...(chosen.get(entry.holder) ?? []), entry]);
  }
  if (!chosen.size) return input.body;
  for (const [holder, entries] of chosen) {
    const parts: Node[] = [];
    let at = 0;
    for (const entry of entries.sort((a, b) => a.start - b.start)) {
      const before = holder.text.slice(at, entry.start);
      if (before.trim()) parts.push(textPart(before, protocol));
      parts.push(filePart(files.get(entry.id) as ModelFile, protocol, provider));
      at = entry.end;
    }
    const after = holder.text.slice(at);
    if (after.trim()) parts.push(textPart(after, protocol));
    holder.replace(parts);
  }
  return body;
}

/** Whether the request names a picture the person attached, still as its sentence. */
export function carriesAttachedPicture(body: Record<string, unknown>): boolean {
  const text = JSON.stringify(body);
  return text.includes('[[melete-file ') && text.includes(PICTURE_NOT_SHOWN.slice(0, 40));
}

/** True for a PDF the request carries itself, in any protocol. */
function isDocument(node: Node): boolean {
  if (node.type === 'document' && isNode(node.source)) return node.source.type === 'base64';
  if (node.type === 'input_file') return typeof node.file_data === 'string';
  if (node.type === 'file' && isNode(node.file)) return typeof node.file.file_data === 'string';
  return false;
}

/** The pages a document part carries, read from the PDF itself; at least one. */
function documentPages(node: Node): number {
  const data =
    node.type === 'document' && isNode(node.source)
      ? String(node.source.data ?? '')
      : node.type === 'input_file'
        ? String(node.file_data ?? '')
        : isNode(node.file)
          ? String(node.file.file_data ?? '')
          : '';
  const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64').toString('latin1');
  const pages = bytes.match(/\/Type\s*\/Page(?![a-z])/g)?.length ?? 0;
  return Math.max(1, pages);
}

/**
 * The tokens a request's pictures and documents are charged as, and the body
 * to estimate the rest from: their bytes are not text and are not counted as
 * text.
 */
export function mediaTokens(body: Record<string, unknown>): {
  tokens: number;
  text: Record<string, unknown>;
} {
  const pictures = imageTokens(body);
  let pages = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isNode(value)) return value;
    if (isDocument(value)) {
      pages += documentPages(value);
      return { type: 'text', text: '' };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  };
  const text = walk(pictures.text) as Record<string, unknown>;
  if (!pages) return pictures;
  return { tokens: pictures.tokens + pages * PDF_PAGE_INPUT_TOKENS, text };
}
