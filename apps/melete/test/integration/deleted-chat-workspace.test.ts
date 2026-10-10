/**
 * A deleted chat's workspace, against Postgres and a real work folder.
 *
 * - Deleting a chat moves its workspace into its trash, restorable for the
 *   trash period, and its records of files there go with it. A file it saved
 *   to the person's Files stays theirs.
 * - At start, workspaces left by chats deleted with an earlier version go to the
 *   trash the same way, and records that pointed into them stop being listed.
 * - The pages the browser captured in a chat are deleted with it, and those
 *   an earlier version left behind are deleted at start.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreFromTrash } from '../../src/connectors/files-trash.ts';
import { openDatabase } from '../../src/db/client.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { trashOrphanedWorkspaces } from '../../src/experience/workspace-trash.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { LocalWorkspaceFs, TRASH_DIRECTORY } from '../../src/runtime/workspace-fs.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { seedJob } from '../helpers/broker.ts';
import { createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
const root = await mkdtemp(join(tmpdir(), 'melete-deleted-chat-'));
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = db ? describe : describe.skip;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function put(path: string, text: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

async function recordFile(
  spaceId: string,
  jobId: string | null,
  area: 'work' | 'artifacts',
  path: string,
  sourceJobId: string | null = jobId,
) {
  const id = newId('art');
  if (!db) return id;
  await db.sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
    values (${id}, ${spaceId}, ${jobId}, ${sourceJobId}, ${area}, ${path}, ${'a'.repeat(64)}, 'text/plain', 4)`;
  return id;
}

/** Another chat in the same space as this one. */
async function siblingJob(jobId: string) {
  const id = newId('job');
  if (!db) return id;
  await db.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
    select ${id}, space_id, title, objective, state, lease_epoch, budget, constraints
    from job where id = ${jobId}`;
  return id;
}

withDb('a deleted chat’s workspace', () => {
  test('goes to its trash with the chat, restorable; the person’s Files stay', async () => {
    if (!db || !jobs) return;
    const workRoot = join(root, 'work-delete');
    const spacesRoot = join(root, 'spaces-delete');
    const { claims } = await seedJob(db.sql);
    const job = claims.job_id;
    const space = claims.space_id;
    await put(join(workRoot, job, 'index.html'), '<p>test text</p>');
    await put(join(workRoot, job, 'notes', 'o-test-note.txt'), 'note');
    await put(join(spacesRoot, space, 'artifacts', 'report.txt'), 'mine');
    const inWork = await recordFile(space, job, 'work', 'index.html');
    const inFiles = await recordFile(space, job, 'artifacts', 'report.txt');

    await removeJobs({ jobs, sql: db.sql, workspaces: { workRoot, days: 7 } }, [job]);

    expect(await exists(join(workRoot, job))).toBe(false);
    const trash = join(workRoot, TRASH_DIRECTORY, job);
    const [id] = await readdir(trash);
    if (!id) throw new Error('nothing went to the trash');
    const manifest = JSON.parse(await readFile(join(trash, id, 'manifest.json'), 'utf8'));
    expect(manifest.items.map((item: { path: string }) => item.path).sort()).toEqual([
      'index.html',
      'notes',
    ]);
    // Kept for the trash period, as any delete is.
    expect(Date.parse(manifest.expires_at) - Date.now()).toBeGreaterThan(6 * 24 * 3600_000);
    // The record of a file in the workspace goes with it; the person's file stays theirs.
    const rows =
      await db.sql`select id, job_id from artifact where id in ${db.sql([inWork, inFiles])}`;
    expect(rows.map((row) => [row.id, row.job_id])).toEqual([[inFiles, null]]);
    expect(await readFile(join(spacesRoot, space, 'artifacts', 'report.txt'), 'utf8')).toBe('mine');

    // Restorable for the trash period, every file to its own name.
    const restored = await restoreFromTrash(await new LocalWorkspaceFs(workRoot).trash(job), id);
    expect(restored.restored.sort()).toEqual(['index.html', 'notes']);
    expect(await readFile(join(workRoot, job, 'notes', 'o-test-note.txt'), 'utf8')).toBe('note');
  });

  test('a chat with no workspace is deleted as before', async () => {
    if (!db || !jobs) return;
    const workRoot = join(root, 'work-empty');
    await mkdir(workRoot, { recursive: true });
    const { claims } = await seedJob(db.sql);
    await removeJobs({ jobs, sql: db.sql, workspaces: { workRoot, days: 7 } }, [claims.job_id]);
    const [gone] = await db.sql`select id from job where id = ${claims.job_id}`;
    expect(gone).toBeUndefined();
    expect(await readdir(workRoot)).toEqual([]);
  });

  test('at start, workspaces of chats deleted earlier go to the trash and stop being listed', async () => {
    if (!db) return;
    const workRoot = join(root, 'work-orphans');
    const spacesRoot = join(root, 'spaces-orphans');
    const { claims } = await seedJob(db.sql);
    const live = claims.job_id;
    const space = claims.space_id;
    const orphan = newId('job');
    await put(join(workRoot, orphan, 'b64test.bin'), 'left');
    await put(join(workRoot, live, 'draft.md'), 'still mine');
    await put(join(spacesRoot, space, 'artifacts', 'voice.mp3'), 'audio');
    // As a chat deleted before left them: no job, and no source job either.
    const stale = await recordFile(space, null, 'work', 'b64test.bin', null);
    const generated = await recordFile(space, null, 'work', 'artifacts/voice.mp3', null);
    const lines: string[] = [];

    const moved = await trashOrphanedWorkspaces(db.sql, { workRoot, spacesRoot, days: 7 }, (line) =>
      lines.push(line),
    );

    expect(moved).toBe(1);
    expect(await exists(join(workRoot, orphan))).toBe(false);
    expect((await readdir(join(workRoot, TRASH_DIRECTORY, orphan))).length).toBe(1);
    expect(await readFile(join(workRoot, live, 'draft.md'), 'utf8')).toBe('still mine');
    const rows = await db.sql`select id from artifact where id in ${db.sql([stale, generated])}`;
    expect(rows.map((row) => row.id)).toEqual([generated]);
    expect(lines.join('\n')).toContain('moved 1 workspace of deleted chats to the trash');
    // Run again, nothing is left to do.
    expect(await trashOrphanedWorkspaces(db.sql, { workRoot, spacesRoot, days: 7 }, () => {})).toBe(
      0,
    );
  });

  test('the pages the browser captured in a chat are deleted with it', async () => {
    if (!db || !jobs) return;
    const workRoot = join(root, 'work-captures');
    const spacesRoot = join(root, 'spaces-captures');
    const { claims } = await seedJob(db.sql);
    const other = await siblingJob(claims.job_id);
    const space = claims.space_id;
    const capture = browserArtifactSink(db.sql, spacesRoot);
    const page = {
      id: 'obs_1',
      url: 'https://bank.example.test/statement',
      title: 'Statement',
      tree: 'Balance 1,234.56',
      screenshot: Buffer.from('a picture').toString('base64'),
      schema: {},
    };
    const deleted = await capture({ space_id: space, job_id: claims.job_id }, page);
    const kept = await capture({ space_id: space, job_id: other }, page);
    await put(join(spacesRoot, space, 'artifacts', 'report.txt'), 'mine');
    const mine = await recordFile(space, claims.job_id, 'artifacts', 'report.txt');
    const files = (handles: Record<string, unknown>) =>
      ['tree', 'screenshot'].map((key) => {
        const handle = handles[key] as { path: string; artifact_id: string };
        return { id: handle.artifact_id, file: join(spacesRoot, space, 'artifacts', handle.path) };
      });
    for (const { file } of [...files(deleted), ...files(kept)])
      expect(await exists(file)).toBe(true);

    await removeJobs({ jobs, sql: db.sql, workspaces: { workRoot, days: 7, spacesRoot } }, [
      claims.job_id,
    ]);

    // The chat's captures are gone, record and file; another chat's and the person's file stay.
    for (const { id, file } of files(deleted)) {
      expect(await exists(file)).toBe(false);
      expect(await db.sql`select id from artifact where id = ${id}`).toHaveLength(0);
    }
    for (const { id, file } of files(kept)) {
      expect(await exists(file)).toBe(true);
      expect(await db.sql`select id from artifact where id = ${id}`).toHaveLength(1);
    }
    expect(await db.sql`select id from artifact where id = ${mine}`).toHaveLength(1);
    expect(await readFile(join(spacesRoot, space, 'artifacts', 'report.txt'), 'utf8')).toBe('mine');
  });

  test('at start, pages captured in chats deleted earlier are deleted', async () => {
    if (!db || !jobs) return;
    const workRoot = join(root, 'work-old-captures');
    const spacesRoot = join(root, 'spaces-old-captures');
    await mkdir(workRoot, { recursive: true });
    const { claims } = await seedJob(db.sql);
    const live = await siblingJob(claims.job_id);
    const space = claims.space_id;
    const capture = browserArtifactSink(db.sql, spacesRoot);
    const page = {
      id: 'obs_2',
      url: 'https://mail.example.test/inbox',
      tree: 'Inbox: 3 unread',
      screenshot: Buffer.from('a picture').toString('base64'),
      schema: {},
    };
    const left = await capture({ space_id: space, job_id: claims.job_id }, page);
    const current = await capture({ space_id: space, job_id: live }, page);
    // Deleted as an earlier version deleted a chat: the captures stay, naming no chat.
    await removeJobs({ jobs, sql: db.sql, workspaces: { workRoot, days: 7 } }, [claims.job_id]);
    const browser = join(spacesRoot, space, 'artifacts', 'browser');
    const before = await readdir(browser);
    expect(before).toHaveLength(4);
    // A capture file with no record: an old one goes, one still being saved stays.
    const stray = join(browser, 'art_01STRAYOLDCAPTURE.png');
    const fresh = join(browser, 'art_01STRAYNEWCAPTURE.txt');
    await writeFile(stray, 'old');
    await writeFile(fresh, 'new');
    const hoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(stray, hoursAgo, hoursAgo);
    const lines: string[] = [];

    await trashOrphanedWorkspaces(db.sql, { workRoot, spacesRoot, days: 7 }, (line) =>
      lines.push(line),
    );

    const name = (handles: Record<string, unknown>, key: string) =>
      String((handles[key] as { path: string }).path).slice('browser/'.length);
    expect((await readdir(browser)).sort()).toEqual(
      [name(current, 'tree'), name(current, 'screenshot'), 'art_01STRAYNEWCAPTURE.txt'].sort(),
    );
    const ids = ['tree', 'screenshot'].map(
      (key) => (left[key] as { artifact_id: string }).artifact_id,
    );
    expect(await db.sql`select id from artifact where id = any(${ids})`).toHaveLength(0);
    expect(lines.join(' ')).toContain('deleted 3 page captures of deleted chats');
  });
});
