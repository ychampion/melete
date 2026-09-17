import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
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
import { FakeSandboxProvider } from './fake.ts';
import type { FileEntry, SandboxHandle, SandboxProvider } from './types.ts';
import { SyncRefusal, syncIn, syncOut } from './workspace.ts';

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
