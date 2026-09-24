import { expect, test } from 'bun:test';
import { applyEvents, fromTurns } from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const conversationId = 'conversation-tools';
const at = (second: number) => `2026-09-01T12:00:${String(second).padStart(2, '0')}.000Z`;
const turn: Turn = {
  id: 'turn-1',
  conversation_id: conversationId,
  agent_id: 'helper',
  text: 'Send the invite to Sam',
  answer: '',
  status: 'working',
  delivery: null,
  created_at: at(1),
};
type Tool = Extract<ExperienceEvent['item'], { type: 'tool' }>['tool'];
const tool = (id: string, status: Tool['status'], permission?: string): Tool => ({
  id,
  kind: id.startsWith('action:') ? 'connector' : 'model',
  title: 'Sending the email',
  status,
  started_at: at(2),
  ended_at: null,
  input_summary: null,
  output_summary: null,
  detail: permission ? { type: 'permission', id: permission } : null,
  parent: null,
});
let seq = 10;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: seq++,
  conversation_id: conversationId,
  turn_id: turn.id,
  created_at: at(3),
  item,
});
const permission = (id: string) =>
  event({
    type: 'permission',
    permission: {
      id,
      conversation_id: conversationId,
      what: 'Send the email to sam@example.test',
      why: ['This change needs your permission before it happens.'],
      options: ['allow_once', 'deny'],
      version: 'v1',
      preview: null,
      created_at: '2026-09-24T08:00:00.000Z',
    },
  });
const decided = (events: ExperienceEvent[]) =>
  Object.fromEntries(
    applyEvents(fromTurns([turn], 'pause', 'working'), events).turns[0]?.blocks.flatMap((block) =>
      block.type === 'permission' ? [[block.permission.id, block.decided]] : [],
    ) ?? [],
  );

test('background tool entries leave an open permission alone', () => {
  expect(
    decided([
      event({ type: 'tool', tool: tool('action:a1', 'needs_approval', 'apr-1') }),
      permission('apr-1'),
      event({ type: 'tool', tool: tool('model:m1', 'running') }),
      event({ type: 'tool', tool: tool('model:m1', 'done') }),
    ]),
  ).toEqual({ 'apr-1': null });
});

test('an action moving on from approval closes its own permission and no other', () => {
  expect(
    decided([
      event({ type: 'tool', tool: tool('action:a1', 'needs_approval', 'apr-1') }),
      permission('apr-1'),
      event({ type: 'tool', tool: tool('action:a2', 'needs_approval', 'apr-2') }),
      permission('apr-2'),
      event({ type: 'tool', tool: tool('action:a1', 'running') }),
    ]),
  ).toEqual({ 'apr-1': 'closed', 'apr-2': null });
});
