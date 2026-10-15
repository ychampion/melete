/**
 * Deleting and restoring a person's files by id never reaches past the one
 * file the id names: not through a link, not into a folder, not into another
 * chat's or another person's files, and never over a file that has taken the
 * name since. Each delete keeps the file restorable until its time is up, and
 * then the trash lets it go.
 */
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PersonFile } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import * as filesModule from '../../src/connectors/files.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import * as trashModule from '../../src/connectors/files-trash.ts';
import {
  filesTrash,
  moveToTrash,
  oneAtATime,
  sweepTrash,
} from '../../src/connectors/files-trash.ts';
import {
  connectorAction as filesTestAction,
  connectorContext as filesTestContext,
} from '../../src/connectors/test-fixtures.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { LocalWorkspaceFs } from '../../src/runtime/workspace-fs.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-person-files-guards-'));
const workRoot = join(root, 'work');
const spacesRoot = join(root, 'spaces');
const outside = join(root, 'outside');
await mkdir(workRoot, { recursive: true });
await mkdir(spacesRoot, { recursive: true });
await mkdir(outside, { recursive: true });
const env = loadEnv({
  MELETE_SPACES_DIR: spacesRoot,
  MELETE_WORK_DIR: workRoot,
  MELETE_ENABLE_FAKE_PROVIDER: 'true',
});
const app = createApp({ env, db: fixture?.db ?? null, checkDatabase: async () => 'ok' });
let cookie = '';
let otherCookie = '';
let otherPrincipal = '';
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
  await fixture.sql`update job set kind = 'chat', title = 'Taxes' where id = ${jobId}`;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'files-guards@example.test', password: 'person-files-password' }),
  });
  if (setup.status !== 201) throw new Error('Session setup failed');
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  // A second person on the same installation, signed in from a browser of their own.
  const [owner] = await fixture.sql`select id from owner limit 1`;
  const [someone] = await fixture.sql`insert into principal (id, email, kind)
    values (${recordId('prn')}, 'second-person@example.test', 'person') returning id`;
  const token = randomBytes(32).toString('base64url');
  await fixture.sql`insert into session (token_hash, principal_id, owner_id, expires_at)
    values (${hash(token)}, ${someone?.id}, ${owner?.id}, now() + interval '1 day')`;
  otherCookie = `melete_session=${token}`;
  otherPrincipal = String(someone?.id);
}
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

const inFiles = (...names: string[]) => join(spacesRoot, spaceId, 'artifacts', ...names);
const inChat = (...names: string[]) => join(workRoot, jobId, ...names);

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

async function savedInFiles(path: string, text: string, job = jobId): Promise<string> {
  await mkdir(dirname(inFiles(...path.split('/'))), { recursive: true });
  await writeFile(inFiles(...path.split('/')), text);
  return fileAction({ path, area: 'artifacts', content_hash: hash(text) }, job);
}

const list = async (headers: Record<string, string> = { cookie }) => {
  const response = await app.request('/files', { headers });
  return ((await response.json()) as { files?: PersonFile[] }).files ?? [];
};
const remove = (id: string, as = cookie) =>
  app.request(`/files/${id}`, { method: 'DELETE', headers: { cookie: as } });
const restore = (id: string, trash: string, as = cookie) =>
  app.request(`/files/${id}/restore`, {
    method: 'POST',
    headers: { cookie: as, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trash_id: trash }),
  });
const trashOf = async (response: Response) =>
  ((await response.json()) as { trash_id: string }).trash_id;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

databaseTest(
  'a link in Files, to a file or a folder outside, is never listed or deleted',
  async () => {
    await writeFile(join(outside, 'secret.txt'), 'outside\n');
    await mkdir(join(outside, 'folder'), { recursive: true });
    await writeFile(join(outside, 'folder', 'inner.txt'), 'inner\n');
    await mkdir(inFiles(), { recursive: true });
    await symlink(join(outside, 'secret.txt'), inFiles('linked.txt'));
    await symlink(join(outside, 'folder'), inFiles('linkdir'));
    const toFile = await fileAction({
      path: 'linked.txt',
      area: 'artifacts',
      content_hash: hash('outside\n'),
    });
    const throughFolder = await fileAction({
      path: 'linkdir/inner.txt',
      area: 'artifacts',
      content_hash: hash('inner\n'),
    });
    // And a link in a chat's own folder.
    await mkdir(inChat('out'), { recursive: true });
    await symlink(join(outside, 'secret.txt'), inChat('out', 'linked.txt'));
    const inWork = await fileAction({
      path: 'out/linked.txt',
      area: 'work',
      content_hash: hash('outside\n'),
    });
    const files = await list();
    for (const id of [toFile, throughFolder, inWork]) {
      expect(files.some((file) => file.id === id)).toBe(false);
      expect((await remove(id)).status).toBe(404);
      expect((await restore(id, 'del_0000000000000_000000000000')).status).toBe(404);
    }
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n');
    expect(await readFile(join(outside, 'folder', 'inner.txt'), 'utf8')).toBe('inner\n');
    // The links themselves stay where they were.
    expect(await exists(inFiles('linked.txt'))).toBe(true);
    expect(await exists(inChat('out', 'linked.txt'))).toBe(true);
  },
);

