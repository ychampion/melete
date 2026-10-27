/**
 * "Show me only what needs me", end to end on Postgres. The setting is kept
 * with the space and starts off. While it is on, the space's files are not
 * served by their content routes, only by opening the original on purpose,
 * and each open is noted in the space's activity for everyone in it, as is
 * turning the setting on or off. With it off, the same files are read as
 * before, and the agent's instructions say nothing about it.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ActivityEntry } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { recordId } from '../../src/broker/records.ts';
import { job } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { buildAttemptSkeleton } from '../../src/jobs/bundle.ts';
import { SUMMARIES_ONLY_INSTRUCTION, summariesOnlyIn } from '../../src/spaces/summaries.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-summaries-only-'));
const workRoot = join(root, 'work');
const spacesRoot = join(root, 'spaces');
await mkdir(workRoot, { recursive: true });
await mkdir(spacesRoot, { recursive: true });
const env = loadEnv({
  MELETE_SPACES_DIR: spacesRoot,
  MELETE_WORK_DIR: workRoot,
  MELETE_ENABLE_FAKE_PROVIDER: 'true',
});
const app = createApp({
  env,
  db: fixture?.db ?? null,
  sql: fixture?.sql,
  checkDatabase: async () => 'ok',
});
let cookie = '';
let spaceId = '';
let jobId = '';
let attemptId = '';
let connectionId = '';
const sql = () => {
  if (!fixture) throw new Error('No database');
  return fixture.sql;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

if (fixture) {
  const seed = await seedJob(fixture.sql, { provider: 'files', scopes: ['files.write'] });
  spaceId = seed.claims.space_id;
  jobId = seed.claims.job_id;
  attemptId = seed.claims.attempt_id;
  connectionId = seed.connectionId;
  await fixture.sql`update job set kind = 'chat', title = 'Mom’s bills' where id = ${jobId}`;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'helper@example.test', password: 'summaries-only-password' }),
  });
  if (setup.status !== 201) throw new Error('Session setup failed');
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
}
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

/** A file a files action saved into the space's Files, as the files connector leaves it. */
async function savedFile(path: string, text: string): Promise<string> {
  const file = join(spacesRoot, spaceId, 'artifacts', ...path.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  const id = recordId('act');
  const payload = JSON.stringify({});
  const receipt = { path, area: 'artifacts', content_hash: hash(text) };
  await sql()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${id}, ${jobId}, ${attemptId}, ${connectionId}, 'files.write', 'write',
      ${payload}::jsonb, ${hash(payload)}, 'succeeded', ${id},
      ${JSON.stringify({ action_id: id, detail: receipt })}::jsonb, now())`;
  return id;
}

/** An artifact recorded in the space without a job, as a capture or a download is. */
async function savedArtifact(path: string, text: string, mime = 'text/plain'): Promise<string> {
  const file = join(spacesRoot, spaceId, 'artifacts', ...path.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  const id = recordId('art');
  await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${id}, ${spaceId}, null, null, 'artifacts', ${path}, 'text', ${hash(text)}, ${mime},
      ${Buffer.byteLength(text)})`;
  return id;
}

const headers = () => ({ cookie, 'Content-Type': 'application/json' });
const setting = async () => {
  const response = await app.request(`/spaces/${spaceId}/summaries-only`, { headers: headers() });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const turn = async (on: boolean) => {
  const response = await app.request(`/spaces/${spaceId}/summaries-only`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ on }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const read = (path: string) => app.request(path, { headers: headers() });
const open = (path: string) => app.request(path, { method: 'POST', headers: headers() });
const activity = async (): Promise<ActivityEntry[]> => {
  const response = await app.request('/activity', { headers: headers() });
  expect(response.status).toBe(200);
  return ((await response.json()) as { activity: ActivityEntry[] }).activity;
};

databaseTest('the setting starts off, and turning it on is kept with the space', async () => {
  expect(await setting()).toEqual({
    status: 200,
    body: { space_id: spaceId, on: false, can_change: true, recent: [] },
  });
  expect((await turn(true)).body).toMatchObject({ on: true });
  expect(await setting()).toMatchObject({ body: { on: true } });
  expect(await summariesOnlyIn(fixture?.db as never, spaceId)).toBe(true);
  const [row] = await sql()`select summaries_only from space_policy where space_id = ${spaceId}`;
  expect(row?.summaries_only).toBe(true);
  // The space's other rules are untouched: still nothing restricted, never changed by anyone.
  const rules = await app.request(`/spaces/${spaceId}/policy`, { headers: headers() });
  expect(((await rules.json()) as { policy: Record<string, unknown> }).policy).toMatchObject({
    allowed_models: [],
    denied_connector_kinds: [],
    denied_tool_kinds: [],
    updated_by: null,
  });
  // Asking for what is already set changes nothing and notes nothing new.
  await turn(true);
  const notes = (await activity()).filter((entry) => entry.note === 'summaries_on');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    what: 'Turned on “Show me only what needs me”',
    where: 'Space rules',
    source: 'helper',
  });
  await turn(false);
});

