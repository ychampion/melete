/**
 * The computer's `/work` is shared by every conversation in a space. A file
 * or folder there over a read-back cap stays on the computer and is named on
 * the receipt; everything else still comes back. A file moved into the
 * person's Files leaves `/work` too, so the next read-back does not bring it
 * back.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createFilesConnector } from '../connectors/files.ts';
import { fileRecords } from '../connectors/files-ownership.ts';
import { deleteRule, workspaceNote } from '../connectors/sandbox-exec.ts';
import { connectorAction, connectorContext } from '../connectors/test-fixtures.ts';
import { FakeSandboxProvider } from './fake.ts';
import {
  describeSkipped,
  leftOnComputer,
  removeMovedFile,
  removeMovedFromComputers,
} from './move-out.ts';
import type { SandboxHandle } from './types.ts';
import { SYNC_LIMITS, syncIn, syncOut } from './workspace.ts';

const JOB = 'job_01';
const MiB = 1024 * 1024;
let root = '';
let provider: FakeSandboxProvider;
let handle: SandboxHandle;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-read-back-')));
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
  if (!path.basename(root).startsWith('melete-read-back-')) throw new Error('refusing cleanup');
  await rm(root, { recursive: true, force: true });
});

const local = (...names: string[]) => path.join(root, 'work', JOB, ...names);
const fs = () => {
  const sandbox = provider.engine.get(handle.providerSandboxId);
  if (!sandbox) throw new Error('no sandbox');
  return sandbox.fs;
};
/** A file in the computer's /work, made there the way a command would. */
const onComputer = (relative: string, content: string | Uint8Array) =>
  fs().writeFile(
    `/work/${relative}`,
    typeof content === 'string' ? Buffer.from(content) : content,
    { parents: true },
  );
const inSandbox = (relative: string) =>
  provider
    .getFile(handle, `/work/${relative}`, 64 * MiB, AbortSignal.timeout(5_000))
    .then((bytes) => Buffer.from(bytes).toString())
    .catch(() => null);
const options = () => ({
  provider,
  handle,
  workRoot: path.join(root, 'work'),
  jobId: JOB,
  signal: AbortSignal.timeout(30_000),
});
const keepNothing = deleteRule({ records: fileRecords([]), othersRunning: false });

/** A query function answering each statement from a queue, as the ledger would. */
function answers(...results: Record<string, unknown>[][]): Sql {
  return ((strings: TemplateStringsArray) =>
    strings[0]?.trimStart().startsWith('not exists')
      ? { fragment: true }
      : Promise.resolve(results.shift() ?? [])) as unknown as Sql;
}

const files = (computer: Parameters<typeof createFilesConnector>[0]['computer']) =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
    ...(computer ? { computer } : {}),
  });
const move = (connector: ReturnType<typeof files>, from: string, to = path.basename(from)) => {
  const action = connectorAction('files.move', { from, to, to_area: 'artifacts' });
  return connector.execute(action, connectorContext(action));
};

test('a leftover archive and unpacked tree stay on the computer, and a file the agent made still comes back', async () => {
  // The real run: an 8.4 MB archive and its 2,140-file tree left in /work.
  onComputer('Python-3.15.0.tar.xz', new Uint8Array(Math.round(8.4 * MiB)));
  for (let n = 0; n < 2_140; n += 1)
    onComputer(`Python-3.15.0/${n % 7 === 0 ? 'Lib/' : 'Modules/'}f${n}.c`, `int f${n};`);
  onComputer('report.md', '# The report');
  const { sent } = await syncIn(options());
  const report = await syncOut({ ...options(), deletions: { sent, keep: keepNothing } });

  expect(await readFile(local('report.md'), 'utf8')).toBe('# The report');
  expect(existsSync(local('Python-3.15.0.tar.xz'))).toBe(false);
  expect(existsSync(local('Python-3.15.0'))).toBe(false);
  expect(report.skipped.map(describeSkipped)).toEqual([
    'skipped Python-3.15.0.tar.xz (8.4 MB, over the 8 MB limit)',
    'skipped 2,140 files under Python-3.15.0/ (too many files)',
  ]);
  // Left on the computer, never taken for deleted.
  expect(report.deleted).toEqual([]);
  expect(await inSandbox('Python-3.15.0.tar.xz')).not.toBeNull();

  // The receipt says it in words the agent can act on.
  const note = workspaceNote(report);
  expect(note.workspace_skipped_count).toBe(2);
  expect(String(note.workspace_note)).toContain(
    'skipped Python-3.15.0.tar.xz (8.4 MB, over the 8 MB limit); skipped 2,140 files under Python-3.15.0/ (too many files)',
  );
});

