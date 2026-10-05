/**
 * A Drive as a document source: what changes in its files reaches deadlines
 * kept on them, once, and goes when the account does.
 *
 * The Drive is the loopback Google stand-in, read through the real Drive
 * connector; the poller and the clocks run on a clock the test moves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRIVE_CONSENT_WORDS } from '@melete/contracts';
import { type FakeGoogle, startFakeGoogle } from '../../src/connectors/fixtures/fake-google.ts';
import { GoogleDriveConnector } from '../../src/connectors/google-drive.ts';
import { connection } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { documentSubjectKey } from '../../src/signals/observations.ts';
import { SignalPoller } from '../../src/signals/poller.ts';
import { SituationService } from '../../src/situations/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'documents-fixture-key-32-bytes!!!' })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-documents-'));
const MINUTE = 60_000;
let clock = Math.floor(Date.now() / MINUTE) * MINUTE;

const sources = new Map<string, GoogleDriveConnector>();
const situations =
  jobs && triggers
    ? new SituationService({ jobs, triggers, connectors: sources, now: () => clock })
    : null;
if (triggers && situations)
  triggers.observers.push((tx, delivery, seq) => situations.observe(tx, delivery, seq));
const poller =
  handle && triggers && situations
    ? new SignalPoller({
        sql: handle.sql,
        triggers,
        connectors: sources,
        now: () => clock,
        detectorDemand: () => situations.demand(),
      })
    : null;
const app =
  handle && jobs && triggers && situations
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
        sql: handle.sql,
        jobs,
        triggers,
        situations,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

let cookie = '';
let spaceId = '';
let personId = '';
let google: FakeGoogle | null = null;

const call = (path: string, method = 'GET', body?: unknown) =>
  required(app).request(path, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A signed-in Drive in the person's space, read through the real connector. */
async function connectDrive(inSpace = spaceId) {
  const id = newId('conn');
  await required(handle)
    .db.insert(connection)
    .values({
      id,
      spaceId: inSpace,
      provider: 'drive',
      label: 'Google Drive (person@example.test)',
      configuration: { kind: 'google_drive', account: 'person@example.test' },
      scopes: ['documents.status'],
    });
  const fake = required(google);
  const token = fake.accessToken();
  sources.set(
    id,
    new GoogleDriveConnector({
      id,
      spaceId: inSpace,
      base: fake.endpoints.drive,
      access: { token: async () => token, renew: async () => token },
    }),
  );
  return id;
}

const fileId = (label: string) => `${label}${'0'.repeat(24)}`.slice(0, 28);
const at = (ms: number) => new Date(ms).toISOString();

/** Read every Drive that is due now. */
async function poll() {
  await required(handle).sql`update source_cursor set next_poll_at = now() - interval '1 day'`;
  return required(poller).runOnce();
}