databaseTest('a record that names a folder never deletes the folder', async () => {
  await mkdir(inFiles('tax-2025'), { recursive: true });
  await writeFile(inFiles('tax-2025', 'payslip.pdf'), '%PDF payslip\n');
  const folder = await fileAction({ path: 'tax-2025', area: 'artifacts', content_hash: hash('') });
  await mkdir(inChat('drafts'), { recursive: true });
  await writeFile(inChat('drafts', 'a.md'), 'a\n');
  const workFolder = await fileAction({ path: 'drafts', area: 'work', content_hash: hash('') });
  for (const id of [folder, workFolder]) {
    expect((await list()).some((file) => file.id === id)).toBe(false);
    expect((await remove(id)).status).toBe(404);
  }
  expect(await readFile(inFiles('tax-2025', 'payslip.pdf'), 'utf8')).toBe('%PDF payslip\n');
  expect(await readFile(inChat('drafts', 'a.md'), 'utf8')).toBe('a\n');
});

databaseTest('a receipt naming a path outside its area is never listed or followed', async () => {
  await writeFile(join(spacesRoot, spaceId, 'top.txt'), 'space top\n');
  const ids = [];
  for (const path of [
    '../top.txt',
    '../../outside/secret.txt',
    `/${join(outside, 'secret.txt')}`,
    'a/../../top.txt',
    '.\\top.txt',
    'C:/top.txt',
    'notes//top.txt',
  ])
    ids.push(await fileAction({ path, area: 'artifacts', content_hash: hash('space top\n') }));
  ids.push(await fileAction({ path: '../../top.txt', area: 'work', content_hash: hash('x') }));
  const files = await list();
  for (const id of ids) {
    expect(files.some((file) => file.id === id)).toBe(false);
    expect((await remove(id)).status).toBe(404);
  }
  for (const id of ['..%2F..%2Ftop.txt', '%2e%2e', 'act_..', `${ids[0]}%2F..`])
    expect([400, 404]).toContain((await remove(id)).status);
  expect(await readFile(join(spacesRoot, spaceId, 'top.txt'), 'utf8')).toBe('space top\n');
});

databaseTest('a restore never replaces a file that has taken the name since', async () => {
  const id = await savedInFiles('letters/landlord.md', 'first\n');
  const trash = await trashOf(await remove(id));
  await writeFile(inFiles('letters', 'landlord.md'), 'newer\n');
  const refused = await restore(id, trash);
  expect(refused.status).toBe(409);
  expect(await readFile(inFiles('letters', 'landlord.md'), 'utf8')).toBe('newer\n');
  // The deleted one is still in the trash, and comes back once the name is free.
  await rm(inFiles('letters', 'landlord.md'));
  expect((await restore(id, trash)).status).toBe(200);
  expect(await readFile(inFiles('letters', 'landlord.md'), 'utf8')).toBe('first\n');
});

databaseTest(
  'the same file deleted twice: only the latest delete restores here, and nothing is lost',
  async () => {
    const first = await savedInFiles('notes/plan.md', 'version one\n');
    const firstTrash = await trashOf(await remove(first));
    const second = await savedInFiles('notes/plan.md', 'version two\n');
    const secondTrash = await trashOf(await remove(second));
    expect(firstTrash).not.toBe(secondTrash);
    expect((await restore(second, firstTrash)).status).toBe(404);
    expect((await restore(first, firstTrash)).status).toBe(404);
    // Both deletes are still in the trash.
    const trashes = await readdir(join(spacesRoot, spaceId, '.trash', jobId));
    expect(trashes).toContain(firstTrash);
    expect(trashes).toContain(secondTrash);
    expect((await restore(second, secondTrash)).status).toBe(200);
    expect(await readFile(inFiles('notes', 'plan.md'), 'utf8')).toBe('version two\n');
    // The older one is now the latest, and is refused while the name is taken.
    expect((await restore(first, firstTrash)).status).toBe(409);
    expect(await readFile(inFiles('notes', 'plan.md'), 'utf8')).toBe('version two\n');
  },
);

