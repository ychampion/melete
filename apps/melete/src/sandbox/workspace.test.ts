import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openedAt } from '../connectors/files.ts';
import { FakeSandboxProvider } from './fake.ts';
import type { FileEntry, SandboxHandle, SandboxProvider } from './types.ts';
import { SyncRefusal, syncIn, syncOut, writeWorkspaceFile } from './workspace.ts';

const JOB = 'job_WORKSPACE';
const HANDLE: SandboxHandle = { providerSandboxId: 'stub', imageDigest: null, region: null };
let root = '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-sync-')));
  await mkdir(path.join(root, 'work'));
  await mkdir(path.join(root, 'outside'));
});
afterEach(async () => {
  if (!path.basename(root).startsWith('melete-sync-')) throw new Error('refusing cleanup');
  await rm(root, { recursive: true, force: true });
});

const file = (entryPath: string, content = 'x', mode = 0o644): FileEntry & { content: string } => ({
  path: entryPath,
  size: Buffer.byteLength(content),
  mode,
  symlink: false,
  directory: false,
  content,
});

/** A provider that answers with whatever listing a test hands it. */
function listing(
  entries: (FileEntry & { content?: string })[],
  sizes: Record<string, number> = {},
) {
  return {
    capabilities: {},
    async listFiles() {
      return entries.map(({ content: _content, ...entry }) => entry);
    },
    async getFile(_handle: SandboxHandle, filePath: string) {
      const relative = filePath.replace(/^\/work\//, '');
      const entry = entries.find((candidate) => candidate.path === relative);
      const bytes = Buffer.from(entry?.content ?? '');
      const size = sizes[relative];
      return size === undefined ? bytes : Buffer.alloc(size);
    },
  } as unknown as SandboxProvider;
}

const out = (provider: SandboxProvider, limits = {}) =>
  syncOut({
    provider,
    handle: HANDLE,
    workRoot: path.join(root, 'work'),
    jobId: JOB,
    signal: AbortSignal.timeout(5_000),
    limits,
  }).catch((error: unknown) => error);

const nothingWritten = async () => {
  expect(await readdir(path.join(root, 'outside'))).toEqual([]);
  expect(existsSync(path.join(root, 'work', JOB, 'kept.txt'))).toBe(false);
};

test('a listing that names a path outside the job workspace is refused before anything is written', async () => {
  for (const hostile of [
    '../escape',
    '../../outside/escape',
    '/etc/passwd',
    'a/../../escape',
    'a\\..\\..\\escape',
    'C:/escape',
    'con',
    'nul.txt',
    'trailing.',
    'a//b',
    '',
  ]) {
    const refused = await out(listing([file('kept.txt', 'safe'), file(hostile)]));
    expect(refused).toBeInstanceOf(SyncRefusal);
    expect((refused as SyncRefusal).code).toBe('path');
    await nothingWritten();
  }
});

test('a symbolic link anywhere in the listing refuses the whole synchronisation', async () => {
  const refused = await out(
    listing([file('kept.txt', 'safe'), { ...file('link'), symlink: true, size: 11 }]),
  );
  expect((refused as SyncRefusal).code).toBe('symlink');
  await nothingWritten();
});

test('the file count, per-file size and total size caps refuse the synchronisation', async () => {
  const many = Array.from({ length: 4 }, (_, index) => file(`f${index}.txt`));
  expect(((await out(listing(many), { maxFiles: 3 })) as SyncRefusal).code).toBe('too_many_files');
  expect(
    ((await out(listing([file('big.bin', 'x'.repeat(20))]), { maxFileBytes: 10 })) as SyncRefusal)
      .code,
  ).toBe('file_too_large');
  expect(
    (
      (await out(listing([file('a.txt', 'x'.repeat(8)), file('b.txt', 'x'.repeat(8))]), {
        maxTotalBytes: 10,
      })) as SyncRefusal
    ).code,
  ).toBe('too_large');
  await nothingWritten();
});

test('a file that grew between listing and fetching refuses the synchronisation', async () => {
  const refused = await out(listing([file('kept.txt', 'safe')], { 'kept.txt': 9_000 }));
  expect((refused as SyncRefusal).code).toBe('changed');
  await nothingWritten();
});

test('names that are one file on a case-insensitive host are refused', async () => {
  const refused = await out(listing([file('Report.txt'), file('report.txt')]));
  expect((refused as SyncRefusal).code).toBe('duplicate');
});

test('a link planted inside the job workspace is not followed on write', async () => {
  await mkdir(path.join(root, 'work', JOB));
  await symlink(path.join(root, 'outside'), path.join(root, 'work', JOB, 'dir'), 'junction');
  const refused = await out(
    listing([{ ...file('dir'), directory: true, size: 0 }, file('dir/planted.txt')]),
  );
  expect(refused).toBeInstanceOf(Error);
  expect(await readdir(path.join(root, 'outside'))).toEqual([]);
});

test('files arrive with mode 0o644 or 0o755 and nothing else', async () => {
  const report = await out(
    listing([
      { ...file('bin'), directory: true, size: 0, mode: 0o777 },
      file('bin/tool', '#!/bin/sh\n', 0o4777),
      file('private.txt', 'p', 0o600),
    ]),
  );
  expect(report).toMatchObject({ files: 2, directories: 1 });
  expect(await readFile(path.join(root, 'work', JOB, 'bin', 'tool'), 'utf8')).toBe('#!/bin/sh\n');
  if (process.platform !== 'win32') {
    expect((await stat(path.join(root, 'work', JOB, 'bin', 'tool'))).mode & 0o7777).toBe(0o755);
    expect((await stat(path.join(root, 'work', JOB, 'private.txt'))).mode & 0o7777).toBe(0o644);
  }
});

test('sync-in refuses a workspace above the file count, per-file size and total size caps', async () => {
  const job = path.join(root, 'work', JOB);
  await mkdir(job);
  for (const name of ['a.txt', 'b.txt', 'c.txt'])
    await writeFile(path.join(job, name), 'x'.repeat(8));
  let uploads = 0;
  const provider = {
    async putFiles() {
      uploads += 1;
    },
  } as unknown as SandboxProvider;
  const refusal = async (limits: Record<string, number>) =>
    (
      (await syncIn({
        provider,
        handle: HANDLE,
        workRoot: path.join(root, 'work'),
        jobId: JOB,
        signal: AbortSignal.timeout(5_000),
        limits,
      }).catch((error: unknown) => error)) as SyncRefusal
    ).code;
  expect(await refusal({ maxFiles: 2 })).toBe('too_many_files');
  expect(await refusal({ maxFileBytes: 4 })).toBe('file_too_large');
  expect(await refusal({ maxTotalBytes: 20 })).toBe('too_large');
  expect(uploads).toBe(0);
});

test('sync-in copies the job workspace and refuses a link in it', async () => {
  const provider = new FakeSandboxProvider();
  const handle = await provider.create(
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
  const job = path.join(root, 'work', JOB);
  await mkdir(path.join(job, 'src'), { recursive: true });
  await writeFile(path.join(job, 'src', 'main.py'), 'print(1)\n');
  const options = {
    provider,
    handle,
    workRoot: path.join(root, 'work'),
    jobId: JOB,
    signal: AbortSignal.timeout(5_000),
  };
  expect(await syncIn(options)).toMatchObject({ files: 1, bytes: 9 });
  const copied = await provider.getFile(
    handle,
    '/work/src/main.py',
    64,
    AbortSignal.timeout(5_000),
  );
  expect(new TextDecoder().decode(copied)).toBe('print(1)\n');
  await symlink(path.join(root, 'outside'), path.join(job, 'escape'), 'junction');
  const refused = await syncIn(options).catch((error: unknown) => error);
  expect((refused as SyncRefusal).code).toBe('symlink');
});

test('an opened file that is not the one at its real path is refused before it changes', async () => {
  // What a directory swapped for a link between the component check and the
  // open would leave: a handle on a file elsewhere, and the name checked here.
  const job = path.join(root, 'work', JOB);
  await mkdir(job);
  const named = path.join(job, 'notes.md');
  const elsewhere = path.join(root, 'outside', 'notes.md');
  await writeFile(named, 'mine');
  await writeFile(elsewhere, 'kept');
  const handle = await open(elsewhere, 'r+');
  try {
    // Where the system cannot say where a descriptor points, the path is checked again.
    const byPath = { descriptor: async () => null, realpath, lstat };
    await expect(openedAt(handle, named, byPath)).rejects.toThrow('changed while it was opened');
  } finally {
    await handle.close();
  }
  const own = await open(named, 'r+');
  try {
    await openedAt(own, named, { descriptor: async () => null, realpath, lstat });
  } finally {
    await own.close();
  }
  expect(await readFile(elsewhere, 'utf8')).toBe('kept');
});

test('a second name for a file elsewhere is refused on write, and the file is left alone', async () => {
  const job = path.join(root, 'work', JOB);
  await mkdir(job);
  const elsewhere = path.join(root, 'outside', 'notes.md');
  await writeFile(elsewhere, 'kept');
  await link(elsewhere, path.join(job, 'notes.md'));
  await expect(
    writeWorkspaceFile(path.join(root, 'work'), JOB, 'notes.md', new Uint8Array([1]), 0o644),
  ).rejects.toThrow(SyncRefusal);
  expect(await readFile(elsewhere, 'utf8')).toBe('kept');
});

test("a paired computer's old screenshot never goes to a sandbox, and one a sandbox still holds is removed", async () => {
  // Into the sandbox: left out.
  const left = path.join(root, 'work', JOB, 'device');
  await mkdir(left, { recursive: true });
  await writeFile(path.join(left, 'screenshot-act_01OLD.png'), 'screen');
  await writeFile(path.join(left, 'notes.txt'), 'mine');
  const sent: string[] = [];
  await syncIn({
    provider: {
      async putFiles(_handle: SandboxHandle, files: AsyncIterable<{ path: string }>) {
        for await (const entry of files) sent.push(entry.path);
      },
    } as unknown as SandboxProvider,
    handle: HANDLE,
    workRoot: path.join(root, 'work'),
    jobId: JOB,
    signal: AbortSignal.timeout(5_000),
  });
  expect(sent).toEqual(['/work/device/notes.txt']);

  // Back from a sandbox that holds a copy from before: not written back, and removed there.
  await rm(left, { recursive: true });
  const removed: string[][] = [];
  const provider = listing([file('device/screenshot-act_01OLD.png', 'screen'), file('kept.txt')]);
  Object.assign(provider, {
    async exec(_handle: SandboxHandle, spec: { argv: string[] }) {
      removed.push(spec.argv);
      return { exitCode: 0 };
    },
  });
  expect(await out(provider)).toMatchObject({ files: 1 });
  expect(removed).toEqual([['rm', '-f', '--', '/work/device/screenshot-act_01OLD.png']]);
  expect(existsSync(path.join(root, 'work', JOB, 'device'))).toBe(false);
  expect(await readFile(path.join(root, 'work', JOB, 'kept.txt'), 'utf8')).toBe('x');
});