async function keep(
  drive: string,
  file: string,
  dueIn: number,
  extra: Record<string, unknown> = {},
) {
  const answer = await call('/situations/deadlines', 'POST', {
    connection_id: drive,
    file: `https://docs.google.com/document/d/${file}/edit`,
    title: 'Get the contract signed',
    due_at: at(clock + dueIn),
    lead_seconds: 300,
    by: 'others',
    ...extra,
  });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

const fileReads = (file: string) =>
  required(google).driveRequests.filter((url) => url.pathname.endsWith(`/files/${file}`)).length;
const clockOf = async (drive: string, file: string) => {
  const [row] = await required(handle).sql`select state, note from clock
    where subject_key = ${documentSubjectKey(drive, file)}`;
  return row;
};
const raised = async (drive: string, file: string) =>
  required(handle).sql`select urgency, person_set, evidence, state from situation
    where subject_key = ${documentSubjectKey(drive, file)} and kind = 'deadline.at_risk'`;
const events = async (drive: string) =>
  required(handle).sql`select seq from event where payload->>'kind' = 'connector_event'
    and payload->>'connection_id' = ${drive} and payload->>'event_name' = 'document.changed'`;

withDb('a Drive as a document source', () => {
  beforeAll(async () => {
    google = await startFakeGoogle();
    const setup = await required(app).request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'signer@example.test', password: 'a-long-enough-password' }),
    });
    expect(setup.status).toBe(201);
    cookie =
      setup.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0] ?? '')
        .find((entry) => entry.startsWith('melete_session=')) ?? '';
    const spaces = (await (await call('/spaces')).json()) as {
      spaces: { id: string; kind: string }[];
    };
    spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
    const [who] = await required(handle).sql`select id from owner limit 1`;
    personId = String(who?.id);
  }, 120_000);

  afterAll(async () => {
    await google?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('with no Drive connected, a deadline on a file says what Google will be asked for, and why', async () => {
    const answer = await call('/situations/deadlines', 'POST', {
      file: `https://docs.google.com/document/d/${fileId('noDrive')}/edit`,
      title: 'Get the contract signed',
      due_at: at(clock + 60 * MINUTE),
      by: 'others',
    });
    expect(answer.status).toBe(409);
    const body = (await answer.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'documents_not_connected', message: DRIVE_CONSENT_WORDS });
  }, 60_000);

  test('a document deadline whose file is untouched at T−lead raises at-risk, checked fresh at fire time', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const untouched = fileId('untouched');
    const quiet = fileId('quietedit');
    fake.putFile({ id: untouched, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    fake.putFile({ id: quiet, name: 'Lease', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    for (const file of [untouched, quiet]) {
      const kept = await keep(drive, file, 60 * MINUTE);
      expect(kept.status).toBe(201);
      expect(kept.body.deadline).toMatchObject({
        person_set: true,
        fire_at: at(base + 55 * MINUTE),
      });
    }
    await poll();
    // The lease is signed by the other side a minute before Melete looks, unread in between.
    clock = base + 54 * MINUTE;
    fake.putFile({
      id: quiet,
      modifiedTime: at(clock),
      lastModifyingUser: { displayName: 'Landlord', me: false },
    });
    const before = [fileReads(untouched), fileReads(quiet)];
    clock = base + 55 * MINUTE;
    await required(situations).sweep();
    expect([fileReads(untouched) - (before[0] ?? 0), fileReads(quiet) - (before[1] ?? 0)]).toEqual([
      1, 1,
    ]);
    const [risk] = await raised(drive, untouched);
    expect(risk).toMatchObject({ urgency: 'urgent', person_set: true, state: 'open' });
    expect((risk?.evidence as { fresh?: boolean } | undefined)?.fresh).toBe(true);
    expect((await clockOf(drive, untouched))?.state).toBe('fired');
    // What the fresh look saw ends it: nothing is raised about the signed lease.
    expect(await raised(drive, quiet)).toHaveLength(0);
    expect((await clockOf(drive, quiet))?.state).toBe('met');
  }, 60_000);

  test('a file edited before the deadline is settled only by the look at its time', async () => {
    // The reviewer's P2: the person's own edit, read early, settles nothing by itself.
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('ownedit');
    const later = fileId('laterfile');
    fake.putFile({ id: file, name: 'Offer', modifiedTime: at(clock - 60 * MINUTE) });
    fake.putFile({ id: later, name: 'Budget', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    expect((await keep(drive, file, 120 * MINUTE, { by: 'me' })).status).toBe(201);
    // A later deadline keeps this Drive read after the first one is over.
    expect((await keep(drive, later, 600 * MINUTE, { by: 'me' })).status).toBe(201);
    await poll();
    clock = base + 10 * MINUTE;
    fake.putFile({
      id: file,
      modifiedTime: at(clock),
      modifiedByMeTime: at(clock),
      lastModifyingUser: { me: true },
    });
    await poll();
    expect((await clockOf(drive, file))?.state).toBe('armed');
    // What it keeps about the file meanwhile has no name.
    const [state] = await required(handle).sql`select fields from subject_state
      where subject_key = ${documentSubjectKey(drive, file)}`;
    expect(state?.fields).toMatchObject({ modified_by_me_time: at(clock), trashed: false });
    expect(JSON.stringify(state?.fields)).not.toContain('Offer');
    clock = base + 115 * MINUTE;
    await required(situations).sweep();
    expect(await raised(drive, file)).toHaveLength(0);
    expect((await clockOf(drive, file))?.state).toBe('met');
    // Once its deadline is over, what was kept about the file goes, while the Drive is still read.
    await poll();
    const [read] = await required(handle).sql`select count(*)::int as n from source_cursor
      where connection_id = ${drive}`;
    expect(read?.n).toBe(1);
    const [left] = await required(handle).sql`select count(*)::int as n from subject_state
      where subject_key = ${documentSubjectKey(drive, file)}`;
    expect(left?.n).toBe(0);
  }, 60_000);

  test('an edit of another kind than the one asked for never settles it, and makes the alert a question', async () => {
    // The reviewer's P1: a collaborator's edit to a deadline the person must meet themselves.
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('collabedit');
    fake.putFile({ id: file, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    expect((await keep(drive, file, 60 * MINUTE, { by: 'me' })).status).toBe(201);
    await poll();
    clock = base + 10 * MINUTE;
    fake.putFile({
      id: file,
      modifiedTime: at(clock),
      lastModifyingUser: { displayName: 'Counterparty lawyer', me: false },
    });
    await poll();
    expect((await clockOf(drive, file))?.state).toBe('armed');
    clock = base + 55 * MINUTE;
    await required(situations).sweep();
    const [risk] = await required(handle).sql`select urgency, reason, state from situation
      where subject_key = ${documentSubjectKey(drive, file)} and kind = 'deadline.at_risk'`;
    expect(risk).toMatchObject({ urgency: 'soon', state: 'open' });
    expect(String(risk?.reason)).toContain('changed since you set this');
  }, 60_000);

  test('a change by an editor Drive does not name stays at risk', async () => {
    // The reviewer's P4: `others` with no lastModifyingUser.
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('nouser');
    fake.putFile({ id: file, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    expect((await keep(drive, file, 60 * MINUTE, { by: 'others' })).status).toBe(201);
    await poll();
    clock = base + 10 * MINUTE;
    fake.putFile({ id: file, modifiedTime: at(clock) });
    await poll();
    expect((await clockOf(drive, file))?.state).toBe('armed');
    clock = base + 55 * MINUTE;
    await required(situations).sweep();
    expect((await raised(drive, file)).map((row) => row.state)).toEqual(['open']);
    expect((await clockOf(drive, file))?.state).toBe('fired');
  }, 60_000);

  test('an alert that went out is resolved when the file then changes as asked', async () => {
    // The reviewer's P5.
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('afterfire');
    fake.putFile({ id: file, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    expect((await keep(drive, file, 60 * MINUTE, { by: 'me' })).status).toBe(201);
    await poll();
    clock = base + 55 * MINUTE;
    await required(situations).sweep();
    expect((await raised(drive, file)).map((row) => [row.urgency, row.state])).toEqual([
      ['urgent', 'open'],
    ]);
    clock = base + 57 * MINUTE;
    fake.putFile({
      id: file,
      modifiedTime: at(clock),
      modifiedByMeTime: at(clock),
      lastModifyingUser: { me: true },
    });
    await poll();
    expect((await raised(drive, file)).map((row) => row.state)).toEqual(['resolved']);
  }, 60_000);

  test('a file removed or moved to the bin before its look is raised, not let go', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const binned = fileId('binnedfile');
    const removed = fileId('removedfile');
    fake.putFile({ id: binned, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    fake.putFile({ id: removed, name: 'Lease', modifiedTime: at(clock - 60 * MINUTE) });
    const base = clock;
    for (const file of [binned, removed])
      expect((await keep(drive, file, 60 * MINUTE)).status).toBe(201);
    await poll();
    fake.putFile({ id: binned, trashed: true });
    fake.removeFile(removed);
    await poll();
    clock = base + 55 * MINUTE;
    await required(situations).sweep();
    for (const file of [binned, removed]) {
      const [risk] = await required(handle).sql`select reason, state from situation
        where subject_key = ${documentSubjectKey(drive, file)} and kind = 'deadline.at_risk'`;
      expect(risk?.state).toBe('open');
      expect(String(risk?.reason)).toContain('removed or moved to the bin');
    }
  }, 60_000);

  test('a Drive is not watched by default, and a file nothing follows leaves no name or state', async () => {
    // The reviewer's P6.
    const drive = await connectDrive();
    const fake = required(google);
    const { sql } = required(handle);
    await poll();
    const [unread] = await sql`select count(*)::int as n from source_cursor
      where connection_id = ${drive}`;
    expect(unread?.n).toBe(0);
    const file = fileId('followedfile');
    fake.putFile({ id: file, name: 'Contract', modifiedTime: at(clock - 60 * MINUTE) });
    expect((await keep(drive, file, 600 * MINUTE)).status).toBe(201);
    await poll();
    const other = fileId('unfollowedfile');
    fake.putFile({ id: other, name: 'Divorce settlement draft', modifiedTime: at(clock) });
    fake.putFile({ id: file, modifiedTime: at(clock) });
    await poll();
    const [named] = await sql`select count(*)::int as n from event
      where payload::text like '%Divorce settlement draft%'`;
    expect(named?.n).toBe(0);
    const [state] = await sql`select count(*)::int as n from subject_state
      where subject_key = ${documentSubjectKey(drive, other)}`;
    expect(state?.n).toBe(0);
    // The followed file's change still arrives.
    expect(await events(drive)).toHaveLength(1);
  }, 60_000);

  test('a read that stops at its limit is read again at the next tick', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('busyfile');
    fake.putFile({ id: file, modifiedTime: at(clock - MINUTE) });
    expect((await keep(drive, file, 600 * MINUTE)).status).toBe(201);
    await poll();
    for (let n = 0; n < 501; n++)
      fake.putFile({ id: fileId(`busy${n}x`), modifiedTime: at(clock) });
    await poll();
    const [cursor] = await required(handle).sql`select next_poll_at from source_cursor
      where connection_id = ${drive}`;
    expect(new Date(cursor?.next_poll_at).getTime()).toBeLessThanOrEqual(clock);
  }, 60_000);

  test('a since later than now, or after the due time, is refused', async () => {
    const drive = await connectDrive();
    const file = fileId('sincefile');
    required(google).putFile({ id: file, modifiedTime: at(clock - MINUTE) });
    // The reviewer's P7.
    expect((await keep(drive, file, 60 * MINUTE, { since: at(clock + 600 * MINUTE) })).status).toBe(
      400,
    );
    expect((await keep(drive, file, 60 * MINUTE, { since: at(clock + MINUTE) })).status).toBe(400);
    expect((await keep(drive, file, 60 * MINUTE, { since: at(clock - MINUTE) })).status).toBe(201);
  }, 60_000);

  test('the same change from two polls is one event', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('twicefile');
    fake.putFile({ id: file, name: 'Budget', modifiedTime: at(clock - 60 * MINUTE) });
    expect((await keep(drive, file, 600 * MINUTE)).status).toBe(201);
    await poll();
    const [start] = await required(handle).sql`select cursor from source_cursor
      where connection_id = ${drive} and stream = 'documents'`;
    fake.putFile({ id: file, modifiedTime: at(clock), lastModifyingUser: { me: true } });
    await poll();
    expect(await events(drive)).toHaveLength(1);
    // The feed is read again from before the change: the same change, the same event.
    await required(handle)
      .sql`update source_cursor set cursor = ${JSON.stringify(start?.cursor)}::jsonb
      where connection_id = ${drive} and stream = 'documents'`;
    clock += MINUTE;
    await poll();
    clock += MINUTE;
    await poll();
    expect(await events(drive)).toHaveLength(1);
    // A later change to the same file is a new one.
    clock += MINUTE;
    fake.putFile({ id: file, modifiedTime: at(clock) });
    await poll();
    expect(await events(drive)).toHaveLength(2);
  }, 60_000);

  test('revoking the account clears Drive observations', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('revokedfile');
    fake.putFile({ id: file, name: 'Private settlement', modifiedTime: at(clock - MINUTE) });
    expect((await keep(drive, file, 600 * MINUTE)).status).toBe(201);
    await poll();
    fake.putFile({ id: file, modifiedTime: at(clock) });
    await poll();
    const { sql } = required(handle);
    const count = async () => {
      const [left] = await sql`select
          (select count(*)::int from event where job_id is null
            and payload->>'connection_id' = ${drive}
            and payload->>'kind' = 'connector_event') as observations,
          (select count(*)::int from subject_state where connection_id = ${drive}) as kept,
          (select count(*)::int from source_cursor where connection_id = ${drive}) as cursors,
          (select count(*)::int from clock where connection_id = ${drive}) as clocks`;
      return [left?.observations, left?.kept, left?.cursors, left?.clocks];
    };
    expect(await count()).toEqual([1, 1, 1, 1]);
    const [row] = await sql`select generation from connection where id = ${drive}`;
    await new PolicyService(required(jobs), required(runner)).changeConnection(drive, {
      kind: 'revoke',
      expected_generation: Number(row?.generation ?? 0),
    });
    expect(await count()).toEqual([0, 0, 0, 0]);
    // Nothing anywhere still names the file it read.
    const [named] = await sql`select count(*)::int as n from event
      where payload::text like '%Private settlement%' and payload::text like ${`%${drive}%`}`;
    expect(named?.n).toBe(0);
  }, 60_000);

  test('a Drive asking for time is left alone that long', async () => {
    const drive = await connectDrive();
    const fake = required(google);
    const file = fileId('slowfile');
    fake.putFile({ id: file, modifiedTime: at(clock - MINUTE) });
    expect((await keep(drive, file, 600 * MINUTE)).status).toBe(201);
    await poll();
    // Every Drive this poll reads is told to wait, whichever is read first.
    fake.driveFault = { status: 403, reason: 'userRateLimitExceeded', retryAfter: 900, times: 100 };
    fake.putFile({ id: file, modifiedTime: at(clock) });
    await poll();
    fake.driveFault = null;
    const [cursor] = await required(handle).sql`select next_poll_at, last_error, failures
      from source_cursor where connection_id = ${drive}`;
    expect(new Date(cursor?.next_poll_at).getTime()).toBe(clock + 900_000);
    expect(cursor?.last_error).toContain('slow down');
    expect(await events(drive)).toHaveLength(0);
  }, 60_000);

  test('a deadline links the work handling the file, and only on an account the person uses', async () => {
    const drive = await connectDrive();
    const file = fileId('linkedfile');
    required(google).putFile({ id: file, modifiedTime: at(clock - MINUTE) });
    const work = await required(jobs).create({
      space_id: spaceId,
      title: 'Sign',
      objective: 'Sign',
    });
    expect((await keep(drive, file, 600 * MINUTE, { job_id: work.id })).status).toBe(201);
    const links = await required(handle).sql`select role from subject_link
      where subject_key = ${documentSubjectKey(drive, file)} and job_id = ${work.id}`;
    expect(links.map((link) => link.role)).toEqual(['deadline']);
    // An account in a space the person does not use is refused.
    const elsewhere = newId('sp');
    const otherOwner = newId('own');
    await required(handle)
      .sql`insert into principal (id, email) values (${otherOwner}, ${`${otherOwner}@example.test`})`;
    await required(handle).sql`insert into space (id, name, git_path, owner_principal_id)
      values (${elsewhere}, 'Elsewhere', ${`/s/${elsewhere}`}, ${otherOwner})`;
    const theirs = await connectDrive(elsewhere);
    expect((await keep(theirs, file, 600 * MINUTE)).status).toBe(400);
    expect(personId).not.toBe(otherOwner);
    // A Drive in another space of the person's own is refused too: a deadline
    // is kept in the space the session speaks for, and nowhere else.
    const second = newId('sp');
    await required(handle).sql`insert into space (id, name, git_path, owner_principal_id, kind)
      values (${second}, 'Second', ${`/s/${second}`}, ${personId}, 'personal')`;
    const mine = await connectDrive(second);
    expect((await keep(mine, file, 600 * MINUTE)).status).toBe(400);
  }, 60_000);
});