databaseTest(
  'another file’s trash never restores through this file, and is left alone',
  async () => {
    const a = await savedInFiles('a.md', 'a\n');
    const b = await savedInFiles('b.md', 'b\n');
    const aTrash = await trashOf(await remove(a));
    const bTrash = await trashOf(await remove(b));
    expect((await restore(a, bTrash)).status).toBe(404);
    expect(await exists(inFiles('b.md'))).toBe(false);
    expect((await restore(b, aTrash)).status).toBe(404);
    expect(await exists(inFiles('a.md'))).toBe(false);
    expect((await restore(a, aTrash)).status).toBe(200);
    expect((await restore(b, bTrash)).status).toBe(200);
  },
);

databaseTest(
  'two deletes of one file at once: one succeeds, and the file is restorable',
  async () => {
    const id = await savedInFiles('race.md', 'race\n');
    const results = await Promise.all([remove(id), remove(id), remove(id)]);
    const ok = results.filter((response) => response.status === 200);
    expect(ok.length).toBe(1);
    for (const response of results)
      if (response.status !== 200) expect([404, 409]).toContain(response.status);
    const trash = await trashOf(ok[0] as Response);
    expect((await restore(id, trash)).status).toBe(200);
    expect(await readFile(inFiles('race.md'), 'utf8')).toBe('race\n');
  },
);

databaseTest(
  'a second person sees none of these files and can neither delete nor restore them',
  async () => {
    const id = await savedInFiles('private/bank.md', 'bank\n');
    const theirs = await list({ cookie: otherCookie });
    expect(theirs.some((file) => file.id === id)).toBe(false);
    expect((await remove(id, otherCookie)).status).toBe(404);
    const content = await app.request(`/files/${id}/content`, { headers: { cookie: otherCookie } });
    expect([403, 404]).toContain(content.status);
    const trash = await trashOf(await remove(id));
    expect((await restore(id, trash, otherCookie)).status).toBe(404);
    expect(await exists(inFiles('private', 'bank.md'))).toBe(false);
    expect((await restore(id, trash)).status).toBe(200);
    expect(await readFile(inFiles('private', 'bank.md'), 'utf8')).toBe('bank\n');
    // Their own signed-in sites route answers for their own space only.
    const sites = await app.request('/browser/sites', { headers: { cookie: otherCookie } });
    expect([404, 200]).toContain(sites.status);
  },
);

databaseTest(
  'a file in another space’s chat folder is never listed, deleted or restored',
  async () => {
    const elsewhere = await seedJob(sql(), { spaceId: recordId('sp') });
    const theirJob = elsewhere.claims.job_id;
    await mkdir(join(workRoot, theirJob, 'out'), { recursive: true });
    await writeFile(join(workRoot, theirJob, 'out', 'theirs.md'), 'theirs\n');
    const id = await fileAction(
      { path: 'out/theirs.md', area: 'work', content_hash: hash('theirs\n') },
      theirJob,
    );
    expect((await list()).some((file) => file.id === id)).toBe(false);
    expect((await remove(id)).status).toBe(404);
    expect(await readFile(join(workRoot, theirJob, 'out', 'theirs.md'), 'utf8')).toBe('theirs\n');
  },
);

