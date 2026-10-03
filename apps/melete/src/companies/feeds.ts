/**
 * Reading a connection's ledger feed and writing what it admits.
 *
 * Four rules hold here, and each is checked again at the moment it matters
 * rather than remembered from earlier:
 *
 * 1. **Only a declared feed is read.** The installation names the feed tool;
 *    a connection whose installation declares none adds nothing, whatever
 *    its tools return, and nothing a job or a model writes can declare one.
 * 2. **Only the owner's ledger receives it.** A feed is read for a connection
 *    in a space whose audience is its owner, and its items are written for that
 *    owner, so they are fenced the way the rest of the ledger is: another
 *    account, or another member of a shared space, never reads them.
 * 3. **A connection stands behind what it wrote.** Revoking it or switching it
 *    off hides its items and the companies its feed added; removing its row
 *    removes them, along with the source texts its items quote.
 * 4. **A connection's share is bounded.** It holds at most so many items,
 *    companies and source texts; an item it stopped listing is let go after a
 *    while, and a text no item quotes, or a company no item is about, goes with
 *    it.
 */
import {
  type LedgerItem,
  type LedgerItemAction,
  type LedgerSyncResult,
  type McpLedgerDeclaration,
  mcpLedgerDeclaration,
} from '@melete/contracts';
import { and, count, eq, inArray, isNull, notInArray, sql as raw } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { LedgerFeedUnavailable } from '../connectors/mcp-connector.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { QUEUES } from '../jobs/queue.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { spaceAuthority } from '../principals/authority.ts';
import {
  type Admission,
  actionToolName,
  admitFeed,
  feedBody,
  publishedDedupeKey,
} from './published.ts';
import { company, companyMessage, ledgerItem, type PublishedSource } from './schema.ts';

/** How often the service reads every declared feed on its own. */
export const LEDGER_FEED_SECONDS = 300;

/** What one read of a feed may take before it is given up on. */
const FEED_TIMEOUT_MS = 30_000;

/** What one connection may hold in its space's ledger. */
export type FeedLimits = {
  /** Items, whatever their status. */
  items: number;
  /** Companies its feed added. */
  companies: number;
  /** Source texts its items quote. */
  sources: number;
  /** An item the feed no longer lists, and unchanged for this many days, is let go. */
  retentionDays: number;
};

export const FEED_LIMITS: FeedLimits = {
  items: 1000,
  companies: 200,
  sources: 2000,
  retentionDays: 30,
};

/** The shortest gap between two reads a person asks for on one connection. */
export const MANUAL_SYNC_MS = 60_000;

/** A connection with a declared feed, as the sync needs it. */
export type FeedConnection = {
  id: string;
  spaceId: string;
  label: string;
  status: string;
  serverId: string;
  declaration: McpLedgerDeclaration;
};

/** The connection, if it is an installed server that declares a ledger feed. */
export async function feedConnection(db: Database, id: string): Promise<FeedConnection | null> {
  const [row] = await db
    .select({
      id: connection.id,
      spaceId: connection.spaceId,
      label: connection.label,
      status: connection.status,
      provider: connection.provider,
      configuration: connection.configuration,
    })
    .from(connection)
    .where(eq(connection.id, id));
  if (row?.provider !== 'mcp') return null;
  const server = row.configuration.server as { id?: unknown; ledger?: unknown } | undefined;
  const declaration = mcpLedgerDeclaration.safeParse(server?.ledger);
  if (!declaration.success || typeof server?.id !== 'string') return null;
  return {
    id: row.id,
    spaceId: row.spaceId,
    label: row.label,
    status: row.status,
    serverId: server.id,
    declaration: declaration.data,
  };
}

/** Every active connection whose installation declares a feed. */
export async function feedConnectionIds(sql: Sql): Promise<string[]> {
  const rows = await sql`select id from connection
    where provider = 'mcp' and status = 'active'
      and configuration -> 'server' ? 'ledger'
    order by id`;
  return rows.map((row) => String(row.id));
}