test('a move into Files of a path the read-back left on the computer fails with that reason', async () => {
  onComputer('big.bin', new Uint8Array(SYNC_LIMITS.maxFileBytes + 1));
  for (let n = 0; n < 3; n += 1) onComputer(`tree/f${n}.txt`, 'x');
  onComputer('made.txt', 'made here');
  const report = await syncOut({ ...options(), limits: { maxFiles: 2 } });
  const receipt = workspaceNote(report);
  const ledger = () => answers([{ skipped: receipt.workspace_skipped }]);
  const connector = (sql: Sql) =>
    files({
      leftThere: (jobId, relative) => leftOnComputer(sql, jobId, relative),
      removeMoved: async () => null,
    });

  // A refused move ends as a failed outcome whose reason says why; anything else is shown whole.
  const ended = (from: string) =>
    move(connector(ledger()), from).then(
      (result) =>
        result.outcome === 'failed'
          ? result.reason
          : `${result.outcome}: ${JSON.stringify(result)}; skipped: ${JSON.stringify(report.skipped)}`,
      (error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  expect(await ended('big.bin')).toStartWith(
    '"big.bin" is not in your workspace: the last read-back from your computer left it there (8 MB, over the 8 MB limit)',
  );
  expect(await ended('tree/f1.txt')).toStartWith(
    '"tree/f1.txt" is not in your workspace: it is under tree/, which the last read-back from your computer left there (too many files)',
  );
  // A path no read-back skipped is still just not there.
  expect(await ended('never.txt')).toStartWith('there is no "never.txt" in your workspace');
  // And what did come back moves.
  const moved = await move(connector(ledger()), 'made.txt');
  expect(moved.outcome).toBe('succeeded');
});

test('the files the workspace holds come first, a big new folder is left whole, and its neighbours come', async () => {
  await mkdir(local('proj'), { recursive: true });
  await writeFile(local('proj', 'main.txt'), 'old');
  const { sent } = await syncIn(options());
  onComputer('proj/main.txt', 'new main');
  onComputer('proj/notes.txt', 'notes');
  for (let n = 0; n < 12; n += 1) onComputer(`proj/vendor/v${n}.txt`, 'v');
  for (let n = 0; n < 12; n += 1) onComputer(`downloads/d${n}.txt`, 'd');
  onComputer('out.txt', 'out');
  const report = await syncOut({
    ...options(),
    limits: { maxFiles: 10 },
    deletions: { sent, keep: keepNothing },
  });
  expect(await readFile(local('proj', 'main.txt'), 'utf8')).toBe('new main');
  expect(await readFile(local('proj', 'notes.txt'), 'utf8')).toBe('notes');
  expect(await readFile(local('out.txt'), 'utf8')).toBe('out');
  expect(existsSync(local('proj', 'vendor'))).toBe(false);
  expect(existsSync(local('downloads'))).toBe(false);
  expect(report.skipped).toEqual([
    { path: 'downloads/', reason: 'too many files', files: 12 },
    { path: 'proj/vendor/', reason: 'too many files', files: 12 },
  ]);
  expect(report.files).toBe(3);
});

test('a folder over the total size cap is left whole, by name', async () => {
  for (let n = 0; n < 3; n += 1) onComputer(`data/part${n}.bin`, new Uint8Array(40));
  onComputer('small.txt', 'small');
  const report = await syncOut({ ...options(), limits: { maxTotalBytes: 100 } });
  expect(await readFile(local('small.txt'), 'utf8')).toBe('small');
  expect(existsSync(local('data'))).toBe(false);
  expect(report.skipped.map(describeSkipped)).toEqual([
    'skipped 3 files under data/ (over the total limit of 100 bytes)',
  ]);
});

test('a file the workspace holds that grew past the cap is left there, kept here, and not taken for deleted', async () => {
  await writeFile(local('log.txt'), 'short');
  const { sent } = await syncIn(options());
  onComputer('log.txt', 'x'.repeat(64));
  const report = await syncOut({
    ...options(),
    limits: { maxFileBytes: 32 },
    deletions: { sent, keep: keepNothing },
  });
  expect(report.skipped).toEqual([
    { path: 'log.txt', reason: '64 bytes, over the 32 bytes limit' },
  ]);
  expect(report.deleted).toEqual([]);
  expect(report.kept).toEqual([]);
  expect(await readFile(local('log.txt'), 'utf8')).toBe('short');
});

test('moving a file the computer made into Files removes it from /work, and the next read-back does not bring it back', async () => {
  onComputer('charts/q3.csv', 'quarter,total\nq3,12\n');
  await syncOut(options());
  const asked: unknown[] = [];
  const connector = files({
    leftThere: async () => null,
    removeMoved: async (input) => {
      asked.push({ relative: input.relative, size: input.size, attemptId: input.attemptId });
      return removeMovedFile({ provider, handle, ...input });
    },
  });
  const moved = await move(connector, 'charts/q3.csv', 'q3.csv');
  if (moved.outcome !== 'succeeded') throw new Error('expected the move to succeed');
  expect(moved.receipt.detail.computer_copy).toBe('removed');
  expect(asked).toEqual([{ relative: 'charts/q3.csv', size: 20, attemptId: 'att_01' }]);
  expect(await inSandbox('charts/q3.csv')).toBeNull();
  expect(await readFile(path.join(root, 'spaces', 'sp_01', 'artifacts', 'q3.csv'), 'utf8')).toBe(
    'quarter,total\nq3,12\n',
  );
  await syncOut(options());
  expect(existsSync(local('charts', 'q3.csv'))).toBe(false);
});

test('a computer copy that changed, became a link or is reached through one is kept, and the receipt says so', async () => {
  onComputer('a.txt', 'moved bytes');
  onComputer('b.txt', 'moved bytes');
  onComputer('real/c.txt', 'moved bytes');
  await syncOut(options());
  // Since the read-back: a.txt changed, b.txt became a link, and the folder
  // on c.txt's path became a link to a folder with the same bytes in it.
  onComputer('a.txt', 'other bytes');
  fs().remove('/work/b.txt', false);
  fs().symlink('/work/real/c.txt', '/work/b.txt');
  await mkdir(local('via'), { recursive: true });
  await writeFile(local('via', 'c.txt'), 'moved bytes');
  fs().symlink('/work/real', '/work/via');
  const connector = files({
    leftThere: async () => null,
    removeMoved: (input) => removeMovedFile({ provider, handle, ...input }),
  });
  const reasons: Record<string, string> = {};
  for (const name of ['a.txt', 'b.txt', 'via/c.txt']) {
    const moved = await move(connector, name, name.replace('/', '-'));
    if (moved.outcome !== 'succeeded') throw new Error(`expected ${name} to move`);
    expect(moved.receipt.detail.computer_copy).toBe('kept');
    reasons[name] = String(moved.receipt.detail.computer_note);
  }
  expect(reasons['a.txt']).toContain(
    'The copy at /work/a.txt on your computer was not removed: it changed after it was read back.',
  );
  expect(reasons['b.txt']).toContain('it is a link now');
  expect(reasons['via/c.txt']).toContain('a folder on its path is a link now');
  // Nothing was removed on the computer; the files in Files stay.
  expect(await inSandbox('a.txt')).toBe('other bytes');
  expect(await inSandbox('real/c.txt')).toBe('moved bytes');
  expect(existsSync(path.join(root, 'spaces', 'sp_01', 'artifacts', 'via-c.txt'))).toBe(true);
});

test('a copy the computer no longer has, or a computer that is not running, is said plainly', async () => {
  await writeFile(local('only-here.txt'), 'written by a file step');
  const absent = await move(
    files({
      leftThere: async () => null,
      removeMoved: (input) => removeMovedFile({ provider, handle, ...input }),
    }),
    'only-here.txt',
  );
  if (absent.outcome !== 'succeeded') throw new Error('expected the move to succeed');
  expect(absent.receipt.detail.computer_copy).toBe('not_there');

  const input = {
    providerFor: () => provider,
    attemptId: 'att_01',
    jobId: JOB,
    relative: 'x.txt',
    size: 1,
    hash: 'h',
    signal: AbortSignal.timeout(5_000),
  };
  // No computer this step, and the job never ran a command on one: nothing to say.
  expect(await removeMovedFromComputers({ ...input, sql: answers([], []) })).toBeNull();
  // No computer this step, but the job ran commands on one.
  expect(await removeMovedFromComputers({ ...input, sql: answers([], [{ one: 1 }]) })).toEqual({
    outcome: 'kept',
    reason: 'your computer is not running in this step',
  });
  // The step's computer is running: removed there.
  onComputer('x.txt', 'x');
  const running = [
    {
      connection_id: 'conn_01',
      provider_sandbox_id: handle.providerSandboxId,
      image_digest: null,
      region: null,
    },
  ];
  const removed = await removeMovedFromComputers({
    ...input,
    hash: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
    sql: answers(running),
  });
  expect(removed).toEqual({ outcome: 'removed' });
  expect(await inSandbox('x.txt')).toBeNull();
});
