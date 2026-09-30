/**
 * A saved file opens from where it was saved. A declared write in the job's
 * own workspace is read from that workspace, one in the space's artifacts
 * folder from there, and nothing a row says can reach outside those areas:
 * not another job's workspace, not another space, not a parent directory and
 * not a link.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordId } from '../../src/broker/records.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-artifact-content-'));
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
let otherJobId = '';
const sql = () => {
  if (!fixture) throw new Error('No database');
  return fixture.sql;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

if (fixture) {
  const seed = await seedJob(fixture.sql, { provider: 'files', scopes: ['files.write'] });
  spaceId = seed.claims.space_id;
  jobId = seed.claims.job_id;
  otherJobId = (await seedJob(fixture.sql, { spaceId: recordId('sp') })).claims.job_id;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'files@example.test', password: 'saved-file-password' }),
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

/** Put bytes on disk and record them as the files connector's receipt would. */
async function saved(input: {
  file: string;
  text: string;
  area: string;
  path: string;
  job?: string | null;
  sourceJob?: string | null;
  mime?: string;
}): Promise<string> {
  await mkdir(dirname(input.file), { recursive: true });
  await writeFile(input.file, input.text);
  const id = recordId('art');
  const job = input.job === undefined ? jobId : input.job;
  const source = input.sourceJob === undefined ? job : input.sourceJob;
  await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${id}, ${spaceId}, ${job}, ${source}, ${input.area}, ${input.path}, 'markdown',
      ${hash(input.text)}, ${input.mime ?? 'text/markdown'}, ${Buffer.byteLength(input.text)})`;
  return id;
}
const content = (id: string) => app.request(`/artifacts/${id}/content`, { headers: { cookie } });

databaseTest('a file saved in the job’s own workspace opens', async () => {
  const text = '# Email and admin\n\n1. Batch replies at 4pm\n';
  const id = await saved({
    file: join(workRoot, jobId, 'plans', 'email-and-admin.md'),
    text,
    area: 'work',
    path: 'plans/email-and-admin.md',
  });
  const response = await content(id);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/markdown');
  expect(await response.text()).toBe(text);
});

databaseTest('a file saved in the space’s artifacts folder opens', async () => {
  const text = 'Quarterly report\n';
  const id = await saved({
    file: join(spacesRoot, spaceId, 'artifacts', 'reports', 'q3.md'),
    text,
    area: 'artifacts',
    path: 'reports/q3.md',
  });
  const response = await content(id);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(text);
});

databaseTest('a file recorded without a job is read from the artifacts folder', async () => {
  const text = 'captured page text\n';
  const id = await saved({
    file: join(spacesRoot, spaceId, 'artifacts', 'browser', 'page.txt'),
    text,
    area: 'work',
    path: 'browser/page.txt',
    sourceJob: null,
    mime: 'text/plain',
  });
  expect((await content(id)).status).toBe(200);
});

databaseTest('no recorded path reaches outside the space’s own areas', async () => {
  const secret = 'another job’s notes\n';
  // Bytes that would match the recorded digest, so only the location can refuse them.
  await mkdir(join(workRoot, otherJobId), { recursive: true });
  await writeFile(join(workRoot, otherJobId, 'secret.md'), secret);
  await mkdir(join(spacesRoot, 'sp_other', 'artifacts'), { recursive: true });
  await writeFile(join(spacesRoot, 'sp_other', 'artifacts', 'secret.md'), secret);
  await writeFile(join(root, 'secret.md'), secret);
  const attempts: Array<{ area: string; path: string; job?: string | null; sourceJob?: string }> = [
    { area: 'work', path: `../${otherJobId}/secret.md` },
    { area: 'work', path: `plans/../../${otherJobId}/secret.md` },
    { area: 'work', path: '../../secret.md' },
    { area: 'work', path: `/${otherJobId}/secret.md` },
    { area: 'work', path: `..\\${otherJobId}\\secret.md` },
    { area: 'work', path: 'C:/secret.md' },
    { area: 'artifacts', path: '../../sp_other/artifacts/secret.md' },
    { area: 'artifacts', path: '../../../secret.md' },
    { area: 'work', path: 'secret.md', sourceJob: otherJobId },
    { area: 'work', path: 'secret.md', job: otherJobId, sourceJob: otherJobId },
    { area: 'elsewhere', path: 'secret.md' },
  ];
  for (const attempt of attempts) {
    const id = recordId('art');
    const job = attempt.job === undefined ? jobId : attempt.job;
    await sql()`insert into artifact
      (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
      values (${id}, ${spaceId}, ${job}, ${attempt.sourceJob ?? job}, ${attempt.area},
        ${attempt.path}, 'markdown', ${hash(secret)}, 'text/markdown', ${Buffer.byteLength(secret)})`;
    const response = await content(id);
    expect({ ...attempt, status: response.status }).toEqual({ ...attempt, status: 404 });
    expect(await response.text()).not.toContain('another job');
  }
  // A route id that tries to walk is refused before any lookup.
  expect(
    (await app.request('/artifacts/..%2F..%2Fsecret.md/content', { headers: { cookie } })).status,
  ).toBe(404);
});

databaseTest('a link inside the workspace is not followed', async () => {
  const secret = 'outside the workspace\n';
  await writeFile(join(root, 'linked.md'), secret);
  await mkdir(join(workRoot, jobId), { recursive: true });
  try {
    await symlink(join(root, 'linked.md'), join(workRoot, jobId, 'linked.md'));
  } catch {
    return; // Creating links needs a privilege some Windows accounts lack.
  }
  const id = recordId('art');
  await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${id}, ${spaceId}, ${jobId}, ${jobId}, 'work', 'linked.md', 'markdown',
      ${hash(secret)}, 'text/markdown', ${Buffer.byteLength(secret)})`;
  expect((await content(id)).status).toBe(404);
});
