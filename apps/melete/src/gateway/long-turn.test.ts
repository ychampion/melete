import { describe, expect, test } from 'bun:test';
import {
  LONG_TURN_NOTE,
  LONG_TURN_ROUNDS,
  PROGRESS_NOTE,
  PROGRESS_ROUNDS,
  withLongTurnNote,
} from './long-turn.ts';

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

describe('a conversation turn that goes quiet', () => {
  const chat = [tool('say'), tool('web.fetch')];
  const last = (body: Record<string, unknown>) =>
    (body.messages as { content?: unknown }[]).at(-1)?.content;
  const nudged = (body: Record<string, unknown>) => last(body) === PROGRESS_NOTE;

  test('is asked for one specific update after several silent rounds', () => {
    expect(PROGRESS_ROUNDS).toBe(5);
    expect(nudged(withLongTurnNote(request(PROGRESS_ROUNDS - 1, chat), 'chat/completions'))).toBe(
      false,
    );
    expect(nudged(withLongTurnNote(request(PROGRESS_ROUNDS, chat), 'chat/completions'))).toBe(true);
    // It stays asked until it speaks: the notes are never recorded, so one at most is in view.
    const later = withLongTurnNote(request(PROGRESS_ROUNDS + 3, chat), 'chat/completions');
    expect(nudged(later)).toBe(true);
    expect(
      (later.messages as { content?: unknown }[]).filter((m) => m.content === PROGRESS_NOTE),
    ).toHaveLength(1);
  });

  test('is not asked after it tells the person something, in words or with say', () => {
    const spoken = (message: Record<string, unknown>) =>
      request(2, chat, [message, ...Array.from({ length: 3 }, () => round()).flat()]);
    const words = {
      role: 'assistant',
      content: 'Google Flights shows three non-stops so far.',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'web.fetch', arguments: '{}' } }],
    };
    expect(nudged(withLongTurnNote(spoken(words), 'chat/completions'))).toBe(false);
    const parts = { ...words, content: [{ type: 'text', text: 'Checking the fares now.' }] };
    expect(nudged(withLongTurnNote(spoken(parts), 'chat/completions'))).toBe(false);
    const said = request(2, chat, [
      ...round('say'),
      ...Array.from({ length: 3 }, () => round()).flat(),
    ]);
    expect(nudged(withLongTurnNote(said, 'chat/completions'))).toBe(false);
    // Blank words are not an update.
    const blank = { ...words, content: '   ' };
    expect(nudged(withLongTurnNote(spoken(blank), 'chat/completions'))).toBe(true);
  });

  test('never doubles up with the closing note, and is not given where say is not offered', () => {
    const both = withLongTurnNote(
      request(LONG_TURN_ROUNDS, [tool('run.start'), ...chat]),
      'chat/completions',
    );
    expect(last(both)).toBe(LONG_TURN_NOTE);
    expect(
      (both.messages as { content?: unknown }[]).filter((m) => m.content === PROGRESS_NOTE),
    ).toHaveLength(0);
    // A helper or background work is offered no say, and is never asked.
    expect(
      nudged(
        withLongTurnNote(request(PROGRESS_ROUNDS + 3, [tool('web.fetch')]), 'chat/completions'),
      ),
    ).toBe(false);
  });
});
