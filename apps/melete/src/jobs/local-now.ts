/**
 * The person's own moment and place, for an attempt's volatile input.
 *
 * The profile's time zone is the account's: routines run on it. Until the
 * person has chosen or confirmed it, it is only the default the account was
 * made with, and the zone their device reports when they write is the better
 * guess; once confirmed, the profile wins. A difference between the two is
 * told to the model once (per space and pair of zones), so it can say so in
 * one sentence instead of quietly giving another city's weather.
 *
 * A room keeps no profile of its own unless it chose a zone, and its members
 * write from their own devices, so a room's work reads time in the zone its
 * board does: the room's own choice, else that of the person whose request it
 * is, else its maker's.
 */
import { canonicalTimeZone } from '@melete/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { event, experienceProfile, job, runState } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { JobRow } from './service.ts';

export type LocalNow = {
  at: string;
  time_zone: string;
  city: string | null;
  zone_mismatch: { profile: string; device: string; used: 'profile' | 'device' } | null;
};

/** A zone this runtime knows by name, in its canonical spelling; null for anything else. */
export function knownZone(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z]/.test(value) || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    return null;
  }
  return canonicalTimeZone(value);
}

/**
 * The city a zone is named for ("America/Los_Angeles" is Los Angeles), or null
 * for a zone named for no place (UTC, Etc/GMT+5).
 */
export function zoneCity(zone: string): string | null {
  const parts = zone.split('/');
  if (parts.length < 2 || parts[0] === 'Etc') return null;
  const city = (parts.at(-1) ?? '').replaceAll('_', ' ').trim();
  return city && /^[\p{L}]/u.test(city) ? city : null;
}

/** A transaction, or the database outside one: zones are only read. */
type Reader = Transaction | Database;

/** The zone the person's device reported with their latest message in these jobs, if any. */
async function deviceZone(tx: Reader, jobIds: string[]): Promise<string | null> {
  if (!jobIds.length) return null;
  const [row] = await tx
    .select({ zone: sql<string | null>`${event.payload}->>'client_time_zone'` })
    .from(event)
    .where(
      and(
        inArray(event.jobId, jobIds),
        eq(event.type, 'notice'),
        sql`${event.payload}->>'kind' = 'user_message'`,
        sql`${event.payload} ? 'client_time_zone'`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  return knownZone(row?.zone);
}

/**
 * The zone a room reads time in, or null when the space is not a room. A room
 * that set none takes the zone of the person whose request the first of these
 * jobs is, from their own space, then its maker's; UTC only when nobody chose
 * one. A profile still on its first UTC default counts as no choice. This is
 * the rule the board connector's `roomZone` reads times on the board with, so
 * the hour the work is told it is matches the hours the board shows.
 */
async function roomZone(tx: Reader, spaceId: string, jobIds: string[]): Promise<string | null> {
  const [row] = await tx.execute<{ zone: string | null }>(sql`
    with chosen as (
      select p.space_id, p.time_zone from experience_profile p
      where p.time_zone_confirmed_at is not null or p.time_zone <> 'UTC'),
    personal as (
      select coalesce(s.owner_principal_id, (select id from owner limit 1)) as principal_id,
             c.time_zone
      from space s join chosen c on c.space_id = s.id where s.kind = 'personal')
    select coalesce(
      (select time_zone from chosen where space_id = r.id),
      (select p.time_zone from personal p join job j on j.requested_by_principal_id = p.principal_id
        where j.id = ${jobIds[0] ?? ''} limit 1),
      (select p.time_zone from personal p
        where p.principal_id = coalesce(r.owner_principal_id, (select id from owner limit 1))
        limit 1)) as zone
    from space r where r.id = ${spaceId} and r.kind = 'shared'`);
  if (!row) return null;
  return knownZone(row.zone) ?? 'UTC';
}

/** The profile's zone, the device's, and which one time is read in. */
async function zoneChoice(tx: Reader, spaceId: string, jobIds: string[]) {
  const room = await roomZone(tx, spaceId, jobIds);
  if (room) return { saved: room, device: null, used: 'profile' as const, zone: room };
  const [profile] = await tx
    .select({
      timeZone: experienceProfile.timeZone,
      confirmedAt: experienceProfile.timeZoneConfirmedAt,
    })
    .from(experienceProfile)
    .where(eq(experienceProfile.spaceId, spaceId));
  const saved = knownZone(profile?.timeZone) ?? 'UTC';
  const device = await deviceZone(tx, jobIds);
  const used: 'profile' | 'device' = !profile?.confirmedAt && device ? 'device' : 'profile';
  return { saved, device, used, zone: used === 'device' && device ? device : saved };
}

/**
 * The zone a schedule set with no zone of its own runs in: the one the work
 * was told it is in, so the 9:00 the model wrote is the 9:00 the person
 * meant. Work set up from a conversation also reads the device's zone from
 * that conversation's messages, where the person wrote.
 */
export async function workZone(
  tx: Transaction,
  row: JobRow,
  conversationId?: string | null,
): Promise<string> {
  const ids = conversationId ? [row.id, conversationId] : [row.id];
  return (await zoneChoice(tx, row.spaceId, ids)).zone;
}

/** The space's conversations the person wrote in most lately. */
async function recentChats(tx: Reader, spaceId: string): Promise<string[]> {
  const found = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'chat')))
    .orderBy(desc(job.updatedAt))
    .limit(5);
  return found.map((row) => row.id);
}

