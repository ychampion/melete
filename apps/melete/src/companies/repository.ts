/**
 * Where the map is kept, and the one rule every query here obeys: a row is
 * reachable only by the principal whose row it is, inside the space it belongs
 * to. That is the same rule `experience/*` applies to jobs, written the same
 * way, so there is one ownership test in this service rather than two.
 *
 * The store is an interface because three callers need it: the routes, which
 * want Postgres; the scan, which only wants somewhere to put what it found; and
 * the tests and the demo seed, which want neither a database nor a network.
 */

import type { Company, CompanyMap, LedgerItem, LedgerItemStatus } from '@melete/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { newId } from '../ids.ts';
import { ownJob } from '../principals/authority.ts';
import { company, companyMessage, companyScan, ledgerItem } from './schema.ts';
import { type CompanyTotals, computeTotals, contractTotals, DEFAULT_CURRENCY } from './totals.ts';
import { dedupeKey } from './validate.ts';

export type Owner = { spaceId: string; principalId: string };

export type StoredMessage = {
  messageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  /** Exactly the text the spans index into. */
  text: string;
};

export type ScanRecord = {
  id: string;
  status: 'running' | 'done' | 'failed';
  messagesSeen: number;
  itemsFound: number;
  counts: Record<string, number>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type LedgerDetail = {
  item: LedgerItem;
  company: Company;
  message: { id: string; subject: string; from: string; received_at: string; text: string } | null;
};

export interface CompanyStore {
  /** The scan already running for this person, if there is one. */
  runningScan(owner: Owner): Promise<ScanRecord | null>;
  openScan(owner: Owner): Promise<ScanRecord>;
  closeScan(
    owner: Owner,
    scanId: string,
    result: {
      status: 'done' | 'failed';
      messagesSeen: number;
      itemsFound: number;
      counts: Record<string, number>;
      error?: string;
    },
  ): Promise<void>;
  scan(owner: Owner, scanId: string): Promise<ScanRecord | null>;
  saveMessages(owner: Owner, messages: readonly StoredMessage[]): Promise<void>;
  /** Insert or refresh one company and return the id the ledger should cite. */
  saveCompany(
    owner: Owner,
    input: Omit<Company, 'id' | 'space_id'> & { id?: string },
  ): Promise<string>;
  saveItems(owner: Owner, scanId: string, items: readonly LedgerItem[]): Promise<number>;
  map(owner: Owner, now: Date): Promise<CompanyMap & { totals: CompanyTotals }>;
  item(owner: Owner, id: string): Promise<LedgerDetail | null>;
  setStatus(owner: Owner, id: string, status: LedgerItemStatus): Promise<LedgerItem | null>;
  setJob(owner: Owner, id: string, jobId: string): Promise<LedgerItem | null>;
}

const iso = (value: Date | string): string =>
  typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();

// --------------------------------------------------------------------------
// Postgres
// --------------------------------------------------------------------------

/** The two clauses every read carries: the space it names and the principal it belongs to. */
const ownedCompany = (owner: Owner) =>
  and(eq(company.spaceId, owner.spaceId), ownJob(company.principalId, owner.principalId));
const ownedItem = (owner: Owner) =>
  and(eq(ledgerItem.spaceId, owner.spaceId), ownJob(ledgerItem.principalId, owner.principalId));
const ownedScan = (owner: Owner) =>
  and(eq(companyScan.spaceId, owner.spaceId), ownJob(companyScan.principalId, owner.principalId));

type ScanRow = typeof companyScan.$inferSelect;
const scanRecord = (row: ScanRow): ScanRecord => ({
  id: row.id,
  status: row.status as ScanRecord['status'],
  messagesSeen: row.messagesSeen,
  itemsFound: row.itemsFound,
  counts: row.counts ?? {},
  error: row.error,
  startedAt: iso(row.startedAt),
  finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
});

type CompanyRow = typeof company.$inferSelect;
const companyView = (row: CompanyRow): Company => ({
  id: row.id,
  space_id: row.spaceId,
  name: row.name,
  domain: row.domain,
  monthly_spend_minor: row.monthlySpendMinor,
  currency: row.currency,
  first_seen_at: iso(row.firstSeenAt),
  last_seen_at: iso(row.lastSeenAt),
  message_count: row.messageCount,
});

type ItemRow = typeof ledgerItem.$inferSelect;
const itemView = (row: ItemRow): LedgerItem => ({
  id: row.id,
  space_id: row.spaceId,
  principal_id: row.principalId,
  company_id: row.companyId,
  kind: row.kind as LedgerItem['kind'],
  direction: row.direction as LedgerItem['direction'],
  amount_minor: row.amountMinor,
  currency: row.currency,
  due_at: row.dueAt ? iso(row.dueAt) : null,
  status: row.status as LedgerItemStatus,
  confidence: row.confidence as LedgerItem['confidence'],
  evidence: row.evidence,
  suggested_playbook: row.suggestedPlaybook,
  job_id: row.jobId,
  summary: row.summary,
});

export class PostgresCompanyStore implements CompanyStore {
  constructor(private readonly db: Database) {}

  async runningScan(owner: Owner): Promise<ScanRecord | null> {
    const [row] = await this.db
      .select()
      .from(companyScan)
      .where(and(ownedScan(owner), eq(companyScan.status, 'running')))
      .orderBy(desc(companyScan.startedAt))
      .limit(1);
    return row ? scanRecord(row) : null;
  }

  async openScan(owner: Owner): Promise<ScanRecord> {
    const [row] = await this.db
      .insert(companyScan)
      .values({ id: newId('scn'), spaceId: owner.spaceId, principalId: owner.principalId })
      .returning();
    if (!row) throw new Error('scan row was not created');
    return scanRecord(row);
  }

  async closeScan(
    owner: Owner,
    scanId: string,
    result: Parameters<CompanyStore['closeScan']>[2],
  ): Promise<void> {
    await this.db
      .update(companyScan)
      .set({
        status: result.status,
        messagesSeen: result.messagesSeen,
        itemsFound: result.itemsFound,
        counts: result.counts,
        error: result.error ?? null,
        finishedAt: new Date(),
      })
      .where(and(ownedScan(owner), eq(companyScan.id, scanId)));
  }

  async scan(owner: Owner, scanId: string): Promise<ScanRecord | null> {
    const [row] = await this.db
      .select()
      .from(companyScan)
      .where(and(ownedScan(owner), eq(companyScan.id, scanId)));
    return row ? scanRecord(row) : null;
  }

  async saveMessages(owner: Owner, messages: readonly StoredMessage[]): Promise<void> {
    if (!messages.length) return;
    await this.db
      .insert(companyMessage)
      .values(
        messages.map((message) => ({
          id: newId('msg'),
          spaceId: owner.spaceId,
          principalId: owner.principalId,
          messageId: message.messageId,
          subject: message.subject,
          fromAddress: message.from,
          receivedAt: new Date(message.receivedAt),
          body: message.text,
        })),
      )
      // The stored text is what spans were checked against. It is never rewritten.
      .onConflictDoNothing();
  }

  async saveCompany(
    owner: Owner,
    input: Omit<Company, 'id' | 'space_id'> & { id?: string },
  ): Promise<string> {
    const [row] = await this.db
      .insert(company)
      .values({
        id: input.id ?? newId('co'),
        spaceId: owner.spaceId,
        principalId: owner.principalId,
        name: input.name,
        domain: input.domain,
        monthlySpendMinor: input.monthly_spend_minor,
        currency: input.currency,
        firstSeenAt: new Date(input.first_seen_at),
        lastSeenAt: new Date(input.last_seen_at),
        messageCount: input.message_count,
      })
      .onConflictDoUpdate({
        target: [company.spaceId, company.principalId, company.domain],
        set: {
          name: input.name,
          monthlySpendMinor: input.monthly_spend_minor,
          currency: input.currency,
          lastSeenAt: new Date(input.last_seen_at),
          messageCount: input.message_count,
        },
      })
      .returning({ id: company.id });
    if (!row) throw new Error('company row was not written');
    return row.id;
  }

  async saveItems(owner: Owner, scanId: string, items: readonly LedgerItem[]): Promise<number> {
    if (!items.length) return 0;
    const written = await this.db
      .insert(ledgerItem)
      .values(
        items.map((item) => ({
          id: item.id,
          spaceId: owner.spaceId,
          principalId: owner.principalId,
          companyId: item.company_id,
          kind: item.kind,
          direction: item.direction,
          amountMinor: item.amount_minor,
          currency: item.currency,
          dueAt: item.due_at ? new Date(item.due_at) : null,
          status: item.status,
          confidence: item.confidence,
          evidence: item.evidence,
          suggestedPlaybook: item.suggested_playbook,
          jobId: item.job_id,
          summary: item.summary,
          scanId,
          dedupeKey: dedupeKey(item),
        })),
      )
      // A claim this person already has is the same claim, whichever scan found it.
      .onConflictDoNothing({
        target: [ledgerItem.spaceId, ledgerItem.principalId, ledgerItem.dedupeKey],
      })
      .returning({ id: ledgerItem.id });
    return written.length;
  }

  async map(owner: Owner, now: Date): Promise<CompanyMap & { totals: CompanyTotals }> {
    const companies = await this.db
      .select()
      .from(company)
      .where(ownedCompany(owner))
      .orderBy(company.name);
    const items = await this.db
      .select()
      .from(ledgerItem)
      .where(ownedItem(owner))
      .orderBy(desc(ledgerItem.createdAt), ledgerItem.id);
    const view = items.map(itemView);
    const totals = computeTotals(view, { now });
    return {
      companies: companies.map(companyView),
      items: view,
      totals,
      currency: DEFAULT_CURRENCY,
    };
  }

  async item(owner: Owner, id: string): Promise<LedgerDetail | null> {
    const [row] = await this.db
      .select()
      .from(ledgerItem)
      .where(and(ownedItem(owner), eq(ledgerItem.id, id)));
    if (!row) return null;
    const [parent] = await this.db
      .select()
      .from(company)
      .where(and(ownedCompany(owner), eq(company.id, row.companyId)));
    if (!parent) return null;
    const messageId = row.evidence[0]?.message_id;
    const [source] = messageId
      ? await this.db
          .select()
          .from(companyMessage)
          .where(
            and(
              eq(companyMessage.spaceId, owner.spaceId),
              ownJob(companyMessage.principalId, owner.principalId),
              eq(companyMessage.messageId, messageId),
            ),
          )
      : [];
    return {
      item: itemView(row),
      company: companyView(parent),
      message: source
        ? {
            id: source.messageId,
            subject: source.subject,
            from: source.fromAddress,
            received_at: iso(source.receivedAt),
            text: source.body,
          }
        : null,
    };
  }

  async setStatus(owner: Owner, id: string, status: LedgerItemStatus): Promise<LedgerItem | null> {
    const [row] = await this.db
      .update(ledgerItem)
      .set({ status })
      .where(and(ownedItem(owner), eq(ledgerItem.id, id)))
      .returning();
    return row ? itemView(row) : null;
  }

  async setJob(owner: Owner, id: string, jobId: string): Promise<LedgerItem | null> {
    const [row] = await this.db
      .update(ledgerItem)
      .set({ jobId, status: 'handling' })
      .where(and(ownedItem(owner), eq(ledgerItem.id, id)))
      .returning();
    return row ? itemView(row) : null;
  }
}

// --------------------------------------------------------------------------
// In memory
// --------------------------------------------------------------------------

/** The same store without Postgres, for the fixture scan, the tests and the seed. */
export class MemoryCompanyStore implements CompanyStore {
  private readonly scans = new Map<string, ScanRecord & Owner>();
  private readonly companies = new Map<string, Company & Owner>();
  private readonly items = new Map<string, LedgerItem>();
  private readonly messages = new Map<string, StoredMessage & Owner>();
  private readonly keys = new Set<string>();

  private key(owner: Owner, suffix: string) {
    return `${owner.spaceId}|${owner.principalId}|${suffix}`;
  }
  private mine(owner: Owner, row: Owner) {
    return row.spaceId === owner.spaceId && row.principalId === owner.principalId;
  }

  async runningScan(owner: Owner): Promise<ScanRecord | null> {
    for (const row of this.scans.values())
      if (this.mine(owner, row) && row.status === 'running') return row;
    return null;
  }
  async openScan(owner: Owner): Promise<ScanRecord> {
    const record: ScanRecord & Owner = {
      ...owner,
      id: newId('scn'),
      status: 'running',
      messagesSeen: 0,
      itemsFound: 0,
      counts: {},
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.scans.set(record.id, record);
    return record;
  }
  async closeScan(
    owner: Owner,
    scanId: string,
    result: Parameters<CompanyStore['closeScan']>[2],
  ): Promise<void> {
    const row = this.scans.get(scanId);
    if (!row || !this.mine(owner, row)) return;
    Object.assign(row, {
      status: result.status,
      messagesSeen: result.messagesSeen,
      itemsFound: result.itemsFound,
      counts: result.counts,
      error: result.error ?? null,
      finishedAt: new Date().toISOString(),
    });
  }
  async scan(owner: Owner, scanId: string): Promise<ScanRecord | null> {
    const row = this.scans.get(scanId);
    return row && this.mine(owner, row) ? row : null;
  }
  async saveMessages(owner: Owner, messages: readonly StoredMessage[]): Promise<void> {
    for (const message of messages) {
      const key = this.key(owner, message.messageId);
      if (!this.messages.has(key)) this.messages.set(key, { ...message, ...owner });
    }
  }
  async saveCompany(
    owner: Owner,
    input: Omit<Company, 'id' | 'space_id'> & { id?: string },
  ): Promise<string> {
    const key = this.key(owner, input.domain);
    const existing = this.companies.get(key);
    const id = existing?.id ?? input.id ?? newId('co');
    this.companies.set(key, {
      ...owner,
      id,
      space_id: owner.spaceId,
      name: input.name,
      domain: input.domain,
      monthly_spend_minor: input.monthly_spend_minor,
      currency: input.currency,
      first_seen_at: existing?.first_seen_at ?? input.first_seen_at,
      last_seen_at: input.last_seen_at,
      message_count: input.message_count,
    });
    return id;
  }
  async saveItems(owner: Owner, _scanId: string, items: readonly LedgerItem[]): Promise<number> {
    let written = 0;
    for (const item of items) {
      const key = this.key(owner, dedupeKey(item));
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.items.set(item.id, {
        ...item,
        space_id: owner.spaceId,
        principal_id: owner.principalId,
      });
      written++;
    }
    return written;
  }
  async map(owner: Owner, now: Date): Promise<CompanyMap & { totals: CompanyTotals }> {
    const companies = [...this.companies.values()]
      .filter((row) => this.mine(owner, row))
      .map(({ spaceId: _s, principalId: _p, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name));
    const items = [...this.items.values()].filter(
      (item) => item.space_id === owner.spaceId && item.principal_id === owner.principalId,
    );
    return {
      companies,
      items,
      totals: computeTotals(items, { now }),
      currency: DEFAULT_CURRENCY,
    };
  }
  async item(owner: Owner, id: string): Promise<LedgerDetail | null> {
    const item = this.items.get(id);
    if (!item || item.space_id !== owner.spaceId || item.principal_id !== owner.principalId)
      return null;
    const parent = [...this.companies.values()].find((row) => row.id === item.company_id);
    if (!parent) return null;
    const { spaceId: _s, principalId: _p, ...view } = parent;
    const source = this.messages.get(this.key(owner, item.evidence[0]?.message_id ?? ''));
    return {
      item,
      company: view,
      message: source
        ? {
            id: source.messageId,
            subject: source.subject,
            from: source.from,
            received_at: source.receivedAt,
            text: source.text,
          }
        : null,
    };
  }
  async setStatus(owner: Owner, id: string, status: LedgerItemStatus): Promise<LedgerItem | null> {
    const found = await this.item(owner, id);
    if (!found) return null;
    const updated = { ...found.item, status };
    this.items.set(id, updated);
    return updated;
  }
  async setJob(owner: Owner, id: string, jobId: string): Promise<LedgerItem | null> {
    const found = await this.item(owner, id);
    if (!found) return null;
    const updated: LedgerItem = { ...found.item, job_id: jobId, status: 'handling' };
    this.items.set(id, updated);
    return updated;
  }
}

/** The contract's `CompanyMap`, without the promise counts that sit beside it. */
export function contractMap(map: CompanyMap & { totals: CompanyTotals }): CompanyMap {
  return { ...map, totals: contractTotals(map.totals) };
}
