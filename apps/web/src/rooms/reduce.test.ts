/**
 * A room's thread reads in order, with each answer straight after the message
 * that asked for it, and every person shown by name and the room's handle for them.
 */
import { expect, test } from 'bun:test';
import { inviteLink, type RoomMessage, type RoomRequest, type ThreadView } from './api.ts';
import {
  applyFrame,
  canAnswer,
  canStop,
  dayOf,
  decisionWords,
  initialsOf,
  mentionFor,
  namesAgent,
  needsRead,
  recordDelta,
  type Streams,
  sendKey,
  splitLabel,
  timeline,
  withStreams,
} from './reduce.ts';

const ALICE = { principal_id: 'own_alice', display_name: 'Alice <k7q2mxwa>' };
const BOB = { principal_id: 'own_bob', display_name: 'Bob <p3vz8ndr>' };

const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 9, minute)).toISOString();

const message = (id: string, minute: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  thread_id: 'rth_1',
  author: ALICE,
  kind: 'person',
  via_agent: false,
  text: id,
  mentions: [],
  request_state: 'none',
  request_job_id: null,
  created_at: at(minute),
  ...over,
});

const turn = (id: string, minute: number, answer: string) => ({
  id,
  conversation_id: 'job_1',
  agent_id: 'agt_room',
  text: id,
  answer,
  status: 'done' as const,
  delivery: null,
  created_at: at(minute),
});

const request = (over: Partial<RoomRequest> = {}): RoomRequest => ({
  job_id: 'job_1',
  requested_by: ALICE,
  status: 'done',
  turns: [],
  cards: [],
  receipts: [],
  permissions: [],
  decisions: [],
  ...over,
});

const view = (messages: RoomMessage[], requests: RoomRequest[] = []): ThreadView => ({
  thread: {
    id: 'rth_1',
    room_id: 'sp_room',
    title: 'Launch',
    created_by: ALICE,
    created_at: at(0),
    last_activity_at: at(9),
    archived_at: null,
  },
  messages,
  requests,
});

const none: Streams = new Map();

const shape = (v: ThreadView) =>
  timeline(v).map((entry) =>
    entry.type === 'message'
      ? entry.message.id
      : `answer:${entry.turn.id}${entry.last ? ':last' : ''}`,
  );

test("a label splits into the name and the room's handle, and a bare name keeps no handle", () => {
  expect(splitLabel('Alice <k7q2mxwa>')).toEqual({ name: 'Alice', handle: 'k7q2mxwa' });
  expect(splitLabel('Mary Ann Lee <h4ndl3ab>')).toEqual({
    name: 'Mary Ann Lee',
    handle: 'h4ndl3ab',
  });
  expect(splitLabel('Someone')).toEqual({ name: 'Someone', handle: null });
  // Nothing shaped like an email is ever taken for a handle.
  expect(splitLabel('Alice <alice@example.test>').handle).toBeNull();
  expect(initialsOf('Mary Ann Lee <h4ndl3ab>')).toBe('ML');
  expect(initialsOf('alice <k7q2mxwa>')).toBe('A');
});

test('an answer follows the message that asked for it, even when others spoke in between', () => {
  const ask = message('ask', 1, { request_state: 'started', request_job_id: 'job_1' });
  const aside = message('aside', 2, { author: BOB });
  const followUp = message('follow', 5, { request_state: 'started', request_job_id: 'job_1' });
  const v = view(
    [followUp, aside, ask],
    [request({ turns: [turn('t2', 5, 'Second'), turn('t1', 3, 'First')] })],
  );
  expect(shape(v)).toEqual(['ask', 'answer:t1', 'aside', 'follow', 'answer:t2:last']);
});

test('a request with more turns than asking messages shows every answer after its last message', () => {
  const ask = message('ask', 1, { request_state: 'started', request_job_id: 'job_1' });
  const v = view([ask], [request({ turns: [turn('t1', 1, 'a'), turn('t2', 2, 'b')] })]);
  expect(shape(v)).toEqual(['ask', 'answer:t1', 'answer:t2:last']);
});

test('a pending ask has no answer yet, and a request no message points at still shows', () => {
  const pending = message('wait', 1, { request_state: 'pending' });
  const v = view([pending], [request({ job_id: 'job_9', turns: [turn('t9', 2, 'Orphan')] })]);
  expect(shape(v)).toEqual(['wait', 'answer:t9:last']);
});

