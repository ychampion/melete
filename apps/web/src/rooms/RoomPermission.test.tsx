/**
 * A room's permission card shows exactly what it would do, the draft, its
 * recipients and any file, to everyone in the room before any answer; only the
 * people the room's rule names get answers, and only the ones the card offers.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomPermission } from './api.ts';
import { answerableOptions, RoomPermissionCard } from './RoomPermission.tsx';

const BOB = { principal_id: 'own_bob', display_name: 'Bob <p3vz8ndr>' };
const SEND = {
  id: 'apr_1',
  conversation_id: 'job_1',
  what: 'Send an email to dana@example.test',
  why: ['Waiting for Bob <p3vz8ndr>, who asked for it.', 'From: team@example.test'],
  options: ['allow_once', 'deny'],
  version: 'v1',
  preview: null,
  created_at: '2026-10-02T10:00:00.000Z',
  draft: {
    id: 'drf_1',
    recipient: 'dana@example.test',
    cc: ['lee@example.test'],
    channel: 'email',
    subject: 'Launch notes',
    body: 'The launch moves to Thursday at ten.',
    connection_id: 'conn_1',
    status: 'awaiting_permission',
  },
  file: {
    path: 'notes/launch.md',
    bytes: 24,
    content: 'Room notes for Thursday.',
    truncated: false,
  },
  eligible_approvers: [BOB],
  payload_hash: 'a'.repeat(64),
} as unknown as RoomPermission;

const render = (permission: RoomPermission, me: string | null) =>
  renderToStaticMarkup(
    <RoomPermissionCard permission={permission} me={me} busy={false} onAnswer={() => {}} />,
  );

test('a waiting send shows its subject, body, recipients and file before its answers', () => {
  const html = render(SEND, 'own_bob');
  const shown = [
    'Launch notes',
    'The launch moves to Thursday at ten.',
    'dana@example.test',
    'lee@example.test',
    'From',
    'team@example.test',
    'Room notes for Thursday.',
  ];
  for (const text of shown) expect(html).toContain(text);
  const allow = html.indexOf('Allow once');
  expect(allow).toBeGreaterThan(-1);
  for (const text of shown) expect(html.indexOf(text)).toBeLessThan(allow);
  expect(html).toContain('Deny');
  expect(html).not.toContain('Always allow');
});

test('someone the rule does not name reads the whole card and gets no answers', () => {
  const html = render(SEND, 'own_alice');
  expect(html).toContain('The launch moves to Thursday at ten.');
  expect(html).toContain('Who can answer');
  expect(html).not.toContain('Allow once');
  expect(html).not.toContain('Deny');
  expect(answerableOptions(SEND, 'own_alice')).toEqual([]);
});

test('only the answers the card lists are offered, and a standing rule never is', () => {
  const denyOnly = { ...SEND, options: ['deny'] } as unknown as RoomPermission;
  const html = render(denyOnly, 'own_bob');
  expect(html).toContain('Deny');
  expect(html).not.toContain('Allow once');
  const withAlways = {
    ...SEND,
    options: ['allow_once', 'always', 'deny'],
  } as unknown as RoomPermission;
  expect(answerableOptions(withAlways, 'own_bob')).toEqual(['allow_once', 'deny']);
});
