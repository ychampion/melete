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
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { ownJob } from '../principals/authority.ts';
import { company, companyMessage, companyScan, ledgerItem } from './schema.ts';
import { computeTotals, DEFAULT_CURRENCY } from './totals.ts';
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
  /**
   * Messages and companies are written for a scan, and only while that scan's
   * row is there. Removing a space deletes its scans first, so a scan still
   * reading the mailbox cannot put back what the removal has taken.
   */
  saveMessages(owner: Owner, scanId: string, messages: readonly StoredMessage[]): Promise<void>;
  /** Insert or refresh one company and return the id the ledger should cite. */
  saveCompany(
    owner: Owner,
    scanId: string,
    input: Omit<Company, 'id' | 'space_id'> & { id?: string },
  ): Promise<string>;
  saveItems(owner: Owner, scanId: string, items: readonly LedgerItem[]): Promise<number>;
  /** `timeZone` is the person's own; a due date with no time is a day there. */
  map(owner: Owner, now: Date, timeZone?: string): Promise<CompanyMap>;
  item(owner: Owner, id: string): Promise<LedgerDetail | null>;
  setStatus(owner: Owner, id: string, status: LedgerItemStatus): Promise<LedgerItem | null>;
  setJob(owner: Owner, id: string, jobId: string): Promise<LedgerItem | null>;
}

const iso = (value: Date | string): string =>
  typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();

/**
 * When a later scan's version of a claim replaces the one already held.
 *
 * Only a subscription, because only a subscription is keyed on its company
 * alone: every other kind carries its amount and its date in the key, so a
 * conflicting row is the same claim down to the figure and there is nothing to
 * refresh. A subscription is the standing charge in force, and a company that
 * raises its price sends a new receipt — if that were discarded, the map would
 * keep quoting a price nobody pays and monthly spend would be wrong for good.
 *
 * Only while the person has not touched it. Once an item is being handled or
 * has been settled or dropped, a scan moving the figure underneath it would
 * change what a job is working on without anybody asking.
 *
 * And only when the figure actually differs, so re-reading the same mailbox
 * writes nothing and reports nothing found.
 */
export function refreshable(held: LedgerItem, found: LedgerItem): boolean {
  return (
    held.kind === 'subscription' &&
    held.status === 'found' &&
    held.job_id === null &&
    (held.amount_minor !== found.amount_minor || held.currency !== found.currency)
  );
}

/** What a refresh carries over: the claim, never the person's decisions about it. */
export function refreshedFields(found: LedgerItem) {
  return {
    amount_minor: found.amount_minor,
    currency: found.currency,
    due_at: found.due_at,
    confidence: found.confidence,
    evidence: found.evidence,
    suggested_playbook: found.suggested_playbook,
    summary: found.summary,
  };
}

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

/**
 * A scan runs inside the service process that started it, so a scan still
 * marked running when the service starts was cut off when it last stopped.
 * Left alone it would be handed back to every later request to scan, and the
 * person could never scan again.
 */