export type FeedDeps = {
  db: Database;
  registry: ConnectorRegistry;
  now?: () => Date;
  limits?: FeedLimits;
};

/**
 * Read one connection's feed and write what it admits, for the owner of the
 * connection's space. `actor` is the signed-in principal when a person asked
 * for it, and absent when the service reads on its own; either way the space
 * must be one whose owner is its whole audience.
 */
export async function syncLedgerFeed(
  deps: FeedDeps,
  connectionId: string,
  actor?: string | null,
  options: {
    /** Called once the caller may read this connection, before the read; may refuse it. */
    beforeRead?: (connectionId: string) => void;
  } = {},
): Promise<LedgerSyncResult> {
  const found = await feedConnection(deps.db, connectionId);
  if (!found) throw new ServiceError('not_found', 'Not found.', 404);
  let principalId: string;
  try {
    const access = await spaceAuthority(deps.db, found.spaceId, actor ?? null);
    if (access.role !== 'owner' || access.space.audience !== 'owner' || !access.principalId)
      throw new Error('not owner');
    principalId = access.principalId;
  } catch {
    // A connection that is not the caller's is not found, never forbidden.
    throw new ServiceError('not_found', 'Not found.', 404);
  }
  if (found.status !== 'active')
    throw new ServiceError('not_connected', 'This connection is not active.', 409);
  const connector = deps.registry.get(found.id);
  if (!connector?.ledgerFeed)
    throw new ServiceError('not_connected', 'This connection is not running.', 503);

  options.beforeRead?.(found.id);

  // The time a read is written under is taken before it starts, so an older
  // answer that arrives late never overwrites a newer one already written.
  const now = (deps.now ?? (() => new Date()))();
  let answer: Record<string, unknown>;
  try {
    answer = await connector.ledgerFeed(AbortSignal.timeout(FEED_TIMEOUT_MS));
  } catch (error) {
    const reason = error instanceof LedgerFeedUnavailable ? error.reason : 'no_answer';
    throw new ServiceError(
      'not_connected',
      reason === 'not_granted'
        ? 'This connection’s ledger feed is not granted.'
        : 'This connection did not answer with its ledger feed.',
      503,
    );
  }
  const admitted = admitFeed(feedBody(answer), {
    connectionId: found.id,
    declaredActions: found.declaration.actions,
    now,
  });
  if (!admitted)
    throw new ServiceError(
      'invalid_feed',
      'This connection answered with something that is not a ledger feed.',
      502,
    );
  const written = await publishItems(deps.db, {
    spaceId: found.spaceId,
    principalId,
    connectionId: found.id,
    label: found.label,
    admitted,
    now,
    joinCompanies: found.declaration.join_companies,
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  const dropped = { ...admitted.dropped };
  for (const [reason, count] of Object.entries(written.dropped))
    dropped[reason] = (dropped[reason] ?? 0) + count;
  return {
    connection_id: found.id,
    items_seen: admitted.seen,
    items_written: written.count,
    dropped,
  };
}

/**
 * Write one feed's admitted items in one transaction, while the connection is
 * still active and within the connection's limits, then let go of what it no
 * longer stands behind.
 *
 * A source already stored under the same id must hold the same text, or the
 * items quoting it are dropped: the stored text is what a quote was checked
 * against, and it is never rewritten. An item joins a company the feed added,
 * one it already has items in, or, when the installation allows it, one a
 * mailbox scan found; a company found some other way is not the feed's to join.
 */
export async function publishItems(
  db: Database,
  input: {
    spaceId: string;
    principalId: string;
    connectionId: string;
    label: string;
    admitted: Admission;
    /** When the read began. A write older than the one already stored is not applied. */
    now: Date;
    /** Whether an item may join a company a mailbox scan found. */
    joinCompanies?: boolean;
    limits?: FeedLimits;
  },
): Promise<{ count: number; dropped: Record<string, number> }> {
  const { spaceId, principalId, connectionId, admitted, now } = input;
  const limits = input.limits ?? FEED_LIMITS;
  return db.transaction(async (tx) => {
    await tx.execute(raw`select pg_advisory_xact_lock(hashtext(${`ledger-feed:${connectionId}`}))`);
    const [live] = await tx
      .select({ status: connection.status })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.spaceId, spaceId)))
      .for('share');
    if (live?.status !== 'active')
      throw new ServiceError('not_connected', 'This connection is not active.', 409);
    const dropped: Record<string, number> = {};
    const drop = (reason: string) => {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
    };
    const ownedSource = and(
      eq(companyMessage.spaceId, spaceId),
      eq(companyMessage.principalId, principalId),
      eq(companyMessage.connectionId, connectionId),
    );
    const ownedCompany = and(
      eq(company.spaceId, spaceId),
      eq(company.principalId, principalId),
      eq(company.connectionId, connectionId),
    );
    const ownedItem = and(
      eq(ledgerItem.spaceId, spaceId),
      eq(ledgerItem.principalId, principalId),
      eq(ledgerItem.connectionId, connectionId),
    );

    // Sources: a text already stored is not stored again, and a new one is
    // stored only while the connection holds fewer than its limit.
    const ids = admitted.messages.map((message) => message.messageId);
    const storedIn = ids.length
      ? and(
          eq(companyMessage.spaceId, spaceId),
          eq(companyMessage.principalId, principalId),
          inArray(companyMessage.messageId, ids),
        )
      : undefined;
    const stored = storedIn
      ? await tx
          .select({ messageId: companyMessage.messageId })
          .from(companyMessage)
          .where(storedIn)
      : [];
    const known = new Set(stored.map((row) => row.messageId));
    const fresh = admitted.messages.filter((message) => !known.has(message.messageId));
    const [sourcesHeld] = await tx.select({ n: count() }).from(companyMessage).where(ownedSource);
    const sourceRoom = Math.max(0, limits.sources - (sourcesHeld?.n ?? 0));
    const overSources = new Set(fresh.slice(sourceRoom).map((message) => message.messageId));
    const storing = fresh.slice(0, sourceRoom);
    if (storing.length)
      await tx
        .insert(companyMessage)
        .values(
          storing.map((message) => ({
            id: newId('msg'),
            spaceId,
            principalId,
            messageId: message.messageId,
            subject: message.subject,
            fromAddress: message.from || input.label,
            receivedAt: new Date(message.receivedAt),
            body: message.text,
            connectionId,
          })),
        )
        .onConflictDoNothing();
    const held = storedIn
      ? await tx
          .select({ messageId: companyMessage.messageId, body: companyMessage.body })
          .from(companyMessage)
          .where(storedIn)
      : [];
    const text = new Map(admitted.messages.map((message) => [message.messageId, message.text]));
    const holds = new Set(
      held.filter((row) => text.get(row.messageId) === row.body).map((row) => row.messageId),
    );
    let items = admitted.items.filter((item) => {
      if (item.evidence.some((entry) => overSources.has(entry.message_id))) {
        drop('source_limit');
        return false;
      }
      const kept = item.evidence.every((entry) => holds.has(entry.message_id));
      if (!kept) drop('source_changed');
      return kept;
    });

    // Companies. A feed never renames or re-figures a company, and joins only
    // one it may: its own, one it already has items in, or a scanned one when
    // the installation allows it.
    const domains = [...new Set(items.map((item) => item.counterparty.domain))];
    const existing = domains.length
      ? await tx
          .select({ id: company.id, domain: company.domain, connectionId: company.connectionId })
          .from(company)
          .where(
            and(
              eq(company.spaceId, spaceId),
              eq(company.principalId, principalId),
              inArray(company.domain, domains),
            ),
          )
      : [];
    const holding = existing.length
      ? await tx
          .selectDistinct({ companyId: ledgerItem.companyId })
          .from(ledgerItem)
          .where(
            and(
              ownedItem,
              inArray(
                ledgerItem.companyId,
                existing.map((row) => row.id),
              ),
            ),
          )
      : [];
    const alreadyIn = new Set(holding.map((row) => row.companyId));
    const companyOf = new Map<string, string>();
    const elsewhere = new Set<string>();
    for (const row of existing) {
      if (
        row.connectionId === connectionId ||
        alreadyIn.has(row.id) ||
        (input.joinCompanies === true && row.connectionId === null)
      )
        companyOf.set(row.domain, row.id);
      else elsewhere.add(row.domain);
    }
    const missing = domains.filter((domain) => !companyOf.has(domain) && !elsewhere.has(domain));
    const [companiesHeld] = await tx.select({ n: count() }).from(company).where(ownedCompany);
    const companyRoom = Math.max(0, limits.companies - (companiesHeld?.n ?? 0));
    const overCompanies = new Set(missing.slice(companyRoom));
    const making = missing.slice(0, companyRoom);
    if (making.length) {
      await tx
        .insert(company)
        .values(
          making.map((domain) => ({
            id: newId('co'),
            spaceId,
            principalId,
            name:
              items.find((item) => item.counterparty.domain === domain)?.counterparty.name ??
              domain,
            domain,
            firstSeenAt: now,
            lastSeenAt: now,
            messageCount: 0,
            connectionId,
          })),
        )
        .onConflictDoNothing();
      // A scan may have found the domain in the meantime; then it is not the feed's.
      const made = await tx
        .select({ id: company.id, domain: company.domain })
        .from(company)
        .where(and(ownedCompany, inArray(company.domain, making)));
      for (const row of made) companyOf.set(row.domain, row.id);
      for (const domain of making) if (!companyOf.has(domain)) elsewhere.add(domain);
    }
    items = items.filter((item) => {
      const domain = item.counterparty.domain;
      if (companyOf.has(domain)) return true;
      drop(overCompanies.has(domain) ? 'company_limit' : 'company_elsewhere');
      return false;
    });

    // Items: one already held is updated, and a new one is added only while
    // the connection holds fewer than its limit.
    const keys = items.map((item) => publishedDedupeKey(connectionId, item.ref));
    const present = keys.length
      ? await tx
          .select({ key: ledgerItem.dedupeKey })
          .from(ledgerItem)
          .where(and(ownedItem, inArray(ledgerItem.dedupeKey, keys)))
      : [];
    const presentKeys = new Set(present.map((row) => row.key));
    const [itemsHeld] = await tx.select({ n: count() }).from(ledgerItem).where(ownedItem);
    let itemRoom = Math.max(0, limits.items - (itemsHeld?.n ?? 0));
    items = items.filter((item) => {
      if (presentKeys.has(publishedDedupeKey(connectionId, item.ref))) return true;
      if (itemRoom > 0) {
        itemRoom -= 1;
        return true;
      }
      drop('item_limit');
      return false;
    });

    const written = items.length
      ? await tx
          .insert(ledgerItem)
          .values(
            items.map((item) => {
              const source: PublishedSource = {
                label: input.label,
                ref: item.ref,
                state: item.state,
                next_step: item.next_step,
                parties: item.parties,
                actions: item.actions,
                published_at: now.toISOString(),
              };
              return {
                id: newId('li'),
                spaceId,
                principalId,
                companyId: companyOf.get(item.counterparty.domain) as string,
                kind: item.kind,
                direction: item.direction,
                amountMinor: item.amount_minor,
                currency: item.currency,
                dueAt: item.due_at ? new Date(item.due_at) : null,
                dueDateOnly: item.due_date_only ?? false,
                // A connection that publishes an item already closed is saying it is over.
                status: item.closed ? 'settled' : 'found',
                settledAt: item.closed ? now : null,
                // Its quotes hold against the texts it sent, and Melete vouches
                // for nothing beyond that: the connection reported it.
                confidence: 'reported',
                evidence: item.evidence,
                suggestedPlaybook: null,
                summary: item.summary,
                scanId: connectionId,
                dedupeKey: publishedDedupeKey(connectionId, item.ref),
                connectionId,
                source,
              };
            }),
          )
          // The connection's account of the item replaces the last one, unless
          // that one came from a later read. What the person decided stays
          // theirs: a dropped item stays dropped, a step being taken keeps its
          // job, and only `closed` moves an open item, one being handled
          // included, to settled. Nothing is written when nothing changed, so
          // an unchanged feed reports nothing written.
          .onConflictDoUpdate({
            target: [ledgerItem.spaceId, ledgerItem.principalId, ledgerItem.dedupeKey],
            set: {
              companyId: raw`excluded.company_id`,
              kind: raw`excluded.kind`,
              direction: raw`excluded.direction`,
              amountMinor: raw`excluded.amount_minor`,
              currency: raw`excluded.currency`,
              dueAt: raw`excluded.due_at`,
              dueDateOnly: raw`excluded.due_date_only`,
              confidence: raw`excluded.confidence`,
              evidence: raw`excluded.evidence`,
              summary: raw`excluded.summary`,
              source: raw`excluded.source`,
              status: raw`case when excluded.status = 'settled'
                and ${ledgerItem.status} in ('found', 'handling', 'waiting') then 'settled'
                else ${ledgerItem.status} end`,
              settledAt: raw`case when excluded.status = 'settled'
                and ${ledgerItem.status} in ('found', 'handling', 'waiting')
                then coalesce(${ledgerItem.settledAt}, excluded.settled_at)
                else ${ledgerItem.settledAt} end`,
            },
            setWhere: raw`${ledgerItem.connectionId} = excluded.connection_id
              and (${ledgerItem.source} ->> 'published_at') <= (excluded.source ->> 'published_at')
              and (${ledgerItem.companyId} is distinct from excluded.company_id
                or ${ledgerItem.kind} is distinct from excluded.kind
                or ${ledgerItem.direction} is distinct from excluded.direction
                or ${ledgerItem.amountMinor} is distinct from excluded.amount_minor
                or ${ledgerItem.currency} is distinct from excluded.currency
                or ${ledgerItem.dueAt} is distinct from excluded.due_at
                or ${ledgerItem.dueDateOnly} is distinct from excluded.due_date_only
                or ${ledgerItem.confidence} is distinct from excluded.confidence
                or ${ledgerItem.evidence} is distinct from excluded.evidence
                or ${ledgerItem.summary} is distinct from excluded.summary
                or (${ledgerItem.source} - 'published_at') is distinct from (excluded.source - 'published_at')
                or (excluded.status = 'settled'
                  and ${ledgerItem.status} in ('found', 'handling', 'waiting')))`,
          })
          .returning({ id: ledgerItem.id })
      : [];

    // Let go of what the connection no longer stands behind: an item it has
    // stopped listing, unchanged for the retention period, with no step being
    // taken on it and no drop to remember; then a source text none of its
    // items quotes, and a company of its own no item is about.
    const cutoff = new Date(now.getTime() - limits.retentionDays * 86_400_000).toISOString();
    const listed = admitted.refs.map((ref) => publishedDedupeKey(connectionId, ref));
    await tx
      .delete(ledgerItem)
      .where(
        and(
          ownedItem,
          isNull(ledgerItem.jobId),
          notInArray(ledgerItem.status, ['handling', 'dropped']),
          listed.length ? notInArray(ledgerItem.dedupeKey, listed) : undefined,
          raw`(${ledgerItem.source} ->> 'published_at') < ${cutoff}`,
        ),
      );
    await tx.delete(companyMessage).where(
      and(
        ownedSource,
        raw`not exists (select 1 from ledger_item l where l.connection_id = ${connectionId}
          and l.evidence @> jsonb_build_array(jsonb_build_object('message_id', ${companyMessage.messageId})))`,
      ),
    );
    await tx
      .delete(company)
      .where(
        and(
          ownedCompany,
          raw`not exists (select 1 from ledger_item l where l.company_id = ${company.id})`,
        ),
      );
    return { count: written.length, dropped };
  });
}

