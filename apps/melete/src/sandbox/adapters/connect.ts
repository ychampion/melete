/**
 * The Connect protocol's JSON codec, as far as a sandbox daemon needs it.
 *
 * A unary call is a POST of one JSON message with `Content-Type:
 * application/json`; an error is a non-200 answer whose body is
 * `{"code", "message"}`. A streaming call frames every message in an envelope:
 * one flag byte, a four-byte big-endian length, then the JSON. The last
 * envelope has flag 0x02 and carries `{}` or `{"error": {...}}`. Compressed
 * envelopes (flag 0x01) are never requested and are refused.
 *
 * Reference: https://connectrpc.com/docs/protocol
 */

export const CONNECT_UNARY = 'application/json';
export const CONNECT_STREAM = 'application/connect+json';
const END_STREAM = 0x02;
const COMPRESSED = 0x01;

export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function encodeEnvelope(message: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.byteLength, false);
  out.set(payload, 5);
  return out;
}

export const encodeEndStream = (error?: { code: string; message: string }) =>
  encodeEnvelope(error ? { error } : {}, END_STREAM);

/** Split a complete buffer into its messages; used where a whole body is already in hand. */
export function decodeEnvelopes(bytes: Uint8Array): { end: boolean; message: unknown }[] {
  const out: { end: boolean; message: unknown }[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.byteLength) {
    const flags = bytes[offset] as number;
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    if (offset + 5 + length > bytes.byteLength) break;
    const payload = bytes.subarray(offset + 5, offset + 5 + length);
    out.push({
      end: (flags & END_STREAM) !== 0,
      message: JSON.parse(new TextDecoder().decode(payload)),
    });
    offset += 5 + length;
  }
  return out;
}

/**
 * Read enveloped messages as they arrive. Returns when the end-of-stream
 * envelope arrives; throws its error if it carries one, and throws when the
 * body ends without one, because a stream that simply stops is a lost answer.
 */
export async function* readEnvelopes(
  body: ReadableStream<Uint8Array>,
  maxMessageBytes: number,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      while (buffer.byteLength >= 5) {
        const flags = buffer[0] as number;
        const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
        if (length > maxMessageBytes)
          throw new ConnectError('resource_exhausted', 'message too large');
        if (buffer.byteLength < 5 + length) break;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if (flags & COMPRESSED) throw new ConnectError('internal', 'compressed message refused');
        const message = JSON.parse(new TextDecoder().decode(payload)) as {
          error?: { code?: string; message?: string };
        };
        if (flags & END_STREAM) {
          if (message.error)
            throw new ConnectError(message.error.code ?? 'unknown', message.error.message ?? '');
          return;
        }
        yield message;
      }
      const { done, value } = await reader.read();
      if (done)
        throw new ConnectError('unavailable', 'the stream ended without an end-of-stream message');
      const next = new Uint8Array(buffer.byteLength + value.byteLength);
      next.set(buffer);
      next.set(value, buffer.byteLength);
      buffer = next;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read a body, refusing one above `maxBytes` instead of holding it. */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ConnectError('resource_exhausted', 'the answer is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Read at most `maxBytes` from the start of a body and stop reading there. */
export async function readPrefix(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body || maxBytes <= 0) {
    await response.body?.cancel().catch(() => {});
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const out = new Uint8Array(maxBytes);
  let filled = 0;
  try {
    while (filled < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, maxBytes - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, filled);
}