databaseTest('what another person sent in this space is not listed', async () => {
  const [someone] = await sql()`insert into principal (id, email, kind)
    values (${recordId('prn')}, ${`sender-${recordId('x')}@example.test`}, 'person') returning id`;
  const theirs = recordId('job');
  await sql()`insert into job (id, space_id, principal_id, kind, title, objective, state, lease_epoch,
      budget, constraints)
    select ${theirs}, space_id, ${someone?.id}, 'chat', 'Their chat', objective, state, lease_epoch,
      budget, constraints
    from job where id = ${jobId}`;
  const sent = `file_${recordId('x').slice(2)}`;
  await sql()`insert into attachment (id, space_id, job_id, turn_id, name, media_type, kind, size,
      blob_key, sent_at)
    values (${sent}, ${spaceId}, ${theirs}, 'turn_1', 'their-passport.png', 'image/png', 'image',
      1234, 'blob-key', now())`;
  const files = await list();
  expect(files.some((file) => file.id === sent || file.chat?.id === theirs)).toBe(false);
  // Nor what their chat made in its own folder.
  await mkdir(join(workRoot, theirs, 'out'), { recursive: true });
  await writeFile(join(workRoot, theirs, 'out', 'their-notes.md'), 'theirs\n');
  const made = recordId('art');
  await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
    values (${made}, ${spaceId}, ${theirs}, ${theirs}, 'work', 'out/their-notes.md',
      ${hash('theirs\n')}, 'text/markdown', 7)`;
  expect((await list()).some((file) => file.id === made)).toBe(false);
  expect((await remove(made)).status).toBe(404);
  expect(await readFile(join(workRoot, theirs, 'out', 'their-notes.md'), 'utf8')).toBe('theirs\n');
});

databaseTest(
  'another space’s record never names a file here, even one at the same path',
  async () => {
    const otherSpace = recordId('sp');
    await seedJob(sql(), { spaceId: otherSpace });
    await mkdir(inFiles('shared-name'), { recursive: true });
    await writeFile(inFiles('shared-name', 'mine.md'), 'mine\n');
    const theirs = recordId('art');
    await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
    values (${theirs}, ${otherSpace}, null, null, 'artifacts', 'shared-name/mine.md',
      ${hash('mine\n')}, 'text/markdown', 5)`;
    expect((await list()).some((file) => file.id === theirs)).toBe(false);
    expect((await remove(theirs)).status).toBe(404);
    expect(await readFile(inFiles('shared-name', 'mine.md'), 'utf8')).toBe('mine\n');
  },
);

databaseTest(
  'a file whose chat was deleted goes to the trash, and the trash lets it go in time',
  async () => {
    const text = 'from a deleted chat\n';
    await mkdir(inFiles('old'), { recursive: true });
    await writeFile(inFiles('old', 'report.md'), text);
    const id = recordId('art');
    // What a chat's removal leaves: the file stays with the space, naming no chat.
    await sql()`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
    values (${id}, ${spaceId}, null, null, 'artifacts', 'old/report.md', ${hash(text)},
      'text/markdown', ${Buffer.byteLength(text)})`;
    expect((await list()).some((file) => file.id === id)).toBe(true);
    const deleted = await remove(id);
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { trash_id: string; restorable_until: string };
    const trashes = join(spacesRoot, spaceId, '.trash');
    // Kept until the time it promised; gone after.
    await sweepTrash({ workRoot, spacesRoot }, 7, Date.parse(body.restorable_until) - 60_000);
    expect((await restore(id, body.trash_id)).status).toBe(200);
    const again = await trashOf(await remove(id));
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    await sweepTrash({ workRoot, spacesRoot }, 7, later);
    const left: string[] = [];
    for (const name of await readdir(trashes))
      left.push(...(await readdir(join(trashes, name)).catch(() => [])));
    expect(left).not.toContain(again);
  },
);

/** Another conversation in this space, of the same person: a chat, or a run started from one. */
async function anotherJob(kind: 'chat' | 'run', parent: string | null = null): Promise<string> {
  const id = recordId('job');
  await sql()`insert into job (id, space_id, principal_id, kind, title, objective, state, lease_epoch,
      budget, constraints, experience_parent_id)
    select ${id}, space_id, principal_id, ${kind}, ${kind === 'chat' ? 'Another chat' : 'Weekly report'},
      objective, state, lease_epoch, budget, constraints, ${parent}
    from job where id = ${jobId}`;
  return id;
}

databaseTest(
  'three restores of one delete at once: one puts it back, the others find nothing to put back',
  async () => {
    const id = await savedInFiles('together/agenda.md', 'agenda\n');
    const trash = await trashOf(await remove(id));
    const results = await Promise.all([restore(id, trash), restore(id, trash), restore(id, trash)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 404, 404]);
    expect(await readFile(inFiles('together', 'agenda.md'), 'utf8')).toBe('agenda\n');
    expect(await readdir(join(spacesRoot, spaceId, '.trash', jobId))).not.toContain(trash);
  },
);

databaseTest(
  'a file of the person’s own under .melete in Files is listed and deleted like any other',
  async () => {
    const id = await savedInFiles('.melete/plan.md', 'my plan\n');
    expect((await list()).some((file) => file.id === id && file.deletable)).toBe(true);
    const trash = await trashOf(await remove(id));
    expect(await exists(inFiles('.melete', 'plan.md'))).toBe(false);
    expect((await restore(id, trash)).status).toBe(200);
    expect(await readFile(inFiles('.melete', 'plan.md'), 'utf8')).toBe('my plan\n');
    // In a chat's own folder, .melete stays Melete's working folder.
    await mkdir(inChat('.melete', 'exec'), { recursive: true });
    await writeFile(inChat('.melete', 'exec', 'output.txt'), 'output\n');
    const working = await fileAction({
      path: '.melete/exec/output.txt',
      area: 'work',
      content_hash: hash('output\n'),
    });
    expect((await list()).some((file) => file.id === working)).toBe(false);
    expect((await remove(working)).status).toBe(404);
    expect(await readFile(inChat('.melete', 'exec', 'output.txt'), 'utf8')).toBe('output\n');
  },
);

