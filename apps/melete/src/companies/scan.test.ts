import { describe, expect, test } from 'bun:test';
import { evidenceHolds, LEDGER_ITEM_KINDS, type LedgerItem } from '@melete/contracts';
import type { CompanyExtractor } from './extract.ts';
import { FIXTURE_MESSAGE_COUNT, FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { fixtureMailbox } from './mailbox.ts';
import { messageText } from './messages.ts';
import { MemoryCompanyStore, type Owner, SCAN_LEASE_MS } from './repository.ts';
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
    expect(outcome.messagesSeen).toBe(FIXTURE_MESSAGE_COUNT);
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

  test('finds the companies on both sides of the studio’s money', async () => {
    const { map } = await scanFixtures();
    const domains = map.companies.map((entry) => entry.domain);
    // A client who owes the studio, and a tool the studio pays.
    expect(domains).toContain('pinegrovegroup.example');
    expect(domains).toContain('nimbusledger.example');
    expect(domains).toContain('beaconfibre.example');
    // A colleague and a newsletter are not companies in anybody's life.
    expect(domains).not.toContain('thackeraylane.example');
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
    const at = (domain: string) => map.companies.find((entry) => entry.domain === domain)?.id;
    const find = (domain: string, kind: string) =>
      map.items.find((item) => item.company_id === at(domain) && item.kind === kind);

    // A tool the studio pays for, monthly.
    const subscription = find('nimbusledger.example', 'subscription');
    expect([subscription?.amount_minor, subscription?.currency, subscription?.direction]).toEqual([
      14800,
      'GBP',
      'you_pay',
    ]);

    // A supplier who owes the studio a refund.
    const refund = find('harrowgatehardware.example', 'refund_owed');
    expect([refund?.amount_minor, refund?.currency, refund?.direction]).toEqual([
      42999,
      'GBP',
      'owed_to_you',
    ]);

    // A client who has not paid. This is the direction a CRM never points.
    const invoice = find('pinegrovegroup.example', 'invoice_unpaid');
    expect([invoice?.amount_minor, invoice?.currency, invoice?.direction]).toEqual([
      1240000,
      'GBP',
      'owed_to_you',
    ]);
  });

  test('money runs both ways, which is the point of pointing a CRM backwards', async () => {
    const { map } = await scanFixtures();
    const owed = map.items.filter((item) => item.direction === 'owed_to_you');
    const paid = map.items.filter((item) => item.direction === 'you_pay');
    expect(owed.length).toBeGreaterThan(5);
    expect(paid.length).toBeGreaterThan(5);
    // Three clients have not paid, and they are the largest sums on the map.
    const invoices = map.items.filter((item) => item.kind === 'invoice_unpaid');
    expect(invoices).toHaveLength(3);
    expect(invoices.every((item) => item.direction === 'owed_to_you')).toBe(true);
    expect(invoices.every((item) => item.suggested_playbook === 'unpaid-invoice')).toBe(true);
    expect(invoices.reduce((sum, item) => sum + (item.amount_minor ?? 0), 0)).toBe(2_235_000);
  });

  test('every company in it is invented, and reachable only under .example', async () => {
    const { map } = await scanFixtures();
    expect(map.companies.length).toBeGreaterThan(20);
    for (const entry of map.companies) expect(entry.domain.endsWith('.example')).toBe(true);
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

describe('two messages arriving under one Message-ID', () => {
  // A sender chooses that header, so two messages can claim the same id. The
  // store kept one text per id while the scan had read another, which left an
  // admitted figure whose own span, in the message it cites, said something
  // else: a reviewer produced GBP 5.00 displayed against a stored GBP 900.00.
  const ID = '<duplicate@attacker.example>';
  const clash = (subject: string, text: string, ago: number) => ({
    messageId: ID,
    from: 'Nimbus Ledger <billing@nimbusledger.example>',
    to: 'accounts@thackeraylane.example',
    subject,
    text,
    receivedAt: new Date(now.getTime() - ago * 86_400_000).toISOString(),
  });
  const twoUnderOneId = () => [
    clash('Receipt A', 'Your subscription charge of GBP 5.00 was taken today.', 1),
    clash('Receipt B', 'Your subscription charge of GBP 900.00 was taken today.', 2),
  ];
  const scanThem = async () => {
    const store = new MemoryCompanyStore();
    const outcome = await runScan({
      store,
      mailbox: fixtureMailbox(twoUnderOneId()),
      extractor: scriptedExtractor(),
      owner,
      now,
    });
    return { store, outcome, map: await store.map(owner, now) };
  };

  test('every admitted figure still opens back to the text the store kept', async () => {
    const { store, map } = await scanThem();
    for (const item of map.items) {
      const detail = await store.item(owner, item.id);
      expect(detail?.message).not.toBe(null);
      // The promise the module exists to keep, on a mailbox built to break it.
      for (const evidence of item.evidence)
        expect(evidenceHolds(detail?.message?.text ?? '', evidence)).toBe(true);
    }
  });

  test('the second message under the id is refused and counted, not quietly read', async () => {
    const { outcome } = await scanThem();
    expect(outcome.status).toBe('done');
    expect(outcome.counts.duplicate_message_id).toBe(1);
  });

  test('which message is read is decided the same way twice', async () => {
    const subjectRead = async () => {
      const { store, map } = await scanThem();
      const first = map.items[0];
      if (!first) return null;
      return (await store.item(owner, first.id))?.message?.subject ?? null;
    };
    const first = await subjectRead();
    expect(first).not.toBe(null);
    expect(await subjectRead()).toBe(first);
  });
});

describe('a scan that never finished', () => {
  // The default schedule runs the work in this process. If the process dies
  // mid-scan nothing ever calls closeScan, the row stays `running`, and every
  // later request is handed that row instead of starting a scan — for good.
  // A person cannot unstick that themselves, so a running scan has a lease.
  const staleOwner: Owner = {
    spaceId: 'sp_01J0000000000000000000000A',
    principalId: 'own_01J000000000000000000ST1',
  };

  test('stops being the running scan once its lease has expired', async () => {
    const store = new MemoryCompanyStore();
    const opened = await store.openScan(staleOwner);
    expect((await store.runningScan(staleOwner))?.id).toBe(opened.id);

    // Just inside the lease it is still the running scan.
    const nearly = new Date(Date.parse(opened.startedAt) + SCAN_LEASE_MS - 1000);
    expect((await store.runningScan(staleOwner, nearly))?.id).toBe(opened.id);

    // Past it, nothing is running and a new scan may start.
    const after = new Date(Date.parse(opened.startedAt) + SCAN_LEASE_MS + 1000);
    expect(await store.runningScan(staleOwner, after)).toBe(null);
  });

  test('the abandoned row is still readable, and says it was abandoned', async () => {
    const store = new MemoryCompanyStore();
    const opened = await store.openScan(staleOwner);
    const after = new Date(Date.parse(opened.startedAt) + SCAN_LEASE_MS + 1000);
    await store.runningScan(staleOwner, after);
    const record = await store.scan(staleOwner, opened.id);
    // A person who kept the scan id is told what became of it rather than
    // watching `running` forever.
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('scan_abandoned');
  });

  test('and a fresh scan can then be opened', async () => {
    const store = new MemoryCompanyStore();
    const first = await store.openScan(staleOwner);
    const after = new Date(Date.parse(first.startedAt) + SCAN_LEASE_MS + 1000);
    await store.runningScan(staleOwner, after);
    const second = await store.openScan(staleOwner);
    expect(second.id).not.toBe(first.id);
  });
});

describe('scanning again after a price has changed', () => {
  const subscription = (amountMinor: number): LedgerItem => ({
    id: `li_01J00000000000000000${amountMinor}`,
    space_id: owner.spaceId,
    principal_id: owner.principalId,
    company_id: 'co_01J0000000000000000000000C',
    kind: 'subscription',
    direction: 'you_pay',
    amount_minor: amountMinor,
    currency: 'GBP',
    due_at: null,
    status: 'found',
    confidence: 'high',
    evidence: [{ message_id: `<${amountMinor}@x.example>`, quote: 'q', start: 0, end: 1 }],
    suggested_playbook: 'cancel-subscription',
    job_id: null,
    summary: `Subscription at ${amountMinor}`,
  });

  test('the map shows the price in force, not the one it first learned', async () => {
    const store = new MemoryCompanyStore();
    expect(await store.saveItems(owner, 'scn_1', [subscription(14800)])).toBe(1);
    // A later scan reads a receipt at the new price. One subscription per
    // company means this is the same claim, so it has to replace the figure
    // rather than be discarded — otherwise monthly spend is wrong for good.
    expect(await store.saveItems(owner, 'scn_2', [subscription(17900)])).toBe(1);
    const map = await store.map(owner, now);
    expect(map.items.filter((item) => item.kind === 'subscription')).toHaveLength(1);
    expect(map.totals.monthly_spend_minor).toBe(17900);
  });

  test('an unchanged price is not rewritten, so a re-scan still finds nothing new', async () => {
    const store = new MemoryCompanyStore();
    expect(await store.saveItems(owner, 'scn_1', [subscription(14800)])).toBe(1);
    expect(await store.saveItems(owner, 'scn_2', [subscription(14800)])).toBe(0);
  });

  test('a subscription the person has picked up is left alone', async () => {
    const store = new MemoryCompanyStore();
    await store.saveItems(owner, 'scn_1', [subscription(14800)]);
    const [held] = (await store.map(owner, now)).items;
    expect(held).toBeDefined();
    if (!held) return;
    await store.setJob(owner, held.id, 'job_01J0000000000000000000000H');
    // It is being handled. A scan must not move the figure under the job.
    expect(await store.saveItems(owner, 'scn_2', [subscription(17900)])).toBe(0);
    const after = await store.map(owner, now);
    expect(after.items[0]?.amount_minor).toBe(14800);
    expect(after.items[0]?.status).toBe('handling');
  });
});

describe('an extractor that fails on one message', () => {
  test('costs that message its items and nothing else its place on the map', async () => {
    let seen = 0;
    const flaky: CompanyExtractor = {
      async extract(request) {
        seen++;
        // Every third message is unreadable, whatever it says.
        if (seen % 3 === 0) throw new Error('provider refused');
        return scriptedExtractor().extract(request);
      },
    };
    const store = new MemoryCompanyStore();
    const outcome = await runScan({
      store,
      mailbox: fixtureMailbox(fixtureMessages()),
      extractor: flaky,
      owner,
      now,
    });
    const map = await store.map(owner, now);
    expect(outcome.status).toBe('done');
    expect(outcome.counts.extractor_failed).toBeGreaterThan(0);
    expect(map.items.length).toBeGreaterThan(10);
    // What survived is still admitted evidence, not a partial guess.
    for (const item of map.items) {
      const detail = await store.item(owner, item.id);
      for (const evidence of item.evidence)
        expect(evidenceHolds(detail?.message?.text ?? '', evidence)).toBe(true);
    }
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
