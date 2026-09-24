/**
 * The brief under the greeting is composed from counts alone, so every clause
 * in it is a number the service returned. A clause whose count is zero is not
 * said, and small counts are spelled out.
 */
import { expect, test } from 'bun:test';
import { progressOf, toolOf } from '../experience/trace.ts';
import type { Conversation, Permission, Question } from '../experience/types.ts';
import { briefLine, type Decision, frontOf, queueOrder } from './Home.tsx';

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

const chat = (id: string, updated_at: string) => ({ id, updated_at }) as unknown as Conversation;
const permission = (id: string, conversation_id: string): Decision => ({
  kind: 'permission',
  id,
  permission: { id, conversation_id } as unknown as Permission,
});
const question = (id: string, conversation_id: string): Decision => ({
  kind: 'question',
  id,
  question: { id, conversation_id } as unknown as Question,
});
const ids = (list: Decision[]) => list.map((decision) => decision.id);

test('the queue is oldest first, dated by when each conversation last changed', () => {
  const chats = [
    chat('c_new', '2026-09-23T10:00:00.000Z'),
    chat('c_old', '2026-09-23T08:00:00.000Z'),
    chat('c_mid', '2026-09-23T09:00:00.000Z'),
  ];
  const ordered = queueOrder(
    [permission('p_new', 'c_new'), question('q_old', 'c_old'), permission('p_mid', 'c_mid')],
    chats,
  );
  expect(ids(ordered)).toEqual(['q_old', 'p_mid', 'p_new']);
});

test('a decision that arrives later does not move the card at the front', () => {
  const chats = [chat('c_1', '2026-09-23T09:00:00.000Z'), chat('c_0', '2026-09-23T08:00:00.000Z')];
  const before = queueOrder([permission('p_1', 'c_1')], chats);
  const held = frontOf(before, null).front?.id ?? null;
  expect(held).toBe('p_1');
  // An older decision shows up; the person is still reading p_1.
  const after = queueOrder([permission('p_1', 'c_1'), question('q_0', 'c_0')], chats);
  expect(ids(after)).toEqual(['q_0', 'p_1']);
  expect(frontOf(after, held).front?.id).toBe('p_1');
  expect(frontOf(after, held).next?.id).toBe('q_0');
});

test('the front falls to the oldest when the held card is gone', () => {
  const chats = [chat('c_a', '2026-09-23T08:00:00.000Z'), chat('c_b', '2026-09-23T09:00:00.000Z')];
  const ordered = queueOrder([permission('p_b', 'c_b'), permission('p_a', 'c_a')], chats);
  expect(frontOf(ordered, 'p_gone').front?.id).toBe('p_a');
  expect(frontOf([ordered[0] as Decision], null).next).toBeUndefined();
});