databaseTest(
  'content routes refuse in a summaries-only space and serve as before elsewhere',
  async () => {
    const file = await savedFile('mail/statement.txt', 'Balance due: $412.08 on Nov 3\n');
    const artifact = await savedArtifact('downloads/notice.txt', 'Your plan changes on Jan 1\n');

    // Off: the space reads its files as it always has.
    const before = await read(`/files/${file}/content?disposition=inline`);
    expect(before.status).toBe(200);
    expect(await before.text()).toBe('Balance due: $412.08 on Nov 3\n');
    expect((await read(`/artifacts/${artifact}/content`)).status).toBe(200);

    await turn(true);
    for (const path of [
      `/files/${file}/content`,
      `/files/${file}/content?disposition=inline`,
      `/artifacts/${artifact}/content`,
    ]) {
      const refused = await read(path);
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('summaries_only');
      expect(body.error.message).toContain('Open the original');
      expect(JSON.stringify(body)).not.toContain('412.08');
    }

    // A different space, set to nothing, still serves its own files.
    const other = await seedJob(sql(), { provider: 'files', scopes: ['files.write'] });
    expect(await summariesOnlyIn(fixture?.db as never, other.claims.space_id)).toBe(false);

    await turn(false);
    expect((await read(`/files/${file}/content`)).status).toBe(200);
    expect((await read(`/artifacts/${artifact}/content`)).status).toBe(200);
  },
);

