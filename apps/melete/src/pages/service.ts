/**
 * Pages a connection shows the person (MCP Apps), and the wait on them.
 *
 * Opening: a tool call on a connected server that names a page succeeded, and
 * the page was read from the server. In one transaction Melete keeps the page,
 * makes a watch on this connection's `page.settled` event for this page, and,
 * unless the turn already set a wait, records the wait for the turn: when the
 * turn ends, the conversation waits on the page, the way it waits on an
 * approval, until the server reports or the page expires.
 *
 * Settling: only the connection's server can settle a page. With the call that
 * opened it, Melete handed the server a report address and a key made for that
 * page alone. The server signs its report with the key (Standard Webhooks:
 * `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC>`).
 * The page never sees the key, and nothing the page says or posts reaches the
 * conversation, so a page cannot claim it is done.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type Action,
  type ConnectionPage,
  connectionPage,
  isTerminal,
  type JsonObject,
  jobState,
  PAGE_LIMITS,
  type PageReport,
  pageReport,
  type TriggerSpec,
  triggerSpec,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { appendEvent, lockJob } from '../broker/records.ts';
import type { OpenedPage } from '../connectors/mcp.ts';
import { allowedDomains, type PageDomains, pagePolicy } from '../connectors/mcp-ui.ts';
import { newId } from '../ids.ts';

/** The event a connection's page settles with; a watch on it names the page. */
export const PAGE_SETTLED = 'page.settled';

/** SQL for "this trigger is a watch on a connection's page". */
export const PAGE_WATCH_SQL = (alias: string) =>
  `${alias}.kind = 'watch' and ${alias}.spec->>'event_name' = '${PAGE_SETTLED}' and ${alias}.spec #>> '{predicate,all,0,field}' = 'page_id'`;

const PAGE_ID = /^cpg_[0-9A-Z]{26}$/;

/** The page a service-made watch follows, or null for any other trigger. */
export function watchedPage(spec: unknown): string | null {
  const parsed = triggerSpec.safeParse(spec);
  if (!parsed.success || parsed.data.kind !== 'watch') return null;
  if (parsed.data.event_name !== PAGE_SETTLED) return null;
  const [first] = parsed.data.predicate.all;
  if (first?.field !== 'page_id' || first.op !== 'eq' || typeof first.value !== 'string')
    return null;
  return PAGE_ID.test(first.value) ? first.value : null;
}

export function pageWatchSpec(connectionId: string, pageId: string): TriggerSpec {
  return triggerSpec.parse({
    kind: 'watch',
    connection_id: connectionId,
    event_name: PAGE_SETTLED,
    poll_seconds: 300,
    predicate: { all: [{ field: 'page_id', op: 'eq', value: pageId }] },
  });
}

/* ---------- report keys and signatures ---------- */

/** The key a page's server signs its report with, made from the installation's secret. */
export function pageReportKey(secret: string, pageId: string): string {
  const raw = createHmac('sha256', secret).update(`melete page report v1\n${pageId}`).digest();
  return `whsec_${raw.toString('base64')}`;
}

