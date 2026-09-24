import { expect, test } from 'bun:test';
import { followUpRefusal } from './chase-scope.ts';
import { ruleView } from './rules.ts';

/** The first message the person allowed, once. */
const approved = {
  to: 'orders@thornfieldprint.example',
  subject: 'Refund for order TP-5521',
  body: 'Your payment of GBP 534.50 was to be refunded within 5 working days. Please confirm the date.',
};

const followUp = (over: Record<string, unknown> = {}) => ({
  to: 'orders@thornfieldprint.example',
  subject: 'Re: Refund for order TP-5521',
  body: 'Following up on the GBP 534.50 refund. Please confirm the date it will be paid.',
  ...over,
});

test('a follow-up to the same person, in the same thread, saying nothing new is covered', () => {
  expect(followUpRefusal(approved, followUp())).toBeNull();
  // The address is compared as an address, and a one-item list is the address.
  expect(
    followUpRefusal(approved, followUp({ to: ['Orders@ThornfieldPrint.example'] })),
  ).toBeNull();
  // The same amount written another way is the same amount.
  expect(
    followUpRefusal(approved, followUp({ body: 'Still waiting on £534.50. Please confirm.' })),
  ).toBeNull();
});

test('a new recipient asks again', () => {
  expect(followUpRefusal(approved, followUp({ to: 'complaints@thornfieldprint.example' }))).toBe(
    'new_recipient',
  );
  expect(
    followUpRefusal(
      approved,
      followUp({ to: ['orders@thornfieldprint.example', 'manager@thornfieldprint.example'] }),
    ),
  ).toBe('new_recipient');
});

test('anyone copied in asks again', () => {
  expect(followUpRefusal(approved, followUp({ cc: 'me@example.test' }))).toBe('copied_recipient');
  expect(followUpRefusal(approved, followUp({ bcc: ['me@example.test'] }))).toBe(
    'copied_recipient',
  );
});

test('a new thread asks again', () => {
  expect(followUpRefusal(approved, followUp({ subject: 'Complaint about order TP-5521' }))).toBe(
    'new_thread',
  );
  expect(followUpRefusal(approved, followUp({ subject: 'Fwd: Refund for order TP-5521' }))).toBe(
    'new_thread',
  );
});

test('anything beyond a message, such as an attachment, asks again', () => {
  expect(
    followUpRefusal(approved, followUp({ attachments: ['art_01J0000000000000000000000A'] })),
  ).toBe('unexpected_field');
});

test('an amount the person did not approve asks again', () => {
  expect(
    followUpRefusal(approved, followUp({ body: 'Please refund GBP 600.00 including costs.' })),
  ).toBe('new_amount');
  expect(
    followUpRefusal(approved, followUp({ body: 'I would accept $50 as a goodwill gesture.' })),
  ).toBe('new_amount');
});

test('wording that commits the person asks again', () => {
  for (const body of [
    'I agree to your offer.',
    'We accept a partial refund.',
    'I will pay the remaining balance.',
    'Please treat this as full and final settlement.',
    'I authorise you to charge my card.',
    'I waive any further claim.',
  ])
    expect(followUpRefusal(approved, followUp({ body }))).toBe('commitment');
});

test('the scope reads, in the person’s rules, as a chase’s follow-ups', () => {
  const view = ruleView({
    id: 'rule_act_01J0000000000000000000000A',
    tool_kind: 'email.send',
    connection_id: 'conn_01J0000000000000000000000B',
    recipient_class: 'orders@thornfieldprint.example',
    count_cap: 3,
    expires_at: '2026-10-24T09:00:00.000Z',
    reconsent_after_days: 30,
    used: 1,
    created_at: '2026-09-24T09:00:00.000Z',
    job_id: 'job_01J0000000000000000000000C',
  });
  expect(view.text).toBe(
    'Follow-ups in one chase to orders@thornfieldprint.example, up to 3, until 24/10/2026.',
  );
  expect(view.used).toBe(1);
});
