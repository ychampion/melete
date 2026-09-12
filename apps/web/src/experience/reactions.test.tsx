import { expect, test } from 'bun:test';
import type { MeleteEvent } from '@melete/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionBar } from '../chat/parts.tsx';
import {
  acceptLocalTurn,
  addLocalTurn,
  applyEvent,
  applyMessageEvent,
  emptyTranscript,
  fromTurns,
  reactionMessageSeq,
  turnIndexForReaction,
} from './reduce.ts';
import type { ExperienceEvent, Reaction, Turn } from './types.ts';

const conversationId = 'conversation-reactions';
const at = (second: number) => `2026-09-01T12:00:${String(second).padStart(2, '0')}.000Z`;
const turn = (id: string, text: string, second: number): Turn => ({
  id,
  conversation_id: conversationId,
  agent_id: 'helper',
  text,
  answer: '',
  status: 'done',
  delivery: null,
  created_at: at(second),
});
const first = turn('first', 'Check the address.', 1);
const second = turn('second', 'Use the newer address.', 2);
const reaction = (messageId: number, by: Reaction['by'] = 'assistant'): Reaction => ({
  message_id: String(messageId),
  by,
  emoji: '👍',
  job_id: conversationId,
  seq: 100,
  created_at: at(9),
});
const reply = (seq: number, turnId: string): ExperienceEvent => ({
  seq,
  turn_id: turnId,
  conversation_id: conversationId,
  created_at: at(3),
  item: { type: 'text_delta', text: 'I checked it.' },
});
const transcript = () => ({
  ...fromTurns([first, second], 'send', 'done'),
  messages: {
    '10': {
      conversationId,
      turnId: first.id,
      author: 'person' as const,
      text: first.text,
      createdAt: first.created_at,
    },
    '20': {
      conversationId,
      turnId: second.id,
      author: 'person' as const,
      text: second.text,
      createdAt: second.created_at,
    },
  },
});

test('ordinary interleaved messages keep the reaction on the identified person', () => {
  const state = applyEvent(applyEvent(transcript(), reply(15, first.id)), reply(30, second.id));
  expect(turnIndexForReaction(state, reaction(20))).toBe(1);
});

test('two person messages before one reply keep the reaction on the second person message', () => {
  const state = applyEvent(transcript(), reply(30, second.id));
  expect(turnIndexForReaction(state, reaction(20))).toBe(1);
});

test('delayed projection of an earlier reply cannot move a later message reaction', () => {
  const state = applyEvent(applyEvent(transcript(), reply(30, first.id)), reply(40, second.id));
  expect(turnIndexForReaction(state, reaction(20))).toBe(1);
});

test('a reaction with an unknown message identity is omitted', () => {
  expect(turnIndexForReaction(applyEvent(transcript(), reply(30, second.id)), reaction(999))).toBe(
    -1,
  );
});

const card: ExperienceEvent['item'] = {
  type: 'card',
  card: {
    id: 'card-only',
    title: 'A saved result',
    meta: '',
    facts: [],
    primary_action: null,
    secondary_actions: [],
    source_connection: null,
  },
};
const receipt: ExperienceEvent['item'] = {
  type: 'receipt',
  receipt: { id: 'receipt-only', what: 'Saved', where: 'Your files', when: at(3) },
};

for (const item of [card, receipt]) {
  test(`${item.type}-only finished turns have no rendered reaction controls`, () => {
    const state = applyEvent(fromTurns([first], 'send', 'done'), {
      ...reply(30, first.id),
      item,
    });
    const saved = state.turns[0];
    if (!saved) throw new Error('Missing turn');
    expect(saved.blocks[0]?.type).toBe(item.type);
    const html = renderToStaticMarkup(
      <ActionBar turn={saved} touch={false} onCopy={() => {}} onReact={() => {}} />,
    );
    expect(html).not.toContain('React with');
  });
}

test('a finished text message retains its four rendered reaction buttons', () => {
  const state = applyEvent(fromTurns([first], 'send', 'done'), reply(30, first.id));
  const saved = state.turns[0];
  if (!saved) throw new Error('Missing turn');
  const html = renderToStaticMarkup(
    <ActionBar turn={saved} touch={false} onCopy={() => {}} onReact={() => {}} />,
  );
  expect(html.match(/React with/g)).toHaveLength(4);
});

const personEvent = (seq: number, saved: Turn): MeleteEvent => ({
  seq,
  job_id: saved.conversation_id,
  attempt_id: null,
  type: 'notice',
  payload: { kind: 'user_message', text: saved.text },
  created_at: saved.created_at,
});

