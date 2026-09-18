/**
 * Noticing that a company wrote back.
 *
 * A chase spends most of its life waiting on a reply, and the wait it holds is
 * an event wait on a `mail.new` trigger. Something has to put that event there.
 * This is that something, and it is deliberately the smallest thing that can be:
 * it reads, it compares, and it hands what it finds to the trigger service that
 * already knows how to wake a job exactly once.
 *
 * Three properties it is built to keep:
 *
 * 1. **It cannot send.** The mailbox is read through the registered connector's
 *    own `email.search` tool, with a service-minted action whose effect class is
 *    `read` — the same route the scan uses, not a second one. Nothing in this
 *    file opens a transport or proposes an effect.
 * 2. **One reply is one wake.** Delivery is keyed by the message id, and
 *    `TriggerService.deliver` dedupes on `connector:<connection>:<dedup_key>`,
 *    so the same message seen on ten polls is one event and one wake.
 * 3. **Only the company it is about.** A message counts only when its sender's
 *    registrable domain is the company's own and it arrived after the first
 *    message went out. Everything else in the mailbox is somebody else's business.
 *
 * It finds its work from the job rather than from the ledger tables, which
 * another lane owns: a job holding a `mail.new` trigger, with a message already
 * sent, is exactly a ledger item being handled. `candidatesFrom` is a plain
 * function over rows so the integrator can swap in a ledger-scoped query without
 * touching anything else here.
 */
import { jobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { QUEUES } from '../jobs/queue.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { connectorMailbox, MAILBOX_READ_LIMIT } from './mailbox.ts';
import { registrableDomain, type ScanMessage, senderAddress } from './messages.ts';

/** The event a waiting chase listens on. Must match `REPLY_EVENT_NAME`. */
export const REPLY_EVENT_NAME = 'mail.new';

/** How often the mailbox is looked at. Modest: a reply is not an emergency. */
export const REPLY_POLL_SECONDS = 120;

/**
 * The same interval, said in the only language the scheduler listens to.
 *
 * pg-boss schedules on cron and the payload beside it is data nobody reads, so
 * a constant that disagrees with the cron is not a slower poll, it is a comment
 * that is wrong. The cron is derived here rather than written out, and a test
 * reads the interval back out of it, so the two cannot drift apart. Cron's
 * finest grain is a minute, which is why the interval is minutes.
 */
export const REPLY_POLL_CRON = `*/${Math.max(1, Math.round(REPLY_POLL_SECONDS / 60))} * * * *`;

/** The connector refuses a larger read; the ceiling is the mailbox's, not ours. */
export const REPLY_READ_LIMIT = MAILBOX_READ_LIMIT;

/** How many chases one query asks for. A pass turns as many pages as it needs. */
export const REPLY_CANDIDATE_PAGE = 200;

/**
 * A ceiling on the pages one pass will turn, so a query that somehow stops
 * making progress ends the pass instead of running forever. At the page size
 * above this is forty thousand chases, which is far past anything real.
 */
export const REPLY_MAX_PAGES = 200;

/**
 * One message, as little of it as deciding needs — a narrowing of what the scan
 * already reads, so the two cannot disagree about what a message is.
 */
export type ReplyMessage = Pick<ScanMessage, 'messageId' | 'from' | 'subject' | 'receivedAt'>;

/** A job waiting on a reply, and what would count as one. */
export type ReplyCandidate = {
  jobId: string;
  spaceId: string;
  connectionId: string;
  triggerId: string;
  /** The company's registrable domain, from the job's own allowed domains. */
  domain: string;
  /** When the first message went out. Anything older is not a reply to it. */
  since: string;
};

export interface ReplyMailbox {
  /** Newest first, the connector's hygiene already applied. */
  recent(limit: number): Promise<ReplyMessage[]>;
}

// --------------------------------------------------------------------------
// who sent it
// --------------------------------------------------------------------------

// Who a message is from is answered by the scan's parser, not by a second one
// here. That answer decides whether a stranger can wake somebody's chase, so
// two copies of it would be two rules that drift apart without anything saying
// so — and the one that drifted would be the one nobody was reading.

/**
 * The company a job is about, read off the domains it was allowed to fetch.
 * `handleLedgerItem` puts the bare domain and its `www.` form there, so the one
 * that is not a `www.` is the company.
 */
export function companyDomain(allowed: readonly string[]): string | null {
  const bare = allowed.find((entry) => !entry.toLowerCase().startsWith('www.')) ?? allowed[0];
  return bare ? registrableDomain(bare) : null;
}

/** Is this message the company writing back about the message we sent? */
export function isReplyFrom(
  candidate: Pick<ReplyCandidate, 'domain' | 'since'>,
  message: ReplyMessage,
): boolean {
  if (!message.messageId) return false;
  const sender = senderAddress(message.from);
  if (!sender || registrableDomain(sender) !== candidate.domain) return false;
  const at = Date.parse(message.receivedAt);
  const since = Date.parse(candidate.since);
  if (!Number.isFinite(at) || !Number.isFinite(since)) return false;
  // Strictly after: a message stamped at the same second as our own send is not
  // an answer to it.
  return at > since;
}

// --------------------------------------------------------------------------
// what to look at
// --------------------------------------------------------------------------

/** A message that really left, in a deployment that really sends. */
const PRODUCTION_SEND_KINDS = ['email.send'];
/** The same, plus the scripted connector's, where that connector is built. */
const SEND_KINDS = [...PRODUCTION_SEND_KINDS, 'test.send'];

export type CandidateRow = {
  job_id: unknown;
  space_id: unknown;
  constraints: unknown;
  trigger_id: unknown;
  spec: unknown;
  first_send_at: unknown;
};

/** Rows to candidates, pure, so the query and the judgement are testable apart. */
export function candidatesFrom(rows: readonly CandidateRow[]): ReplyCandidate[] {
  const candidates: ReplyCandidate[] = [];
  for (const row of rows) {
    const constraints = jobConstraints.safeParse(row.constraints);
    const spec = row.spec as { connection_id?: unknown; event_name?: unknown } | null;
    const connectionId = typeof spec?.connection_id === 'string' ? spec.connection_id : null;
    const domain = constraints.success ? companyDomain(constraints.data.allowed_domains) : null;
    const since =
      row.first_send_at instanceof Date
        ? row.first_send_at.toISOString()
        : typeof row.first_send_at === 'string'
          ? new Date(row.first_send_at).toISOString()
          : null;
    if (!connectionId || !domain || !since) continue;
    if (spec?.event_name !== REPLY_EVENT_NAME) continue;
    candidates.push({
      jobId: String(row.job_id),
      spaceId: String(row.space_id),
      connectionId,
      triggerId: String(row.trigger_id),
      domain,
      since,
    });
  }
  return candidates;
}

/**
 * Every live chase that has already written to somebody. A job that has sent
 * nothing has nothing to be replied to, and a finished job is finished.
 *
 * The connection is joined and required to be active in the job's own space.
 * Revocation is a person saying stop, and stopping has to be decided by the row
 * they changed rather than by whether some registry still happens to hold a
 * connector for it — a mailbox nobody may read is not read.
 */
export async function readCandidates(
  sql: Sql,
  options: { after?: string; limit?: number; includeTestSends?: boolean } = {},
): Promise<ReplyCandidate[]> {
  const limit = options.limit ?? REPLY_CANDIDATE_PAGE;
  // Keyset, not offset: the pass walks job ids upward and asks for what comes
  // after the last one it read, so a chase settling mid-pass cannot shuffle a
  // later one into a page that has already gone by.
  const after = options.after ?? '';
  // A deployment without the scripted connector has no business looking for
  // mail sent through it, so the test kind is named only where it exists. The
  // flag is the same one that decides whether the connector is built at all.
  const kinds = options.includeTestSends ? SEND_KINDS : PRODUCTION_SEND_KINDS;
  const rows = await sql`
    select j.id as job_id, j.space_id, j.constraints, t.id as trigger_id, t.spec,
      min(a.resolved_at) as first_send_at
    from job j
      join trigger t on t.job_id = j.id and t.enabled = true
        and t.spec->>'event_name' = ${REPLY_EVENT_NAME}
      join connection c on c.id = t.spec->>'connection_id'
        and c.space_id = j.space_id and c.status = 'active'
      join action a on a.job_id = j.id and a.status = 'succeeded'
        and a.kind = any(${kinds}) and a.resolved_at is not null
    where j.state not in ('completed', 'failed', 'cancelled')
      and (${after} = '' or j.id > ${after})
    group by j.id, j.space_id, j.constraints, t.id, t.spec
    order by j.id
    limit ${limit}`;
  return candidatesFrom(rows as unknown as CandidateRow[]);
}

// --------------------------------------------------------------------------
// reading the mailbox
// --------------------------------------------------------------------------

/** A fixed set of messages, for tests. */
export function fixtureReplyMailbox(messages: readonly ReplyMessage[]): ReplyMailbox {
  return {
    async recent(limit) {
      return [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    },
  };
}

/**
 * The installed mailbox — the scan's own reader, borrowed.
 *
 * The action that reaches a connector is minted in exactly one place, which is
 * `connectorMailbox`. A second copy of those forty lines here would be a second
 * place for an effect class or a tool name to be got wrong, and the thing that
 * would be got wrong is the promise that this can only read. A `ScanMessage`
 * already carries everything a reply needs and guarantees the message id, so
 * there is nothing left to adapt.
 */
export const connectorReplyMailbox = (options: {
  registry: ConnectorRegistry;
  connectionId: string;
  spaceId: string;
  undatedAt: string;
}): ReplyMailbox => connectorMailbox(options);

// --------------------------------------------------------------------------
// the poller
// --------------------------------------------------------------------------

/**
 * What one pass did. `failed` is a count rather than a thrown error because a
 * pass that skipped one unreadable chase still did its job for the rest, and a
 * caller that logs this can tell the difference between quiet and broken.
 */
export type ReplyPass = { delivered: number; failed: number };

export type ReplyPollerDeps = {
  sql: Sql;
  triggers: TriggerService;
  /** How to read one candidate's mailbox. Production reads the connector. */
  mailboxFor: (candidate: ReplyCandidate) => ReplyMailbox;
  /** How many chases one query asks for. Tests use a small one to turn pages. */
  pageSize?: number;
  /**
   * Whether mail sent through the scripted connector counts as a first message.
   * The service passes `MELETE_ENABLE_TEST_CONNECTOR`, the same flag that
   * decides whether that connector is built at all.
   */
  includeTestSends?: boolean;
};

/**
 * Hand one candidate's replies to the trigger service. Returns how many events
 * were new, so a caller can say what it did without reading the event table.
 */
export async function deliverReplies(
  deps: Pick<ReplyPollerDeps, 'triggers' | 'mailboxFor'>,
  candidate: ReplyCandidate,
): Promise<number> {
  const messages = await deps.mailboxFor(candidate).recent(REPLY_READ_LIMIT);
  // Oldest first, so a company that wrote twice wakes the job in the order it
  // wrote rather than in the order the mailbox happened to list.
  const replies = messages
    .filter((message) => isReplyFrom(candidate, message))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  let delivered = 0;
  for (const message of replies) {
    const received = await deps.triggers.deliver({
      connection_id: candidate.connectionId,
      event_name: REPLY_EVENT_NAME,
      // The message id is the identity of the thing that happened, so it is both
      // the cursor and the key that makes a second sighting a duplicate.
      cursor: message.messageId,
      dedup_key: message.messageId,
      payload: {
        message_id: message.messageId,
        from: message.from,
        subject: message.subject,
        received_at: message.receivedAt,
      },
    });
    if (!received.duplicate) delivered += 1;
  }
  return delivered;
}

/**
 * Looks at the mailbox on the service's own periodic scheduling, which is
 * pg-boss, the same one the recovery scan runs on. There is no second scheduler
 * and no timer of its own.
 */
export class CompanyReplyPoller {
  private started = false;

  constructor(readonly deps: ReplyPollerDeps) {}

  /** One pass. Returns the number of new events, for tests and for logs. */
  async runOnce(): Promise<ReplyPass> {
    const limit = this.deps.pageSize ?? REPLY_CANDIDATE_PAGE;
    let delivered = 0;
    let failed = 0;
    let after: string | undefined;
    // Every waiting chase, not the first page of them. A person whose job id
    // sorts late is owed their reply as much as anyone.
    for (let page = 0; page < REPLY_MAX_PAGES; page += 1) {
      const batch = await readCandidates(this.deps.sql, {
        after,
        limit,
        includeTestSends: this.deps.includeTestSends,
      });
      if (batch.length === 0) break;
      for (const candidate of batch) {
        // One chase that cannot be read is one chase missing from this pass,
        // not a failed pass. A space deleted or a credential pulled between the
        // query and the read throws here, and every other person waiting on a
        // reply is owed their turn regardless. The same judgement the scan
        // makes about a message the extractor cannot read.
        try {
          delivered += await deliverReplies(this.deps, candidate);
        } catch {
          failed += 1;
        }
      }
      if (batch.length < limit) break;
      after = batch.at(-1)?.jobId;
      if (!after) break;
    }
    return { delivered, failed };
  }

  async start(): Promise<void> {
    if (this.started) return;
    const boss = this.deps.triggers.jobs.boss;
    await boss.work(
      QUEUES.companyReplies,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async () => {
        await this.runOnce();
      },
    );
    // The cron is the whole of the schedule; there is no payload to carry,
    // because nothing on the other side would read one.
    await boss.schedule(QUEUES.companyReplies, REPLY_POLL_CRON);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.deps.triggers.jobs.boss.offWork(QUEUES.companyReplies, { wait: false });
    }
    this.started = false;
  }
}
