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
  return mapImages(body, (image) => {
    const replacement = typeof text === 'string' ? text : text(image);
    return replacement === null ? image : textInPlaceOf(image, replacement);
  });
}

/** A copy of the body with each inline picture replaced by what `change` makes of it. */
function mapImages(body: Record<string, unknown>, change: (image: Node) => Node) {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isNode(value)) return value;
    if (isInlineImage(value)) return change(value);
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

/** The JPEG comment the runtime writes into each screenshot it sends (melete_plugin/vision.py). */
export const SOURCE_MARK = 'melete-screenshot:';

const ACTION_ID = /^act_[A-Za-z0-9]{1,64}$/;

/** Where the runtime's comment segment sits in a picture's bytes, and what it says. */
function findMark(bytes: Buffer): { start: number; end: number; text: string } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    // Start of scan: the header is over.
    if (marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (marker === 0xfe) {
      const text = bytes.subarray(at + 4, at + 2 + length).toString('latin1');
      if (text.startsWith(SOURCE_MARK)) return { start: at, end: at + 2 + length, text };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * The action a screenshot names: the id of the brokered screenshot it came
 * from. It is only a claim. Whether it is this job's screenshot, and whose
 * screen it shows, is read from the action itself, never from the picture.
 */
export function imageMark(image: Node): string | null {
  const mark = findMark(header(image));
  const id = mark?.text.slice(SOURCE_MARK.length) ?? '';
  return ACTION_ID.test(id) ? id : null;
}

/** The picture with the runtime's comment taken out, in its own protocol's shape. */
function unmarked(image: Node): Node {
  const data = inlineData(image);
  if (!data) return image;
  const bytes = Buffer.from(data, 'base64');
  const mark = findMark(bytes);
  if (!mark) return image;
  const clean = Buffer.concat([bytes.subarray(0, mark.start), bytes.subarray(mark.end)]).toString(
    'base64',
  );
  if (image.type === 'image' && isNode(image.source))
    return { ...image, source: { ...image.source, data: clean } };
  const url = isNode(image.image_url) ? image.image_url.url : image.image_url;
  const prefix = typeof url === 'string' ? url.slice(0, url.length - data.length) : '';
  if (isNode(image.image_url))
    return { ...image, image_url: { ...image.image_url, url: `${prefix}${clean}` } };
  return { ...image, image_url: `${prefix}${clean}` };
}

/**
 * A copy of the body with no picture carrying the runtime's comment: the mark
 * is for the router, and never reaches a provider.
 */
export function withoutMarks(body: Record<string, unknown>): Record<string, unknown> {
  return inlineImages(body).some((image) => findMark(header(image)) !== null)
    ? mapImages(body, unmarked)
    : body;
}

/** The first few kilobytes of a picture, where its header and any comment sit. */
function header(image: Node): Buffer {
  const data = inlineData(image) ?? '';
  return Buffer.from(data.slice(0, 8192 - (Math.min(data.length, 8192) % 4)), 'base64');
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
