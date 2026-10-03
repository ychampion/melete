/**
 * Reading a connection's ledger feed and writing what it admits.
 *
 * Three rules hold here, and each is checked again at the moment it matters
 * rather than remembered from earlier:
 *
 * 1. **Only a declared feed is read.** The installation names the feed tool;
 *    a connection whose installation declares none adds nothing, whatever
 *    its tools return, and nothing a job or a model writes can declare one.
 * 2. **Only the owner's ledger receives it.** A feed is read for a connection
 *    in a space whose audience is its owner, and its items are written for that
 *    owner, so they are fenced the way the rest of the ledger is: another
 *    account, or another member of a shared space, never reads them.
 * 3. **A connection stands behind its items.** Revoking it withholds them
 *    from every read, and removing its row removes them.
 */
import {
  type LedgerItem,
  type LedgerItemAction,
  type LedgerSyncResult,
  type McpLedgerDeclaration,
  mcpLedgerDeclaration,
} from '@melete/contracts';
import { and, eq, inArray, sql as raw } from 'drizzle-orm';
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
  const now = (deps.now ?? (() => new Date()))();
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
 * still active. A source already stored under the same id must hold the same
 * text, or the items quoting it are dropped: the stored text is what a quote
 * was checked against, and it is never rewritten.
 */
export async function publishItems(
  db: Database,
  input: {
    spaceId: string;
    principalId: string;
    connectionId: string;
    label: string;
    admitted: Admission;
    now: Date;
  },
): Promise<{ count: number; dropped: Record<string, number> }> {
  const { spaceId, principalId, connectionId, admitted, now } = input;
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

    if (admitted.messages.length)
      await tx
        .insert(companyMessage)
        .values(
          admitted.messages.map((message) => ({
            id: newId('msg'),
            spaceId,
            principalId,
            messageId: message.messageId,
            subject: message.subject,
            fromAddress: message.from || input.label,
            receivedAt: new Date(message.receivedAt),
            body: message.text,
          })),
        )
        .onConflictDoNothing();
    const held = admitted.messages.length
      ? await tx
          .select({ messageId: companyMessage.messageId, body: companyMessage.body })
          .from(companyMessage)
          .where(
            and(
              eq(companyMessage.spaceId, spaceId),
              eq(companyMessage.principalId, principalId),
              inArray(
                companyMessage.messageId,
                admitted.messages.map((message) => message.messageId),
              ),
            ),
          )
      : [];
    const text = new Map(admitted.messages.map((message) => [message.messageId, message.text]));
    const holds = new Set(
      held.filter((row) => text.get(row.messageId) === row.body).map((row) => row.messageId),
    );
    const items = admitted.items.filter((item) => {
      const kept = item.evidence.every((entry) => holds.has(entry.message_id));
      if (!kept) dropped.source_changed = (dropped.source_changed ?? 0) + 1;
      return kept;
    });
    if (!items.length) return { count: 0, dropped };

    // A counterparty joins the company the person already has at that domain,
    // and a new one is made only when there is none. A feed never renames or
    // re-figures a company a scan found.
    const domains = [...new Set(items.map((item) => item.counterparty.domain))];
    await tx
      .insert(company)
      .values(
        domains.map((domain) => ({
          id: newId('co'),
          spaceId,
          principalId,
          name:
            items.find((item) => item.counterparty.domain === domain)?.counterparty.name ?? domain,
          domain,
          firstSeenAt: now,
          lastSeenAt: now,
          messageCount: 0,
        })),
      )
      .onConflictDoNothing();
    const companies = await tx
      .select({ id: company.id, domain: company.domain })
      .from(company)
      .where(
        and(
          eq(company.spaceId, spaceId),
          eq(company.principalId, principalId),
          inArray(company.domain, domains),
        ),
      );
    const companyOf = new Map(companies.map((row) => [row.domain, row.id]));

    const written = await tx
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
            confidence: 'high',
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
      // The connection's account of the item replaces the last one. What the
      // person decided about it stays theirs: a dropped item stays dropped, a
      // job keeps its item, and only `closed` moves an open item to settled.
      // Nothing is written when nothing changed, so an unchanged feed reports
      // nothing written.
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
          evidence: raw`excluded.evidence`,
          summary: raw`excluded.summary`,
          source: raw`excluded.source`,
          status: raw`case when excluded.status = 'settled'
            and ${ledgerItem.status} in ('found', 'waiting') then 'settled'
            else ${ledgerItem.status} end`,
          settledAt: raw`case when excluded.status = 'settled'
            and ${ledgerItem.status} in ('found', 'waiting')
            then coalesce(${ledgerItem.settledAt}, excluded.settled_at)
            else ${ledgerItem.settledAt} end`,
        },
        setWhere: raw`${ledgerItem.connectionId} = excluded.connection_id and (
          ${ledgerItem.companyId} is distinct from excluded.company_id
          or ${ledgerItem.kind} is distinct from excluded.kind
          or ${ledgerItem.direction} is distinct from excluded.direction
          or ${ledgerItem.amountMinor} is distinct from excluded.amount_minor
          or ${ledgerItem.currency} is distinct from excluded.currency
          or ${ledgerItem.dueAt} is distinct from excluded.due_at
          or ${ledgerItem.dueDateOnly} is distinct from excluded.due_date_only
          or ${ledgerItem.evidence} is distinct from excluded.evidence
          or ${ledgerItem.summary} is distinct from excluded.summary
          or (${ledgerItem.source} - 'published_at') is distinct from (excluded.source - 'published_at')
          or (excluded.status = 'settled' and ${ledgerItem.status} in ('found', 'waiting')))`,
      })
      .returning({ id: ledgerItem.id });
    return { count: written.length, dropped };
  });
}

/**
 * Reads every declared feed on the service's own periodic schedule, pg-boss,
 * the same one the reply poller runs on. A feed that cannot be read is skipped
 * and read again next time; it never stops the feeds after it.
 */
export class LedgerFeedPoller {
  private started = false;

  constructor(readonly deps: FeedDeps & { sql: Sql; triggers: TriggerService }) {}

  /** One pass. Returns the number of items written, for tests and for logs. */
  async runOnce(): Promise<number> {
    let written = 0;
    for (const id of await feedConnectionIds(this.deps.sql)) {
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
 * The action a person asked for on a published item, checked against the
 * installation as it stands now rather than as it stood when the item was
 * published: the connection is active, the installation still declares the
 * action's tool, and that tool is still granted. Returns the tool's brokered
 * name for the job to call.
 */
export async function publishedAction(
  db: Database,
  item: LedgerItem,
  actionId?: string,
): Promise<{ action: LedgerItemAction; toolName: string; label: string }> {
  const source = item.source;
  if (!source) throw new ServiceError('invalid_request', 'This item was not published.', 400);
  const action = actionId
    ? source.actions.find((entry) => entry.id === actionId)
    : source.actions[0];
  if (!action)
    throw new ServiceError(
      actionId ? 'invalid_request' : 'no_action',
      actionId
        ? 'This item offers no such action.'
        : 'The connection that added this offers nothing to do about it here.',
      400,
    );
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
      'The connection that added this no longer offers that action.',
      409,
    );
  return { action, toolName, label: found.label };
}
