/**
 * A Server-Sent Events reader. Small enough to read in one sitting, because the
 * browser's own `EventSource` cannot send headers and cannot be given a custom
 * fetch, and both of those are required here: the session cookie travels on a
 * cross-origin request, and the tests run without a socket.
 */

export type SseFrame = {
  /** The `id:` field. Melete puts the event `seq` here. */
  id: string | null;
  /** The `event:` field, defaulting to `message` as the specification says. */
  event: string;
  /** The `data:` field; multiple data lines are joined with newlines. */
  data: string;
  /** True for `: keepalive` and any other comment-only frame. */
  comment: boolean;
};

const LINE_BREAK = /\r\n|\r|\n/;

/** Parse one already-split frame. Returns null when the frame carries nothing. */
export function parseFrame(raw: string): SseFrame | null {
  if (raw.length === 0) return null;

  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  let sawField = false;
  let sawComment = false;

  for (const line of raw.split(LINE_BREAK)) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) {
      sawComment = true;
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // "If value starts with a space, remove it." — one space, not all of them.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'id':
        id = value;
        sawField = true;
        break;
      case 'event':
        event = value;
        sawField = true;
        break;
      case 'data':
        data.push(value);
        sawField = true;
        break;
      default:
        // `retry` and unknown fields are ignored; reconnection timing here is
        // the caller's policy, not the server's.
        break;
    }
  }

  if (!sawField) return sawComment ? { id: null, event, data: '', comment: true } : null;
  return { id, event, data: data.join('\n'), comment: false };
}

/** Read a response body and yield one frame at a time. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Normalising first keeps the split
      // honest for a server that emits CRLF.
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) yield frame;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const tail = parseFrame(buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    if (tail) yield tail;
  } finally {
    // A cancelled reader releases the socket; without this an aborted stream
    // leaks a connection per reconnect.
    try {
      await reader.cancel();
    } catch {
      // The body was already closed or errored. Nothing left to release.
    }
  }
}