/** A Standard Webhooks signature over one message, as a server computes it. */
export function signReport(key: string, id: string, timestamp: number, body: string): string {
  const raw = Buffer.from(key.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', raw).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export type ReportHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

/** Whether the headers sign this body with this page's key, within the time allowed. */
export function reportSigned(
  key: string,
  headers: ReportHeaders,
  body: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || id.length > 256 || !/^[\x21-\x7e]+$/.test(id)) return false;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || signature.length > 2048)
    return false;
  const seconds = Number(timestamp);
  if (Math.abs(now / 1000 - seconds) > PAGE_LIMITS.report_tolerance_seconds) return false;
  const expected = Buffer.from(signReport(key, id, seconds, body).slice(3), 'base64');
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/* ---------- view tokens ---------- */

const TOKEN_PART = /^[A-Za-z0-9_-]+$/;
const PRINCIPAL = /^[A-Za-z0-9_]{1,80}$/;
const TAG = /^[0-9a-f]{32}$/;
/** A frame lasts at most as long as a page may wait. */
export const PAGE_VIEW_TTL_SECONDS = PAGE_LIMITS.max_ttl_seconds;

export type PageViewClaims = {
  pageId: string;
  principalId: string;
  sessionTag: string;
  expiresAt: number;
};

/** What lets a framed page load: one page, one person, one browser session. Signed, not stored. */
export class PageViewTokens {
  private readonly key: Buffer;
  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac('sha256', secret).update('melete page view token v1').digest();
  }
  private mac(body: string) {
    return createHmac('sha256', this.key).update(body).digest();
  }
  issue(claims: Omit<PageViewClaims, 'expiresAt'>, until: number) {
    if (
      !PAGE_ID.test(claims.pageId) ||
      !PRINCIPAL.test(claims.principalId) ||
      !TAG.test(claims.sessionTag)
    )
      throw new Error('a page view names a page, a person and a session');
    const expiresAt = Math.min(
      Math.floor(this.now() / 1000) + PAGE_VIEW_TTL_SECONDS,
      Math.floor(until / 1000),
    );
    const body = Buffer.from(
      [
        'v1',
        claims.pageId,
        claims.principalId,
        claims.sessionTag,
        String(expiresAt),
        randomBytes(9).toString('base64url'),
      ].join('.'),
    ).toString('base64url');
    return { token: `${body}.${this.mac(body).toString('base64url')}`, expiresAt };
  }
  verify(token: string | undefined): PageViewClaims | null {
    if (!token || token.length > 512) return null;
    const [body, signature, ...rest] = token.split('.');
    if (!body || !signature || rest.length || !TOKEN_PART.test(body) || !TOKEN_PART.test(signature))
      return null;
    const expected = this.mac(body);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const fields = Buffer.from(body, 'base64url').toString('utf8').split('.');
    const [version, pageId, principalId, tag, expires, nonce] = fields;
    if (
      fields.length !== 6 ||
      version !== 'v1' ||
      !pageId ||
      !PAGE_ID.test(pageId) ||
      !principalId ||
      !PRINCIPAL.test(principalId) ||
      !tag ||
      !TAG.test(tag) ||
      !nonce ||
      !/^\d{1,12}$/.test(expires ?? '')
    )
      return null;
    const expiresAt = Number(expires);
    if (expiresAt * 1000 <= this.now()) return null;
    return { pageId, principalId, sessionTag: tag, expiresAt };
  }
}

/* ---------- opening ---------- */

export type OpenPageInput = {
  pageId: string;
  action: Action;
  connectionId: string;
  spaceId: string;
  serverOrigin: string;
  /** Origins this connection's pages may use: the server's own and the operator's. */
  allowedOrigins: readonly string[];
  source: OpenedPage;
  ttlSeconds?: number;
};

const NOTE_WAITING =
  "The page is on the person's screen now, from this connection. Say in a sentence what it is for and end this turn. Do not say it is done: the conversation goes on by itself when the connection's server reports what happened on the page, or when the page expires.";
const NOTE_NOT_WAITING =
  "The page is on the person's screen now, from this connection. This turn already waits on something else, so it does not wait on the page; the connection's server reports what happened there.";

/** How long the server asked the page to wait, within what a page may. */
export function pageTtl(result: JsonObject): number {
  const meta = result._meta;
  const own =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)['io.melete/page']
      : undefined;
  const asked =
    own && typeof own === 'object' && !Array.isArray(own)
      ? (own as Record<string, unknown>).expires_in_seconds
      : undefined;
  return typeof asked === 'number' && Number.isInteger(asked) && asked >= 60
    ? Math.min(asked, PAGE_LIMITS.max_ttl_seconds)
    : PAGE_LIMITS.default_ttl_seconds;
}

/** What the page is handed must fit; past the limit it gets the result's text alone. */
function handoff(source: OpenedPage): { input: JsonObject; result: JsonObject } {
  const size = Buffer.byteLength(JSON.stringify([source.arguments, source.result]));
  if (size <= PAGE_LIMITS.handoff_max_bytes)
    return { input: source.arguments, result: source.result };
  return { input: {}, result: { content: [], isError: false } };
}

