/**
 * The person's own moment and place, for an attempt's volatile input.
 *
 * The profile's time zone is the account's: routines run on it. Until the
 * person has chosen or confirmed it, it is only the default the account was
 * made with, and the zone their device reports when they write is the better
 * guess; once confirmed, the profile wins. A difference between the two is
 * told to the model once (per space and pair of zones), so it can say so in
 * one sentence instead of quietly giving another city's weather.
 */
import { canonicalTimeZone } from '@melete/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { event, experienceProfile } from '../db/schema.ts';
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

/** The zone the person's device reported with their latest message in this job, if any. */
async function deviceZone(tx: Transaction, jobId: string): Promise<string | null> {
  const [row] = await tx
    .select({ zone: sql<string | null>`${event.payload}->>'client_time_zone'` })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
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
 * When and where this attempt starts. `now` is the database's clock. A
 * mismatch is recorded the first time it is seen, and only that attempt is
 * told of it.
 */
export async function localNow(tx: Transaction, row: JobRow, now: Date): Promise<LocalNow> {
  const [profile] = await tx
    .select({
      timeZone: experienceProfile.timeZone,
      confirmedAt: experienceProfile.timeZoneConfirmedAt,
    })
    .from(experienceProfile)
    .where(eq(experienceProfile.spaceId, row.spaceId));
  const saved = knownZone(profile?.timeZone) ?? 'UTC';
  const device = await deviceZone(tx, row.id);
  const used: 'profile' | 'device' = !profile?.confirmedAt && device ? 'device' : 'profile';
  const zone = used === 'device' && device ? device : saved;
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
