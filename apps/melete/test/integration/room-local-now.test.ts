/**
 * A room's work is told the hour in the room's time zone, the zone its board
 * reads and writes times in, not UTC because the room keeps no profile.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { recordId } from '../../src/broker/records.ts';
import { job } from '../../src/db/schema.ts';
import { localNow, personZone, workZone } from '../../src/jobs/local-now.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const withDb = fixture ? describe : describe.skip;
const NOW = new Date('2026-10-29T09:41:00Z');

afterAll(async () => {
  await fixture?.close();
}, 30_000);

/** A person with their own space and, optionally, a time zone they chose there. */
async function person(zone: string | null, confirmed = true) {
  if (!fixture) throw new Error('Postgres unavailable');
  const id = recordId('own');
  const personal = recordId('sp');
  await fixture.sql`insert into principal (id, email, kind, display_name)
    values (${id}, ${`${id}@example.test`}, 'person', 'Member')`;
  await fixture.sql`insert into space (id, name, git_path, owner_principal_id)
    values (${personal}, 'Personal', ${`spaces/${personal}`}, ${id})`;
  if (zone)
    await fixture.sql`insert into experience_profile (space_id, time_zone, time_zone_confirmed_at)
      values (${personal}, ${zone}, ${confirmed ? NOW.toISOString() : null})`;
  return id;
}

/** A room made by `maker`, and a request in it from `requester`. */
async function roomRequest(maker: string, requester: string | null) {
  if (!fixture) throw new Error('Postgres unavailable');
  const seed = await seedJob(fixture.sql);
  const roomId = seed.claims.space_id;
  await fixture.sql`update space set kind = 'shared', owner_principal_id = ${maker}, audience = 'members'
    where id = ${roomId}`;
  await fixture.sql`update job set requested_by_principal_id = ${requester} where id = ${seed.claims.job_id}`;
  const [row] = await fixture.db.select().from(job).where(eq(job.id, seed.claims.job_id));
  if (!row) throw new Error('job missing');
  return { roomId, row };
}

withDb("a room's work reads time in the room's zone", () => {
  test("a request is told the requester's own zone, not UTC", async () => {
    if (!fixture) return;
    const member = await person('America/Los_Angeles');
    const { row } = await roomRequest(member, member);
    const now = await fixture.db.transaction((tx) => localNow(tx, row, NOW));
    expect(now).toMatchObject({
      time_zone: 'America/Los_Angeles',
      city: 'Los Angeles',
      zone_mismatch: null,
    });
    expect(await fixture.db.transaction((tx) => workZone(tx, row))).toBe('America/Los_Angeles');
  });

  test("the requester's zone comes before the maker's, and the maker's when the requester chose none", async () => {
    if (!fixture) return;
    const maker = await person('Europe/Berlin');
    const traveller = await person('Asia/Tokyo');
    const unset = await person('UTC', false);
    const first = await roomRequest(maker, traveller);
    expect((await fixture.db.transaction((tx) => localNow(tx, first.row, NOW))).time_zone).toBe(
      'Asia/Tokyo',
    );
    const second = await roomRequest(maker, unset);
    expect((await fixture.db.transaction((tx) => localNow(tx, second.row, NOW))).time_zone).toBe(
      'Europe/Berlin',
    );
    expect(await fixture.db.transaction((tx) => personZone(tx, second.roomId))).toBe(
      'Europe/Berlin',
    );
  });

  test('a zone the room chose for itself wins, and a room where nobody chose one stays on UTC', async () => {
    if (!fixture) return;
    const member = await person('America/Los_Angeles');
    const chosen = await roomRequest(member, member);
    await fixture.sql`insert into experience_profile (space_id, time_zone, time_zone_confirmed_at)
      values (${chosen.roomId}, 'America/Chicago', ${NOW.toISOString()})`;
    expect((await fixture.db.transaction((tx) => localNow(tx, chosen.row, NOW))).time_zone).toBe(
      'America/Chicago',
    );
    const nobody = await person(null);
    const plain = await roomRequest(nobody, nobody);
    expect((await fixture.db.transaction((tx) => localNow(tx, plain.row, NOW))).time_zone).toBe(
      'UTC',
    );
  });

  test('a personal space still reads its own profile', async () => {
    if (!fixture) return;
    const seed = await seedJob(fixture.sql);
    await fixture.sql`insert into experience_profile (space_id, time_zone, time_zone_confirmed_at)
      values (${seed.claims.space_id}, 'Australia/Sydney', ${NOW.toISOString()})`;
    const [row] = await fixture.db.select().from(job).where(eq(job.id, seed.claims.job_id));
    if (!row) throw new Error('job missing');
    expect((await fixture.db.transaction((tx) => localNow(tx, row, NOW))).time_zone).toBe(
      'Australia/Sydney',
    );
  });
});
