/**
 * A saved file opens from where it was saved. A declared write in the job's
 * own workspace is read from that workspace, one in the space's artifacts
 * folder from there, and nothing a row says can reach outside those areas:
 * not another job's workspace, not another space, not a parent directory and
 * not a link.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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

databaseTest(
  'a download is an attachment; only a PDF, a picture or text is shown in place',
  async () => {
    const cases: Array<{ path: string; mime: string; inline: string | null }> = [
      { path: 'shown/report.pdf', mime: 'application/pdf', inline: 'application/pdf' },
      { path: 'shown/chart.png', mime: 'image/png', inline: 'image/png' },
      { path: 'shown/notes.md', mime: 'text/markdown', inline: 'text/plain; charset=utf-8' },
      { path: 'shown/page.html', mime: 'text/html', inline: null },
      { path: 'shown/logo.svg', mime: 'image/svg+xml', inline: null },
      { path: 'shown/data.bin', mime: 'application/octet-stream', inline: null },
    ];
    for (const entry of cases) {
      const id = await saved({
        file: join(spacesRoot, spaceId, 'artifacts', entry.path),
        text: '<script>alert(1)</script>',
        area: 'artifacts',
        path: entry.path,
        mime: entry.mime,
      });
      const download = await content(id);
      expect(download.status).toBe(200);
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(download.headers.get('content-disposition')).toStartWith('attachment;');
      const shown = await app.request(`/artifacts/${id}/content?disposition=inline`, {
        headers: { cookie },
      });
      expect(shown.headers.get('x-content-type-options')).toBe('nosniff');
      if (entry.inline) {
        expect(shown.headers.get('content-disposition')).toStartWith('inline;');
        expect(shown.headers.get('content-type')).toBe(entry.inline);
      } else {
        // A page or an SVG asked for in place still only downloads.
        expect({ path: entry.path, disposition: shown.headers.get('content-disposition') }).toEqual(
          {
            path: entry.path,
            disposition: expect.stringMatching(/^attachment;/),
          },
        );
        // Sent as plain bytes in an opaque origin, whatever a client does with the disposition.
        expect(shown.headers.get('content-type')).toBe(
          entry.mime === 'application/octet-stream' ? entry.mime : 'application/octet-stream',
        );
        expect(shown.headers.get('content-security-policy')).toContain('sandbox');
      }
    }
  },
);

/** A files action's row, as the broker keeps it once its receipt came back. */
async function fileAction(input: {
  kind: string;
  receipt: Record<string, unknown>;
  job?: string;
  status?: string;
}): Promise<string> {
  const id = recordId('act');
  const payload = JSON.stringify({});
  await sql()`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${id}, ${input.job ?? jobId}, ${attemptId}, ${connectionId}, ${input.kind}, 'write',
      ${payload}::jsonb, ${hash(payload)}, ${input.status ?? 'succeeded'}, ${id},
      ${JSON.stringify({ action_id: id, detail: input.receipt })}::jsonb, now())`;
  return id;
}
const fileContent = (id: string, query = '', headers: Record<string, string> = { cookie }) =>
  app.request(`/files/${id}/content${query}`, { headers });

databaseTest('a file a files action moved into Files opens and downloads', async () => {
  const pdf = '%PDF-1.4 the beige book\n';
  await mkdir(join(spacesRoot, spaceId, 'artifacts'), { recursive: true });
  await writeFile(join(spacesRoot, spaceId, 'artifacts', 'BeigeBook_20260902.pdf'), pdf);
  const id = await fileAction({
    kind: 'files.move',
    receipt: {
      from: 'BeigeBook_20260902.pdf',
      to: 'BeigeBook_20260902.pdf',
      area: 'work',
      to_area: 'artifacts',
      content_hash: hash(pdf),
    },
  });
  const download = await fileContent(id);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe(pdf);
  expect(download.headers.get('content-type')).toBe('application/pdf');
  expect(download.headers.get('content-disposition')).toBe(
    `attachment; filename="BeigeBook_20260902.pdf"; filename*=UTF-8''BeigeBook_20260902.pdf`,
  );
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  expect(download.headers.get('cache-control')).toBe('private, no-store');
  const shown = await fileContent(id, '?disposition=inline');
  expect(shown.status).toBe(200);
  expect(shown.headers.get('content-disposition')).toStartWith('inline;');
  expect(shown.headers.get('content-type')).toBe('application/pdf');
});

databaseTest(
  'a file a files action wrote in its workspace opens; a page there only downloads',
  async () => {
    const page = '<html><script>fetch("/api/me")</script></html>';
    await mkdir(join(workRoot, jobId, 'out'), { recursive: true });
    await writeFile(join(workRoot, jobId, 'out', 'page.html'), page);
    const id = await fileAction({
      kind: 'files.write',
      receipt: { path: 'out/page.html', area: 'work', content_hash: hash(page) },
    });
    const shown = await fileContent(id, '?disposition=inline');
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-disposition')).toStartWith('attachment;');
    expect(shown.headers.get('content-type')).toBe('application/octet-stream');
    expect(shown.headers.get('content-security-policy')).toContain('sandbox');
    expect(shown.headers.get('x-content-type-options')).toBe('nosniff');
  },
);

