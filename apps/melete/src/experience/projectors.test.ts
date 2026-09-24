import { expect, test } from 'bun:test';
import { estimateTokens } from '@melete/skills';
import { AGENT_TEMPLATES, agentIdentity } from './agents.ts';
import {
  type ActionRow,
  BACKEND_VOCABULARY,
  plainText,
  projectActionGroup,
  projectCards,
  projectPermission,
  projectPermissionDecision,
  projectQuestionDecision,
  SUPERSEDED_NOTE,
  safeUrl,
  senderAddress,
} from './projectors.ts';

const base: ActionRow = {
  id: 'one',
  jobId: 'chat',
  attemptId: 'attempt',
  connectionId: 'calendar-connection',
  kind: 'calendar.list',
  effectClass: 'read',
  canonicalPayload: {},
  receipt: {
    detail: {
      events: [{ summary: 'Dinner', start: '2026-09-12T19:00:00Z', end: '2026-09-12T20:00:00Z' }],
    },
  },
  status: 'succeeded',
  createdAt: new Date(),
  resolvedAt: new Date(),
};
test('three calls across two connections produce one compound action with attributable sources', () => {
  const calendar = { id: 'calendar-connection', label: 'My calendar', provider: 'caldav' };
  const mail = { id: 'mail-connection', label: 'My mail', provider: 'imap' };
  const rows = [
    { action: base, connection: calendar },
    {
      action: {
        ...base,
        id: 'two',
        kind: 'email.search',
        connectionId: mail.id,
        receipt: { detail: { messages: [{ subject: 'Dinner invite' }] } },
      },
      connection: mail,
    },
    {
      action: {
        ...base,
        id: 'three',
        kind: 'email.read',
        connectionId: mail.id,
        receipt: { detail: { message: { subject: 'Menu' } } },
      },
      connection: mail,
    },
  ];
  const group = projectActionGroup(rows);
  expect(group?.label).toBe('Checked your calendar, Checked your mail, Read a message');
  expect(group?.sources.map((source) => source.connection_id)).toEqual([
    calendar.id,
    mail.id,
    mail.id,
  ]);
  expect(JSON.stringify(group)).not.toMatch(BACKEND_VOCABULARY);
  expect(projectCards(base, calendar)[0]?.facts).toHaveLength(2);
});
test('source content cannot smuggle backend labels or credential URLs', () => {
  expect(plainText('calendar.list with canonical_payload', 'Event')).toBe('Event');
  expect(safeUrl('https://user:password@example.com')).toBeUndefined();
  expect(safeUrl('javascript:alert(1)')).toBeUndefined();
  expect(safeUrl('https://example.com/menu?token=private')).toBe('https://example.com/menu');
});
test('agent identity includes personalization and stays within the existing 250-token counter', () => {
  for (const template of AGENT_TEMPLATES.templates) {
    const text = agentIdentity(template.agent);
    expect(text).toContain(template.agent.name);
    expect(text).toContain(template.agent.tone);
    expect(text).toContain(template.agent.standing_instruction);
    expect(estimateTokens(text)).toBeLessThanOrEqual(250);
  }
});

test('the mailbox a message would leave from is read off the connection, or left out', () => {
  expect(senderAddress({ kind: 'mail', mail: { from: 'jo@example.test' } })).toBe(
    'jo@example.test',
  );
  expect(senderAddress({ from: ' jo@example.test ' })).toBe('jo@example.test');
  // An operator-configured mailbox keeps its address in the environment.
  for (const unknown of [{}, null, undefined, { kind: 'mail', mail: {} }, { from: '   ' }])
    expect(senderAddress(unknown)).toBeNull();
  // Anything that would not survive being shown verbatim is left out instead.
  expect(senderAddress({ from: 'Bearer sk-abcdefghijkl' })).toBeNull();
  expect(senderAddress({ from: { address: 'jo@example.test' } })).toBeNull();
});

