/**
 * What this screen must never get wrong.
 *
 * The figures at the top are counts of the rows under them, and pressing one
 * filters to exactly those rows. The highlight in a message is drawn only where
 * the characters at the span are the quote the item carries — a span that has
 * drifted shows the message with nothing highlighted, never the wrong sentence
 * under a mark. And a person with nothing found yet is told what will appear
 * and given the one thing to press.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceText, holds, MessageCard, segment } from './evidence.tsx';
import { type Filter, inOrder, matches, money, whenDue } from './format.ts';
import { EmptyLedger, LedgerRow } from './Ledger.tsx';
import { TotalsRow, totalsOf } from './Totals.tsx';
import type { Company, CompanyMapTotals, LedgerItem, LedgerMessage } from './types.ts';

const NOW = Date.parse('2026-09-18T09:00:00.000Z');

const TEXT = [
  'Hello Jamie,',
  '',
  'Your refund of £64.00 will be back with you within 5 working days.',
  '',
  'Tern & Co Customer Care',
].join('\n');

const QUOTE = 'Your refund of £64.00 will be back with you within 5 working days.';
const START = TEXT.indexOf(QUOTE);

const MESSAGE: LedgerMessage = {
  id: '<tern.example>',
  subject: 'Your return has been received',
  from: 'Tern & Co <help@ternandco.example>',
  received_at: '2026-09-01T10:05:00.000Z',
  text: TEXT,
};

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

const item = (over: Partial<LedgerItem> = {}): LedgerItem => ({
  id: 'li_01M2000000000000000000000A',
  space_id: COMPANY.space_id,
  principal_id: 'own_01M2000000000000000000000A',
  company_id: COMPANY.id,
  kind: 'refund_owed',
  direction: 'owed_to_you',
  amount_minor: 6400,
  currency: 'GBP',
  due_at: '2026-09-08T12:00:00.000Z',
  status: 'found',
  confidence: 'high',
  evidence: [{ message_id: MESSAGE.id, quote: QUOTE, start: START, end: START + QUOTE.length }],
  suggested_playbook: 'refund-owed',
  job_id: null,
  summary: 'Refund for the returned order TC-88412',
  ...over,
});

const TOTALS: CompanyMapTotals = {
  owed_to_you_minor: 247_600,
  monthly_spend_minor: 28_359,
  renewals_next_30d: 2,
  price_rises: 3,
  trials_ending: 1,
  data_holders: 2,
  promises_in_force: 4,
  promises_lapsed: 1,
};

/* ---------- the totals ---------- */

test('every total is drawn with its figure and the plain word for it', () => {
  const html = renderToStaticMarkup(
    <TotalsRow
      totals={TOTALS}
      companies={9}
      currency="GBP"
      filter={null}
      onFilter={() => undefined}
    />,
  );
  for (const text of [
    'Companies found',
    'You pay a month',
    'Owed to you',
    'Renews in 30 days',
    'Price rises',
    'Trial ending',
    'Holding your data',
    'Promises in force',
    'Promises lapsed',
  ])
    expect(html).toContain(text);
  // Money reads the way a person writes it, and a whole figure loses its pence.
  expect(html).toContain('£2,476');
  expect(html).toContain('£283.59');
  expect(html).not.toContain('£2,476.00');
  // Nine of them, and the count says so.
  expect(html).toContain('>9<');
});

test('the promise figures are not drawn when the service does not serve them', () => {
  const { promises_in_force, promises_lapsed, ...six } = TOTALS;
  expect(promises_in_force).toBe(4);
  expect(promises_lapsed).toBe(1);
  const html = renderToStaticMarkup(
    <TotalsRow
      totals={six}
      companies={9}
      currency="GBP"
      filter={null}
      onFilter={() => undefined}
    />,
  );
  expect(html).not.toContain('Promises in force');
  expect(html).not.toContain('Promises lapsed');
  expect(html).toContain('Holding your data');
});