/** Keeps a page a call opened and makes the conversation wait on it. Returns the receipt's note. */
export async function openPage(sql: Sql, input: OpenPageInput): Promise<JsonObject> {
  const ttl = input.ttlSeconds ?? pageTtl(input.source.result);
  const domains: PageDomains = allowedDomains(input.source.declared, input.allowedOrigins);
  const { input: toolInput, result: toolResult } = handoff(input.source);
  return (await sql.begin(async (tx) => {
    const job = await lockJob(tx, input.action.job_id);
    if (isTerminal(jobState.parse(job.state)))
      return { shown: false, note: 'This conversation has ended, so the page was not shown.' };
    const [person] =
      await tx`select coalesce(requested_by_principal_id, principal_id) as id from job
      where id = ${job.id}`;
    const triggerId = newId('trg');
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await tx`insert into connection_page (id, job_id, action_id, connection_id, space_id,
        principal_id, trigger_id, resource_uri, html, domains, open_origins, server_origin,
        tool_input, tool_result, expires_at)
      values (${input.pageId}, ${job.id}, ${input.action.id}, ${input.connectionId},
        ${input.spaceId}, ${person?.id ?? null}, ${triggerId}, ${input.source.resourceUri},
        ${input.source.html}, ${JSON.stringify(domains)}::jsonb,
        ${JSON.stringify(input.allowedOrigins)}::jsonb, ${input.serverOrigin},
        ${JSON.stringify(toolInput)}::jsonb, ${JSON.stringify(toolResult)}::jsonb,
        ${expiresAt.toISOString()})`;
    const spec = pageWatchSpec(input.connectionId, input.pageId);
    // From now on: lockJob holds the event order, so nothing below this
    // sequence number is still to commit.
    const [last] = await tx`select coalesce(max(seq), 0)::bigint as seq from event`;
    await tx`insert into trigger (id, job_id, kind, spec, cursor)
      values (${triggerId}, ${job.id}, 'watch', ${JSON.stringify(spec)}::jsonb,
        ${String(last?.seq ?? 0)})`;
    await appendEvent(
      tx,
      job.id,
      null,
      'notice',
      { kind: 'trigger_created', trigger_id: triggerId, spec },
      `${triggerId}:created`,
    );
    const attemptId = input.action.attempt_id;
    const waiting = await waitForPage(tx, job.id, attemptId, triggerId, expiresAt);
    return {
      shown: true,
      page_id: input.pageId,
      expires_at: expiresAt.toISOString(),
      note: waiting ? NOTE_WAITING : NOTE_NOT_WAITING,
    };
  })) as JsonObject;
}

/**
 * Records the turn's wait on the page, as `job.wait` would, unless the turn
 * already asked the person something or set another wait.
 */
async function waitForPage(
  tx: TransactionSql,
  jobId: string,
  attemptId: string | null,
  triggerId: string,
  expiresAt: Date,
): Promise<boolean> {
  if (!attemptId) return false;
  const [busy] = await tx`select 1 from event
    where dedup_key in (${`${attemptId}:runtime-wait`}, ${`${attemptId}:ask-person`}) limit 1`;
  if (busy) return false;
  await appendEvent(
    tx,
    jobId,
    attemptId,
    'notice',
    {
      kind: 'runtime_wait_requested',
      wait: { kind: 'event', trigger_id: triggerId, deadline_at: expiresAt.toISOString() },
    },
    `${attemptId}:runtime-wait`,
  );
  return true;
}

/* ---------- reading and settling ---------- */

type PageRow = {
  id: string;
  job_id: string;
  connection_id: string;
  principal_id: string | null;
  state: string;
  summary: string | null;
  html: string;
  domains: PageDomains;
  open_origins: string[];
  server_origin: string;
  tool_input: JsonObject;
  tool_result: JsonObject;
  created_at: Date;
  expires_at: Date;
  settled_at: Date | null;
  label: string;
};

/** The driver hands timestamps back as text; a page row holds dates. */
function asPage(row: PageRow): PageRow {
  return {
    ...row,
    created_at: new Date(row.created_at),
    expires_at: new Date(row.expires_at),
    settled_at: row.settled_at ? new Date(row.settled_at) : null,
  };
}

/** A page past its time is expired, whatever it was stored as while open. */
const stateOf = (row: Pick<PageRow, 'state' | 'expires_at'>, now = Date.now()) =>
  row.state === 'open' && row.expires_at.getTime() <= now ? 'expired' : row.state;

export const EXPIRED_SUMMARY = 'The page expired before its connection reported anything.';

export function pageView(row: PageRow, now = Date.now()): ConnectionPage {
  const state = stateOf(row, now);
  return connectionPage.parse({
    id: row.id,
    conversation_id: row.job_id,
    connection_label: row.label,
    connection_origin: row.server_origin,
    state,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    settled_at: row.settled_at?.toISOString() ?? null,
    summary: state === 'expired' && row.state === 'open' ? EXPIRED_SUMMARY : row.summary,
    open_origins: row.open_origins,
  });
}