/**
 * Reads every declared feed on the service's own periodic schedule, pg-boss,
 * the same one the reply poller runs on. A feed that cannot be read is skipped
 * and read again next time; it never stops the feeds after it.
 *
 * Passes never overlap. A pass asked for while one runs answers at once rather
 * than starting a second beside it, and a pass stops starting reads once it
 * has used its interval less one read's timeout, so it is over before the next.
 */
export class LedgerFeedPoller {
  private started = false;
  private running: Promise<number> | null = null;

  constructor(
    readonly deps: FeedDeps & {
      sql: Sql;
      triggers: TriggerService;
      /** How long one pass may go on starting reads; the interval less one read, unless set. */
      passMs?: number;
    },
  ) {}

  /** One pass. Returns the number of items written, for tests and for logs. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<number> {
    const until = Date.now() + (this.deps.passMs ?? LEDGER_FEED_SECONDS * 1000 - FEED_TIMEOUT_MS);
    let written = 0;
    for (const id of await feedConnectionIds(this.deps.sql)) {
      if (Date.now() >= until) {
        process.stderr.write('ledger feed: pass out of time; the rest are read next time\n');
        break;
      }
      try {
        written += (await syncLedgerFeed(this.deps, id)).items_written;
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : 'failed';
        process.stderr.write(`ledger feed: ${code} ${id}\n`);
      }
    }
    return written;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const boss = this.deps.triggers.jobs.boss;
    await boss.work(QUEUES.ledgerFeeds, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => {
      await this.runOnce();
    });
    await boss.schedule(QUEUES.ledgerFeeds, '*/5 * * * *', {
      interval_seconds: LEDGER_FEED_SECONDS,
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started)
      await this.deps.triggers.jobs.boss.offWork(QUEUES.ledgerFeeds, { wait: false });
    this.started = false;
  }
}

