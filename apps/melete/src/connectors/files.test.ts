import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectorManifest } from '@melete/contracts';
import { asConnectorFault } from './faults.ts';
import { createFilesConnector, filesManifest } from './files.ts';
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
