/**
 * Pictures inside a model request.
 *
 * The agent's screenshots reach the model as pictures carried in the request
 * itself, base64 in a data URL or an inline source block. That is the only
 * kind the gateway forwards: a picture named by a remote address or a provider
 * file id would be fetched by the provider, out of sight of the metering and
 * the privacy router, and is refused like any other remote input.
 *
 * One request may carry a few pictures, each small (the runtime shrinks
 * screenshots before the model sees them), and each is charged as the flat
 * number of tokens the engine itself counts, not by its bytes.
 */
import { IMAGE_INPUT_TOKENS, MAX_IMAGE_ENCODED_BYTES, MAX_REQUEST_IMAGES } from '@melete/contracts';
import { GatewayError } from './types.ts';

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DATA_URL = /^data:(image\/[a-z]+);base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The base64 text of a picture carried inline, per protocol; undefined for anything else. */
function inlineData(node: Node): string | undefined {
  let url: unknown;
  if (node.type === 'image_url')
    // Chat completions: { type: 'image_url', image_url: { url } } or a bare string.
    url = isNode(node.image_url) ? node.image_url.url : node.image_url;
  else if (node.type === 'input_image' && node.file_id === undefined)
    // Responses: { type: 'input_image', image_url: 'data:…' }.
    url = node.image_url;
  else if (node.type === 'image' && isNode(node.source)) {
    // Messages: { type: 'image', source: { type: 'base64', media_type, data } }.
    const source = node.source;
    if (
      source.type === 'base64' &&
      typeof source.media_type === 'string' &&
      MEDIA_TYPES.has(source.media_type) &&
      typeof source.data === 'string'
    )
      return source.data;
    return undefined;
  } else return undefined;
  if (typeof url !== 'string') return undefined;
  const match = DATA_URL.exec(url);
  if (!match?.[1] || !MEDIA_TYPES.has(match[1])) return undefined;
  return url.slice(match[0].length);
}

/** True for a picture the request carries itself, which the gateway may forward. */
export function isInlineImage(value: unknown): boolean {
  return isNode(value) && inlineData(value) !== undefined;
}

function visit(value: unknown, found: (data: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, found);
    return;
  }
  if (!isNode(value)) return;
  const data = inlineData(value);
  if (data !== undefined) {
    found(data);
    return;
  }
  for (const child of Object.values(value)) visit(child, found);
}

/**
 * How many pictures a request carries, refusing one it may not: more than a
 * request may hold, one larger than the runtime ever sends, or one whose
 * content is not base64.
 */
export function countImages(body: unknown): number {
  let count = 0;
  visit(body, (data) => {
    count += 1;
    if (count > MAX_REQUEST_IMAGES) throw new GatewayError(413, 'too_many_images');
    if (data.length > MAX_IMAGE_ENCODED_BYTES) throw new GatewayError(413, 'image_too_large');
    if (!BASE64.test(data)) throw new GatewayError(400, 'invalid_image');
  });
  return count;
}

/** The text part that stands where a picture was, in the picture's own protocol. */
function textInPlaceOf(node: Node, text: string): Node {
  return { type: node.type === 'input_image' ? 'input_text' : 'text', text };
}

/**
 * A copy of the body with inline pictures replaced by text. `text` is the
 * replacement for every picture, or a function that names one per picture and
 * returns null for a picture that stays. The input is not modified.
 */
export function withoutImages(
  body: Record<string, unknown>,
  text: string | ((image: Node) => string | null),
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isNode(value)) return value;
    if (isInlineImage(value)) {
      const replacement = typeof text === 'string' ? text : text(value);
      return replacement === null ? value : textInPlaceOf(value, replacement);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  };
  return walk(body) as Record<string, unknown>;
}

/** Every inline picture in a body, in order. */
export function inlineImages(body: unknown): Node[] {
  const found: Node[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (isNode(value)) {
      if (isInlineImage(value)) found.push(value);
      else for (const child of Object.values(value)) walk(child);
    }
  };
  walk(body);
  return found;
}

/**
 * Where a screenshot came from, as the runtime marked it: the agent's own
 * computer, or a paired computer by id. Anything without the mark (a picture
 * re-encoded on the way, or from somewhere else) is unknown, and is treated as
 * the most private kind there is.
 */
export type ImageSource =
  | { kind: 'computer' }
  | { kind: 'device'; deviceId: string | null }
  | { kind: 'unknown' };

/** The JPEG comment the runtime writes into each screenshot it sends (melete_plugin/vision.py). */
export const SOURCE_MARK = 'melete-screenshot:';

/** The source a screenshot's own bytes name: a JPEG comment segment before the image data. */
export function imageSource(image: Node): ImageSource {
  const data = inlineData(image);
  if (!data) return { kind: 'unknown' };
  // The comment sits in the header, well inside the first few kilobytes.
  const head = Buffer.from(data.slice(0, 8192 - (Math.min(data.length, 8192) % 4)), 'base64');
  if (head[0] !== 0xff || head[1] !== 0xd8) return { kind: 'unknown' };
  let at = 2;
  while (at + 4 <= head.length && head[at] === 0xff) {
    const marker = head[at + 1] ?? 0;
    // Start of scan: the header is over.
    if (marker === 0xda) break;
    const length = head.readUInt16BE(at + 2);
    if (length < 2) break;
    if (marker === 0xfe) {
      const comment = head.subarray(at + 4, at + 2 + length).toString('latin1');
      if (!comment.startsWith(SOURCE_MARK)) break;
      const source = comment.slice(SOURCE_MARK.length);
      if (source === 'computer') return { kind: 'computer' };
      if (source === 'device') return { kind: 'device', deviceId: null };
      const device = /^device:([A-Za-z0-9_-]{1,100})$/.exec(source);
      if (device?.[1]) return { kind: 'device', deviceId: device[1] };
      break;
    }
    at += 2 + length;
  }
  return { kind: 'unknown' };
}

/**
 * The tokens a request's pictures are charged as, and the body to estimate the
 * rest from: the pictures' bytes are not text and are not counted as text.
 */
export function imageTokens(body: Record<string, unknown>): {
  tokens: number;
  text: Record<string, unknown>;
} {
  const count = countImages(body);
  return {
    tokens: count * IMAGE_INPUT_TOKENS,
    text: count ? withoutImages(body, '') : body,
  };
}
