/**
 * A file a command deletes in the sandbox: gone from the workspace too when it
 * is Melete's own, and not sent back on the next command; kept, and said so,
 * when it is the person's or changed meanwhile. Never silently put back.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceNote } from '../connectors/sandbox-exec.ts';
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
  signal: AbortSignal.timeout(5_000),
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

test("a command's delete of Melete's own files sticks, and a person's file comes back with the reason", async () => {
  await mkdir(local('smoke-test'));
  await writeFile(local('smoke-test', 'notes.md'), 'hello');
  await writeFile(local('upload.csv'), 'a,b');
  await writeFile(local('keep.txt'), 'kept');
  const { sent } = await syncIn(options());
  expect([...sent.keys()].sort()).toEqual(['keep.txt', 'smoke-test/notes.md', 'upload.csv']);

  await run('rm -rf /work/smoke-test /work/upload.csv');
  const reason = '"upload.csv" is a file the person gave you';
  const report = await syncOut({
    ...options(),
    deletions: { sent, keep: (relative) => (relative === 'upload.csv' ? reason : null) },
  });
  expect(report.deleted).toEqual(['smoke-test/notes.md']);
  expect(report.kept).toEqual([{ path: 'upload.csv', reason }]);
  // The emptied folder goes with it; the person's file and the rest stay.
  expect(existsSync(local('smoke-test'))).toBe(false);
  expect(await readFile(local('upload.csv'), 'utf8')).toBe('a,b');
  expect(await readFile(local('keep.txt'), 'utf8')).toBe('kept');

  // The next command's sync-in does not bring the deleted folder back.
  await syncIn(options());
  expect(await inSandbox('smoke-test/notes.md')).toBe(false);
  expect(await inSandbox('upload.csv')).toBe(true);

  // And the command's receipt says what happened, pointing at files.delete.
  const note = workspaceNote(report);
  expect(note.workspace_deleted).toEqual(['smoke-test/notes.md']);
  expect(note.workspace_restored).toEqual([{ path: 'upload.csv', reason }]);
  expect(String(note.workspace_note)).toContain('use files.delete');
});

test('a file changed in the workspace while the command ran is kept, and said so', async () => {
  await writeFile(local('notes.md'), 'before');
  const { sent } = await syncIn(options());
  await run('rm -f /work/notes.md');
  await writeFile(local('notes.md'), 'written meanwhile');
  const report = await syncOut({ ...options(), deletions: { sent, keep: () => null } });
  expect(report.deleted).toEqual([]);
  expect(report.kept).toEqual([
    { path: 'notes.md', reason: 'it changed in the workspace while the command ran' },
  ]);
  expect(await readFile(local('notes.md'), 'utf8')).toBe('written meanwhile');
});

test('a file written in the workspace after the sync-in is never taken for a deleted one', async () => {
  const { sent } = await syncIn(options());
  await writeFile(local('output.txt'), 'the service wrote this during the command');
  const report = await syncOut({ ...options(), deletions: { sent, keep: () => null } });
  expect(report).toMatchObject({ deleted: [], kept: [] });
  expect(existsSync(local('output.txt'))).toBe(true);
  expect(workspaceNote(new Error('the sandbox went away')).workspace_note).toContain(
    'was not read back',
  );
});