databaseTest(
  'the files route keeps to the person’s own succeeded files and their recorded content',
  async () => {
    const text = 'saved once\n';
    await mkdir(join(spacesRoot, spaceId, 'artifacts'), { recursive: true });
    await writeFile(join(spacesRoot, spaceId, 'artifacts', 'kept.md'), text);
    const receipt = { path: 'kept.md', area: 'artifacts', content_hash: hash(text) };
    const own = await fileAction({ kind: 'files.write', receipt });
    expect((await fileContent(own)).status).toBe(200);
    // No session, no file.
    expect((await fileContent(own, '', {})).status).toBe(401);
    // Another person's conversation in the same space.
    const [someone] = await sql()`insert into principal (id, email, kind)
    values (${recordId('prn')}, ${`someone-${recordId('x')}@example.test`}, 'person') returning id`;
    const theirJob = recordId('job');
    await sql()`insert into job (id, space_id, principal_id, title, objective, state, lease_epoch,
        budget, constraints)
      select ${theirJob}, space_id, ${someone?.id}, title, objective, state, lease_epoch, budget,
        constraints
      from job where id = ${jobId}`;
    const theirFile = await fileAction({ kind: 'files.write', receipt, job: theirJob });
    expect((await fileContent(theirFile)).status).toBe(404);
    // A conversation in another space.
    const elsewhere = await fileAction({ kind: 'files.write', receipt, job: otherJobId });
    expect((await fileContent(elsewhere)).status).toBe(404);
    // An action that did not succeed, and one that is not a files action.
    expect(
      (await fileContent(await fileAction({ kind: 'files.write', receipt, status: 'failed' })))
        .status,
    ).toBe(404);
    expect((await fileContent(await fileAction({ kind: 'web.fetch', receipt }))).status).toBe(404);
    // A receipt path that tries to walk out of the space's areas.
    const walking = await fileAction({
      kind: 'files.write',
      receipt: { path: `../../${otherJobId}/kept.md`, area: 'work', content_hash: hash(text) },
    });
    expect((await fileContent(walking)).status).toBe(404);
    // The file changed since it was saved: it is no longer the one the receipt names.
    await writeFile(join(spacesRoot, spaceId, 'artifacts', 'kept.md'), 'changed\n');
    expect((await fileContent(own)).status).toBe(404);
    // An id that is not an action's.
    expect((await fileContent('..%2Fkept.md')).status).toBe(404);
  },
);

databaseTest(
  'a saved file swapped for a huge sparse one is refused before it is read',
  async () => {
    const text = 'the report as saved\n';
    const file = join(workRoot, jobId, 'out', 'swapped.pdf');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    const viaFiles = await fileAction({
      kind: 'files.write',
      receipt: { path: 'out/swapped.pdf', area: 'work', content_hash: hash(text) },
    });
    const viaArtifact = await saved({
      file,
      text,
      area: 'work',
      path: 'out/swapped.pdf',
      mime: 'application/pdf',
    });
    expect((await fileContent(viaFiles)).status).toBe(200);
    // The agent's computer rewrites it after the receipt: 2 GiB that take no disk.
    await truncate(file, 2 * 1024 ** 3);
    const started = performance.now();
    const memory = process.memoryUsage().rss;
    for (const response of await Promise.all([
      fileContent(viaFiles),
      fileContent(viaFiles, '', { cookie, range: 'bytes=0-9' }),
      content(viaArtifact),
    ]))
      expect(response.status).toBe(404);
    // Refused from its size alone: nowhere near the time or memory a full read takes.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(process.memoryUsage().rss - memory).toBeLessThan(256 * 1024 * 1024);
  },
);

databaseTest('a large saved file is sent in pieces, and a range is just that range', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024 + 7);
  const file = join(spacesRoot, spaceId, 'artifacts', 'big.txt');
  await writeFile(file, big);
  const id = await fileAction({
    kind: 'files.write',
    receipt: { path: 'big.txt', area: 'artifacts', content_hash: hash(big) },
  });
  const whole = await fileContent(id);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-length')).toBe(String(big.length));
  expect((await whole.text()).length).toBe(big.length);
  const part = await fileContent(id, '', { cookie, range: `bytes=${big.length - 5}-` });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe(
    `bytes ${big.length - 5}-${big.length - 1}/${big.length}`,
  );
  expect(await part.text()).toBe('xxxxx');
  const outside = await fileContent(id, '', { cookie, range: `bytes=${big.length}-` });
  expect(outside.status).toBe(416);
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