databaseTest(
  'opening an original serves it and notes the open in the space’s activity',
  async () => {
    const file = await savedFile('mail/appeal.txt', 'We received your appeal on Oct 2\n');
    const artifact = await savedArtifact('downloads/eob.txt', 'Explanation of benefits\n');
    await turn(true);
    const openedNotes = async () =>
      (await activity()).filter((entry) => entry.note === 'original_opened');
    const already = (await openedNotes()).length;

    const opened = await open(`/files/${file}/original?disposition=inline`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('We received your appeal on Oct 2\n');
    const openedArtifact = await open(`/artifacts/${artifact}/original`);
    expect(openedArtifact.status).toBe(200);
    expect(await openedArtifact.text()).toBe('Explanation of benefits\n');

    const notes = await openedNotes();
    expect(notes).toHaveLength(already + 2);
    expect(notes.map((entry) => entry.destination)).toEqual(
      expect.arrayContaining(['appeal.txt', 'eob.txt']),
    );
    expect(notes[0]).toMatchObject({
      what: 'Opened the original',
      where: 'Files',
      source: 'helper',
    });
    // The note names the file and who opened it, never what it said.
    expect(JSON.stringify(notes)).not.toContain('appeal on Oct 2');
    const rows = await sql()`select principal_id, kind, effect_class from activity_record
    where space_id = ${spaceId} and kind = 'space.original_opened'`;
    expect(rows.length).toBe(already + 2);
    expect(rows.every((row) => row.effect_class === 'read' && row.principal_id)).toBe(true);

    // A file that is not there is not noted as opened.
    expect((await open(`/files/${recordId('act')}/original`)).status).toBe(404);
    expect(await openedNotes()).toHaveLength(already + 2);
    await turn(false);
  },
);

databaseTest(
  'a recording is an original too; only speech Melete made plays as before',
  async () => {
    // A voicemail saved into Files, and a recording kept as an artifact.
    const memo = await savedFile('mail/voicemail.mp3', 'A letter, read aloud\n');
    const recording = await savedArtifact('downloads/memo.m4a', 'A voice memo\n', 'audio/mp4');
    // Speech an audio.synthesize step made, kept under that step's own id.
    const step = recordId('act');
    const payload = JSON.stringify({ text: 'Your bill is due on Friday.' });
    await sql()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${step}, ${jobId}, ${attemptId}, ${connectionId}, 'audio.synthesize', 'write',
      ${payload}::jsonb, ${hash(payload)}, 'succeeded', ${step},
      ${JSON.stringify({ action_id: step, detail: {} })}::jsonb, now())`;
    const speech = `art_${step.slice('act_'.length)}`;
    const said = 'RIFF speech\n';
    await mkdir(join(spacesRoot, spaceId, 'artifacts'), { recursive: true });
    await writeFile(join(spacesRoot, spaceId, 'artifacts', 'reply.wav'), said);
    await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${speech}, ${spaceId}, ${jobId}, null, 'artifacts', 'artifacts/reply.wav', 'audio',
      ${hash(said)}, 'audio/wav', ${Buffer.byteLength(said)})`;

    await turn(true);
    const opens = async () =>
      (await activity()).filter((entry) => entry.note === 'original_opened').length;
    const already = await opens();
    for (const path of [`/files/${memo}/content`, `/artifacts/${recording}/content`]) {
      const refused = await read(path);
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain('read aloud');
    }
    const opened = await open(`/files/${memo}/original`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('A letter, read aloud\n');
    expect(await opens()).toBe(already + 1);
    // Melete's own speech is its words, not an original: it plays, and nothing is noted.
    const played = await read(`/artifacts/${speech}/content`);
    expect(played.status).toBe(200);
    expect(await played.text()).toBe(said);
    expect(await opens()).toBe(already + 1);
    await turn(false);
  },
);

/** What the next attempt of the chat is asked to do, as the agent is given it. */
async function objective(): Promise<string> {
  if (!fixture) throw new Error('No database');
  const db = fixture.db;
  const [row] = await db.select().from(job).where(eq(job.id, jobId));
  if (!row) throw new Error('No job');
  const bundle = await serviceTransaction(db, (tx) =>
    buildAttemptSkeleton(
      tx,
      row,
      { id: recordId('att'), epoch: 2, revision: 0, token: 'fixture-only' },
      { provider: 'fake', model: 'scripted-v1', fallback: null },
      0,
    ),
  );
  return bundle.job.objective;
}

databaseTest('turning it off is noted too, and the agent is told only while it is on', async () => {
  expect(await objective()).not.toContain(SUMMARIES_ONLY_INSTRUCTION);
  await turn(true);
  expect(await objective()).toContain(SUMMARIES_ONLY_INSTRUCTION);
  const off = await turn(false);
  expect(off).toMatchObject({ status: 200, body: { on: false } });
  const entries = await activity();
  const latest = entries.find((entry) => entry.note === 'summaries_off');
  expect(latest).toMatchObject({
    what: 'Turned off “Show me only what needs me”',
    where: 'Space rules',
    source: 'helper',
  });
  expect(entries.find((entry) => entry.note)?.note).toBe('summaries_off');
  expect(await summariesOnlyIn(fixture?.db as never, spaceId)).toBe(false);
  expect(await objective()).not.toContain(SUMMARIES_ONLY_INSTRUCTION);
  expect(SUMMARIES_ONLY_INSTRUCTION).toContain('Do not quote');
  expect(SUMMARIES_ONLY_INSTRUCTION).not.toContain('—');
});

databaseTest('the setting needs a session and the space’s owner', async () => {
  const anonymous = await app.request(`/spaces/${spaceId}/summaries-only`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true }),
  });
  expect(anonymous.status).toBe(401);
  // A shared space someone else owns, which the helper is only a member of.
  const elsewhere = (await seedJob(sql(), {})).claims.space_id;
  const [someone] = await sql()`insert into principal (id, email, kind)
    values (${recordId('prn')}, ${`owner-${recordId('x')}@example.test`}, 'person') returning id`;
  const [helper] = await sql()`select id from owner limit 1`;
  await sql()`update space set kind = 'shared', owner_principal_id = ${someone?.id}
    where id = ${elsewhere}`;
  await sql()`insert into space_membership (principal_id, space_id, role)
    values (${helper?.id}, ${elsewhere}, 'member')`;
  const seen = await app.request(`/spaces/${elsewhere}/summaries-only`, { headers: headers() });
  expect(await seen.json()).toEqual({
    space_id: elsewhere,
    on: false,
    can_change: false,
    recent: [],
  });
  const notTheirs = await app.request(`/spaces/${elsewhere}/summaries-only`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ on: true }),
  });
  expect(notTheirs.status).toBe(403);
  expect(await summariesOnlyIn(fixture?.db as never, elsewhere)).toBe(false);
});