/**
 * The action a person chose on a published item, checked against the
 * installation as it stands now rather than as it stood when the item was
 * published: the connection is active, the installation still declares the
 * action's tool, and that tool is still granted. Returns the action as stored,
 * the tool's brokered name, and the connection's label.
 */
export async function publishedAction(
  db: Database,
  item: LedgerItem,
  actionId: string,
): Promise<{ action: LedgerItemAction; toolName: string; label: string }> {
  const source = item.source;
  if (!source) throw new ServiceError('invalid_request', 'This item was not published.', 400);
  const shown = source.actions.find((entry) => entry.id === actionId);
  if (!shown) throw new ServiceError('invalid_request', 'This item offers no such step.', 400);
  const action: LedgerItemAction = {
    id: shown.id,
    label: shown.label,
    tool: shown.tool,
    input: shown.input,
  };
  const found = await feedConnection(db, source.connection_id);
  const toolName = found ? actionToolName(found.serverId, action) : null;
  const [row] = found
    ? await db
        .select({ scopes: connection.scopes })
        .from(connection)
        .where(and(eq(connection.id, found.id), eq(connection.spaceId, item.space_id)))
    : [];
  if (
    !found ||
    !toolName ||
    !row ||
    found.status !== 'active' ||
    !found.declaration.actions.includes(action.tool) ||
    !row.scopes.includes(toolName)
  )
    throw new ServiceError(
      'action_unavailable',
      'The connection that added this no longer offers that step.',
      409,
    );
  return { action, toolName, label: found.label };
}