test('service message records match repeated text by the exact transaction timestamp', () => {
  const repeated = { ...second, text: first.text };
  let state = fromTurns([first, repeated], 'send', 'done');
  state = applyMessageEvent(state, personEvent(10, first));
  state = applyMessageEvent(state, personEvent(20, repeated));
  expect(turnIndexForReaction(state, reaction(20))).toBe(1);
  expect(turnIndexForReaction(state, reaction(10))).toBe(0);
});

test('ambiguous identical message records are omitted instead of choosing a turn', () => {
  const repeated = { ...first, id: second.id };
  const state = applyMessageEvent(
    fromTurns([first, repeated], 'send', 'done'),
    personEvent(10, first),
  );
  expect(turnIndexForReaction(state, reaction(10))).toBe(-1);
});

test('matching text without a matching creation timestamp is not enough', () => {
  const state = applyMessageEvent(fromTurns([first], 'send', 'done'), {
    ...personEvent(10, first),
    created_at: at(8),
  });
  expect(turnIndexForReaction(state, reaction(10))).toBe(-1);
});

test('an explicit message turn that is absent cannot fall back to a neighboring turn', () => {
  const state = applyMessageEvent(fromTurns([first], 'send', 'done'), {
    ...personEvent(10, first),
    payload: { kind: 'user_message', text: first.text, turn_id: 'missing' },
  });
  expect(turnIndexForReaction(state, reaction(10))).toBe(-1);
});

test('a local acceptance adopts the server timestamp before matching the message event', () => {
  let state = addLocalTurn(
    emptyTranscript(),
    first.text,
    first.agent_id,
    conversationId,
    'sending',
    'local',
  );
  state = applyMessageEvent(state, personEvent(10, first));
  expect(turnIndexForReaction(state, reaction(10))).toBe(-1);
  state = acceptLocalTurn(state, 'local', first.id, first.created_at);
  expect(turnIndexForReaction(state, reaction(10))).toBe(0);
});

test('reactions from another conversation or on the wrong author are omitted', () => {
  const state = applyMessageEvent(fromTurns([first], 'send', 'done'), personEvent(10, first));
  expect(turnIndexForReaction(state, { ...reaction(10), job_id: 'another-conversation' })).toBe(-1);
  expect(turnIndexForReaction(state, reaction(10, 'person'))).toBe(-1);
});

test('reply controls target text after a card and reactions on later text chunks keep their turn', () => {
  let state = applyEvent(fromTurns([first, second], 'send', 'done'), {
    ...reply(25, second.id),
    item: card,
  });
  state = applyEvent(state, reply(30, second.id));
  state = applyEvent(state, reply(31, second.id));
  const saved = state.turns[1];
  if (!saved) throw new Error('Missing reply');
  expect(reactionMessageSeq(saved)).toBe(30);
  expect(turnIndexForReaction(state, reaction(25, 'person'))).toBe(-1);
  expect(turnIndexForReaction(state, reaction(31, 'person'))).toBe(1);
});

test('a projected reply preserves the source text identity for existing reactions', () => {
  const state = applyMessageEvent(fromTurns([first, second], 'send', 'done'), {
    ...personEvent(40, second),
    payload: {
      kind: 'experience',
      turn_id: second.id,
      source_seq: 30,
      item: { type: 'text_delta', text: 'Checked.' },
    },
  });
  expect(turnIndexForReaction(state, reaction(30, 'person'))).toBe(1);
  expect(turnIndexForReaction(state, reaction(40, 'person'))).toBe(1);
});

for (const status of ['queued', 'working', 'needs_you', 'paused'] as const) {
  test(`${status} turns cannot offer reactions even if a text event exists`, () => {
    const state = applyEvent(
      fromTurns([{ ...first, status }], 'send', status),
      reply(30, first.id),
    );
    const saved = state.turns[0];
    if (!saved) throw new Error('Missing turn');
    expect(reactionMessageSeq(saved)).toBeNull();
  });
}

test('text without an identified turn or consisting only of whitespace is not a reaction target', () => {
  for (const event of [
    { ...reply(30, first.id), turn_id: null },
    { ...reply(30, first.id), item: { type: 'text_delta' as const, text: '  ' } },
  ]) {
    const state = applyEvent(fromTurns([first], 'send', 'done'), event);
    const saved = state.turns[0];
    if (!saved) throw new Error('Missing turn');
    expect(reactionMessageSeq(saved)).toBeNull();
    expect(turnIndexForReaction(state, reaction(30, 'person'))).toBe(-1);
  }
});
