import { expect, test } from 'bun:test';
import { CHASE_NUDGES, chaseFollowUp, followUpRefusal } from './chase-scope.ts';
import { ruleView } from './rules.ts';

/** The first message the person allowed, once. */
const approved = {
  to: 'orders@thornfieldprint.example',
  subject: 'Refund for order TP-5521',
  body: 'Your payment of GBP 534.50 was to be refunded within 5 working days. Please confirm the date.',
};

test('each covered follow-up is a fixed line from the service, then the approved message', () => {
  for (let n = 1; n <= CHASE_NUDGES.length; n++) {
    const follow = chaseFollowUp(approved, n);
    expect(follow.subject).toBe('Re: Refund for order TP-5521');
    expect(follow.body).toBe(`${CHASE_NUDGES[n - 1]}\n\n${approved.body}`);
    expect(followUpRefusal(approved, follow)).toBeNull();
  }
  // The address is compared as an address, and a one-item list is the address.
  expect(
    followUpRefusal(approved, {
      ...chaseFollowUp(approved, 1),
      to: ['Orders@ThornfieldPrint.example'],
    }),
  ).toBeNull();
  // A subject that was already a reply keeps one `Re:`.
  const reply = { ...approved, subject: 'Re: Refund for order TP-5521' };
  expect(chaseFollowUp(reply, 1).subject).toBe('Re: Refund for order TP-5521');
  expect(() => chaseFollowUp(approved, CHASE_NUDGES.length + 1)).toThrow();
});

test('any other words ask again', () => {
  const follow = chaseFollowUp(approved, 1);
  for (const body of [
    // A line the model wrote itself.
    `Just checking in on this.\n\n${approved.body}`,
    // The approved message, changed in the smallest way.
    `${CHASE_NUDGES[0]}\n\n${approved.body.replace('534.50', '600.00')}`,
    // Something added after it.
    `${follow.body}\n\nI agree to your offer.`,
    // The approved message alone, which is the first message again.
    approved.body,
  ])
    expect(followUpRefusal(approved, { ...follow, body })).toBe('not_the_approved_message');
});

test('a new recipient asks again', () => {
  const follow = chaseFollowUp(approved, 1);
  expect(followUpRefusal(approved, { ...follow, to: 'complaints@thornfieldprint.example' })).toBe(
    'new_recipient',
  );
  expect(
    followUpRefusal(approved, {
      ...follow,
      to: ['orders@thornfieldprint.example', 'manager@thornfieldprint.example'],
    }),
  ).toBe('new_recipient');
});

test('anyone copied in asks again', () => {
  const follow = chaseFollowUp(approved, 1);
  expect(followUpRefusal(approved, { ...follow, cc: 'me@example.test' })).toBe('copied_recipient');
  expect(followUpRefusal(approved, { ...follow, bcc: ['me@example.test'] })).toBe(
    'copied_recipient',
  );
});

test('a new thread asks again', () => {
  const follow = chaseFollowUp(approved, 1);
  for (const subject of [
    'Complaint about order TP-5521',
    'Fwd: Refund for order TP-5521',
    approved.subject,
  ])
    expect(followUpRefusal(approved, { ...follow, subject })).toBe('new_thread');
});

test('anything beyond a message, such as an attachment, asks again', () => {
  expect(
    followUpRefusal(approved, {
      ...chaseFollowUp(approved, 1),
      attachments: ['art_01J0000000000000000000000A'],
    }),
  ).toBe('unexpected_field');
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