test('a message frame is folded in once, and agent work asks for a fresh read', () => {
  const first = message('m1', 1);
  const v = view([first]);
  const again = applyFrame(
    v,
    { seq: 4, kind: 'message', message: { ...first, text: 'edited' } },
    none,
  );
  expect(again.messages).toHaveLength(1);
  expect(again.messages[0]?.text).toBe('edited');
  const added = applyFrame(again, { seq: 5, kind: 'message', message: message('m2', 2) }, none);
  expect(added.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  const elsewhere = applyFrame(
    added,
    {
      seq: 6,
      kind: 'message',
      message: { ...message('m3', 3), thread_id: 'rth_other' },
    },
    none,
  );
  expect(elsewhere.messages).toHaveLength(2);
  expect(needsRead(v, { seq: 7, kind: 'request', request_job_id: 'job_1', event: {} })).toBe(true);
  expect(
    needsRead(v, {
      seq: 8,
      kind: 'message',
      message: message('m4', 4, { request_state: 'started', request_job_id: 'job_new' }),
    }),
  ).toBe(true);
  expect(needsRead(v, { seq: 9, kind: 'message', message: message('m5', 5) })).toBe(false);
});

test('only the person who asked, or an owner, can stop a request under way', () => {
  const working = request({ status: 'working' });
  expect(canStop(working, 'own_alice', 'member')).toBe(true);
  expect(canStop(working, 'own_bob', 'member')).toBe(false);
  expect(canStop(working, 'own_bob', 'owner')).toBe(true);
  expect(canStop(request({ status: 'done' }), 'own_alice', 'owner')).toBe(false);
});

test('the agent is asked by its one-word name, or by @Melete', () => {
  expect(mentionFor('Juno')).toBe('@Juno');
  expect(mentionFor('Design helper')).toBe('@Melete');
  expect(namesAgent('@melete can you check?', 'Juno')).toBe(true);
  expect(namesAgent('ask @Juno.', 'Juno')).toBe(true);
  expect(namesAgent('mail juno@melete.example', 'Juno')).toBe(false);
  expect(namesAgent('@Junora hi', 'Juno')).toBe(false);
});

const working = () => {
  const ask = message('ask', 1, { request_state: 'started', request_job_id: 'job_1' });
  return view(
    [ask],
    [request({ status: 'streaming', turns: [{ ...turn('t1', 1, 'Here'), status: 'streaming' }] })],
  );
};
const event = (item: Record<string, unknown>, turn_id: string | null = 't1') => ({
  seq: 10,
  kind: 'request' as const,
  request_job_id: 'job_1',
  event: { seq: 10, conversation_id: 'job_1', turn_id, created_at: at(2), item },
});

test('the words, cards and receipts of the agent are folded in from the stream without a read', () => {
  let v = working();
  const streams: Streams = new Map([['t1', 'Here']]);
  const fold = (frame: ReturnType<typeof event>) => {
    recordDelta(streams, v, frame);
    v = applyFrame(v, frame, streams);
  };
  const delta = event({ type: 'text_delta', text: ' it is' });
  expect(needsRead(v, delta)).toBe(false);
  fold(delta);
  expect(v.requests[0]?.turns[0]?.answer).toBe('Here it is');
  const card = {
    id: 'card_1',
    title: 'Notes',
    meta: '',
    facts: [],
    primary_action: null,
    secondary_actions: [],
    source_connection: null,
  };
  fold(event({ type: 'card', card }));
  fold(event({ type: 'card', card }));
  expect(v.requests[0]?.cards).toHaveLength(1);
  fold(event({ type: 'receipt', receipt: { id: 'r_1', what: 'Saved', where: 'x', when: at(3) } }));
  expect(v.requests[0]?.receipts).toHaveLength(1);
  const done = event({ type: 'status', status: 'done', composer: 'send' });
  fold(done);
  expect(v.requests[0]?.status).toBe('done');
  expect(v.requests[0]?.turns[0]?.status).toBe('done');
});

test('a full read is asked for only by what the stream cannot carry', () => {
  const v = working();
  expect(needsRead(v, event({ type: 'status', status: 'working', composer: 'stop' }))).toBe(false);
  expect(needsRead(v, event({ type: 'status', status: 'done', composer: 'send' }))).toBe(true);
  expect(needsRead(v, event({ type: 'text_delta', text: 'x' }, 't_new'))).toBe(true);
  expect(needsRead(v, event({ type: 'permission', permission: {} }))).toBe(true);
});

test('a message sent again after a failure keeps its key, and a changed one gets a new key', () => {
  let n = 0;
  const mint = () => `key-${++n}`;
  const first = sendKey(null, 'hello', false, mint);
  expect(first).toBe('key-1');
  const held = { text: 'hello', ask: false, key: first };
  expect(sendKey(held, 'hello', false, mint)).toBe('key-1');
  expect(sendKey(held, 'hello!', false, mint)).toBe('key-2');
  expect(sendKey(held, 'hello', true, mint)).toBe('key-3');
});

test('a read that is ahead of the stream never shows a word twice', () => {
  const streams: Streams = new Map([['t1', 'Here']]);
  // The read already holds words whose frames have not arrived yet.
  const ahead = working();
  const read = {
    ...ahead,
    requests: ahead.requests.map((r) => ({
      ...r,
      turns: r.turns.map((t) => ({ ...t, answer: 'Here is Jamie' })),
    })),
  };
  let v = withStreams(read, streams);
  expect(v.requests[0]?.turns[0]?.answer).toBe('Here is Jamie');
  for (const text of [' is', ' Jamie', ' Davis']) {
    const frame = event({ type: 'text_delta', text });
    recordDelta(streams, v, frame);
    v = applyFrame(v, frame, streams);
  }
  expect(v.requests[0]?.turns[0]?.answer).toBe('Here is Jamie Davis');
  // Once the turn rests, the service's own copy is shown as it is.
  const rested = withStreams(
    {
      ...v,
      requests: v.requests.map((r) => ({
        ...r,
        status: 'done' as const,
        turns: r.turns.map((t) => ({ ...t, status: 'done' as const, answer: 'Final words.' })),
      })),
    },
    streams,
  );
  expect(rested.requests[0]?.turns[0]?.answer).toBe('Final words.');
});

test('an answered permission says who answered it, or that nobody in the room did', () => {
  const base = { approval_id: 'apr_1', decided_at: at(4) };
  expect(decisionWords({ ...base, decision: 'approved', decided_by: BOB })).toBe(
    'Allowed by Bob <p3vz8ndr>',
  );
  expect(decisionWords({ ...base, decision: 'denied', decided_by: ALICE })).toBe(
    'Denied by Alice <k7q2mxwa>',
  );
  expect(decisionWords({ ...base, decision: 'denied', decided_by: null })).toBe(
    'Withdrawn by Melete',
  );
});

test("only the people the room's rule names can answer, and only for the content the card names", () => {
  const card = {
    id: 'apr_1',
    conversation_id: 'job_1',
    what: 'Send the notes',
    why: ['Waiting for Bob <p3vz8ndr>, who asked for it.'],
    options: ['allow_once', 'deny'] as ('allow_once' | 'deny' | 'always')[],
    version: 'v1',
    preview: null,
    created_at: '2026-10-02T10:00:00.000Z',
    eligible_approvers: [BOB],
    payload_hash: 'a'.repeat(64),
  };
  expect(canAnswer(card, 'own_bob')).toBe(true);
  expect(canAnswer(card, 'own_alice')).toBe(false);
  expect(canAnswer(card, null)).toBe(false);
  // A card that names no content is never answered from here.
  const { payload_hash: _hash, ...unbound } = card;
  expect(canAnswer(unbound, 'own_bob')).toBe(false);
  expect(canAnswer({ ...card, eligible_approvers: [] }, 'own_bob')).toBe(false);
});

test('an invite link opens on this page when the service knows no public address', () => {
  const path = '/#/invite?token=abc';
  expect(inviteLink({ link: null, path }, 'http://melete.local:8080/')).toBe(
    'http://melete.local:8080/#/invite?token=abc',
  );
  expect(inviteLink({ link: 'https://melete.example/#/invite?token=abc', path }, 'x')).toBe(
    'https://melete.example/#/invite?token=abc',
  );
});

test('a date reads as people say it, with the year only when it is not this one', () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  expect(dayOf('2026-10-25T12:00:00.000Z', now)).toBe('Oct 25');
  expect(dayOf('2027-01-05T12:00:00.000Z', now)).toBe('Jan 5, 2027');
});
