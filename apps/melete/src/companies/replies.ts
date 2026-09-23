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
import { canonicalizePayload, jobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import { EmailConnector } from '../connectors/email.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { newId } from '../ids.ts';
import { QUEUES } from '../jobs/queue.ts';
import type { TriggerService } from '../jobs/triggers.ts';

/** The event a waiting chase listens on. Must match `REPLY_EVENT_NAME`. */
export const REPLY_EVENT_NAME = 'mail.new';

/** How often the mailbox is looked at. Modest: a reply is not an emergency. */
export const REPLY_POLL_SECONDS = 120;

/** The connector refuses a larger read; this is its ceiling, not a choice. */
export const REPLY_READ_LIMIT = 50;

/** One message, as little of it as deciding needs. No body is read here. */
export type ReplyMessage = {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
};

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

/**
 * Every address in a From header, lowercased. Quoted display names and
 * comments are set aside first, so `"Acme, Inc." <a@acme.test>` is one address
 * and `billing@acme.test (Acme Billing)` is `billing@acme.test`. A part that is
 * not an address makes the whole header unreadable, which reads as nobody.
 */
export function fromAddresses(from: string): string[] {
  let text = from.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  }
  const addresses: string[] = [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angled = /<([^<>@\s]+@[^<>@\s]+)>/.exec(trimmed)?.[1];
    const address = angled ?? (/^[^<>@\s"]+@[^<>@\s"]+$/.test(trimmed) ? trimmed : null);
    if (!address) return [];
    addresses.push(address.toLowerCase());
  }
  return addresses;
}

/**
 * The one company a From header speaks for: the registrable domain every
 * address in it shares, or nothing. A header naming two companies is not a
 * reply from either, whichever of them comes last.
 */
export function senderDomain(from: string): string | null {
  const domains = new Set(fromAddresses(from).map((address) => registrableDomain(address)));
  if (domains.size !== 1) return null;
  const [domain] = domains;
  return domain ?? null;
}

/**
 * Suffixes registrations happen under, so `billing.acme.co.uk` and
 * `mail.acme.co.uk` are one company. A short list rather than the public suffix
 * list: anything it does not know is cut to its last two labels, which is right
 * for every single-label suffix. Kept in step with the scan's own copy.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'co.in',
  'net.in',
  'org.in',
  'co.jp',
  'or.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.sg',
  'com.mx',
  'co.za',
]);

/** The registrable domain of an address or host: the company's identity. */
export function registrableDomain(value: string): string | null {
  const at = value.lastIndexOf('@');
  const host = (at < 0 ? value : value.slice(at + 1)).trim().toLowerCase().replace(/\.$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..'))
    return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

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
  if (senderDomain(message.from) !== candidate.domain) return false;
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
 */
export async function readCandidates(sql: Sql, limit = 200): Promise<ReplyCandidate[]> {
  const rows = await sql`
    select j.id as job_id, j.space_id, j.constraints, t.id as trigger_id, t.spec,
      min(a.resolved_at) as first_send_at
    from job j
      join trigger t on t.job_id = j.id and t.enabled = true
        and t.spec->>'event_name' = ${REPLY_EVENT_NAME}
      join action a on a.job_id = j.id and a.status = 'succeeded'
        and a.kind in ('email.send', 'test.send') and a.resolved_at is not null
    where j.state not in ('completed', 'failed', 'cancelled')
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
 * The installed mailbox, read through the registered connector with a minted
 * read action. The action is never recorded as an effect: an agent looking at
 * mail is not something that happened to the world.
 *
 * A message the server could not date is dated when this read first sees it,
 * so a reply is read rather than dropped; delivery is keyed by message id, so
 * seeing it again on a later read is not a second wake.
 */
export function connectorReplyMailbox(options: {
  registry: ConnectorRegistry;
  connectionId: string;
  spaceId: string;
}): ReplyMailbox {
  return {
    async recent(limit) {
      const readAt = new Date().toISOString();
      const connector = options.registry.get(options.connectionId);
      if (!(connector instanceof EmailConnector)) return [];
      const id = newId('act');
      const payload = canonicalizePayload({
        query: '',
        limit: Math.min(limit, REPLY_READ_LIMIT),
      });
      const result = await connector.execute(
        {
          id,
          job_id: id,
          attempt_id: id,
          connection_id: options.connectionId,
          kind: 'email.search',
          effect_class: 'read',
          canonical_payload: payload.canonical,
          payload_hash: payload.hash,
          intent_key: null,
          status: 'dispatched',
          authorization_ref: null,
          budget_reservation: null,
          idempotency_key: id,
          dispatched_at: readAt,
          receipt: null,
          resolved_at: null,
          reconciliation: null,
          repair_trace: [],
          repair_counters: {},
          repair_disposition: null,
          retry_after_at: null,
          created_at: readAt,
        },
        {
          job_id: id,
          space_id: options.spaceId,
          idempotency_key: id,
          constraints: jobConstraints.parse({}),
        },
      );
      if (result.outcome !== 'succeeded') return [];
      const messages = result.receipt.detail.messages;
      if (!Array.isArray(messages)) return [];
      const read: ReplyMessage[] = [];
      for (const entry of messages) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const messageId = typeof record.message_id === 'string' ? record.message_id : '';
        // A message with no id cannot be delivered once rather than twice.
        if (!messageId) continue;
        read.push({
          messageId,
          from: String(record.from ?? ''),
          subject: String(record.subject ?? ''),
          receivedAt: typeof record.date === 'string' ? record.date : readAt,
        });
      }
      return read.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    },
  };
}

// --------------------------------------------------------------------------
// the poller
// --------------------------------------------------------------------------

export type ReplyPollerDeps = {
  sql: Sql;
  triggers: TriggerService;
  /** How to read one candidate's mailbox. Production reads the connector. */
  mailboxFor: (candidate: ReplyCandidate) => ReplyMailbox;
};

/**
 * The observation a reply is delivered as. `sender_domain` is what a chase's
 * watch compares, so the judgement of who sent it is made once, here, from the
 * parsed header rather than by a pattern over its text.
 */
export function replyPayload(message: ReplyMessage) {
  return {
    message_id: message.messageId,
    from: message.from,
    sender_domain: senderDomain(message.from),
    subject: message.subject,
    received_at: message.receivedAt,
  };
}

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
      payload: replyPayload(message),
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
  async runOnce(): Promise<number> {
    let delivered = 0;
    for (const candidate of await readCandidates(this.deps.sql)) {
      // One chase whose mailbox cannot take a reply right now must not stop
      // every chase after it from being read. Its reply is still in the
      // mailbox, and delivery is keyed by message id, so the next pass that
      // succeeds delivers it once.
      try {
        delivered += await deliverReplies(this.deps, candidate);
      } catch {
        process.stderr.write(`company replies: delivery_failed ${candidate.jobId}\n`);
      }
    }
    return delivered;
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
    await boss.schedule(QUEUES.companyReplies, '* * * * *', {
      interval_seconds: REPLY_POLL_SECONDS,
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.deps.triggers.jobs.boss.offWork(QUEUES.companyReplies, { wait: false });
    }
    this.started = false;
  }
}
