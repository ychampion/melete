/**
 * The person's files in one list. It lists what their own conversations saved
 * and what they sent, once each and only while it is there, and leaves out the
 * browser's step-by-step captures. Another person's files, and another
 * space's, are neither listed nor deleted nor restored. A delete goes into the
 * trash, and the file comes back from there.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PersonFile } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-person-files-'));
const workRoot = join(root, 'work');
const spacesRoot = join(root, 'spaces');
await mkdir(workRoot, { recursive: true });
await mkdir(spacesRoot, { recursive: true });
const env = loadEnv({
  MELETE_SPACES_DIR: spacesRoot,
  MELETE_WORK_DIR: workRoot,
  MELETE_ENABLE_FAKE_PROVIDER: 'true',
});
const app = createApp({ env, db: fixture?.db ?? null, checkDatabase: async () => 'ok' });
let cookie = '';
let spaceId = '';
let jobId = '';
let otherSpaceJob = '';
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
  await fixture.sql`update job set kind = 'chat', title = 'Trip to Lisbon' where id = ${jobId}`;
  otherSpaceJob = (await seedJob(fixture.sql, { spaceId: recordId('sp') })).claims.job_id;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'files-list@example.test', password: 'person-files-password' }),
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

const inFiles = (...names: string[]) => join(spacesRoot, spaceId, 'artifacts', ...names);

/** A files action that succeeded, with the receipt the files connector writes. */
async function fileAction(receipt: Record<string, unknown>, job = jobId): Promise<string> {
  const id = recordId('act');
  const payload = JSON.stringify({});
  await sql()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${id}, ${job}, ${attemptId}, ${connectionId}, 'files.write', 'write',
      ${payload}::jsonb, ${hash(payload)}, 'succeeded', ${id},
      ${JSON.stringify({ action_id: id, detail: receipt })}::jsonb, now())`;
  return id;
}

/** Bytes in the person's Files, saved by a files action of `job`. */
async function savedInFiles(path: string, text: string, job = jobId): Promise<string> {
  await mkdir(dirname(inFiles(...path.split('/'))), { recursive: true });
  await writeFile(inFiles(...path.split('/')), text);
  return fileAction({ path, area: 'artifacts', content_hash: hash(text) }, job);
}

/** A job of someone else's, in this space. */
async function someoneElsesJob(): Promise<string> {
  const [someone] = await sql()`insert into principal (id, email, kind)
    values (${recordId('prn')}, ${`someone-${recordId('x')}@example.test`}, 'person') returning id`;
  const theirs = recordId('job');
  await sql()`insert into job (id, space_id, principal_id, title, objective, state, lease_epoch,
      budget, constraints)
    select ${theirs}, space_id, ${someone?.id}, title, objective, state, lease_epoch, budget,
      constraints
    from job where id = ${jobId}`;
  return theirs;
}

const list = async (headers: Record<string, string> = { cookie }) => {
  const response = await app.request('/files', { headers });
  return {
    status: response.status,
    files: ((await response.json()) as { files?: PersonFile[] }).files,
  };
};
const remove = (id: string) =>
  app.request(`/files/${id}`, { method: 'DELETE', headers: { cookie } });
const restore = (id: string, trash: string) =>
  app.request(`/files/${id}/restore`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trash_id: trash }),
  });

databaseTest('the list needs a session', async () => {
  expect((await list({})).status).toBe(401);
});

databaseTest('a file saved into Files is listed with its chat, and opens from its id', async () => {
  const id = await savedInFiles('reports/budget.md', '# Budget\n');
  const { status, files } = await list();
  expect(status).toBe(200);
  const entry = files?.find((file) => file.id === id);
  expect(entry).toMatchObject({
    name: 'budget.md',
    path: 'reports/budget.md',
    place: 'files',
    mime: 'text/markdown',
    size: 9,
    chat: { id: jobId, title: 'Trip to Lisbon' },
    deletable: true,
  });
  const content = await app.request(`/files/${id}/content`, { headers: { cookie } });
  expect(await content.text()).toBe('# Budget\n');
});

databaseTest('a file made in a chat’s own folder and a file sent in chat are listed', async () => {
  const made = '%PDF-1.4 itinerary\n';
  await mkdir(join(workRoot, jobId, 'out'), { recursive: true });
  await writeFile(join(workRoot, jobId, 'out', 'itinerary.pdf'), made);
  const id = recordId('art');
  await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${id}, ${spaceId}, ${jobId}, ${jobId}, 'work', 'out/itinerary.pdf', 'pdf',
      ${hash(made)}, 'application/pdf', ${Buffer.byteLength(made)})`;
  const sent = `file_${recordId('x').slice(2)}`;
  await sql()`insert into attachment (id, space_id, job_id, turn_id, name, media_type, kind, size,
      blob_key, sent_at)
    values (${sent}, ${spaceId}, ${jobId}, 'turn_1', 'passport.png', 'image/png', 'image', 1234,
      'blob-key', now())`;
  const { files } = await list();
  expect(files?.find((file) => file.id === id)).toMatchObject({
    place: 'chat',
    path: 'out/itinerary.pdf',
    mime: 'application/pdf',
    deletable: true,
  });
  expect(files?.find((file) => file.id === sent)).toMatchObject({
    place: 'sent',
    name: 'passport.png',
    chat: { id: jobId, title: 'Trip to Lisbon' },
    deletable: false,
  });
  // A file sent in chat goes with its chat, not from here.
  expect((await remove(sent)).status).toBe(404);
});

