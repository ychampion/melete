/**
 * Base64 shaped like a screenshot the runtime sends: a JPEG header whose
 * comment names the action it came from, padded to the length a test needs.
 * Only the header is ever read by the gateway; the rest stands in for the
 * image data.
 */
import { SOURCE_MARK } from '../images.ts';

const SOI = Buffer.from([0xff, 0xd8]);
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x02]);

function comment(action: string): Buffer {
  const text = Buffer.from(`${SOURCE_MARK}${action}`, 'latin1');
  const size = Buffer.alloc(2);
  size.writeUInt16BE(text.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), size, text]);
}

/** Whole groups of three bytes, so base64 padding after it stays valid. */
const aligned = (bytes: Buffer) =>
  Buffer.concat([bytes, Buffer.alloc((3 - (bytes.length % 3)) % 3)]);

/** A screenshot naming `action` (null: no mark at all). */
export function markedScreenshot(action: string | null, length = 4096): string {
  const header = aligned(Buffer.concat([SOI, ...(action === null ? [] : [comment(action)]), SOS]));
  const text = header.toString('base64');
  return text + 'A'.repeat(Math.max(0, length - text.length));
}

/** The same picture's bytes as they must reach a provider: without the comment. */
export function unmarkedBytes(action: string, length = 4096): Buffer {
  const marked = Buffer.from(markedScreenshot(action, length), 'base64');
  const mark = comment(action);
  const at = marked.indexOf(mark);
  return Buffer.concat([marked.subarray(0, at), marked.subarray(at + mark.length)]);
}