test('the pressed figure says so, and only that one', () => {
  const filter: Filter = { kind: 'direction', value: 'owed_to_you' };
  const html = renderToStaticMarkup(
    <TotalsRow
      totals={TOTALS}
      companies={9}
      currency="GBP"
      filter={filter}
      onFilter={() => undefined}
    />,
  );
  expect(html.split('aria-pressed="true"')).toHaveLength(2);
  expect(html).toContain('data-on="true"');
});

test('a total filters to exactly the rows it was counted from', () => {
  const rows = [
    item({ id: 'li_a', direction: 'owed_to_you' }),
    item({ id: 'li_b', direction: 'you_pay', kind: 'subscription' }),
    item({ id: 'li_c', kind: 'price_rise', direction: 'you_pay' }),
    item({ id: 'li_d', kind: 'promise', direction: 'info', due_at: '2026-09-01T12:00:00.000Z' }),
    item({ id: 'li_e', kind: 'promise', direction: 'info', due_at: '2026-12-01T12:00:00.000Z' }),
  ];
  const under = (filter: Filter) =>
    rows.filter((row) => matches(row, filter, NOW)).map((row) => row.id);
  expect(under({ kind: 'direction', value: 'owed_to_you' })).toEqual(['li_a']);
  expect(under({ kind: 'item', value: 'price_rise' })).toEqual(['li_c']);
  // A promise whose date has passed is lapsed; one with time left is in force.
  expect(under({ kind: 'promise', lapsed: true })).toEqual(['li_d']);
  expect(under({ kind: 'promise', lapsed: false })).toEqual(['li_e']);
  expect(under(null)).toHaveLength(5);
});

/**
 * The promise this screen makes is that a figure IS the rows under it. That
 * holds only while every cell's filter selects exactly what its figure counted,
 * so this pins each cell against a map built to break the ones that are easy to
 * get right by accident: a renewal outside the window, and a settled row of
 * every counted kind.
 */
test('every counted figure selects exactly the rows it counted, and nothing else', () => {
  const soon = '2026-10-10T12:00:00.000Z'; // 22 days out — inside the window
  const far = '2026-12-20T12:00:00.000Z'; // 93 days out — outside it
  const rows = [
    item({ id: 'li_renew_soon', kind: 'renewal', direction: 'you_pay', due_at: soon }),
    item({ id: 'li_renew_far', kind: 'renewal', direction: 'you_pay', due_at: far }),
    item({ id: 'li_rise', kind: 'price_rise', direction: 'you_pay', due_at: soon }),
    item({ id: 'li_rise_done', kind: 'price_rise', direction: 'you_pay', status: 'settled' }),
    item({ id: 'li_trial', kind: 'trial_ending', direction: 'you_pay', due_at: soon }),
    item({ id: 'li_data', kind: 'data_held', direction: 'info', amount_minor: null }),
    item({ id: 'li_owed', direction: 'owed_to_you', amount_minor: 6400 }),
    item({ id: 'li_owed_done', direction: 'owed_to_you', amount_minor: 9900, status: 'settled' }),
    item({ id: 'li_promise', kind: 'promise', direction: 'info', due_at: far }),
    item({
      id: 'li_promise_done',
      kind: 'promise',
      direction: 'info',
      due_at: far,
      status: 'settled',
    }),
  ];
  // The totals a service would serve for exactly these rows.
  const totals: CompanyMapTotals = {
    owed_to_you_minor: 6400,
    monthly_spend_minor: 0,
    renewals_next_30d: 1,
    price_rises: 1,
    trials_ending: 1,
    data_holders: 1,
    promises_in_force: 1,
    promises_lapsed: 0,
  };
  const cells = totalsOf(totals, 1, 'GBP');
  const under = (filter: Filter) => rows.filter((row) => matches(row, filter, NOW));
  const cell = (key: string) => {
    const found = cells.find((entry) => entry.key === key);
    if (!found) throw new Error(`no ${key} cell`);
    return found;
  };

  // Every cell whose figure is a count of rows selects exactly that many.
  for (const key of ['renewals', 'rises', 'trials', 'data', 'promises', 'lapsed'])
    expect({ key, rows: under(cell(key).filter).length }).toEqual({
      key,
      rows: Number(cell(key).figure),
    });

  // And the right ones: the renewal outside the window is not among them.
  expect(under(cell('renewals').filter).map((row) => row.id)).toEqual(['li_renew_soon']);

  // A settled row is off every counted figure, of every kind.
  for (const key of ['rises', 'owed', 'promises', 'lapsed'])
    expect(under(cell(key).filter).map((row) => row.id)).not.toContain(
      key === 'owed' ? 'li_owed_done' : `li_${key === 'rises' ? 'rise' : 'promise'}_done`,
    );

  // The money figure is the sum of the rows it selects, to the penny.
  const owed = under(cell('owed').filter).reduce((sum, row) => sum + (row.amount_minor ?? 0), 0);
  expect(owed).toBe(totals.owed_to_you_minor);

  // But the whole ledger still shows the settled rows, faded rather than gone.
  expect(under(null)).toHaveLength(rows.length);
});

