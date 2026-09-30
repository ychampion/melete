import { expect, test } from 'bun:test';
import { readTextPrefix } from './text-prefix.ts';

const streamed = (parts: string[]) => {
  let pulled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts[pulled++];
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
  return { response: new Response(body), pulled: () => pulled };
};

test('a small file is read whole', async () => {
  const { response } = streamed(['# Notes\n', 'Walk daily.\n']);
  expect(await readTextPrefix(response, 1024)).toEqual({
    text: '# Notes\nWalk daily.\n',
    truncated: false,
  });
});

test('a very large file stops at the limit and says it was cut', async () => {
  const parts = Array.from({ length: 1000 }, () => 'x'.repeat(1024));
  const { response, pulled } = streamed(parts);
  const shown = await readTextPrefix(response, 4096);
  expect(shown).toEqual({ text: 'x'.repeat(4096), truncated: true });
  // Reading stopped soon after the limit instead of pulling the whole file.
  expect(pulled()).toBeLessThan(10);
});

test('a character cut in half at the limit is left out, not shown broken', async () => {
  const { response } = streamed(['ab', 'é', 'cd']);
  const shown = await readTextPrefix(response, 3);
  expect(shown).toEqual({ text: 'ab', truncated: true });
  expect(shown.text).not.toContain('�');
});