databaseTest(
  'a working record is never put back by its id, even with its file in the trash',
  async () => {
    await mkdir(inChat('.melete', 'exec'), { recursive: true });
    await writeFile(inChat('.melete', 'exec', 'run.log'), 'run log\n');
    const working = await fileAction({
      path: '.melete/exec/run.log',
      area: 'work',
      content_hash: hash('run log\n'),
    });
    const trashed = await moveToTrash(
      await new LocalWorkspaceFs(workRoot).trash(jobId),
      [{ path: '.melete/exec/run.log', hash: null }],
      { days: 7 },
    );
    expect(await exists(inChat('.melete', 'exec', 'run.log'))).toBe(false);
    expect((await restore(working, trashed.trash_id as string)).status).toBe(404);
    expect(await exists(inChat('.melete', 'exec', 'run.log'))).toBe(false);
  },
);

databaseTest(
  'a delete that makes room in a full trash says how many earlier deletes it took out',
  async () => {
    const small = createApp({
      env: loadEnv({
        MELETE_SPACES_DIR: spacesRoot,
        MELETE_WORK_DIR: workRoot,
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_TRASH_MAX_MB: '1',
      }),
      db: fixture?.db ?? null,
      checkDatabase: async () => 'ok',
    });
    const chat = await anotherJob('chat');
    const big = 'x'.repeat(600 * 1024);
    const first = await savedInFiles('big/first.bin', big, chat);
    const second = await savedInFiles('big/second.bin', big, chat);
    const removeHere = (id: string) =>
      small.request(`/files/${id}`, { method: 'DELETE', headers: { cookie } });
    const one = await removeHere(first);
    expect(one.status).toBe(200);
    const firstBody = (await one.json()) as { trash_id: string; evicted: number };
    expect(firstBody.evicted).toBe(0);
    const two = await removeHere(second);
    expect(two.status).toBe(200);
    expect(((await two.json()) as { evicted: number }).evicted).toBe(1);
    // The first delete really is gone from the trash.
    expect((await restore(first, firstBody.trash_id)).status).toBe(404);
  },
);

databaseTest('a file a run saved goes into the trash of the chat it was started from', async () => {
  const run = await anotherJob('run', jobId);
  const id = await savedInFiles('reports/weekly.md', 'weekly\n', run);
  const trash = await trashOf(await remove(id));
  // Where the chat's own restore looks for it.
  expect(await readdir(join(spacesRoot, spaceId, '.trash', jobId))).toContain(trash);
  expect(await exists(join(spacesRoot, spaceId, '.trash', run, trash))).toBe(false);
  expect((await restore(id, trash)).status).toBe(200);
  expect(await readFile(inFiles('reports', 'weekly.md'), 'utf8')).toBe('weekly\n');
});

databaseTest(
  'in a shared space, only its owner deletes a file no chat names; a member cannot',
  async () => {
    const digestOf = (value: string) => hash(value.split('=')[1] ?? '');
    const [me] = await sql()`select principal_id from session
      where token_hash = ${digestOf(cookie)}`;
    // A room the first person owns, with the second as a member.
    const shared = recordId('sp');
    await sql()`insert into space (id, name, kind, owner_principal_id, audience, git_path)
      values (${shared}, 'Household', 'shared', ${me?.principal_id}, 'space',
        ${join(spacesRoot, shared)})`;
    await sql()`insert into space_membership (principal_id, space_id, role)
      values (${me?.principal_id}, ${shared}, 'owner'), (${otherPrincipal}, ${shared}, 'member')`;
    const text = 'house rules\n';
    const rules = join(spacesRoot, shared, 'artifacts', 'house', 'rules.md');
    await mkdir(dirname(rules), { recursive: true });
    await writeFile(rules, text);
    const id = recordId('art');
    await sql()`insert into artifact
      (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
      values (${id}, ${shared}, null, null, 'artifacts', 'house/rules.md', ${hash(text)},
        'text/markdown', ${Buffer.byteLength(text)})`;
    const sessions = [digestOf(cookie), digestOf(otherCookie)];
    const before = await sql()`select token_hash, space_id, membership_generation from session
      where token_hash in ${sql()(sessions)}`;
    try {
      await sql()`update session set space_id = ${shared}, membership_generation = 0
        where token_hash in ${sql()(sessions)}`;
      const theirs = (await list({ cookie: otherCookie })).find((file) => file.id === id);
      expect(theirs?.deletable).toBe(false);
      expect((await remove(id, otherCookie)).status).toBe(403);
      expect(await readFile(rules, 'utf8')).toBe(text);
      const owners = (await list()).find((file) => file.id === id);
      expect(owners?.deletable).toBe(true);
      const trash = await trashOf(await remove(id));
      expect((await restore(id, trash, otherCookie)).status).toBe(403);
      expect((await restore(id, trash)).status).toBe(200);
      expect(await readFile(rules, 'utf8')).toBe(text);
    } finally {
      for (const row of before)
        await sql()`update session set space_id = ${row.space_id},
          membership_generation = ${row.membership_generation} where token_hash = ${row.token_hash}`;
    }
  },
);