/* ---------- the evidence ---------- */

test('a span that holds is the highlight, and it is the quote', () => {
  const html = renderToStaticMarkup(<EvidenceText text={TEXT} spans={item().evidence} />);
  expect(html).toContain(`<mark class="evidence-mark">${QUOTE}</mark>`);
  // The surrounding message is still all there, on both sides of the mark.
  expect(html).toContain('Hello Jamie,');
  expect(html).toContain('Tern &amp; Co Customer Care');
});

test('a span that does not match renders no highlight rather than the wrong words', () => {
  const drifted = [
    { message_id: MESSAGE.id, quote: QUOTE, start: START + 7, end: START + 7 + QUOTE.length },
  ];
  expect(holds(TEXT, drifted[0] as { quote: string; start: number; end: number })).toBe(false);
  const html = renderToStaticMarkup(<EvidenceText text={TEXT} spans={drifted} />);
  expect(html).not.toContain('<mark');
  // Every word of the message is still shown, unshifted.
  expect(html).toContain(QUOTE);
  expect(html).toContain('Hello Jamie,');
});

test('a span of the wrong length, off the end, or on an empty quote never marks anything', () => {
  const cases = [
    { quote: QUOTE, start: START, end: START + QUOTE.length - 1 },
    { quote: QUOTE, start: START, end: TEXT.length + 40 },
    { quote: '', start: 0, end: 0 },
    { quote: QUOTE, start: -1, end: START + QUOTE.length },
    { quote: QUOTE, start: Number.NaN, end: START + QUOTE.length },
  ];
  for (const span of cases) {
    expect(holds(TEXT, span)).toBe(false);
    const pieces = segment(TEXT, [{ message_id: MESSAGE.id, ...span }]);
    expect(pieces.some((piece) => piece.quoted)).toBe(false);
    // The whole message survives the rejection, character for character.
    expect(pieces.map((piece) => piece.text).join('')).toBe(TEXT);
  }
});

test('the pieces of a marked message put the message back together exactly', () => {
  const pieces = segment(TEXT, item().evidence);
  expect(pieces.map((piece) => piece.text).join('')).toBe(TEXT);
  expect(pieces.filter((piece) => piece.quoted).map((piece) => piece.text)).toEqual([QUOTE]);
});

test('the message is shown as a message: who sent it, what it was called, and when', () => {
  const html = renderToStaticMarkup(<MessageCard message={MESSAGE} spans={item().evidence} />);
  expect(html).toContain('Your return has been received');
  expect(html).toContain('help@ternandco.example');
  expect(html).toContain('1 September 2026');
  expect(html).toContain('<mark');
});

/* ---------- a row ---------- */

