/**
 * The case panel's steps are read from what the service returned. A step
 * with nothing behind it is not drawn, and a step is done only when the thing
 * it names happened.
 */
import { expect, test } from 'bun:test';
import { emptyTranscript, type Transcript, type TranscriptTurn } from '../experience/reduce.ts';
import type {
  Company,
  Draft,
  LedgerItem,
  Permission,
  Receipt,
  ResultCard,
} from '../experience/types.ts';
import { type Case, caseSteps } from './CasePanel.tsx';

const COMPANY: Company = {
  id: 'co_01M2000000000000000000000A',
  space_id: 'sp_01M2000000000000000000000A',
  name: 'Tern & Co',
  domain: 'ternandco.example',
  monthly_spend_minor: null,
  currency: null,
  first_seen_at: '2026-06-15T08:30:00.000Z',
  last_seen_at: '2026-09-01T10:05:00.000Z',
  message_count: 9,
};

const ITEM: LedgerItem = {
  id: 'li_01M2000000000000000000000A',
  space_id: COMPANY.space_id,
  principal_id: 'own_01M2000000000000000000000A',
  company_id: COMPANY.id,
  kind: 'refund_owed',
  direction: 'owed_to_you',
  amount_minor: 6400,
  currency: 'GBP',
  due_at: '2026-09-08T12:00:00.000Z',
  status: 'handling',
  confidence: 'high',
  evidence: [{ message_id: '<m>', quote: 'refund', start: 0, end: 6 }],
  suggested_playbook: 'refund-owed',
  job_id: 'job_01M2000000000000000000000A',
  summary: 'Refund for the returned order',
};

const DRAFT: Draft = {
  id: 'draft_1',
  recipient: 'Customer Care <help@ternandco.example>',
  channel: 'email',
  body: 'Hello',
  subject: 'The refund',
  connection_id: 'conn_1',
  status: 'awaiting_permission',
};

const PERMISSION: Permission = {
  id: 'permission_1',
  conversation_id: ITEM.job_id ?? '',
  what: 'Send this draft',
  why: ['This is the first message to this company. You are asked once.'],
  options: ['allow_once', 'deny'],
  version: 'v_1',
  preview: null,
  draft: DRAFT,
};

const RECEIPT: Receipt = {
  id: 'receipt_1',
  what: 'Sent a message to Customer Care',
  where: 'Mail',
  when: '2026-09-18T14:11:00.000Z',
};

function transcript(blocks: TranscriptTurn['blocks'], drafts: Draft[] = []): Transcript {
  const base = emptyTranscript();
  const turn = { id: 't1', blocks } as unknown as TranscriptTurn;
  return {
    ...base,
    turns: [turn],
    drafts: Object.fromEntries(drafts.map((draft) => [draft.id, draft])),
  };
}

const found: Case = { item: ITEM, company: COMPANY, detail: null };
const keys = (steps: ReturnType<typeof caseSteps>) =>
  steps.map((step) => `${step.key}:${step.state}`);

test('an item with nothing drafted yet shows only what exists and what ends it', () => {
  expect(keys(caseSteps(found, transcript([])))).toEqual(['found:done', 'settled:later']);
});

test('a draft waiting on the person puts the decision now and the send after it', () => {
  const steps = caseSteps(
    found,
    transcript([{ type: 'permission', permission: PERMISSION, decided: null }], [DRAFT]),
  );
  expect(keys(steps)).toEqual([
    'found:done',
    'draft:done',
    'ok:now',
    'sent:later',
    'watch:later',
    'settled:later',
  ]);
});

test('allowed and sent: the send is done and the thread is being watched', () => {
  const steps = caseSteps(
    found,
    transcript(
      [
        { type: 'permission', permission: PERMISSION, decided: 'allow_once' },
        { type: 'receipt', receipt: RECEIPT, reversed: false },
      ],
      [{ ...DRAFT, status: 'sent' }],
    ),
  );
  expect(steps.find((step) => step.key === 'ok')?.label).toBe('Allowed once');
  expect(keys(steps)).toContain('sent:done');
  expect(keys(steps)).toContain('watch:now');
});

test('a denied send is never shown as allowed', () => {
  const steps = caseSteps(
    found,
    transcript([{ type: 'permission', permission: PERMISSION, decided: 'deny' }], [DRAFT]),
  );
  expect(steps.find((step) => step.key === 'ok')?.state).toBe('now');
  expect(keys(steps)).toContain('sent:later');
});

test('a settled item settles the case', () => {
  const steps = caseSteps(
    { ...found, item: { ...ITEM, status: 'settled' } },
    transcript([{ type: 'receipt', receipt: RECEIPT, reversed: false }]),
  );
  expect(keys(steps)).toContain('settled:done');
  expect(keys(steps)).toContain('watch:done');
});

test('a draft counts as written from the moment its card is in the chat', () => {
  const card = {
    id: 'draft_1',
    title: 'The refund',
    meta: 'Email',
    facts: [],
    primary_action: { label: 'Review and send', kind: 'send', handle: 'draft_1' },
    secondary_actions: [],
    source_connection: null,
  } as ResultCard;
  const steps = caseSteps(found, transcript([{ type: 'card', card }]));
  expect(keys(steps)).toEqual([
    'found:done',
    'draft:done',
    'sent:later',
    'watch:later',
    'settled:later',
  ]);
});

test('a permission carrying the draft is enough to call it written', () => {
  const steps = caseSteps(
    found,
    transcript([{ type: 'permission', permission: PERMISSION, decided: null }]),
  );
  expect(steps.find((step) => step.key === 'draft')).toEqual({
    key: 'draft',
    label: 'Draft written',
    sub: 'The refund',
    state: 'done',
  });
});