databaseTest(
  "in a shared space, a member's own record deletes only the file it saved, not one put at its name since",
  async () => {
    const digestOf = (value: string) => hash(value.split('=')[1] ?? '');
    const [me] = await sql()`select principal_id from session
      where token_hash = ${digestOf(cookie)}`;
    const shared = recordId('sp');
    await sql()`insert into space (id, name, kind, owner_principal_id, audience, git_path)
      values (${shared}, 'Flat', 'shared', ${me?.principal_id}, 'space', ${join(spacesRoot, shared)})`;
    await sql()`insert into space_membership (principal_id, space_id, role)
      values (${me?.principal_id}, ${shared}, 'owner'), (${otherPrincipal}, ${shared}, 'member')`;
    // A chat of the member's own in the shared space, which saved two files into its Files.
    const chat = recordId('job');
    await sql()`insert into job (id, space_id, principal_id, kind, title, objective, state,
        lease_epoch, budget, constraints)
      select ${chat}, ${shared}, ${otherPrincipal}, 'chat', 'Plans', objective, state, lease_epoch,
        budget, constraints
      from job where id = ${jobId}`;
    const at = (name: string) => join(spacesRoot, shared, 'artifacts', 'plans', name);
    await mkdir(dirname(at('week.md')), { recursive: true });
    const saved = async (name: string, text: string) => {
      await writeFile(at(name), text);
      return fileAction(
        { path: `plans/${name}`, area: 'artifacts', content_hash: hash(text) },
        chat,
      );
    };
    const week = await saved('week.md', "the member's week\n");
    const swapped = await saved('month.md', "the member's month\n");
    const kept = await saved('year.md', "the member's year\n");
    const sessions = [digestOf(cookie), digestOf(otherCookie)];
    const before = await sql()`select token_hash, space_id, membership_generation from session
      where token_hash in ${sql()(sessions)}`;
    try {
      await sql()`update session set space_id = ${shared}, membership_generation = 0
        where token_hash in ${sql()(sessions)}`;
      // The owner saves over one in place, and puts a new file at the other's name.
      await writeFile(at('week.md'), "the owner's week\n");
      await writeFile(`${at('month.md')}.new`, "the owner's month\n");
      await rename(`${at('month.md')}.new`, at('month.md'));
      const listed = await list({ cookie: otherCookie });
      expect(listed.find((file) => file.id === week)?.deletable).toBe(false);
      expect(listed.find((file) => file.id === swapped)?.deletable).toBe(false);
      expect(listed.find((file) => file.id === kept)?.deletable).toBe(true);
      const refused = await remove(week, otherCookie);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        'Only the owner of this space can delete a file that no chat of yours made.',
      );
      expect((await remove(swapped, otherCookie)).status).toBe(403);
      expect(await readFile(at('week.md'), 'utf8')).toBe("the owner's week\n");
      expect(await readFile(at('month.md'), 'utf8')).toBe("the owner's month\n");
      // The one still as the member's chat saved it goes, and comes back.
      const trash = await trashOf(await remove(kept, otherCookie));
      expect(await exists(at('year.md'))).toBe(false);
      expect((await restore(kept, trash, otherCookie)).status).toBe(200);
      expect(await readFile(at('year.md'), 'utf8')).toBe("the member's year\n");
    } finally {
      for (const row of before)
        await sql()`update session set space_id = ${row.space_id},
          membership_generation = ${row.membership_generation} where token_hash = ${row.token_hash}`;
    }
  },
);

