import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectorManifest } from '@melete/contracts';
import { asConnectorFault } from './faults.ts';
import {
  createFilesConnector,
  descriptorPath,
  filesManifest,
  openedAt,
  pinDirectory,
} from './files.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-files-'));
  await Promise.all([
    mkdir(path.join(root, 'work', 'job_01'), { recursive: true }),
    mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true }),
    mkdir(path.join(root, 'outside')),
  ]);
});
afterEach(async () => {
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`) ||
    !path.basename(root).startsWith('melete-files-')
  ) {
    throw new Error('refusing fixture cleanup outside the temp root');
  }
  await rm(resolved, { recursive: true, force: true });
});
const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });
const execute = async (kind: string, payload: Record<string, unknown>) => {
  const action = connectorAction(kind, payload);
  return connector().execute(action, connectorContext(action));
};

test('files manifests parse and workspace/artifact writes can be read and verified', async () => {
  connectorManifest.parse(filesManifest);
  for (const area of ['work', 'artifacts']) {
    const action = connectorAction('files.write', {
      path: 'nested/report.txt',
      area,
      content: 'hello',
    });
    expect((await connector().execute(action, connectorContext(action))).outcome).toBe('succeeded');
    expect((await connector().verify(action, connectorContext(action))).decision).toBe('succeeded');
    const read = await execute('files.read', { path: 'nested/report.txt', area });
    if (read.outcome !== 'succeeded') throw new Error('expected readable file');
    expect(read.receipt.detail.content).toBe('hello');
  }
});

test('a move whose source is not the recorded content is a bad output, not an unknown', async () => {
  await execute('files.write', { path: 'brief.txt', content: 'the current text' });
  let fault: unknown;
  try {
    await execute('files.move', {
      from: 'brief.txt',
      to: 'archive/brief.txt',
      content_hash: 'a'.repeat(64),
    });
  } catch (error) {
    fault = asConnectorFault(error);
  }
  // Nothing moved, so this is a question for a person rather than a retry or a
  // dispatch nobody can decide.
  expect(fault).toMatchObject({ kind: 'bad_output', may_have_committed: false });
  const still = await execute('files.read', { path: 'brief.txt' });
  expect(still.outcome).toBe('succeeded');
});

test('a write is read back before it is called delivered', async () => {
  const action = connectorAction('files.write', { path: 'note.txt', content: 'written once' });
  const result = await connector().execute(action, connectorContext(action));
  if (result.outcome !== 'succeeded') throw new Error('expected a written file');
  // The receipt's hash is the hash of what is on disk, not of what was asked
  // for: the connector read it back and compared before answering.
  const read = await execute('files.read', { path: 'note.txt' });
  if (read.outcome !== 'succeeded') throw new Error('expected a readable file');
  expect(read.receipt.detail.content_hash).toBe(result.receipt.detail.content_hash);
});

test('files list order is deterministic', async () => {
  await execute('files.write', { path: 'z.txt', content: 'z' });
  await execute('files.write', { path: 'a.txt', content: 'a' });
  const listed = await execute('files.list', { path: '.' });
  if (listed.outcome !== 'succeeded') throw new Error('expected directory');
  expect(listed.receipt.detail.entries).toEqual([
    { name: 'a.txt', kind: 'file' },
    { name: 'z.txt', kind: 'file' },
  ]);
});

test('an area nobody has written to yet lists as empty; a missing folder or file is named', async () => {
  // A new space has no artifacts folder and a new job no work folder until the
  // first write makes one. Listing either is an empty answer, not a failure.
  await rm(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true });
  await rm(path.join(root, 'work', 'job_01'), { recursive: true });
  for (const area of ['work', 'artifacts']) {
    const listed = await execute('files.list', { path: '.', area });
    if (listed.outcome !== 'succeeded') throw new Error('expected an empty listing');
    expect(listed.receipt.detail.entries).toEqual([]);
  }
  await expect(execute('files.list', { path: 'memory' })).rejects.toThrow(
    'there is no folder "memory" in work',
  );
  await expect(
    execute('files.read', { path: 'notes/today.md', area: 'artifacts' }),
  ).rejects.toThrow('there is no file "notes/today.md" in artifacts');
});

test('file boundary rejects parent traversal, absolute paths, alternate streams and device names', async () => {
  for (const target of [
    '../outside/leak',
    'dir/../../leak',
    '/etc/passwd',
    'C:/outside/leak',
    '\\\\server\\share',
    'dir\\..\\leak',
    'safe:stream',
    'NUL',
    'dir/../leak',
    'trailing./leak',
  ]) {
    await expect(execute('files.write', { path: target, content: 'bad' })).rejects.toThrow();
  }
  const action = connectorAction('files.read', { path: '.' });
  await expect(
    connector().execute(action, { ...connectorContext(action), space_id: '../other' }),
  ).rejects.toThrow('invalid trusted');
});

test('file boundary rejects directory junctions and final symlinks without touching outside content', async () => {
  const outside = path.join(root, 'outside');
  await writeFile(path.join(outside, 'secret.txt'), 'preserved');
  await symlink(
    outside,
    path.join(root, 'work', 'job_01', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(execute('files.read', { path: 'escape/secret.txt' })).rejects.toThrow(
    'symbolic links',
  );
  await expect(
    execute('files.write', { path: 'escape/secret.txt', content: 'changed' }),
  ).rejects.toThrow('symbolic links');
  expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('preserved');
  await symlink(
    outside,
    path.join(root, 'spaces', 'sp_01', 'artifacts', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(execute('files.list', { path: 'escape', area: 'artifacts' })).rejects.toThrow(
    'symbolic links',
  );
});

test('a write refuses a second name for a file outside the workspace and leaves that file alone', async () => {
  const outside = path.join(root, 'outside', 'secret.txt');
  await writeFile(outside, 'preserved');
  await link(outside, path.join(root, 'work', 'job_01', 'notes.txt'));
  await expect(execute('files.write', { path: 'notes.txt', content: 'changed' })).rejects.toThrow(
    'more than one name',
  );
  expect(await readFile(outside, 'utf8')).toBe('preserved');
});

test('move verifies by content hash and refuses to clobber a destination', async () => {
  await execute('files.write', { path: 'from.txt', content: 'move me' });
  const action = connectorAction('files.move', {
    from: 'from.txt',
    to: 'to.txt',
    to_area: 'artifacts',
    content_hash: createHash('sha256').update('move me').digest('hex'),
  });
  expect((await connector().execute(action, connectorContext(action))).outcome).toBe('succeeded');
  expect((await connector().verify(action, connectorContext(action))).decision).toBe('succeeded');
  await execute('files.write', { path: 'again.txt', content: 'again' });
  await expect(
    execute('files.move', { from: 'again.txt', to: 'to.txt', to_area: 'artifacts' }),
  ).rejects.toThrow('already exists');
  await execute('files.write', { path: 'to.txt', area: 'artifacts', content: 'changed' });
  expect((await connector().verify(action, connectorContext(action))).decision).toBe('undecided');
});

const linux = process.platform === 'linux';

test('an opened file the descriptor places elsewhere is refused, even when the path looks clean', async () => {
  const work = await realpath(path.join(root, 'work', 'job_01'));
  const named = path.join(work, 'notes.txt');
  await writeFile(named, 'mine');
  const handle = await open(named, 'r+');
  try {
    // The path lookups answer as a parent flipped back to a real directory would.
    const lookups = {
      descriptor: async () => path.join(root, 'outside', 'notes.txt'),
      realpath,
      lstat,
    };
    await expect(openedAt(handle, named, lookups)).rejects.toThrow('not where it was opened');
    await openedAt(handle, named, { ...lookups, descriptor: async () => named });
  } finally {
    await handle.close();
  }
});

test.skipIf(!linux)(
  'the descriptor names where a file opened through a swapped parent really is',
  async () => {
    const outside = await realpath(path.join(root, 'outside'));
    const work = await realpath(path.join(root, 'work', 'job_01'));
    await writeFile(path.join(outside, 'notes.txt'), 'kept');
    await symlink(outside, path.join(work, 'flip'), 'dir');
    const named = path.join(work, 'flip', 'notes.txt');
    const handle = await open(named, 'r+');
    try {
      expect(await descriptorPath(handle)).toBe(path.join(outside, 'notes.txt'));
      // The flip back to a real directory, as the path lookups would then see it.
      const opened = await handle.stat();
      const clean = {
        descriptor: descriptorPath,
        realpath: async () => named,
        lstat: async () => opened,
      };
      await expect(openedAt(handle, named, clean as never)).rejects.toThrow(
        'not where it was opened',
      );
    } finally {
      await handle.close();
    }
    expect(await readFile(path.join(outside, 'notes.txt'), 'utf8')).toBe('kept');
  },
);

test.skipIf(!linux)(
  'a held directory keeps receiving entries after its name is swapped for a link',
  async () => {
    const outside = await realpath(path.join(root, 'outside'));
    const work = await realpath(path.join(root, 'work', 'job_01'));
    await mkdir(path.join(work, 'sub'));
    const held = await pinDirectory(path.join(work, 'sub'));
    try {
      await rename(path.join(work, 'sub'), path.join(work, 'sub-moved'));
      await symlink(outside, path.join(work, 'sub'), 'dir');
      await writeFile(held.at('report.txt'), 'here');
    } finally {
      await held.close();
    }
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path.join(work, 'sub-moved', 'report.txt'), 'utf8')).toBe('here');
    await expect(pinDirectory(path.join(work, 'sub'))).rejects.toThrow();
  },
);

test.skipIf(!linux)(
  'a pipe planted at a name fails the read or write instead of waiting',
  async () => {
    const work = path.join(root, 'work', 'job_01');
    expect(spawnSync('mkfifo', [path.join(work, 'pipe.txt')]).status).toBe(0);
    await expect(execute('files.write', { path: 'pipe.txt', content: 'x' })).rejects.toThrow();
    await expect(execute('files.read', { path: 'pipe.txt' })).rejects.toThrow();
  },
  4000,
);

test("a paired computer's screenshot an earlier version left in the workspace cannot be opened", async () => {
  const left = path.join(root, 'work', 'job_01', 'device');
  await mkdir(left, { recursive: true });
  await writeFile(path.join(left, 'screenshot-act_01OLD.png'), 'the person\u2019s screen');
  for (const [kind, payload] of [
    ['files.read', { path: 'device/screenshot-act_01OLD.png' }],
    ['files.read', { path: './device/screenshot-act_01OLD.png' }],
    ['files.move', { from: 'device/screenshot-act_01OLD.png', to: 'mine.png' }],
    ['files.write', { path: 'device/screenshot-act_01OLD.png', content: 'x' }],
  ] as const) {
    const result = await execute(kind, payload).catch((error: unknown) => error);
    expect(JSON.stringify(result instanceof Error ? result.message : result)).not.toContain(
      'person',
    );
    if (!(result instanceof Error)) expect(result).toMatchObject({ outcome: 'failed' });
  }
  // The same name in the person's own Files is theirs and opens as usual.
  await mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts', 'device'), { recursive: true });
  await writeFile(
    path.join(root, 'spaces', 'sp_01', 'artifacts', 'device', 'screenshot-act_01OLD.png'),
    'theirs',
  );
  const theirs = await execute('files.read', {
    path: 'device/screenshot-act_01OLD.png',
    area: 'artifacts',
  });
  expect(JSON.stringify(theirs)).toContain('theirs');
});

test("only a new file in the person's own Files stays in their space without a question", async () => {
  const files = path.join(root, 'spaces', 'sp_01', 'artifacts');
  await writeFile(path.join(files, 'theirs.txt'), 'kept');
  const stays = (kind: string, payload: Record<string, unknown>) =>
    connector().staysInSpace?.(connectorAction(kind, payload), 'sp_01');
  expect(stays('files.write', { path: 'new.txt', area: 'artifacts', content: 'x' })).toBe(true);
  expect(stays('files.move', { from: 'a.txt', to: 'new.txt', to_area: 'artifacts' })).toBe(true);
  // Saving over theirs, a name that is a link, a path that is not a plain name,
  // moving out of or within their Files, and the agent's own workspace: no.
  await symlink(path.join(root, 'outside'), path.join(files, 'link'), 'junction').catch(() => {});
  for (const [kind, payload] of [
    ['files.write', { path: 'theirs.txt', area: 'artifacts', content: 'x' }],
    ['files.write', { path: 'link', area: 'artifacts', content: 'x' }],
    ['files.write', { path: '../escape.txt', area: 'artifacts', content: 'x' }],
    ['files.move', { from: 'theirs.txt', to: 'out.txt', area: 'artifacts', to_area: 'work' }],
    ['files.move', { from: 'theirs.txt', to: 'renamed.txt', area: 'artifacts' }],
    ['files.write', { path: 'notes.md', content: 'x' }],
  ] as const)
    expect(stays(kind, payload)).toBe(false);
});