export async function closeInterruptedScans(db: Database): Promise<number> {
  const closed = await db
    .update(companyScan)
    .set({ status: 'failed', error: 'interrupted by a restart', finishedAt: new Date() })
    .where(eq(companyScan.status, 'running'))
    .returning({ id: companyScan.id });
  return closed.length;
}

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

  /**
   * The scan's row, held until the caller's write commits. Deleting the row
   * waits for that write, and every write after it finds no row and is refused.
   */
  private async holdScan(tx: Transaction, owner: Owner, scanId: string): Promise<void> {
    const [held] = await tx
      .select({ id: companyScan.id })
      .from(companyScan)
      .where(and(ownedScan(owner), eq(companyScan.id, scanId)))
      .for('share');
    if (!held) throw new Error('This scan was stopped.');
  }

  async saveMessages(
    owner: Owner,
    scanId: string,
    messages: readonly StoredMessage[],
  ): Promise<void> {
    if (!messages.length) return;
    await this.db.transaction(async (tx) => {
      await this.holdScan(tx, owner, scanId);
      await tx
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
    });
  }

  async saveCompany(
    owner: Owner,
    scanId: string,
    input: Omit<Company, 'id' | 'space_id'> & { id?: string },
  ): Promise<string> {
    const [row] = await this.db.transaction(async (tx) => {
      await this.holdScan(tx, owner, scanId);
      return tx
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
    });
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
      // A claim this person already has is the same claim, whichever scan found
      // it — with one exception, `refreshable` above: an untouched subscription
      // whose price has actually changed takes the new figure. The condition is
      // in the DO UPDATE's own WHERE, so a row it excludes is neither written
      // nor returned, and re-reading an unchanged mailbox still reports nothing.
      .onConflictDoUpdate({
        target: [ledgerItem.spaceId, ledgerItem.principalId, ledgerItem.dedupeKey],
        set: {
          amountMinor: sql`excluded.amount_minor`,
          currency: sql`excluded.currency`,
          dueAt: sql`excluded.due_at`,
          confidence: sql`excluded.confidence`,
          evidence: sql`excluded.evidence`,
          suggestedPlaybook: sql`excluded.suggested_playbook`,
          summary: sql`excluded.summary`,
          scanId: sql`excluded.scan_id`,
        },
        setWhere: sql`${ledgerItem.kind} = 'subscription'
          and ${ledgerItem.status} = 'found'
          and ${ledgerItem.jobId} is null
          and (${ledgerItem.amountMinor} is distinct from excluded.amount_minor
            or ${ledgerItem.currency} is distinct from excluded.currency)`,
      })
      .returning({ id: ledgerItem.id });
    return written.length;
  }

  async map(owner: Owner, now: Date, timeZone?: string): Promise<CompanyMap> {
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
    const totals = computeTotals(view, { now, timeZone });
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
  /** Dedupe key to the id of the item holding it, so a refresh can find the row. */
  private readonly keys = new Map<string, string>();

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
  async saveMessages(
    owner: Owner,
    _scanId: string,
    messages: readonly StoredMessage[],
  ): Promise<void> {
    for (const message of messages) {
      const key = this.key(owner, message.messageId);
      if (!this.messages.has(key)) this.messages.set(key, { ...message, ...owner });
    }
  }
  async saveCompany(
    owner: Owner,
    _scanId: string,
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
      const held = this.keys.get(key);
      if (held) {
        const existing = this.items.get(held);
        if (!existing || !refreshable(existing, item)) continue;
        this.items.set(held, {
          ...existing,
          ...refreshedFields(item),
        });
        written++;
        continue;
      }
      this.keys.set(key, item.id);
      this.items.set(item.id, {
        ...item,
        space_id: owner.spaceId,
        principal_id: owner.principalId,
      });
      written++;
    }
    return written;
  }
  async map(owner: Owner, now: Date, timeZone?: string): Promise<CompanyMap> {
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
      totals: computeTotals(items, { now, timeZone }),
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
  /**
   * Changing an item is about the item, so it does not go through `item()`,
   * which also needs the company row for its detail view. Postgres updates the
   * ledger row on its own; this has to as well, or the two stores disagree
   * about a ledger that has no company saved beside it.
   */
  private own(owner: Owner, id: string): LedgerItem | null {
    const item = this.items.get(id);
    if (!item || item.space_id !== owner.spaceId || item.principal_id !== owner.principalId)
      return null;
    return item;
  }
  async setStatus(owner: Owner, id: string, status: LedgerItemStatus): Promise<LedgerItem | null> {
    const item = this.own(owner, id);
    if (!item) return null;
    const updated = { ...item, status };
    this.items.set(id, updated);
    return updated;
  }
  async setJob(owner: Owner, id: string, jobId: string): Promise<LedgerItem | null> {
    const item = this.own(owner, id);
    if (!item) return null;
    const updated: LedgerItem = { ...item, job_id: jobId, status: 'handling' };
    this.items.set(id, updated);
    return updated;
  }
}
