/**
 * A permission asked for in a chat stays open until the service says how it
 * was decided. The model keeps writing after a tool call comes back "needs
 * approval", and that text, the model's own entries and the waiting action read
 * again as under way all arrive before the turn says it needs the person; none
 * of them decides anything, so the card keeps its buttons.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionCard } from '../chat/parts.tsx';
import { applyEvents, fromTurns, type TurnBlock } from './reduce.ts';
import type { ExperienceEvent, Permission, Turn } from './types.ts';

const AT = '2026-09-30T04:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Email and admin is what eats my week right now.',
  answer: '',
  status: 'working',
  delivery: null,
  created_at: AT,
};
const PERMISSION: Permission = {
  id: 'apr_1',
  conversation_id: 'job_1',
  what: 'Save plans/email-and-admin.md',
  why: ['This change needs your permission before it happens.'],
  options: ['allow_once', 'deny'],
  version: 'v_1',
  preview: null,
  file: {
    path: 'plans/email-and-admin.md',
    bytes: 42,
    content: '# Email and admin\n\n1. Batch replies at 4pm',
    truncated: false,
  },
  created_at: AT,
};
type Tool = Extract<ExperienceEvent['item'], { type: 'tool' }>['tool'];
const tool = (id: string, status: Tool['status'], permission?: string): Tool => ({
  id,
  kind: id.startsWith('action:') ? 'file' : 'model',
  title: 'Saving a file',
  status,
  started_at: AT,
  ended_at: null,
  input_summary: null,
  output_summary: null,
  detail: permission ? { type: 'permission', id: permission } : null,
  parent: null,
});

let seq = 80;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});

/** The order a real model produced: ask, keep writing, then say it waits. */
const asked = (): ExperienceEvent[] => [
  event({ type: 'tool', tool: tool('action:act_1', 'needs_approval', 'apr_1') }),
  event({ type: 'permission', permission: PERMISSION }),
  event({ type: 'tool', tool: tool('model:m1', 'running') }),
  event({ type: 'text_delta', text: 'I drafted a plan for your week. ' }),
  event({ type: 'text_delta', text: 'It is waiting on your OK before it is saved.' }),
  event({ type: 'tool', tool: tool('model:m1', 'done') }),
  event({ type: 'tool', tool: tool('action:act_1', 'running') }),
  event({ type: 'status', status: 'needs_you', composer: 'send' }),
];

const permissionBlock = (events: ExperienceEvent[]) =>
  applyEvents(fromTurns([TURN], 'pause', 'working'), events).turns[0]?.blocks.find(
    (block): block is Extract<TurnBlock, { type: 'permission' }> => block.type === 'permission',
  );

test('the answer streaming after the request leaves the permission open', () => {
  expect(permissionBlock(asked())?.decided).toBeNull();
});

test('the card drawn from that stream still offers Allow once and Deny, not "Decided"', () => {
  const block = permissionBlock(asked());
  const html = renderToStaticMarkup(
    <PermissionCard permission={PERMISSION} decided={block?.decided ?? null} onDecide={() => {}} />,
  );
  expect(html).toContain('Allow once');
  expect(html).toContain('Deny');
  expect(html).not.toContain('Decided');
  // The file it would save is shown, so it is not approved unseen.
  expect(html).toContain('# Email and admin');
  expect(html).toContain('Batch replies at 4pm');
});

test('the decision reported by the service settles the card, wherever it was made', () => {
  const block = permissionBlock([
    ...asked(),
    event({
      type: 'decision',
      decision: { kind: 'permission', id: 'apr_1', outcome: 'deny', answer: null, decided_at: AT },
    }),
  ]);
  expect(block?.decided).toBe('deny');
  const html = renderToStaticMarkup(
    <PermissionCard permission={PERMISSION} decided={block?.decided ?? null} onDecide={() => {}} />,
  );
  expect(html).toContain('Denied');
  expect(html).not.toContain('Allow once');
});

test('the waiting action finishing without a decision item closes the card', () => {
  expect(
    permissionBlock([
      ...asked(),
      event({ type: 'tool', tool: tool('action:act_1', 'done') }),
      event({ type: 'status', status: 'done', composer: 'send' }),
    ])?.decided,
  ).toBe('closed');
});

test('the turn finishing on its own says nothing about the request', () => {
  expect(
    permissionBlock([...asked(), event({ type: 'status', status: 'done', composer: 'send' })])
      ?.decided,
  ).toBeNull();
});
