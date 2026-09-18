import { expect, test } from 'bun:test';
import { LAUNCH_PLAYBOOKS, type LedgerEvidence } from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import { admittedEvidence, formatAmount, PLAYBOOK_FOR_KIND, playbookFor } from './handle.ts';

test('an amount is written the way its own currency is written', () => {
  expect(formatAmount(4999, 'GBP')).toBe('49.99 GBP');
  expect(formatAmount(0, 'USD')).toBe('0.00 USD');
  // A hundredth of a yen does not exist, so 4999 yen is 4999 yen.
  expect(formatAmount(4999, 'JPY')).toBe('4999 JPY');
  expect(formatAmount(1200, 'KRW')).toBe('1200 KRW');
  // And a dinar is thousandths.
  expect(formatAmount(4999, 'KWD')).toBe('4.999 KWD');
  // Nothing to say is said as nothing, never as zero.
  expect(formatAmount(null, 'GBP')).toBeNull();
  expect(formatAmount(4999, null)).toBeNull();
});

test('a suggested playbook is honoured only when it is one that ships', () => {
  for (const playbook of LAUNCH_PLAYBOOKS)
    expect(playbookFor({ kind: 'refund_owed', suggested_playbook: playbook })).toBe(playbook);
  // Anything else falls back to the kind rather than being taken on trust.
  expect(playbookFor({ kind: 'price_rise', suggested_playbook: 'delete-my-data' })).toBe(
    'price-rise',
  );
  expect(playbookFor({ kind: 'invoice_unpaid', suggested_playbook: null })).toBe('unpaid-invoice');
});

test('every playbook a kind falls back to is one that actually ships', () => {
  for (const playbook of Object.values(PLAYBOOK_FOR_KIND))
    expect(LAUNCH_PLAYBOOKS as readonly string[]).toContain(playbook);
});

test('a kind with no playbook of its own is refused rather than approximated', () => {
  for (const kind of ['data_held', 'promise'] as const) {
    let caught: unknown;
    try {
      playbookFor({ kind, suggested_playbook: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('no_playbook');
  }
});

test('only the quotes that still sit where they claim to sit survive', () => {
  const quote = 'We will refund you within 5-7 working days.';
  const text = `Thanks for waiting. ${quote} Sorry for the delay.`;
  const at = text.indexOf(quote);
  const holds: LedgerEvidence = { message_id: 'one', quote, start: at, end: at + quote.length };
  // The same words, one character along: a person clicking this would be shown
  // the wrong run of text, so it is not admitted.
  const movedOn: LedgerEvidence = {
    ...holds,
    message_id: 'two',
    start: at + 1,
    end: at + 1 + quote.length,
  };
  const invented: LedgerEvidence = {
    message_id: 'three',
    quote: 'We will refund you today.',
    start: 0,
    end: 'We will refund you today.'.length,
  };
  expect(admittedEvidence(text, [holds, movedOn, invented])).toEqual([holds]);
  // A quote from some other message is not admitted just because it reads well.
  expect(admittedEvidence(text, [invented])).toEqual([]);
  expect(admittedEvidence('', [holds])).toEqual([]);
});