test('a row says the company, the words, the figure, the date and the state', () => {
  const html = renderToStaticMarkup(
    <LedgerRow item={item()} company={COMPANY} now={NOW} open={false} onToggle={() => undefined} />,
  );
  expect(html).toContain('Tern &amp; Co');
  expect(html).toContain('Refund for the returned order TC-88412');
  expect(html).toContain('£64');
  expect(html).toContain('owed to you');
  expect(html).toContain('8 Sep');
  expect(html).toContain('10 days ago');
  // Past its date and not settled: the row says so rather than naming its kind.
  expect(html).toContain('Overdue');
  // Confidence is there for anyone who wants it, and quiet for everyone else.
  expect(html).toContain('Read with high confidence');
  expect(html).toContain('data-level="high"');
});

test('a settled row keeps its figure and stops claiming to need anything', () => {
  const html = renderToStaticMarkup(
    <LedgerRow
      item={item({ status: 'settled' })}
      company={COMPANY}
      now={NOW}
      open={false}
      onToggle={() => undefined}
    />,
  );
  expect(html).toContain('Settled');
  expect(html).not.toContain('Overdue');
  expect(html).toContain('data-faded="true"');
});

test('the ledger reads in the order the work needs doing', () => {
  const overdue = item({ id: 'li_overdue', due_at: '2026-09-08T12:00:00.000Z' });
  const soon = item({ id: 'li_soon', due_at: '2026-10-08T12:00:00.000Z' });
  const undated = item({ id: 'li_undated', due_at: null });
  const done = item({ id: 'li_done', status: 'settled', due_at: '2026-09-02T12:00:00.000Z' });
  expect(inOrder([done, undated, soon, overdue], NOW).map((row) => row.id)).toEqual([
    'li_overdue',
    'li_soon',
    'li_undated',
    'li_done',
  ]);
});

/* ---------- nothing found yet ---------- */

test('an empty ledger explains what will appear and offers the one thing to press', () => {
  const html = renderToStaticMarkup(
    <EmptyLedger scanning={false} progress={null} error={null} onScan={() => undefined} />,
  );
  expect(html).toContain('No companies found yet');
  expect(html).toContain('what renews next');
  expect(html).toContain('opens the sentence in the email it came from');
  // Nothing on this screen assumes one kind of person behind the mailbox.
  expect(html).not.toContain('your life');
  expect(html).not.toContain('personal');
  expect(html).toContain('Scan the inbox');
  expect(html).not.toContain('messages read');
});

test('a scan in progress counts out loud and takes the button away', () => {
  const html = renderToStaticMarkup(
    <EmptyLedger
      scanning
      progress={{ status: 'running', messages_seen: 1204, items_found: 7 }}
      error={null}
      onScan={() => undefined}
    />,
  );
  expect(html).toContain('1,204 messages read');
  expect(html).toContain('7 found so far');
  expect(html).toContain('role="status"');
  expect(html).not.toContain('Scan the inbox');
});

test('a scan that has started but said nothing yet still says it is going', () => {
  const html = renderToStaticMarkup(
    <EmptyLedger scanning progress={null} error={null} onScan={() => undefined} />,
  );
  expect(html).toContain('Starting');
  expect(html).not.toContain('Scan the inbox');
});

/* ---------- the words on a figure ---------- */

test('money and dates are written the way a person writes them', () => {
  expect(money(6400, 'GBP')).toBe('£64');
  expect(money(28_359, 'GBP')).toBe('£283.59');
  expect(money(0, 'GBP')).toBe('£0');
  expect(whenDue('2026-09-19T09:00:00.000Z', NOW)).toBe('tomorrow');
  expect(whenDue('2026-09-18T09:00:00.000Z', NOW)).toBe('today');
  expect(whenDue('2026-09-17T09:00:00.000Z', NOW)).toBe('yesterday');
  expect(whenDue('2026-09-25T09:00:00.000Z', NOW)).toBe('in 7 days');
  expect(whenDue('2026-09-09T09:00:00.000Z', NOW)).toBe('9 days ago');
});