databaseTest(
  "in a shared space, a member's delete never takes what the owner's agent saved over the file while it ran",
  async () => {
    const digestOf = (value: string) => hash(value.split('=')[1] ?? '');
    const [me] = await sql()`select principal_id from session
      where token_hash = ${digestOf(cookie)}`;
    const shared = recordId('sp');
    await sql()`insert into space (id, name, kind, owner_principal_id, audience, git_path)
      values (${shared}, 'Studio', 'shared', ${me?.principal_id}, 'space', ${join(spacesRoot, shared)})`;
    await sql()`insert into space_membership (principal_id, space_id, role)
      values (${me?.principal_id}, ${shared}, 'owner'), (${otherPrincipal}, ${shared}, 'member')`;
    const chat = recordId('job');
    await sql()`insert into job (id, space_id, principal_id, kind, title, objective, state,
        lease_epoch, budget, constraints)
      select ${chat}, ${shared}, ${otherPrincipal}, 'chat', 'Sketches', objective, state,
        lease_epoch, budget, constraints
      from job where id = ${jobId}`;
    const at = join(spacesRoot, shared, 'artifacts', 'sketch.md');
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, "the member's sketch\n");
    const id = await fileAction(
      { path: 'sketch.md', area: 'artifacts', content_hash: hash("the member's sketch\n") },
      chat,
    );
    // The owner's agent saves over the same file once the member's delete has
    // found it still as their chat saved it, and before it is taken.
    const ownerSaves = async () => {
      const action = filesTestAction('files.write', {
        path: 'sketch.md',
        area: 'artifacts',
        content: "the owner's sketch",
      });
      return createFilesConnector({ workRoot, spacesRoot }).execute(action, {
        ...filesTestContext(action),
        space_id: shared,
      });
    };
    let saving: Promise<unknown> | null = null;
    const original = trashModule.moveToTrash;
    const spy = spyOn(trashModule, 'moveToTrash').mockImplementation(async (...args) => {
      if (!saving) {
        saving = ownerSaves();
        await Promise.race([saving.catch(() => {}), Bun.sleep(2500)]);
      }
      return original(...args);
    });
    const sessions = [digestOf(cookie), digestOf(otherCookie)];
    const before = await sql()`select token_hash, space_id, membership_generation from session
      where token_hash in ${sql()(sessions)}`;
    try {
      await sql()`update session set space_id = ${shared}, membership_generation = 0
        where token_hash in ${sql()(sessions)}`;
      const response = await remove(id, otherCookie);
      expect(saving).not.toBeNull();
      expect(((await saving) as { outcome?: string } | null)?.outcome).toBe('succeeded');
      // The member's delete took the member's sketch, and then the owner's
      // agent saved theirs: the owner's is in the space's Files.
      expect(response.status).toBe(200);
      expect(await readFile(at, 'utf8')).toBe("the owner's sketch");
    } finally {
      spy.mockRestore();
      for (const row of before)
        await sql()`update session set space_id = ${row.space_id},
          membership_generation = ${row.membership_generation} where token_hash = ${row.token_hash}`;
    }
  },
);

databaseTest(
  'in a space of their own, a record still deletes the file at its name after it was saved over',
  async () => {
    const id = await savedInFiles('drafts/letter.md', 'first draft\n');
    await writeFile(inFiles('drafts', 'letter.md'), 'second draft\n');
    expect((await list()).find((file) => file.id === id)?.deletable).toBe(true);
    const trash = await trashOf(await remove(id));
    expect(await exists(inFiles('drafts', 'letter.md'))).toBe(false);
    expect((await restore(id, trash)).status).toBe(200);
    expect(await readFile(inFiles('drafts', 'letter.md'), 'utf8')).toBe('second draft\n');
  },
);

/** Whether this process holds `path` open, looked for until it does or `ms` pass (Linux). */
async function heldOpen(path: string, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    for (const fd of await readdir('/proc/self/fd').catch(() => []))
      if ((await readlink(`/proc/self/fd/${fd}`).catch(() => '')) === path) return true;
    await Bun.sleep(10);
  }
  return false;
}

databaseTest(
  'a file deleted and made again at its name after the delete was decided stays',
  async () => {
    const id = await savedInFiles('again/notes.md', 'first\n');
    const place = filesTrash(await realpath(spacesRoot), spaceId, jobId);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The chat's trash is busy with something else while this delete waits its turn.
    const busy = oneAtATime(place, () => gate);
    const pending = remove(id);
    await heldOpen(inFiles('again', 'notes.md'));
    // Deleted and written again under the same name: on most disks the new
    // file can be given the old one's number.
    await rm(inFiles('again', 'notes.md'));
    await writeFile(inFiles('again', 'notes.md'), 'second\n');
    release();
    await busy;
    expect((await pending).status).toBe(409);
    expect(await readFile(inFiles('again', 'notes.md'), 'utf8')).toBe('second\n');
  },
);

