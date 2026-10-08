import { expect, test } from 'bun:test';
import { type CanonicalMessage, EARLIER_SUMMARY_CHARACTERS } from '@melete/contracts';
import { estimateInputTokens } from '../gateway/metering.ts';
import { assembleHistory, boundHistory, type TranscriptLimits } from './bundle.ts';
import {
  type ConversationSummary,
  chunkMessages,
  EMPTY_SUMMARY,
  HISTORY_SUMMARY_KIND,
  KEEP_SHARE,
  madeUnder,
  planExtension,
  renderSummary,
  type StoredSummary,
  storedSummary,
} from './history-summary.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 9, minute)).toISOString();
const said = (minute: number, content: string, role: 'user' | 'assistant' = 'user') =>
  ({ role, content, at: at(minute) }) satisfies CanonicalMessage;
const tokens = (messages: readonly CanonicalMessage[]) =>
  messages.reduce((sum, message) => sum + estimateInputTokens(JSON.stringify(message)), 0);
const summary = (facts: string[]): ConversationSummary => ({ ...EMPTY_SUMMARY, facts });
const GENERATIONS = { policy_generation: 2, connection_generations: { conn_a: 1 } };
const limits = (maxTokens: number): TranscriptLimits => ({
  maxMessages: 800,
  maxTokens,
  maxBytes: 10_000_000,
});

test('nothing is summarised while the conversation fits', () => {
  const prior = [said(0, 'a'.repeat(400)), said(1, 'b'.repeat(400), 'assistant')];
  expect(planExtension(prior, { tokens: tokens(prior), messages: 10 })).toBeNull();
});

test('past its room, the oldest messages are summarised until what stays takes half', () => {
  const prior = Array.from({ length: 20 }, (_, index) =>
    said(index, `${index}:${'x'.repeat(396)}`, index % 2 ? 'assistant' : 'user'),
  );
  const room = { tokens: Math.floor(tokens(prior) / 2), messages: 800 };
  const plan = planExtension(prior, room);
  if (!plan) throw new Error('expected a plan');
  const kept = prior.slice(plan.summarise.length);
  // What stays fits in half the room, and taking one more would not.
  expect(tokens(kept)).toBeLessThanOrEqual(room.tokens * KEEP_SHARE);
  expect(tokens(prior.slice(plan.summarise.length - 1))).toBeGreaterThan(room.tokens * KEEP_SHARE);
  expect(plan.summarise).toEqual(prior.slice(0, plan.summarise.length));
  expect(plan.through).toBe(plan.summarise.at(-1)?.at ?? 'missing');
});

test('a message sharing the time of the last one summarised goes with it', () => {
  const prior = [
    said(0, 'x'.repeat(2000)),
    said(1, 'y'.repeat(2000), 'assistant'),
    { role: 'user' as const, content: 'z'.repeat(10), at: at(1) },
    said(2, 'w'.repeat(10), 'assistant'),
  ];
  const plan = planExtension(prior, { tokens: 300, messages: 800 });
  expect(plan?.summarise.map((message) => message.content[0])).toEqual(['x', 'y', 'z']);
});

test('a newest message too big for half the room is summarised with the rest', () => {
  const prior = [said(0, 'a'.repeat(100)), said(1, 'b'.repeat(8000))];
  const plan = planExtension(prior, { tokens: 1000, messages: 800 });
  expect(plan?.summarise).toHaveLength(2);
});

test('messages are packed into calls in order, a long one split, and each chunk says what it completes', () => {
  const messages = [
    said(0, 'first'),
    said(1, 'L'.repeat(9000), 'assistant'),
    said(2, 'third'),
    said(3, 'fourth'),
  ];
  const chunks = chunkMessages(messages, 1000);
  // Every chunk is within the call size, give or take the separators.
  for (const chunk of chunks) expect(estimateInputTokens(chunk.text)).toBeLessThan(1100);
  const joined = chunks.map((chunk) => chunk.text).join('\n\n');
  expect(joined.indexOf('first')).toBeLessThan(joined.indexOf('(part 1 of'));
  expect(joined.indexOf('third')).toBeGreaterThan(joined.lastIndexOf('(part'));
  // All of the long message is there, once.
  expect(joined.replace(/[^L]/g, '').length).toBe(9000);
  // A chunk holding only the long message's first parts completes only the first message.
  expect(chunks[0]?.completes).toBe(1);
  expect(chunks.map((chunk) => chunk.completes)).toEqual(
    [...chunks.map((chunk) => chunk.completes)].sort((a, b) => a - b),
  );
  expect(chunks.at(-1)?.completes).toBe(4);
});

