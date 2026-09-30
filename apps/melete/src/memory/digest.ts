/**
 * The weekly "Here's what I learned this week" digest.
 *
 * It is due each Sunday at the start of the person's day, in their own time
 * zone, and never inside their quiet hours: a digest that falls due at night
 * waits for the morning. The week it covers is the seven local days before that
 * Sunday morning, built from local wall times, so a week the clocks change in
 * is 167 or 169 hours rather than a fixed 168. One digest is kept per space per
 * Sunday; a service that was down all Sunday writes it at the next moment
 * inside the day's hours within two days, for the week it missed.
 */
import type { MemoryDigest } from '@melete/contracts';
import { canonicalTimeZone } from '@melete/contracts';
import { subjectLabel } from './beliefs.ts';
import { getHead } from './claims.ts';
import { iso, lockSpace, type MemoryScope, type MemorySql, newId } from './db.ts';
import { currentVersion } from './rewind.ts';
import { addDays, localDay, localTime, weekdayOf, zonedInstant } from './zoned.ts';

/** How long after its Sunday a missed digest is still written. */
const CATCH_UP_MS = 48 * 3_600_000;
export type DayHours = { start: string; end: string };
export type DigestWeek = {
  /** The local Sunday the digest is for. */
  weekOf: string;
  /** When it falls due: that Sunday at the start of the person's day. */
  dueAt: Date;
  windowStart: Date;
  windowEnd: Date;
};

/** The week whose digest is the most recent one due at `now`. */
export function digestWeek(now: Date, timeZone: string, hours: DayHours): DigestWeek {
  const today = localDay(now, timeZone);
  let sunday = addDays(today, -weekdayOf(today));
  if (zonedInstant(sunday, hours.start, timeZone) > now) sunday = addDays(sunday, -7);
  const dueAt = zonedInstant(sunday, hours.start, timeZone);
  return {
    weekOf: sunday,
    dueAt,
    windowStart: zonedInstant(addDays(sunday, -7), hours.start, timeZone),
    windowEnd: dueAt,
  };
}

/** When the next digest falls due after `now`. */
export function nextDigestAt(now: Date, timeZone: string, hours: DayHours): Date {
  const current = digestWeek(now, timeZone, hours);
  return zonedInstant(addDays(current.weekOf, 7), hours.start, timeZone);
}

/** Whether `now` is inside the person's day, outside their quiet hours. */
export function withinDayHours(now: Date, timeZone: string, hours: DayHours): boolean {
  const time = localTime(now, timeZone);
  return hours.start <= hours.end
    ? time >= hours.start && time < hours.end
    : time >= hours.start || time < hours.end;
}

/**
 * The week a digest should be written for now, or null: none is due yet, this
 * week's is already written, or it is the person's quiet hours.
 */
export function dueDigest(
  now: Date,
  timeZone: string,
  hours: DayHours,
  latestWeekOf: string | null,
): DigestWeek | null {
  const week = digestWeek(now, timeZone, hours);
  if (latestWeekOf !== null && latestWeekOf >= week.weekOf) return null;
  // A week missed by more than two days is left for the next Sunday.
  if (now.getTime() - week.dueAt.getTime() > CATCH_UP_MS) return null;
  if (!withinDayHours(now, timeZone, hours)) return null;
  return week;
}

/** A space's zone and day hours, as the person set them; UTC 08:00 to 22:00 by default. */
export async function spaceDay(sql: MemorySql, spaceId: string) {
  const [row] = await sql`select time_zone, day_start, day_end from experience_profile
    where space_id = ${spaceId}`;
  return {
    timeZone: canonicalTimeZone(row?.time_zone ? String(row.time_zone) : 'UTC'),
    hours: {
      start: row?.day_start ? String(row.day_start) : '08:00',
      end: row?.day_end ? String(row.day_end) : '22:00',
    },
  };
}

