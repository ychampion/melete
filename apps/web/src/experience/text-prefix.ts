/** How much of a saved text file the Open dialog shows; the rest is a download away. */
export const OPEN_TEXT_LIMIT_BYTES = 256 * 1024;

/**
 * Read at most `limit` bytes of a response as text, then stop reading, so a very
 * large file never lands whole in the page. A character cut in half at the limit
 * is left out rather than shown broken.
 */
export async function readTextPrefix(
  response: Response,
  limit: number = OPEN_TEXT_LIMIT_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return decodePrefix([whole], limit);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (read <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.byteLength;
    }
  } finally {
    if (read > limit) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return decodePrefix(chunks, limit);
}

function decodePrefix(chunks: Uint8Array[], limit: number) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= bytes.byteLength) break;
    const part = chunk.subarray(0, bytes.byteLength - at);
    bytes.set(part, at);
    at += part.byteLength;
  }
  const truncated = total > limit;
  const decoder = new TextDecoder();
  // Streaming mode holds back an incomplete last character instead of replacing it.
  const text = truncated ? decoder.decode(bytes, { stream: true }) : decoder.decode(bytes);
  return { text, truncated };
}
