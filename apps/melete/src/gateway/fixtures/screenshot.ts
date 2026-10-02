/**
 * Base64 shaped like a screenshot the runtime sends: a JPEG header whose
 * comment names the source, padded to the length a test needs. Only the header
 * is ever read by the gateway; the rest stands in for the image data.
 */
import { SOURCE_MARK } from '../images.ts';

export function markedScreenshot(source: string | null, length = 4096): string {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (source !== null) {
    const comment = Buffer.from(`${SOURCE_MARK}${source}`, 'latin1');
    const size = Buffer.alloc(2);
    size.writeUInt16BE(comment.length + 2);
    parts.push(Buffer.from([0xff, 0xfe]), size, comment);
  }
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));
  let header = Buffer.concat(parts);
  // Whole groups of three bytes, so the padding below stays valid base64.
  header = Buffer.concat([header, Buffer.alloc((3 - (header.length % 3)) % 3)]);
  const text = header.toString('base64');
  return text + 'A'.repeat(Math.max(0, length - text.length));
}
