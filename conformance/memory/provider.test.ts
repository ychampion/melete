import { expect, test } from 'bun:test';
import { startScriptedProvider } from './provider.ts';

test('two providers bound to ephemeral ports serve their own requests', async () => {
  const first = await startScriptedProvider(0);
  let second: Awaited<ReturnType<typeof startScriptedProvider>> | undefined;
  try {
    second = await startScriptedProvider(0);
    const request = {
      question: 'Unknown fact?',
      key: 'unknown',
      mode: 'current' as const,
      items: [],
    };
    expect((await first.ask(request)).answer).toBeNull();
    expect(first.calls.answer).toBe(1);
    expect(second.calls.answer).toBe(0);
    expect((await second.ask(request)).answer).toBeNull();
    expect(first.calls.answer).toBe(1);
    expect(second.calls.answer).toBe(1);
  } finally {
    second?.close();
    first.close();
  }
});