databaseTest(
  'the browser’s step captures are left out; other files in browser/ are not',
  async () => {
    const capture = recordId('art');
    await mkdir(inFiles('browser'), { recursive: true });
    await writeFile(inFiles('browser', `${capture}.txt`), 'page tree');
    await sql()`insert into artifact (id, space_id, job_id, path, content_hash, mime, size)
    values (${capture}, ${spaceId}, ${jobId}, ${`browser/${capture}.txt`}, ${hash('page tree')},
      'text/plain', 9)`;
    const kept = await savedInFiles('browser/boarding-pass.pdf', '%PDF boarding\n');
    const { files } = await list();
    expect(files?.some((file) => file.id === capture)).toBe(false);
    expect(files?.some((file) => file.id === kept)).toBe(true);
    expect((await remove(capture)).status).toBe(404);
  },
);

databaseTest(
  'one file saved twice is listed once, at its newest; a missing one is not',
  async () => {
    const first = await savedInFiles('notes/packing.md', 'socks\n');
    const second = await savedInFiles('notes/packing.md', 'socks and a coat\n');
    const gone = await fileAction({
      path: 'notes/never.md',
      area: 'artifacts',
      content_hash: hash('x'),
    });
    const { files } = await list();
    const packing = files?.filter((file) => file.path === 'notes/packing.md') ?? [];
    expect(packing.map((file) => file.id)).toEqual([second]);
    expect(packing[0]?.size).toBe('socks and a coat\n'.length);
    expect(files?.some((file) => file.id === first || file.id === gone)).toBe(false);
  },
);

databaseTest('another person’s files, and another space’s, are not listed or touched', async () => {
  const theirs = await savedInFiles('theirs/diary.md', 'private\n', await someoneElsesJob());
  const elsewhere = await fileAction(
    { path: 'diary.md', area: 'artifacts', content_hash: hash('private\n') },
    otherSpaceJob,
  );
  const { files } = await list();
  expect(files?.some((file) => file.id === theirs || file.id === elsewhere)).toBe(false);
  for (const id of [theirs, elsewhere]) {
    expect((await remove(id)).status).toBe(404);
    expect((await restore(id, 'del_0000000000000_000000000000')).status).toBe(404);
  }
  // Their file is still where it was.
  expect(await readFile(inFiles('theirs', 'diary.md'), 'utf8')).toBe('private\n');
  // An id that is no record's.
  expect((await remove('..%2Fdiary.md')).status).toBe(404);
});

databaseTest('a delete goes to the trash, and the file comes back from there', async () => {
  const id = await savedInFiles('receipts/hotel.pdf', '%PDF hotel\n');
  const deleted = await remove(id);
  expect(deleted.status).toBe(200);
  const body = (await deleted.json()) as { trash_id: string; restorable_until: string };
  expect(body.trash_id).toMatch(/^del_/);
  expect(Date.parse(body.restorable_until)).toBeGreaterThan(Date.now());
  await expect(stat(inFiles('receipts', 'hotel.pdf'))).rejects.toThrow();
  expect((await list()).files?.some((file) => file.id === id)).toBe(false);
  // Deleting it again finds nothing to delete.
  expect((await remove(id)).status).toBe(404);
  // Only its own trash puts it back.
  expect((await restore(id, 'del_0000000000000_000000000000')).status).toBe(404);
  const restored = await restore(id, body.trash_id);
  expect(restored.status).toBe(200);
  expect(await readFile(inFiles('receipts', 'hotel.pdf'), 'utf8')).toBe('%PDF hotel\n');
  expect((await list()).files?.some((file) => file.id === id)).toBe(true);
});

databaseTest('a file made in a chat’s folder is deleted into that chat’s trash', async () => {
  const text = 'draft letter\n';
  await mkdir(join(workRoot, jobId, 'letters'), { recursive: true });
  await writeFile(join(workRoot, jobId, 'letters', 'landlord.md'), text);
  const id = await fileAction({
    path: 'letters/landlord.md',
    area: 'work',
    content_hash: hash(text),
  });
  const deleted = await remove(id);
  expect(deleted.status).toBe(200);
  await expect(stat(join(workRoot, jobId, 'letters', 'landlord.md'))).rejects.toThrow();
  const { trash_id } = (await deleted.json()) as { trash_id: string };
  expect((await restore(id, trash_id)).status).toBe(200);
  expect(await readFile(join(workRoot, jobId, 'letters', 'landlord.md'), 'utf8')).toBe(text);
});