export type DeliverPageEvent = (input: {
  connection_id: string;
  event_name: string;
  cursor: string;
  dedup_key: string;
  payload: JsonObject;
}) => Promise<unknown>;

export type ReportOutcome =
  | { ok: true; state: string; repeated: boolean }
  | { ok: false; status: 400 | 401 | 404 | 409 | 410; message: string };

/**
 * A server's report on its page. Believed only for its signature; settles an
 * open page once. The same report again is answered as before; another one
 * after it is refused.
 */
export async function settlePage(
  sql: Sql,
  deliver: DeliverPageEvent,
  secret: string,
  pageId: string,
  headers: ReportHeaders,
  body: string,
  now = Date.now(),
): Promise<ReportOutcome> {
  if (!PAGE_ID.test(pageId)) return { ok: false, status: 404, message: 'No such page.' };
  // The signature first: nothing is said about a page to anyone who cannot sign for it.
  if (!reportSigned(pageReportKey(secret, pageId), headers, body, now))
    return { ok: false, status: 401, message: 'The report is not signed for this page.' };
  const [found] = await sql<PageRow[]>`select p.*, c.label from connection_page p
    join connection c on c.id = p.connection_id where p.id = ${pageId}`;
  if (!found) return { ok: false, status: 404, message: 'No such page.' };
  const row = asPage(found);
  let report: PageReport;
  try {
    report = pageReport.parse(JSON.parse(body));
  } catch {
    return { ok: false, status: 400, message: 'The report is not a page report.' };
  }
  if (Buffer.byteLength(JSON.stringify(report.data ?? {})) > PAGE_LIMITS.report_max_bytes)
    return { ok: false, status: 400, message: 'The report is too large.' };
  const state = stateOf(row, now);
  if (state !== 'open') {
    if (state === report.status && row.summary === report.summary)
      return { ok: true, state, repeated: true };
    return state === 'expired'
      ? { ok: false, status: 410, message: 'The page expired before this report.' }
      : { ok: false, status: 409, message: 'The page was already settled.' };
  }
  // The event first: it is delivered once whatever happens below, and a
  // report sent again after a failure here finds it and settles the row.
  await deliver({
    connection_id: row.connection_id,
    event_name: PAGE_SETTLED,
    cursor: pageId,
    dedup_key: `page:${pageId}`,
    payload: {
      page_id: pageId,
      status: report.status,
      summary: report.summary,
      ...(report.data ? { data: report.data } : {}),
      origin_trust: 'external_content',
    },
  });
  const [settled] = await sql`update connection_page
    set state = ${report.status}, summary = ${report.summary},
      report_data = ${report.data ? JSON.stringify(report.data) : null}::jsonb,
      report_id = ${headers.id ?? null}, settled_at = now()
    where id = ${pageId} and state = 'open' returning id`;
  if (!settled) return { ok: false, status: 409, message: 'The page was already settled.' };
  return { ok: true, state: report.status, repeated: false };
}

const PAGE_COLUMNS = (sql: Sql) => sql`p.id, p.job_id, p.connection_id, p.principal_id,
  p.state, p.summary, p.domains, p.open_origins, p.server_origin, p.created_at, p.expires_at,
  p.settled_at, c.label`;

/** A conversation's pages, newest first. The caller has checked the person may read it. */
export async function conversationPages(sql: Sql, jobId: string): Promise<ConnectionPage[]> {
  const rows = await sql<PageRow[]>`select ${PAGE_COLUMNS(sql)} from connection_page p
    join connection c on c.id = p.connection_id
    where p.job_id = ${jobId} order by p.created_at desc limit 50`;
  return rows.map((row) => pageView(asPage(row)));
}

/** One page with what its frame needs, or null. */
export async function pageForView(sql: Sql, pageId: string) {
  if (!PAGE_ID.test(pageId)) return null;
  const [row] = await sql<PageRow[]>`select p.*, c.label from connection_page p
    join connection c on c.id = p.connection_id where p.id = ${pageId}`;
  return row ? asPage(row) : null;
}

/** The response a framed page is served as. */
export function pageResponse(row: Pick<PageRow, 'html' | 'domains'>, head = false): Response {
  return new Response(head ? null : row.html, {
    status: 200,
    headers: {
      'content-security-policy': pagePolicy(row.domains),
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
      'x-dns-prefetch-control': 'off',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

export function refused(message: string, status: 403 | 404 = 404) {
  return new ServiceError(status === 403 ? 'forbidden' : 'not_found', message, status);
}
