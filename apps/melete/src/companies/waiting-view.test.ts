import { describe, expect, test } from 'bun:test';
import { type AwaitedReply, type CompanyMap, type LedgerItem, waitingOn } from '@melete/contracts';
import { waitingOnView } from './waiting-view.ts';

const SPACE = 'sp_01J0000000000000000000000A';
const OWNER = 'own_01J0000000000000000000000B';
const CO = 'co_01J0000000000000000000000C';

let serial = 0;
const id = (prefix: string) =>
  `${prefix}_01J00000000000000000000${String(++serial).padStart(3, '0')}`;

const owed = (over: Partial<LedgerItem> = {}): LedgerItem => ({
  id: id('li'),
  space_id: SPACE,
  principal_id: OWNER,
  company_id: CO,
  kind: 'refund_owed',
  direction: 'owed_to_you',
  amount_minor: 5000,
  currency: 'GBP',
  due_at: null,
  status: 'found',
  confidence: 'high',
  evidence: [{ message_id: '<m@x>', quote: 'We owe you', start: 0, end: 10 }],
  suggested_playbook: 'refund-owed',
  job_id: null,
  summary: 'Refund for the cancelled order',
  ...over,
});

const map = (items: LedgerItem[], owedMinor: number, currency = 'GBP'): CompanyMap => ({
  companies: [
    {
      id: CO,
      space_id: SPACE,
      name: 'Thornfield Print',
      domain: 'thornfieldprint.example',
      monthly_spend_minor: null,
      currency: null,
      first_seen_at: '2026-09-01T00:00:00.000Z',
      last_seen_at: '2026-09-01T00:00:00.000Z',
      message_count: 1,
    },
  ],
  items,
  totals: {
    owed_to_you_minor: owedMinor,
    monthly_spend_minor: 0,
    renewals_next_30d: 0,
    price_rises: 0,
    trials_ending: 0,
    data_holders: 0,
    promises_in_force: 0,
    promises_lapsed: 0,
  },
  currency,
});

const reply = (over: Partial<AwaitedReply> = {}): AwaitedReply => ({
  id: id('awr'),
  space_id: SPACE,
  principal_id: OWNER,
  message_id: '<s@x>',
  to: 'service@deverillit.example',
  to_name: 'Deverill IT',
  subject: 'Moving the server',
  sent_at: '2026-09-12T09:00:00.000Z',
  evidence: { message_id: '<s@x>', quote: 'Could you send a quote?', start: 0, end: 23 },
  status: 'found',
  job_id: null,
  ...over,
});

const scan = {
  space_id: 'sp_01J0000000000000000000000A',
  connected: true,
  status: 'done' as const,
  finished_at: '2026-09-18T09:00:00.000Z',
  stale: false,
};

describe('what the person is waiting on', () => {
  test('the owed figure is the company map’s own, and the replies are counted beside it', () => {
    const big = owed({ amount_minor: 53450 });
    const view = waitingOnView({
      maps: [map([big, owed({ direction: 'you_pay' })], 53450)],
      replies: [reply(), reply()],
      scan,
    });
    expect(waitingOn.parse(view)).toEqual(view);
    expect(view.owed_minor).toBe(53450);
    expect(view.currency).toBe('GBP');
    // Only what is owed to the person is on the owed list.
    expect(view.owed.map((entry) => entry.id)).toEqual([big.id]);
    expect(view.replies).toHaveLength(2);
    expect(view.owed[0]).toMatchObject({ who: 'Thornfield Print', what: big.summary });
    expect(view.replies[0]).toMatchObject({
      kind: 'reply',
      who: 'Deverill IT',
      what: 'Could you send a quote?',
      sent_at: '2026-09-12T09:00:00.000Z',
    });
  });

  test('the top three take turns between money and replies, largest and longest first', () => {
    const small = owed({ amount_minor: 1000 });
    const large = owed({ amount_minor: 90000 });
    const middle = owed({ amount_minor: 40000 });
    const oldest = reply({ sent_at: '2026-09-01T09:00:00.000Z' });
    const newer = reply({ sent_at: '2026-09-10T09:00:00.000Z' });
    const view = waitingOnView({
      maps: [map([small, large, middle], 131000)],
      replies: [oldest, newer],
      scan,
    });
    expect(view.top.map((entry) => entry.id)).toEqual([large.id, oldest.id, middle.id]);
  });

  test('something already being chased is listed but not offered again', () => {
    const chased = owed({ amount_minor: 90000, status: 'handling', job_id: id('job') });
    const open = owed({ amount_minor: 1000 });
    const asked = reply({ status: 'handling', job_id: id('job') });
    const view = waitingOnView({ maps: [map([chased, open], 91000)], replies: [asked], scan });
    expect(view.owed.map((entry) => entry.id)).toContain(chased.id);
    expect(view.top.map((entry) => entry.id)).toEqual([open.id]);
  });

  test('a settled or dropped debt is not waited on', () => {
    const view = waitingOnView({
      maps: [map([owed({ status: 'settled' }), owed({ status: 'dropped' })], 0)],
      replies: [],
      scan,
    });
    expect(view.owed).toEqual([]);
    expect(view.top).toEqual([]);
  });

  test('two spaces add up only in the first one’s currency', () => {
    const view = waitingOnView({
      maps: [map([owed()], 5000), map([owed({ currency: 'EUR' })], 7000, 'EUR')],
      replies: [],
      scan,
    });
    expect(view.owed_minor).toBe(5000);
  });

  test('with nothing scanned yet it says so, and shows nothing', () => {
    const view = waitingOnView({
      maps: [],
      replies: [],
      scan: { space_id: null, connected: true, status: 'none', finished_at: null, stale: false },
    });
    expect(view).toMatchObject({ owed_minor: 0, owed: [], replies: [], top: [] });
    expect(view.scan.status).toBe('none');
  });
});

describe('items a connected app added', () => {
  const source = (actions: Array<{ id: string; label: string }>) => ({
    connection_id: 'conn_01J0000000000000000000000D',
    label: 'Project tracker',
    ref: 'TRK-1',
    state: 'open',
    next_step: null,
    parties: [],
    actions: actions.map((action) => ({
      ...action,
      tool: 'post_note',
      input: {},
      digest: 'a'.repeat(64),
    })),
    published_at: '2026-09-01T00:00:00.000Z',
  });

  test('one with a step is offered with that step’s label; one with none has no button', () => {
    const withStep = owed({
      kind: 'commitment',
      suggested_playbook: null,
      confidence: 'reported',
      source: source([{ id: 'nudge', label: 'Nudge them' }]),
    });
    const without = owed({
      kind: 'commitment',
      suggested_playbook: null,
      confidence: 'reported',
      source: source([]),
    });
    const view = waitingOn.parse(
      waitingOnView({
        maps: [map([withStep, without], 10_000)],
        replies: [],
        scan: { space_id: SPACE, connected: true, status: 'done', finished_at: null, stale: false },
      }),
    );
    expect(view.owed.find((entry) => entry.id === withStep.id)).toMatchObject({
      added_by: 'Project tracker',
      next_step_label: 'Nudge them',
    });
    expect(view.owed.find((entry) => entry.id === without.id)).toMatchObject({
      added_by: 'Project tracker',
    });
    expect(view.owed.find((entry) => entry.id === without.id)).not.toHaveProperty(
      'next_step_label',
    );
    expect(view.top.map((entry) => entry.id)).toContain(withStep.id);
    expect(view.top.map((entry) => entry.id)).not.toContain(without.id);
  });
});