databaseTest('a delete that went into a run’s own trash can still be put back', async () => {
  const run = await anotherJob('run', jobId);
  const id = await savedInFiles('reports/monthly.md', 'monthly\n', run);
  // Where a delete of a file a run saved used to go.
  const earlier = await moveToTrash(
    filesTrash(await realpath(spacesRoot), spaceId, run),
    [{ path: 'reports/monthly.md', hash: null }],
    { days: 7 },
  );
  expect(await exists(inFiles('reports', 'monthly.md'))).toBe(false);
  expect((await restore(id, earlier.trash_id as string)).status).toBe(200);
  expect(await readFile(inFiles('reports', 'monthly.md'), 'utf8')).toBe('monthly\n');
});

databaseTest(
  'a delete that took another file in place of the one asked for says it was not deleted',
  async () => {
    const id = await savedInFiles('race/plan.md', 'plan\n');
    const place = filesTrash(await realpath(spacesRoot), spaceId, jobId);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = oneAtATime(place, () => gate);
    const pending = remove(id);
    await heldOpen(inFiles('race', 'plan.md'));
    // The file is moved aside and another put at its name...
    await rename(inFiles('race', 'plan.md'), inFiles('race', 'plan-moved.md'));
    await writeFile(inFiles('race', 'plan.md'), 'swapped\n');
    // ...and a third takes the name the moment the swapped one is in the
    // trash, before it can go back.
    const putBack = filesModule.moveWithoutReplacing;
    let planted = false;
    const spy = spyOn(filesModule, 'moveWithoutReplacing').mockImplementation(async (from, to) => {
      if (!planted) {
        planted = true;
        await writeFile(inFiles('race', 'plan.md'), 'third\n');
      }
      return putBack(from, to);
    });
    try {
      release();
      await busy;
      const response = await pending;
      expect(planted).toBe(true);
      expect(response.status).toBe(409);
      expect(
        ((await response.json()) as { error?: { message?: string } }).error?.message,
      ).toContain('another file took its name');
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(inFiles('race', 'plan.md'), 'utf8')).toBe('third\n');
    expect(await readFile(inFiles('race', 'plan-moved.md'), 'utf8')).toBe('plan\n');
  },
);

databaseTest(
  'a delete that took another file in place of the one asked for says what it took out of a full trash',
  async () => {
    const small = createApp({
      env: loadEnv({
        MELETE_SPACES_DIR: spacesRoot,
        MELETE_WORK_DIR: workRoot,
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_TRASH_MAX_MB: '1',
      }),
      db: fixture?.db ?? null,
      checkDatabase: async () => 'ok',
    });
    const removeHere = (id: string) =>
      small.request(`/files/${id}`, { method: 'DELETE', headers: { cookie } });
    const chat = await anotherJob('chat');
    const big = 'x'.repeat(600 * 1024);
    const first = await savedInFiles('full/first.bin', big, chat);
    const one = await removeHere(first);
    expect(one.status).toBe(200);
    const firstTrash = await trashOf(one);
    const id = await savedInFiles('full/plan.md', 'plan\n', chat);
    const place = filesTrash(await realpath(spacesRoot), spaceId, chat);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = oneAtATime(place, () => gate);
    const pending = removeHere(id);
    await heldOpen(inFiles('full', 'plan.md'));
    // A large file takes its place, and a third takes the name before the
    // large one can go back: the large one stays in the trash.
    await rename(inFiles('full', 'plan.md'), inFiles('full', 'plan-moved.md'));
    await writeFile(inFiles('full', 'plan.md'), big);
    const putBack = filesModule.moveWithoutReplacing;
    let planted = false;
    const spy = spyOn(filesModule, 'moveWithoutReplacing').mockImplementation(async (from, to) => {
      if (!planted) {
        planted = true;
        await writeFile(inFiles('full', 'plan.md'), 'third\n');
      }
      return putBack(from, to);
    });
    try {
      release();
      await busy;
      const response = await pending;
      expect(planted).toBe(true);
      expect(response.status).toBe(409);
      const message =
        ((await response.json()) as { error?: { message?: string } }).error?.message ?? '';
      expect(message).toContain('another file took its name');
      expect(message).toContain('an earlier delete was taken out of it to make room');
    } finally {
      spy.mockRestore();
    }
    // The earlier delete really is gone from the trash.
    expect((await restore(first, firstTrash)).status).toBe(404);
    expect(await readFile(inFiles('full', 'plan-moved.md'), 'utf8')).toBe('plan\n');
  },
);