/**
 * The zone a time is read back to the person in: the zone their work is told
 * it is in, so a reminder set for 2:50 PM where they are reads back as 2:50
 * PM. `jobIds` are the conversations the time came from; with none, the
 * device's zone is read from the space's latest conversations.
 */
export async function personZone(
  tx: Reader,
  spaceId: string,
  jobIds: readonly (string | null | undefined)[] = [],
): Promise<string> {
  const ids = jobIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return (await zoneChoice(tx, spaceId, ids.length ? ids : await recentChats(tx, spaceId))).zone;
}

/** The conversation long work was started from: a run's own, or for a step, its run's. */
async function startedFrom(tx: Reader, row: JobRow): Promise<string | null> {
  if (row.kind !== 'run' && row.kind !== 'run_step') return null;
  const [own] = await tx
    .select({ conversationId: runState.conversationId, parent: runState.parentRunId })
    .from(runState)
    .where(eq(runState.jobId, row.id));
  if (own?.conversationId || !own?.parent) return own?.conversationId ?? null;
  const [run] = await tx
    .select({ conversationId: runState.conversationId })
    .from(runState)
    .where(eq(runState.jobId, own.parent));
  return run?.conversationId ?? null;
}

/**
 * When and where this attempt starts. `now` is the database's clock. Long
 * work also reads the device's zone from the conversation it was started
 * from, so the times it was given there read as the person meant them. A
 * mismatch is recorded the first time it is seen, and only that attempt is
 * told of it.
 */
export async function localNow(tx: Transaction, row: JobRow, now: Date): Promise<LocalNow> {
  const conversation = await startedFrom(tx, row);
  const ids = conversation ? [row.id, conversation] : [row.id];
  const { saved, device, used, zone } = await zoneChoice(tx, row.spaceId, ids);
  let zoneMismatch: LocalNow['zone_mismatch'] = null;
  if (device && device !== saved) {
    const told = await appendEvent(tx, {
      jobId: row.id,
      type: 'notice',
      payload: { kind: 'time_zone_mismatch', profile: saved, device, used },
      dedupKey: `time-zone-mismatch:${row.spaceId}:${saved}:${device}`,
    });
    if (told) zoneMismatch = { profile: saved, device, used };
  }
  return {
    at: now.toISOString(),
    time_zone: zone,
    city: zoneCity(zone),
    zone_mismatch: zoneMismatch,
  };
}
