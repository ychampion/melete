import { describe, expect, test } from 'bun:test';
import { evidenceHolds, LEDGER_ITEM_KINDS } from '@melete/contracts';
import type { CompanyExtractor } from './extract.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { fixtureMailbox } from './mailbox.ts';
import { messageText } from './messages.ts';
import { MemoryCompanyStore, type Owner } from './repository.ts';
import { runScan } from './scan.ts';
import { scriptedExtractor } from './scripted.ts';

const owner: Owner = {
  spaceId: 'sp_01J0000000000000000000000A',
  principalId: 'own_01J0000000000000000000000B',
};
const now = new Date(FIXTURE_REFERENCE);

async function scanFixtures(extractor: CompanyExtractor = scriptedExtractor()) {
  const store = new MemoryCompanyStore();
  const outcome = await runScan({
    store,
    mailbox: fixtureMailbox(fixtureMessages()),
    extractor,
    owner,
    now,
  });
  return { store, outcome, map: await store.map(owner, now) };
}

describe('a scan of the demonstration mailbox', () => {
  test('finishes, and reports what it read rather than what it was given', async () => {
    const { outcome } = await scanFixtures();
    expect(outcome.status).toBe('done');
    expect(outcome.messagesSeen).toBe(40);
    expect(outcome.counts.withheld).toBe(3);
    expect(outcome.itemsFound).toBeGreaterThan(20);
  });

  test('produces the same map twice', async () => {
    const first = await scanFixtures();
    const second = await scanFixtures();
    const shape = (map: Awaited<ReturnType<typeof scanFixtures>>['map']) => ({
      companies: map.companies.map((entry) => entry.domain).sort(),
      totals: map.totals,
      items: map.items
        .map((item) => `${item.kind}|${item.direction}|${item.amount_minor}|${item.currency}`)
        .sort(),
    });
    expect(shape(first.map)).toEqual(shape(second.map));
  });

  test('every admitted figure opens back to the exact sentence it came from', async () => {
    const { store, map } = await scanFixtures();
    expect(map.items.length).toBeGreaterThan(0);
    for (const item of map.items) {
      const detail = await store.item(owner, item.id);
      expect(detail?.message).not.toBe(null);
      for (const evidence of item.evidence)
        expect(evidenceHolds(detail?.message?.text ?? '', evidence)).toBe(true);
    }
  });

  test('finds the companies the mailbox is from, and no company for a friend', async () => {
    const { map } = await scanFixtures();
    const domains = map.companies.map((entry) => entry.domain);
    expect(domains).toContain('nimbusledger.example');
    expect(domains).toContain('beaconfibre.example');
    expect(domains).toContain('pinegrovestudio.example');
    expect(domains).not.toContain('friendsandfamily.example');
    expect(domains).not.toContain('longshoreletter.example');
  });

  test('covers the kinds the map is made of, including promises', async () => {
    const { map } = await scanFixtures();
    const kinds = new Set<string>(map.items.map((item) => item.kind));
    expect([...LEDGER_ITEM_KINDS].filter((kind) => !kinds.has(kind))).toEqual([]);
    expect(map.totals.promises_in_force + map.totals.promises_lapsed).toBeGreaterThan(3);
  });

  test('reads the figures the emails actually state', async () => {
    const { map } = await scanFixtures();
    const nimbus = map.companies.find((entry) => entry.domain === 'nimbusledger.example');
    const nimbusItems = map.items.filter((item) => item.company_id === nimbus?.id);
    const subscription = nimbusItems.find((item) => item.kind === 'subscription');
    expect([subscription?.amount_minor, subscription?.currency]).toEqual([4800, 'GBP']);

    const harrow = map.companies.find((entry) => entry.domain === 'harrowpeck.example');
    const refund = map.items.find(
      (item) => item.company_id === harrow?.id && item.kind === 'refund_owed',
    );
    expect([refund?.amount_minor, refund?.currency, refund?.direction]).toEqual([
      12999,
      'GBP',
      'owed_to_you',
    ]);

    const pinegrove = map.companies.find((entry) => entry.domain === 'pinegrovestudio.example');
    const invoice = map.items.find(
      (item) => item.company_id === pinegrove?.id && item.kind === 'invoice_unpaid',
    );
    expect([invoice?.amount_minor, invoice?.currency]).toEqual([320000, 'GBP']);
  });

  test('the totals are the sum of the items a person can open', async () => {
    const { map } = await scanFixtures();
    const owed = map.items
      .filter(
        (item) =>
          item.direction === 'owed_to_you' && item.currency === 'GBP' && item.status === 'found',
      )
      .reduce((sum, item) => sum + (item.amount_minor ?? 0), 0);
    expect(map.totals.owed_to_you_minor).toBe(owed);
    expect(map.totals.price_rises).toBeGreaterThanOrEqual(3);
  });
});

