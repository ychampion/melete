import { describe, expect, test } from 'bun:test';
import { parseFrame, readSse } from './sse.ts';

const stream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

describe('parseFrame', () => {
  test('reads id, event and data', () => {
    const frame = parseFrame('id: 7\nevent: text_delta\ndata: {"seq":7}');
    expect(frame).toEqual({ id: '7', event: 'text_delta', data: '{"seq":7}', comment: false });
  });

  test('joins repeated data lines with newlines', () => {
    expect(parseFrame('data: one\ndata: two')?.data).toBe('one\ntwo');
  });

  test('strips exactly one leading space', () => {
    expect(parseFrame('data:  padded')?.data).toBe(' padded');
  });

  test('marks a keepalive as a comment', () => {
    expect(parseFrame(': keepalive')).toEqual({
      id: null,
      event: 'message',
      data: '',
      comment: true,
    });
  });

  test('defaults the event name to message', () => {
    expect(parseFrame('data: hi')?.event).toBe('message');
  });
});

describe('readSse', () => {
  test('splits frames that arrive across chunk boundaries', async () => {
    const frames = [];
    for await (const frame of readSse(stream(['id: 1\nda', 'ta: one\n\nid: 2\ndata: two\n\n']))) {
      frames.push(frame);
    }
    expect(frames.map((f) => f.data)).toEqual(['one', 'two']);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
  });

  test('handles CRLF line endings and trailing frames with no blank line', async () => {
    const frames = [];
    for await (const frame of readSse(stream(['data: a\r\n\r\n', 'data: b']))) frames.push(frame);
    expect(frames.map((f) => f.data)).toEqual(['a', 'b']);
  });

  test('passes keepalives through so a caller can see the stream is alive', async () => {
    const frames = [];
    for await (const frame of readSse(stream([': keepalive\n\ndata: x\n\n']))) frames.push(frame);
    expect(frames.map((f) => f.comment)).toEqual([true, false]);
  });
});
