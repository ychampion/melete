/**
 * A space's audit log, for the people who answer for the space.
 *
 * Every effect a job proposes is an action row bound to a connection, so the
 * action table is already the whole record of what the space's work tried to
 * do outside Melete. What it lacked was a reader who is not the job's own
 * principal: `GET /actions` shows a person their own work only, and a request
 * made of a room's agent belongs to the room's principal, not to the member
 * who asked. This reads every action in one space, for its owners (and for the
 * person who set the installation up, who answers for every shared space on
 * it), and names for each one whose work it was, who asked, and who approved
 * it. Where a reader could not otherwise read what the work was about, the
 * entry leaves its title out.
 *
 * It never returns what an effect said. A payload is shown by its hash, which
 * is enough to match an entry to a receipt or an approval, and nothing else.
 */
import {
  AUDIT_EXPORT_MAX,
  auditCsv,
  type SpaceAuditEntry,
  type SpaceAuditFilter,
  spaceAuditFilter,
  spaceAuditQuery,
  spaceAuditResponse,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { spaceAuthority, spaceRole } from '../principals/authority.ts';

/**
 * Where a page ends: the last entry's creation time in UTC to the microsecond
 * (`2026-10-15T09:00:00.123456Z`, the precision Postgres keeps), and its id.
 */
type Cursor = { at: string; id: string };

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A real instant in the marker's own shape; `2026-02-31T…` is not one. */
const cursorTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  CURSOR_TIME.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

export function encodeAuditCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

/** A cursor this service wrote, or null for anything else. */
export function decodeAuditCursor(value: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !cursorTime(parsed[0]) ||
      typeof parsed[1] !== 'string' ||
      !parsed[1]
    )
      return null;
    return { at: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

const READ_REFUSED = 'Only the space’s owners can read its activity log.';

/**
 * Who is reading the log: their id, and whether they are in the space and so
 * can already read what its people said to its agent there.
 */
export type AuditReader = { id: string; inSpace: boolean };

/**
 * Whether the actor may read the space's log: an owner of it, or, for a
 * shared space, the person who set the installation up, in it or not. Another
 * person's own space is theirs alone, so the setup owner is refused there like
 * anyone else. Members are refused, and so is a space under removal.
 */
export async function authorizeAuditReader(
  db: Database,
  sql: Sql,
  spaceId: string,
  actor: string,
): Promise<AuditReader> {
  const [setup] = await sql<{ id: string }[]>`select id from owner limit 1`;
  if (setup?.id === actor) {
    const [row] = await sql`select kind, removed_at from space where id = ${spaceId}`;
    if (!row) throw new ServiceError('not_found', 'Space not found.', 404);
    if (row.removed_at) throw new ServiceError('scope_denied', 'This space is being cleared.', 403);
    if (row.kind === 'shared')
      return { id: actor, inSpace: (await spaceRole(sql, spaceId, actor)) !== null };
  }
  const access = await spaceAuthority(db, spaceId, actor);
  if (access.role !== 'owner') throw new ServiceError('scope_denied', READ_REFUSED, 403);
  return { id: actor, inSpace: true };
}

type Row = {
  id: string;
  job_id: string;
  attempt_id: string;
  kind: string;
  effect_class: string;
  status: string;
  payload_hash: string;
  created_at: Stamp;
  cursor_at: string;
  dispatched_at: Stamp | null;
  resolved_at: Stamp | null;
  title: string | null;
  audience: string;
  principal_id: string | null;
  requested_by: string | null;
  connection_id: string;
  connection_label: string;
  provider: string;
  decision: string | null;
  decided_by: string | null;
  approval_requested_at: Stamp | null;
  decided_at: Stamp | null;
};

/** A timestamp as the driver hands it back: a Date, or the text Postgres wrote. */
type Stamp = Date | string;
const instant = (value: Stamp) => new Date(value).toISOString();
const iso = (value: Stamp | null) => (value === null ? null : instant(value));

/**
 * One page of the log, newest first. Reads one more row than it returns, so
 * it knows whether there is a page after this one without counting.
 *
 * A job's title is what the chat or request it came from was called, often
 * the first words someone typed, so it is shown only to a reader who could
 * already read it: the person whose own work it was, and, for the room's
 * work, someone in the room. Anyone else sees the effect without it.
 */
export async function readSpaceAudit(
  sql: Sql,
  spaceId: string,
  reader: AuditReader,
  filter: SpaceAuditFilter,
  page: { limit: number; cursor?: Cursor | null },
): Promise<{ entries: SpaceAuditEntry[]; next: Cursor | null }> {
  const person = filter.principal_id ?? null;
  const cursor = page.cursor ?? null;
  const rows = await sql<Row[]>`select a.id, a.job_id, a.attempt_id, a.kind, a.effect_class,
      a.status, a.payload_hash, a.created_at,
      to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
      a.dispatched_at, a.resolved_at, j.audience,
      case when coalesce(j.principal_id, (select id from owner limit 1)) = ${reader.id}
          or (${reader.inSpace} and (j.audience = 'room' or jp.kind = 'room'))
        then j.title end as title,
      coalesce(j.principal_id, (select id from owner limit 1)) as principal_id,
      coalesce(t.requested_by_principal_id, j.requested_by_principal_id) as requested_by,
      c.id as connection_id, c.label as connection_label, c.provider,
      p.decision, p.decided_by, p.requested_at as approval_requested_at, p.decided_at
    from action a
    join job j on j.id = a.job_id
    left join principal jp on jp.id = j.principal_id
    join attempt t on t.id = a.attempt_id
    join connection c on c.id = a.connection_id
    left join lateral (select decision, decided_by, requested_at, decided_at from approval
      where approval.action_id = a.id order by requested_at desc, id desc limit 1) p on true
    where j.space_id = ${spaceId}
      ${
        person
          ? sql`and (coalesce(j.principal_id, (select id from owner limit 1)) = ${person}
              or coalesce(t.requested_by_principal_id, j.requested_by_principal_id) = ${person})`
          : sql``
      }
      ${filter.since ? sql`and a.created_at >= ${filter.since}::timestamptz` : sql``}
      ${filter.until ? sql`and a.created_at < ${filter.until}::timestamptz` : sql``}
      ${filter.effect_class ? sql`and a.effect_class = ${filter.effect_class}` : sql``}
      ${cursor ? sql`and (a.created_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id})` : sql``}
    order by a.created_at desc, a.id desc
    limit ${page.limit + 1}`;
  const shown = rows.slice(0, page.limit);
  const names = await personNames(
    sql,
    shown.flatMap((row) => [row.principal_id, row.requested_by, row.decided_by]),
  );
  const named = (id: string | null) => (id ? { id, name: names.get(id) ?? 'Someone' } : null);
  const entries = shown.map(
    (row): SpaceAuditEntry => ({
      action_id: row.id,
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      job_title: row.title,
      audience: row.audience === 'room' ? 'room' : 'principal',
      kind: row.kind,
      effect_class: row.effect_class as SpaceAuditEntry['effect_class'],
      status: row.status as SpaceAuditEntry['status'],
      payload_hash: row.payload_hash,
      connection: { id: row.connection_id, label: row.connection_label, provider: row.provider },
      principal: named(row.principal_id),
      requested_by: named(row.requested_by),
      approval: row.approval_requested_at
        ? {
            decision: row.decision,
            decided_by: row.decided_by,
            decided_by_name: row.decided_by ? (names.get(row.decided_by) ?? null) : null,
            requested_at: instant(row.approval_requested_at),
            decided_at: iso(row.decided_at),
          }
        : null,
      created_at: instant(row.created_at),
      dispatched_at: iso(row.dispatched_at),
      resolved_at: iso(row.resolved_at),
    }),
  );
  const last = shown.at(-1);
  return {
    entries,
    next: rows.length > page.limit && last ? { at: last.cursor_at, id: last.id } : null,
  };
}

/**
 * The name each person is shown by: their display name, or the part of their
 * email before the @. Never the whole address. A value that names no account
 * (`policy`, `reviewer`) is simply not in the map.
 */
async function personNames(sql: Sql, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await sql<{ id: string; name: string }[]>`select id,
      coalesce(nullif(display_name, ''), split_part(email, '@', 1)) as name
    from principal where id in ${sql(wanted)}`;
  return new Map(rows.map((row) => [row.id, row.name]));
}

const badQuery = () =>
  new ServiceError('invalid_query', 'Those filters could not be read. Check the dates.', 400);

export function mountSpaceAudit(app: Hono, deps: { db: Database; sql: Sql }): void {
  const { db, sql } = deps;

  app.get('/spaces/:id/audit', async (c) => {
    const spaceId = c.req.param('id');
    const reader = await authorizeAuditReader(db, sql, spaceId, c.get('owner').id);
    const parsed = spaceAuditQuery.safeParse(c.req.query());
    if (!parsed.success) throw badQuery();
    const { cursor: token, limit, ...filter } = parsed.data;
    const cursor = token ? decodeAuditCursor(token) : null;
    if (token && !cursor)
      throw new ServiceError('invalid_cursor', 'That page marker is not one of ours.', 400);
    const page = await readSpaceAudit(sql, spaceId, reader, filter, { limit, cursor });
    return c.json(
      spaceAuditResponse.parse({
        entries: page.entries,
        next_cursor: page.next ? encodeAuditCursor(page.next) : null,
      }),
    );
  });

  app.get('/spaces/:id/audit/export', async (c) => {
    const spaceId = c.req.param('id');
    const reader = await authorizeAuditReader(db, sql, spaceId, c.get('owner').id);
    const parsed = spaceAuditFilter.safeParse(c.req.query());
    if (!parsed.success) throw badQuery();
    const page = await readSpaceAudit(sql, spaceId, reader, parsed.data, {
      limit: AUDIT_EXPORT_MAX,
    });
    return c.body(auditCsv(page.entries), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      // Set when the window held more than one file carries; export it in parts.
      ...(page.next ? { 'X-Melete-Export-Truncated': 'true' } : {}),
      'Content-Disposition': `attachment; filename="activity-${spaceId.replace(/[^A-Za-z0-9_-]/g, '')}.csv"`,
      'Cache-Control': 'no-store',
    });
  });
}
