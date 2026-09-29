/**
 * The "Waiting on" section speaks in counts the service returned: the money
 * owed and how many replies are awaited. A part whose count is zero is not
 * said, and with nothing behind it the section says nothing at all.
 */
import { expect, test } from 'bun:test';
import type { WaitingOn, WaitingOnEntry } from '../experience/types.ts';
import { entryDetail, mailPlan, waitingOnLine } from './WaitingOnSection.tsx';

const view = (owed: number, replies: number): WaitingOn => ({
  currency: 'GBP',
  owed_minor: owed,
  owed: [],
  replies: Array.from({ length: replies }, (_, index) => entry({ id: `awr_${index}` })),
  top: [],
  scan: { space_id: null, connected: true, status: 'done', finished_at: null, stale: false },
});

function entry(over: Partial<WaitingOnEntry> = {}): WaitingOnEntry {
  return {
    kind: 'reply',
    id: 'awr_1',
    who: 'Deverill IT',
    what: 'Could you send a quote?',
    amount_minor: null,
    currency: null,
    due_at: null,
    sent_at: null,
    status: 'found',
    job_id: null,
    ...over,
  };
}

test('money and replies together', () => {
  expect(waitingOnLine(view(53_450, 3))).toBe('Waiting on: £534.50 and 3 replies');
});

test('one reply is one reply', () => {
  expect(waitingOnLine(view(0, 1))).toBe('Waiting on: 1 reply');
});

test('money alone', () => {
  expect(waitingOnLine(view(1_240_000, 0))).toBe('Waiting on: £12,400');
});

test('nothing waited on says nothing', () => {
  expect(waitingOnLine(view(0, 0))).toBeNull();
});

test('an owed row shows its figure; a reply row how long it has waited', () => {
  const now = Date.parse('2026-09-18T09:00:00.000Z');
  expect(entryDetail(entry({ kind: 'owed', amount_minor: 53_450, currency: 'GBP' }), now)).toBe(
    '£534.50',
  );
  expect(entryDetail(entry({ sent_at: '2026-09-12T09:00:00.000Z' }), now)).toBe('Sent 6 days ago');
  expect(entryDetail(entry({ kind: 'owed' }), now)).toBeNull();
});

test('the mail is read once: on a first run, or when the last read looked for no replies', () => {
  const scan = (over: Partial<WaitingOn['scan']>): WaitingOn['scan'] => ({
    space_id: 'sp_01J0000000000000000000000A',
    connected: true,
    status: 'done',
    finished_at: '2026-09-18T09:00:00.000Z',
    stale: false,
    ...over,
  });
  expect(mailPlan(scan({ status: 'none', finished_at: null }))).toBe('start');
  expect(mailPlan(scan({ stale: true }))).toBe('start');
  expect(mailPlan(scan({ status: 'running' }))).toBe('wait');
  // A finished read that looked for replies, or one that failed, is not repeated.
  expect(mailPlan(scan({}))).toBeNull();
  expect(mailPlan(scan({ status: 'failed' }))).toBeNull();
  expect(mailPlan(scan({ connected: false, status: 'none' }))).toBeNull();
});
