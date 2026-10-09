import { describe, expect, test } from 'bun:test';
import { LONG_TURN_NOTE, LONG_TURN_ROUNDS, withLongTurnNote } from './long-turn.ts';

const tool = (name: string) => ({ type: 'function', function: { name, parameters: {} } });
const round = (name = 'web.fetch') => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c', content: '{"status":"succeeded"}' },
];
const request = (
  rounds: number,
  tools = [tool('run.start'), tool('web.fetch')],
  extra: unknown[] = [],
) => ({
  model: 'm',
  tools,
  messages: [
    { role: 'system', content: 'You are Melete.' },
    { role: 'user', content: 'Research robot vacuums in the background.' },
    ...Array.from({ length: rounds }, () => round()).flat(),
    ...extra,
  ],
});
const noted = (body: Record<string, unknown>) =>
  (body.messages as { content?: unknown }[]).at(-1)?.content === LONG_TURN_NOTE;

describe('a conversation turn that runs long', () => {
  test('is pointed at background work once it passes the round limit', () => {
    expect(noted(withLongTurnNote(request(LONG_TURN_ROUNDS - 1), 'chat/completions'))).toBe(false);
    const long = withLongTurnNote(request(LONG_TURN_ROUNDS), 'chat/completions');
    expect(noted(long)).toBe(true);
    // Only the outgoing request carries it; the body it was given is unchanged.
    const body = request(LONG_TURN_ROUNDS);
    withLongTurnNote(body, 'chat/completions');
    expect(noted(body)).toBe(false);
  });

  test('counts only the current turn, from the latest message', () => {
    const earlier = request(LONG_TURN_ROUNDS, undefined, [
      { role: 'assistant', content: 'Here is what I found.' },
      { role: 'user', content: 'Thanks, and the price?' },
      ...round(),
    ]);
    expect(noted(withLongTurnNote(earlier, 'chat/completions'))).toBe(false);
  });

  test('is left alone where background work is not offered, has started, or another protocol is used', () => {
    expect(
      noted(
        withLongTurnNote(request(LONG_TURN_ROUNDS + 2, [tool('web.fetch')]), 'chat/completions'),
      ),
    ).toBe(false);
    const started = request(LONG_TURN_ROUNDS + 2, undefined, round('run.start'));
    expect(noted(withLongTurnNote(started, 'chat/completions'))).toBe(false);
    expect(noted(withLongTurnNote(request(LONG_TURN_ROUNDS + 2), 'messages'))).toBe(false);
  });
});
