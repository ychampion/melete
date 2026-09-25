/**
 * The brief under the greeting is composed from counts alone, so every clause
 * in it is a number the service returned. A clause whose count is zero is not
 * said, and small counts are spelled out.
 */
import { expect, test } from 'bun:test';
import { progressOf, toolOf } from '../experience/trace.ts';
import type { Conversation, Permission, Question } from '../experience/types.ts';
import {
  briefLine,
  type Decision,
  frontOf,
  motionLine,
  motionRows,
  queueOrder,
  waitedFor,
  waitingOn,
} from './Home.tsx';

test('both clauses, spelled out, with the money the map totals', () => {
  expect(briefLine(2, 6, 481_100, 'GBP')).toBe(
    'Two decisions are waiting, and six companies owe you £4,811.',
  );
});

test('one of each reads in the singular', () => {
  expect(briefLine(1, 1, 6_400, 'GBP')).toBe(
    'One decision is waiting, and one company owes you £64.',
  );
});

test('a clause whose count is zero is dropped', () => {
  expect(briefLine(0, 3, 12_000, 'GBP')).toBe('Three companies owe you £120.');
  expect(briefLine(4, 0, 0, 'GBP')).toBe('Four decisions are waiting.');
  // Companies are only mentioned while the owed total is above zero.
  expect(briefLine(4, 2, 0, 'GBP')).toBe('Four decisions are waiting.');
  expect(briefLine(0, 0, 0, 'GBP')).toBeNull();
});

test('ten and above are figures', () => {
  expect(briefLine(12, 0, 0, 'GBP')).toBe('12 decisions are waiting.');
});

test('a trail step carries a tool entry only when the service sends one', () => {
  expect(toolOf({ type: 'action', label: 'Read', meta: '', sources: [] })).toBeNull();
  const tool = toolOf({
    type: 'action',
    label: 'Read',
    meta: '',
    sources: [],
    tool: {
      id: 'action:act_2',
      kind: 'web',
      title: 'Read a web page',
      status: 'done',
      started_at: '2026-09-24T19:00:04.000Z',
      ended_at: '2026-09-24T19:00:05.000Z',
      input_summary: { text: 'On bistro.example' },
      output_summary: { text: 'Page read', quote: { text: 'Book a table', from: 'page' } },
      detail: null,
      parent: null,
    },
  });
  expect(tool?.title).toBe('Read a web page');
  expect(tool?.output_summary?.quote).toEqual({ text: 'Book a table', from: 'page' });
});

const conversation = (progress?: Conversation['progress']): Conversation => ({
  id: 'job_1',
  title: 'Book dinner with Sam',
  agent_id: 'nova',
  status: 'working',
  composer: 'pause',
  created_at: '2026-09-24T19:00:00.000Z',
  updated_at: '2026-09-24T19:00:07.000Z',
  plan_id: null,
  ...(progress ? { progress } : {}),
});

test('progress is read only when present, as steps and never a percentage', () => {
  expect(progressOf(conversation())).toBeNull();
  expect(progressOf(conversation({ steps_done: 3, current: 'Sending the email' }))).toEqual({
    steps_done: 3,
    current: 'Sending the email',
  });
  expect(progressOf(conversation({ steps_done: 2, current: null }))?.current).toBeNull();
});

const permission = (id: string, created_at: string): Decision => ({
  kind: 'permission',
  id,
  permission: { id, conversation_id: 'job_1', created_at } as unknown as Permission,
});
const question = (id: string, created_at: string): Decision => ({
  kind: 'question',
  id,
  question: { id, conversation_id: 'job_1', created_at } as unknown as Question,
});
const ids = (list: Decision[]) => list.map((decision) => decision.id);

test('the queue is oldest first, by when each was asked', () => {
  const ordered = queueOrder([
    permission('p_new', '2026-09-23T10:00:00.000Z'),
    question('q_old', '2026-09-23T08:00:00.000Z'),
    permission('p_mid', '2026-09-23T09:00:00.000Z'),
  ]);
  expect(ids(ordered)).toEqual(['q_old', 'p_mid', 'p_new']);
});

test('a decision that arrives later does not move the card at the front', () => {
  const before = queueOrder([permission('p_1', '2026-09-23T09:00:00.000Z')]);
  const held = frontOf(before, null).front?.id ?? null;
  expect(held).toBe('p_1');
  // An older decision shows up; the person is still reading p_1.
  const after = queueOrder([
    permission('p_1', '2026-09-23T09:00:00.000Z'),
    question('q_0', '2026-09-23T08:00:00.000Z'),
  ]);
  expect(ids(after)).toEqual(['q_0', 'p_1']);
  expect(frontOf(after, held).front?.id).toBe('p_1');
  expect(frontOf(after, held).next?.id).toBe('q_0');
});

test('the front falls to the oldest when the held card is gone', () => {
  const ordered = queueOrder([
    permission('p_b', '2026-09-23T09:00:00.000Z'),
    permission('p_a', '2026-09-23T08:00:00.000Z'),
  ]);
  expect(frontOf(ordered, 'p_gone').front?.id).toBe('p_a');
  expect(frontOf([ordered[0] as Decision], null).next).toBeUndefined();
});

test('how long the front has waited reads the way a person would say it', () => {
  const asked = '2026-09-25T09:00:00.000Z';
  const after = (minutes: number) => Date.parse(asked) + minutes * 60_000;
  expect(waitedFor(asked, after(0))).toBe('Just now');
  expect(waitedFor(asked, after(1))).toBe('About a minute');
  expect(waitedFor(asked, after(12))).toBe('12 minutes');
  expect(waitedFor(asked, after(70))).toBe('About an hour');
  expect(waitedFor(asked, after(5 * 60))).toBe('5 hours');
  expect(waitedFor(asked, after(26 * 60))).toBe('A day');
  expect(waitedFor(asked, after(3 * 24 * 60))).toBe('3 days');
});

test('In motion reads waiting on you while a job has an open decision, not Done', () => {
  const chase: Conversation = {
    ...conversation(),
    id: 'job_chase',
    title: 'Tern & Co',
    status: 'done',
  };
  const other: Conversation = {
    ...conversation(),
    id: 'job_other',
    title: 'Kyoto',
    status: 'done',
  };
  const waiting = waitingOn({
    permissions: [{ conversation_id: 'job_chase' }],
    questions: [{ conversation_id: null }],
  });
  expect([...waiting]).toEqual(['job_chase']);
  expect(motionLine(chase, waiting, 'Nova')).toBe('Waiting on you');
  expect(motionLine(other, waiting, 'Nova')).toBe('Done');
  // Once the decision is made the turn's own status reads again.
  expect(motionLine(chase, new Set(), 'Nova')).toBe('Done');
});

test('a conversation waiting on the person stays in the list, whatever its age', () => {
  const now = Date.parse('2026-09-30T19:05:00.000Z');
  const stale: Conversation = { ...conversation(), id: 'job_old', status: 'done' };
  const asking: Conversation = { ...conversation(), id: 'job_ask', status: 'needs_you' };
  expect(motionRows([stale], new Set(), now)).toEqual([]);
  expect(motionRows([stale], new Set(['job_old']), now).map((row) => row.id)).toEqual(['job_old']);
  expect(motionRows([asking], new Set(), now).map((row) => row.id)).toEqual(['job_ask']);
  expect(motionLine(asking, new Set(), 'Nova')).toBe('Waiting on you');
});