test('the summary puts what the person said first, and is held to its size', () => {
  const text = renderSummary({
    facts: ['The container number is MSCU-7741-ZQ.'],
    decisions: ['Use the Tuesday ferry.'],
    open_tasks: ['Book the tug.'],
    names: ['Ines Varga, the pilot'],
    story: 'They planned a shipment.',
  });
  expect(text.indexOf('MSCU-7741-ZQ')).toBeLessThan(text.indexOf('Use the Tuesday ferry'));
  expect(text.indexOf('Book the tug')).toBeLessThan(text.indexOf('What happened:'));
  const long = renderSummary({ ...EMPTY_SUMMARY, story: 's'.repeat(40_000), facts: ['kept'] });
  expect(long.length).toBeLessThanOrEqual(EARLIER_SUMMARY_CHARACTERS);
  expect(long.startsWith('What the person said')).toBe(true);
});

test('a stored summary replaces what it covers, keeps tool identities, and counts what is left out', () => {
  const transcript: CanonicalMessage[] = [
    said(0, 'My container is MSCU-7741-ZQ.'),
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}', at: at(1) },
    said(2, 'Noted.', 'assistant'),
    said(3, 'n'.repeat(4000)),
    said(4, 'Newest question?'),
  ];
  const fresh = [transcript[4] as CanonicalMessage];
  const stored: StoredSummary = {
    through: at(2),
    summary: summary(['Container MSCU-7741-ZQ']),
    messages: 2,
    generations: GENERATIONS,
  };
  const roomy = boundHistory(transcript, fresh, stored, limits(10_000));
  expect(roomy.transcript.map((message) => message.at)).toEqual([at(1), at(3), at(4)]);
  // The tool call keeps its identity; its body stays in the record.
  expect(roomy.transcript[0]).toMatchObject({ tool_call_id: 'call_1' });
  expect(roomy.transcript[0]?.content).not.toContain('"ok"');
  expect(roomy.earlier).toEqual({
    summary: renderSummary(stored.summary),
    through: at(2),
    left_out: 0,
  });
  // Too little room: the long message after the summary is left out, and said to be.
  const tight = boundHistory(transcript, fresh, stored, limits(300));
  expect(tight.earlier?.left_out).toBe(1);
  expect(tight.transcript.some((message) => message.content === 'Newest question?')).toBe(true);
  // With no summary, a gap is counted all the same.
  expect(boundHistory(transcript, fresh, null, limits(300)).earlier).toMatchObject({
    summary: null,
    through: null,
  });
  expect(boundHistory(transcript, fresh, null, limits(10_000)).earlier).toBeUndefined();
});

test('the newest stored summary in a job’s events is the one applied', () => {
  const event = (seq: number, payload: Record<string, unknown>, minute: number) => ({
    seq,
    type: 'notice',
    payload,
    createdAt: new Date(at(minute)),
  });
  const message = (seq: number, text: string, minute: number) =>
    event(seq, { kind: 'user_message', text }, minute);
  const stored = (seq: number, through: number, fact: string, minute: number) =>
    event(
      seq,
      {
        kind: HISTORY_SUMMARY_KIND,
        through: at(through),
        summary: summary([fact]),
        messages: 1,
        generations: GENERATIONS,
      },
      minute,
    );
  const history = assembleHistory(
    [
      message(1, 'one', 0),
      message(2, 'two', 1),
      stored(3, 0, 'older summary', 2),
      message(4, 'three', 3),
      stored(5, 1, 'newer summary', 4),
      message(6, 'four', 5),
    ],
    [],
    5,
  );
  expect(history.stored?.summary.facts).toEqual(['newer summary']);
  expect(history.transcript.map((entry) => entry.content)).toEqual(['three', 'four']);
  expect(history.full.map((entry) => entry.content)).toEqual(['one', 'two', 'three', 'four']);
  expect(history.earlier?.summary).toContain('newer summary');
  expect(storedSummary({ kind: HISTORY_SUMMARY_KIND, through: 'not a time' })).toBeNull();
});

test('the cut never reaches a message of this turn, even one older than the last reply', () => {
  const prior = [
    said(0, 'a'.repeat(2000)),
    said(1, 'b'.repeat(2000), 'assistant'),
    said(3, 'c'.repeat(2000), 'assistant'),
  ];
  // A message the person sent at minute 2, while the reply at minute 3 was being written.
  const plan = planExtension(prior, { tokens: 300, messages: 800 }, Date.parse(at(2)));
  expect(plan?.summarise.map((message) => message.content[0])).toEqual(['a', 'b']);
  expect(Date.parse(plan?.through ?? '')).toBeLessThan(Date.parse(at(2)));
  expect(planExtension(prior, { tokens: 300, messages: 800 }, Date.parse(at(0)))).toBeNull();
});

test('a summary counts only under the generations it was made under', () => {
  const stored: StoredSummary = {
    through: at(0),
    summary: EMPTY_SUMMARY,
    messages: 1,
    generations: GENERATIONS,
  };
  expect(madeUnder(stored, GENERATIONS)).toBe(true);
  expect(madeUnder(stored, { ...GENERATIONS, policy_generation: 3 })).toBe(false);
  expect(madeUnder(stored, { policy_generation: 2, connection_generations: { conn_a: 2 } })).toBe(
    false,
  );
  expect(
    madeUnder(stored, { policy_generation: 2, connection_generations: { conn_a: 1, conn_b: 1 } }),
  ).toBe(false);
});