/** What changed in a week, one entry per belief, newest first. */
export async function digestItems(
  sql: MemorySql,
  scope: MemoryScope,
  window: { start: Date; end: Date },
) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const rewound =
      await tx`select steps, undo_steps from memory_rewinds where space_id = ${scope.spaceId}`;
    const produced = new Set<string>();
    for (const row of rewound) {
      for (const step of (row.steps as { claim_id: string; produced?: number }[]) ?? [])
        if (step.produced) produced.add(`${step.claim_id}:${step.produced}`);
      for (const step of (row.undo_steps as { claim_id: string; produced: number | null }[]) ?? [])
        if (step.produced) produced.add(`${step.claim_id}:${step.produced}`);
    }
    const rows =
      await tx`select r.claim_id, r.revision, r.recorded_at, b.content, c.key, c.domain_key,
        (select b2.content from memory_revisions r2 join memory_revision_content b2
          on b2.claim_id = r2.claim_id and b2.revision = r2.revision
          where r2.claim_id = r.claim_id and r2.recorded_at < ${window.start.toISOString()}
            and r2.status in ('superseded','active','disputed')
          order by r2.revision desc limit 1) as previous,
        exists (select 1 from memory_references ref join memory_sources s on s.id = ref.source_id
          where ref.claim_id = r.claim_id and ref.revision = r.revision
            and (s.source_type = 'owner_edit' or s.stream = 'owner-corrections')) as corrected
      from memory_revisions r join memory_claims c on c.id = r.claim_id
      join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where c.space_id = ${scope.spaceId} and not c.hidden
        and r.status in ('superseded','active','disputed')
        and r.recorded_at >= ${window.start.toISOString()} and r.recorded_at < ${window.end.toISOString()}
      order by r.recorded_at desc, r.revision desc`;
    const seen = new Set<string>();
    const items: MemoryDigest['items'] = [];
    for (const row of rows) {
      const claimId = String(row.claim_id);
      if (seen.has(claimId) || produced.has(`${claimId}:${row.revision}`)) continue;
      seen.add(claimId);
      const head = await getHead(tx, scope, claimId);
      const version = currentVersion(head, Number(row.revision));
      items.push({
        belief_id: claimId,
        label: subjectLabel(row.key as string | null, String(row.domain_key)),
        change: row.previous === null ? 'learned' : row.corrected ? 'corrected' : 'changed',
        value: String(row.content),
        previous: row.previous === null ? null : String(row.previous),
        at: iso(row.recorded_at as Date),
        current: version !== null,
        version,
      });
      if (items.length >= 50) break;
    }
    return items;
  });
}

function digestView(row: Record<string, unknown>): MemoryDigest {
  const items = (row.items as MemoryDigest['items']) ?? [];
  return {
    id: String(row.id),
    week_of: String(row.week_of),
    title: "Here's what I learned this week",
    window_start: iso(row.window_start as Date),
    window_end: iso(row.window_end as Date),
    created_at: iso(row.created_at as Date),
    seen_at: row.seen_at ? iso(row.seen_at as Date) : null,
    items,
  };
}

/** Write the digest for a space if one is due now. Returns it when written. */
export async function writeDueDigest(sql: MemorySql, scope: MemoryScope, now = new Date()) {
  const { timeZone, hours } = await spaceDay(sql, scope.spaceId);
  const [latest] = await sql`select week_of from memory_digests where space_id = ${scope.spaceId}
    order by week_of desc limit 1`;
  const week = dueDigest(now, timeZone, hours, latest ? String(latest.week_of) : null);
  if (!week) return null;
  const items = await digestItems(sql, scope, { start: week.windowStart, end: week.windowEnd });
  const [row] = await sql`insert into memory_digests
    (id, space_id, week_of, time_zone, window_start, window_end, items)
    values (${newId('dgs')}, ${scope.spaceId}, ${week.weekOf}, ${timeZone},
      ${week.windowStart.toISOString()}, ${week.windowEnd.toISOString()}, ${JSON.stringify(items)}::text::jsonb)
    on conflict (space_id, week_of) do nothing returning *`;
  return row ? digestView(row as Record<string, unknown>) : null;
}

/** Every space whose digest is due is written; a failure in one never stops the rest. */
export async function runDigests(
  sql: MemorySql,
  onError: (code: string) => void,
  now = new Date(),
) {
  const spaces = await sql`select space_id, owner_id from memory_spaces
    where restore_ready and not revoked order by space_id limit 1000`;
  for (const space of spaces) {
    const scope: MemoryScope = {
      ownerId: String(space.owner_id),
      spaceId: String(space.space_id),
      publisher: 'digest',
      audience: 'private',
      role: 'owner',
    };
    await writeDueDigest(sql, scope, now).catch(() => onError('memory_digest_failed'));
  }
}

/** The newest digest, with its items brought up to date with what is current now. */
export async function latestDigest(sql: MemorySql, scope: MemoryScope, now = new Date()) {
  const { timeZone, hours } = await spaceDay(sql, scope.spaceId);
  const [row] = await sql`select * from memory_digests where space_id = ${scope.spaceId}
    order by week_of desc limit 1`;
  const next_at = nextDigestAt(now, timeZone, hours).toISOString();
  if (!row) return { digest: null, next_at };
  const digest = digestView(row as Record<string, unknown>);
  // A belief corrected or undone since the digest was written no longer offers
  // correcting or undoing the value the digest names.
  const items = await sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const fresh: MemoryDigest['items'] = [];
    for (const item of digest.items) {
      const head = await getHead(tx, scope, item.belief_id);
      const current =
        head !== null &&
        ['active', 'disputed'].includes(head.current.status) &&
        head.current.content === item.value;
      fresh.push({
        ...item,
        current,
        version: current && head ? currentVersion(head, head.head_revision) : null,
      });
    }
    return fresh;
  });
  return { digest: { ...digest, items }, next_at };
}

export async function markDigestSeen(sql: MemorySql, scope: MemoryScope, id: string) {
  const rows = await sql`update memory_digests set seen_at = coalesce(seen_at, clock_timestamp())
    where id = ${id} and space_id = ${scope.spaceId} returning id`;
  return rows.length > 0;
}
