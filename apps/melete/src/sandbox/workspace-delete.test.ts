/**
 * A file a command deletes in the sandbox: moved to the workspace's trash too
 * when it is Melete's own, not sent back on the next command, and restorable
 * in full; kept, and said so, when it is the person's, one of Melete's own
 * records, changed meanwhile, or possibly removed by another conversation's
 * process. Never silently put back.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobConstraints } from '@melete/contracts';
import { createFilesConnector } from '../connectors/files.ts';
import { fileRecords } from '../connectors/files-ownership.ts';
import { deleteRule, withWorkspaceNote, workspaceNote } from '../connectors/sandbox-exec.ts';
import { connectorAction } from '../connectors/test-fixtures.ts';
import { FakeSandboxProvider } from './fake.ts';
import type { SandboxHandle } from './types.ts';
import { syncIn, syncOut } from './workspace.ts';

const JOB = 'job_DELETE';
let root = '';
let provider: FakeSandboxProvider;
let handle: SandboxHandle;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-sync-delete-')));
  await mkdir(path.join(root, 'work', JOB), { recursive: true });
  await mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true });
  provider = new FakeSandboxProvider();
  handle = await provider.create(
    {
      image: 'base',
      egress: { kind: 'deny_all' },
      region: null,
      lifetimeSeconds: 60,
      idleSeconds: null,
      workdir: '/work',
      labels: {},
      env: {},
    },
    AbortSignal.timeout(5_000),
  );
});
afterEach(async () => {
  if (!path.basename(root).startsWith('melete-sync-delete-')) throw new Error('refusing cleanup');
  await rm(root, { recursive: true, force: true });
});

const local = (...names: string[]) => path.join(root, 'work', JOB, ...names);
const options = () => ({
  provider,
  handle,
  workRoot: path.join(root, 'work'),
  jobId: JOB,
  signal: AbortSignal.timeout(10_000),
});
const run = async (command: string) => {
  const outcome = await provider.exec(
    handle,
    {
      marker: 'act_1',
      argv: ['sh', '-c', command],
      cwd: '/work',
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    },
    AbortSignal.timeout(5_000),
  );
  expect(outcome.exitCode).toBe(0);
};
const inSandbox = async (file: string) =>
  provider
    .getFile(handle, `/work/${file}`, 1024, AbortSignal.timeout(5_000))
    .then(() => true)
    .catch(() => false);

test('an rm -rf of 122 files puts all of them in the trash, the receipt says 122, and Undo restores every one', async () => {
  await mkdir(local('build', 'nested'), { recursive: true });
  for (let n = 0; n < 120; n += 1) await writeFile(local('build', `out${n}.txt`), `output ${n}`);
  await writeFile(local('build', 'nested', 'a.txt'), 'a');
  await writeFile(local('build', 'nested', 'b.txt'), 'b');
  const { sent } = await syncIn(options());
  await run('rm -rf /work/build');
  const report = await syncOut({
    ...options(),
    deletions: { sent, keep: deleteRule({ records: fileRecords([]), othersRunning: false }) },
  });
  expect(report.deleted.length).toBe(122);
  expect(report.kept).toEqual([]);
  expect(existsSync(local('build'))).toBe(false);
  const note = workspaceNote(report);
  expect(note.workspace_deleted_count).toBe(122);
  expect((note.workspace_deleted as string[]).length).toBe(50);
  expect(String(note.workspace_note)).toContain('deleted 122 files');
  expect(String(note.workspace_note)).toContain('the first 50 are listed');
  expect(note.workspace_trash).toBe(report.trash_id);

  // The next command does not bring them back.
  await syncIn(options());
  expect(await inSandbox('build/out0.txt')).toBe(false);

  // Undo is files.restore with the receipt's trash id: all 122 come back.
  const files = createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });
  const restore = {
    ...connectorAction('files.restore', { trash_id: String(report.trash_id) }),
    job_id: JOB,
  };
  const back = await files.execute(restore, {
    job_id: JOB,
    space_id: 'sp_01',
    idempotency_key: restore.id,
    constraints: jobConstraints.parse({}),
  });
  if (back.outcome !== 'succeeded') throw new Error('expected a restore receipt');
  expect(back.receipt.detail.restored_count).toBe(122);
  expect(await readFile(local('build', 'out119.txt'), 'utf8')).toBe('output 119');
  expect(await readFile(local('build', 'nested', 'b.txt'), 'utf8')).toBe('b');
});

test("a person's file comes back with the reason, and Melete's own records are never deleted", async () => {
  await writeFile(local('upload.csv'), 'a,b');
  await mkdir(local('.melete', 'exec'), { recursive: true });
  await writeFile(local('.melete', 'exec', 'act_earlier.out'), 'the record of an earlier command');
  await writeFile(local('scratch.txt'), 'mine');
  const { sent } = await syncIn(options());
  await run('rm -rf /work/upload.csv /work/.melete /work/scratch.txt');
  const records = fileRecords([
    {
      kind: 'files.save_attachment',
      canonical_payload: { path: 'upload.csv' },
      receipt: { detail: { path: 'upload.csv' } },
    },
  ]);
  const report = await syncOut({
    ...options(),
    deletions: { sent, keep: deleteRule({ records, othersRunning: false }) },
  });
  expect(report.deleted).toEqual(['scratch.txt']);
  expect(report.kept).toEqual([
    {
      path: '.melete/exec/act_earlier.out',
      reason: '".melete/exec/act_earlier.out" is one of Melete\'s own records',
    },
    { path: 'upload.csv', reason: '"upload.csv" is a file the person gave you' },
  ]);
  expect(await readFile(local('upload.csv'), 'utf8')).toBe('a,b');
  expect(await readFile(local('.melete', 'exec', 'act_earlier.out'), 'utf8')).toBe(
    'the record of an earlier command',
  );
  await syncIn(options());
  expect(await inSandbox('upload.csv')).toBe(true);
  expect(String(workspaceNote(report).workspace_note)).toContain('use files.delete');
});

test("while another conversation's process runs on the computer, nothing it may have removed is deleted", async () => {
  await writeFile(local('notes.md'), 'mine');
  const { sent } = await syncIn(options());
  await run('rm -f /work/notes.md');
  const report = await syncOut({
    ...options(),
    deletions: { sent, keep: deleteRule({ records: fileRecords([]), othersRunning: true }) },
  });
  expect(report.deleted).toEqual([]);
  expect(report.kept[0]?.reason).toContain('another conversation started is still running');
  expect(await readFile(local('notes.md'), 'utf8')).toBe('mine');
});

test('a file changed in the workspace while the command ran is checked in the trash and moved back', async () => {
  await writeFile(local('notes.md'), 'before');
  const { sent } = await syncIn(options());
  await run('rm -f /work/notes.md');
  await writeFile(local('notes.md'), 'written meanwhile');
  const report = await syncOut({ ...options(), deletions: { sent, keep: () => null } });
  expect(report.deleted).toEqual([]);
  expect(report.kept).toEqual([
    { path: 'notes.md', reason: 'it changed after the delete was decided' },
  ]);
  expect(await readFile(local('notes.md'), 'utf8')).toBe('written meanwhile');
});

test('only names this command sent can go: a file written after the sync-in is never taken for a deleted one', async () => {
  const { sent } = await syncIn(options());
  await writeFile(local('output.txt'), 'the service wrote this during the command');
  const report = await syncOut({ ...options(), deletions: { sent, keep: () => null } });
  expect(report).toMatchObject({ deleted: [], kept: [], trash_id: null });
  expect(existsSync(local('output.txt'))).toBe(true);
});

test('a command that never started still carries what the read-back found', () => {
  const note = workspaceNote({
    files: 0,
    directories: 0,
    bytes: 0,
    deleted: ['a.txt'],
    kept: [],
    trash_id: 'del_0000000000000_000000000000',
    restorable_until: '2026-10-11T00:00:00.000Z',
  });
  const failed = withWorkspaceNote(
    { outcome: 'failed', reason: 'the start was refused', retryable: true },
    note,
  );
  expect(failed.outcome === 'failed' && failed.reason).toContain(
    'deleted a file from the workspace',
  );
  expect(
    withWorkspaceNote(
      { outcome: 'failed', reason: 'x', retryable: true },
      workspaceNote(new Error('gone')),
    ),
  ).toMatchObject({ reason: expect.stringContaining('was not read back') });
});