test('a permission to send shows the mailbox it leaves from above the recipient', () => {
  const send: ActionRow = {
    ...base,
    kind: 'email.send',
    effectClass: 'write_external',
    connectionId: 'mail-connection',
    canonicalPayload: { to: 'support@acme.test', subject: 'Refund', body: 'Please refund me.' },
    receipt: null,
    status: 'needs_approval',
  };
  const mailbox = { id: 'mail-connection', label: 'Mail', provider: 'imap' };
  const shown = projectPermission({
    id: 'apr_one',
    version: 'v1',
    action: send,
    connection: { ...mailbox, sender: 'jo@example.test' },
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  // The queue is oldest first, so the card says when it was asked.
  expect(shown.created_at).toBe('2026-09-24T08:00:00.000Z');
  expect(shown.preview?.facts.slice(0, 2)).toEqual([
    { label: 'From', value: 'jo@example.test' },
    { label: 'To', value: 'support@acme.test' },
  ]);
  // Without a known mailbox the card is exactly what it was before.
  const withoutSender = projectPermission({
    id: 'apr_one',
    version: 'v1',
    action: send,
    connection: mailbox,
    reasons: ['This change needs your permission before it happens.'],
    canAlways: true,
    requestedAt: new Date('2026-09-24T08:00:00.000Z'),
  });
  expect(withoutSender.preview?.facts.map((fact) => fact.label)).toEqual([
    'To',
    'Subject',
    'Message',
  ]);
  expect(JSON.stringify(shown)).not.toMatch(BACKEND_VOCABULARY);
});

test('a decided permission says which of the three choices was taken', () => {
  const at = new Date('2026-09-24T09:00:00.000Z');
  const decided = (decision: string, ruleSaved: boolean) =>
    projectPermissionDecision({ approvalId: 'apr_one', decision, ruleSaved, at });
  expect(decided('approved', false)).toEqual({
    kind: 'permission',
    id: 'apr_one',
    outcome: 'allow_once',
    answer: null,
    decided_at: '2026-09-24T09:00:00.000Z',
  });
  expect(decided('approved', true).outcome).toBe('always');
  expect(decided('denied', false).outcome).toBe('deny');
});

test('a closed question is answered with the chosen text, or withdrawn with none', () => {
  const at = new Date('2026-09-24T09:00:00.000Z');
  expect(
    projectQuestionDecision({ questionId: 'q_one', state: 'answered', answer: 'Cook at home', at }),
  ).toEqual({
    kind: 'question',
    id: 'q_one',
    outcome: 'answered',
    answer: 'Cook at home',
    decided_at: '2026-09-24T09:00:00.000Z',
  });
  const withdrawn = projectQuestionDecision({
    questionId: 'q_one',
    state: 'withdrawn',
    answer: 'ignored',
    at,
  });
  expect([withdrawn.outcome, withdrawn.answer]).toEqual(['withdrawn', null]);
});

test('a permission a later message made stale reads as replaced, not as a refusal', () => {
  expect(
    projectPermissionDecision({
      approvalId: 'apr_one',
      decision: 'denied',
      ruleSaved: false,
      note: SUPERSEDED_NOTE,
      at: new Date('2026-09-25T09:00:00.000Z'),
    }).outcome,
  ).toBe('replaced');
});

test('a draft card offers sending only while its draft can still be sent', () => {
  const mail = { id: 'mail-connection', label: 'My mail', provider: 'imap' };
  const draft: ActionRow = {
    ...base,
    id: 'act_draft',
    connectionId: mail.id,
    kind: 'email.draft',
    effectClass: 'write_reversible',
    canonicalPayload: { to: 'alex@example.test', subject: 'Dinner', body: 'At seven?' },
    receipt: { detail: {} },
  };
  const action = (status?: Parameters<typeof projectCards>[2]) =>
    projectCards(draft, mail, status)[0]?.primary_action ?? null;
  const send = { kind: 'send' as const, label: 'Review and send', handle: 'act_draft' };
  expect(action('draft')).toEqual(send);
  // A send the person refused leaves the draft theirs to send again.
  expect(action('denied')).toEqual(send);
  for (const status of ['awaiting_permission', 'sent', 'discarded', undefined] as const)
    expect(action(status)).toBeNull();
  // A draft that cannot be shown in full cannot be reviewed, so it is never offered.
  const hidden = {
    ...draft,
    canonicalPayload: { to: 'alex@example.test', body: 'x'.repeat(200_001) },
  };
  expect(projectCards(hidden, mail, 'draft')[0]?.primary_action ?? null).toBeNull();
  // Other actions keep their own primary action.
  expect(projectCards(base, mail, 'draft')[0]?.primary_action ?? null).toBeNull();
});