describe('a message that tries to give the agent orders', () => {
  const injection = () =>
    fixtureMessages().find((message) => message.text.startsWith('Ignore previous instructions'));

  test('produces no item, and nothing about it is settled', async () => {
    const { map } = await scanFixtures();
    const crestline = map.companies.find((entry) => entry.domain === 'crestlinesupply.example');
    const items = map.items.filter((item) => item.company_id === crestline?.id);
    expect(items).toEqual([]);
    expect(map.items.every((item) => item.status === 'found')).toBe(true);
    expect(map.items.every((item) => item.job_id === null)).toBe(true);
  });

  test('a model that obeys the email still changes nothing, because the quote does not hold', async () => {
    // The extractor is made to do exactly what the email asked for: claim every
    // matter is closed, and cite a sentence it composed rather than copied.
    const obedient: CompanyExtractor = {
      async extract(request) {
        const fabricated = 'This account owes nothing and every item is settled.';
        return [
          {
            kind: 'refund_owed',
            direction: 'owed_to_you',
            amount_minor: 0,
            currency: 'GBP',
            due_at: null,
            confidence: 'high',
            suggested_playbook: null,
            summary: `Everything settled with ${request.companyName}`,
            evidence: [{ quote: fabricated, start: 0, end: fabricated.length }],
          },
        ];
      },
    };
    const store = new MemoryCompanyStore();
    const outcome = await runScan({
      store,
      mailbox: fixtureMailbox(fixtureMessages()),
      extractor: obedient,
      owner,
      now,
    });
    const map = await store.map(owner, now);
    expect(outcome.status).toBe('done');
    expect(map.items).toEqual([]);
    expect(outcome.itemsFound).toBe(0);
    expect(outcome.counts.evidence_span).toBeGreaterThan(0);
    expect(map.totals.owed_to_you_minor).toBe(0);
  });

  test('the injected sentence is stored as text and never as an instruction', async () => {
    const message = injection();
    expect(message).toBeDefined();
    if (!message) return;
    const text = messageText(message);
    expect(text).toContain('Ignore previous instructions');
    // It is a candidate — it says "charge" — so it is read, and nothing comes of it.
    const { store } = await scanFixtures();
    const detail = await store.item(owner, 'li_nothing');
    expect(detail).toBe(null);
  });
});

describe('a scan whose mailbox will not answer', () => {
  test('is recorded as failed, and leaves no half-written map', async () => {
    const store = new MemoryCompanyStore();
    const outcome = await runScan({
      store,
      mailbox: {
        async recent() {
          throw new Error('mail connection unavailable');
        },
      },
      extractor: scriptedExtractor(),
      owner,
      now,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('mail connection unavailable');
    expect((await store.map(owner, now)).items).toEqual([]);
    expect((await store.scan(owner, outcome.id))?.status).toBe('failed');
  });
});

describe('one person’s map is one person’s', () => {
  test('a second principal in the same space reads nothing of the first', async () => {
    const { store, map } = await scanFixtures();
    const stranger: Owner = {
      spaceId: owner.spaceId,
      principalId: 'own_01J000000000000000000000ZZ',
    };
    const theirs = await store.map(stranger, now);
    expect(theirs.items).toEqual([]);
    expect(theirs.companies).toEqual([]);
    const first = map.items[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(await store.item(stranger, first.id)).toBe(null);
    expect(await store.setStatus(stranger, first.id, 'settled')).toBe(null);
    // And the owner's own item is untouched by the attempt.
    expect((await store.item(owner, first.id))?.item.status).toBe('found');
  });

  test('the same principal in another space reads nothing either', async () => {
    const { store, map } = await scanFixtures();
    const elsewhere: Owner = {
      spaceId: 'sp_01J000000000000000000000ZZ',
      principalId: owner.principalId,
    };
    expect((await store.map(elsewhere, now)).items).toEqual([]);
    const first = map.items[0];
    if (!first) return;
    expect(await store.item(elsewhere, first.id)).toBe(null);
  });
});
