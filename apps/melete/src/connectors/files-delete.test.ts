/**
 * `files.delete`: everything goes to a trash it can be restored from; what
 * Melete made goes at once with a receipt, the person's own files ask with a
 * warning that names them, only what was checked goes, and no path leaves
 * its area.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type JsonObject, jobConstraints } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
import { createFilesConnector } from './files.ts';
import { fileRecords, personGivenReason } from './files-ownership.ts';
import { filesTrash, hasTrash, moveToTrash, restoreFromTrash, sweepTrash } from './files-trash.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-delete-'));
  await Promise.all([
    mkdir(path.join(root, 'work', 'job_01'), { recursive: true }),
    mkdir(path.join(root, 'spaces', 'sp_01', 'artifacts'), { recursive: true }),
    mkdir(path.join(root, 'outside')),
  ]);
});
afterEach(async () => {
  if (!path.basename(root).startsWith('melete-delete-')) throw new Error('refusing cleanup');
  await rm(root, { recursive: true, force: true });
});

const work = (...names: string[]) => path.join(root, 'work', 'job_01', ...names);
const files = (...names: string[]) => path.join(root, 'spaces', 'sp_01', 'artifacts', ...names);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });

/** A transaction that answers every query with these action rows. */
const recorded = (rows: unknown[] = []) => (async () => rows) as unknown as Query;

const ctx = {
  job_id: 'job_01',
  space_id: 'sp_01',
  idempotency_key: '',
  constraints: jobConstraints.parse({}),
};

async function prepared(payload: JsonObject, rows: unknown[] = []) {
  const files = connector();
  const bound = await files.prepare?.(payload, ctx, recorded(rows), 'files.delete');
  if (!bound) throw new Error('files.delete is not prepared');
  const action = connectorAction('files.delete', bound);
  return { files, action, checked: bound.checked as Record<string, unknown> };
}

async function run(payload: JsonObject, rows: unknown[] = []) {
  const { files, action, checked } = await prepared(payload, rows);
  return { files, action, checked, result: await files.execute(action, connectorContext(action)) };
}

test('a file Melete made in its workspace is deleted without asking, with a receipt', async () => {
  await mkdir(work('smoke-test'));
  await writeFile(work('smoke-test', 'notes.md'), 'hello');
  const { files, action, checked, result } = await run({ path: 'smoke-test/notes.md' });
  expect(checked).toMatchObject({ owner: 'agent', what: 'file', files: 1, bytes: 5 });
  expect(checked.warning).toBeUndefined();
  expect(files.asksFirst?.(action)).toBe(false);
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  expect(result.receipt.detail).toMatchObject({
    path: 'smoke-test/notes.md',
    area: 'work',
    deleted: 'file',
    deleted_count: 1,
    owner: 'agent',
    content_hash: sha('hello'),
  });
  expect(String(result.receipt.detail.trash_id)).toMatch(/^del_/);
  expect(existsSync(work('smoke-test', 'notes.md'))).toBe(false);
  expect((await files.verify(action, connectorContext(action))).decision).toBe('succeeded');
});

test('a folder Melete made goes whole, and a link inside it is removed without being followed', async () => {
  await mkdir(work('smoke-test', 'inner'), { recursive: true });
  await writeFile(work('smoke-test', 'notes.md'), 'hello');
  await writeFile(work('smoke-test', 'inner', 'deep.txt'), 'deeper');
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'preserved');
  await symlink(
    path.join(root, 'outside'),
    work('smoke-test', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const { checked, result } = await run({ path: 'smoke-test' });
  expect(checked).toMatchObject({ owner: 'agent', what: 'folder', files: 2, bytes: 11 });
  expect(result.outcome).toBe('succeeded');
  expect(existsSync(work('smoke-test'))).toBe(false);
  expect(await readFile(path.join(root, 'outside', 'secret.txt'), 'utf8')).toBe('preserved');
});

test("a file in the person's Files asks first, with a warning that names it", async () => {
  await writeFile(files('report.pdf'), 'theirs');
  const {
    files: connectorFiles,
    action,
    checked,
  } = await prepared({
    path: 'report.pdf',
    area: 'artifacts',
  });
  expect(checked).toMatchObject({ owner: 'person', what: 'file' });
  expect(checked.warning).toBe(
    'This deletes “report.pdf” from your Files. It can be restored from the trash for 7 days.',
  );
  expect(connectorFiles.asksFirst?.(action)).toBe(true);
  // Nothing goes before the person answers; once they agree, it does.
  expect(await readFile(files('report.pdf'), 'utf8')).toBe('theirs');
  const done = await connectorFiles.execute(action, connectorContext(action));
  expect(done.outcome).toBe('succeeded');
  expect(existsSync(files('report.pdf'))).toBe(false);
});

test("a file this conversation saved new in the person's Files is its own until it changes", async () => {
  await writeFile(files('draft.md'), 'made here');
  const saved = [
    {
      kind: 'files.write',
      canonical_payload: { path: 'draft.md', area: 'artifacts', content: 'made here' },
      receipt: { detail: { created: true, content_hash: sha('made here') } },
    },
  ];
  expect((await prepared({ path: 'draft.md', area: 'artifacts' }, saved)).checked.owner).toBe(
    'agent',
  );
  // Saved over an existing file, it stays the person's.
  const over = [{ ...saved[0], receipt: { detail: { content_hash: sha('made here') } } }];
  expect((await prepared({ path: 'draft.md', area: 'artifacts' }, over)).checked.owner).toBe(
    'person',
  );
  // Changed since, by the person or anyone else: theirs.
  await writeFile(files('draft.md'), 'edited by the person');
  expect((await prepared({ path: 'draft.md', area: 'artifacts' }, saved)).checked.owner).toBe(
    'person',
  );
});

test('a file the person gave the agent asks first, also after the agent renamed it', async () => {
  await writeFile(work('renamed.csv'), 'a,b');
  const rows = [
    {
      kind: 'files.save_attachment',
      canonical_payload: { attachment_id: 'file_1', path: 'upload.csv' },
      receipt: { detail: { path: 'upload.csv' } },
    },
    {
      kind: 'files.move',
      canonical_payload: { from: 'upload.csv', to: 'renamed.csv' },
      receipt: { detail: { content_hash: sha('a,b') } },
    },
  ];
  const { files: connectorFiles, action, checked } = await prepared({ path: 'renamed.csv' }, rows);
  expect(checked.owner).toBe('person');
  expect(checked.warning).toBe(
    'This deletes “renamed.csv”, which you gave Melete. It can be restored from the trash for 7 days.',
  );
  expect(connectorFiles.asksFirst?.(action)).toBe(true);
  // A folder holding it asks too.
  await mkdir(work('data'));
  await writeFile(work('data', 'mine.txt'), 'x');
  const inFolder = [{ ...rows[0], receipt: { detail: { path: 'data/mine.txt' } } }];
  const folder = (await prepared({ path: 'data' }, inFolder)).checked;
  expect(folder.owner).toBe('person');
  expect(folder.warning).toBe(
    'This deletes the folder “data” with its file, one of which you gave Melete. It can be restored from the trash for 7 days.',
  );
});

test('a delete whose target changed after it was decided deletes nothing', async () => {
  await writeFile(work('notes.md'), 'hello');
  const { files: connectorFiles, action } = await prepared({ path: 'notes.md' });
  await writeFile(work('notes.md'), 'hello, changed');
  await expect(connectorFiles.execute(action, connectorContext(action))).rejects.toThrow(
    'changed after this delete was decided',
  );
  expect(await readFile(work('notes.md'), 'utf8')).toBe('hello, changed');
  // An action that never went through the check is refused outright.
  const unchecked = connectorAction('files.delete', { path: 'notes.md' });
  await expect(connectorFiles.execute(unchecked, connectorContext(unchecked))).rejects.toThrow(
    'not checked',
  );
});

test('traversal, links, area roots and other conversations’ files are refused', async () => {
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'preserved');
  for (const target of [
    '../outside/secret.txt',
    'dir/../../outside/secret.txt',
    '/etc/passwd',
    'C:/outside/secret.txt',
    'dir\\..\\..\\outside',
    'NUL',
    '.',
  ])
    await expect(prepared({ path: target })).rejects.toThrow();
  await expect(prepared({ path: '.', area: 'artifacts' })).rejects.toThrow('a whole area');
  await expect(prepared({ path: 'from-chats/art_1/x.md', area: 'artifacts' })).rejects.toThrow(
    'another conversation',
  );
  await symlink(
    path.join(root, 'outside'),
    work('escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(prepared({ path: 'escape' })).rejects.toThrow('symbolic links');
  await expect(prepared({ path: 'escape/secret.txt' })).rejects.toThrow('symbolic links');
  await expect(prepared({ path: 'missing.txt' })).rejects.toThrow('there is no file or folder');
  // Melete's own records (stored output, screenshots) are never deleted this way.
  await mkdir(work('.melete', 'exec'), { recursive: true });
  await writeFile(work('.melete', 'exec', 'act_1.out'), 'output');
  await expect(prepared({ path: '.melete' })).rejects.toThrow("Melete's own records");
  await expect(prepared({ path: '.melete/exec/act_1.out' })).rejects.toThrow(
    "Melete's own records",
  );
  expect(await readFile(path.join(root, 'outside', 'secret.txt'), 'utf8')).toBe('preserved');
});

test('the records follow a file through moves and deletes', () => {
  const records = fileRecords([
    {
      kind: 'files.save_attachment',
      canonical_payload: { path: 'in/a.txt' },
      receipt: { detail: { path: 'in/a.txt' } },
    },
    {
      kind: 'files.move',
      canonical_payload: { from: 'theirs.txt', to: 'out.txt', area: 'artifacts', to_area: 'work' },
      receipt: { detail: { content_hash: 'h' } },
    },
    {
      kind: 'files.move',
      canonical_payload: { from: 'in/a.txt', to: 'kept.txt', to_area: 'artifacts' },
      receipt: { detail: { content_hash: 'h2' } },
    },
    { kind: 'files.delete', canonical_payload: { path: 'out.txt' }, receipt: { detail: {} } },
  ]);
  expect([...records.personInWork]).toEqual([]);
  // Moved into the person's Files from one they gave: still theirs, not Melete's.
  expect(records.madeInFiles.has('kept.txt')).toBe(false);
  expect(personGivenReason(fileRecords([]), 'anything')).toBeNull();
});

test('a delete goes to the trash, and files.restore puts all of it back', async () => {
  await mkdir(work('smoke-test', 'inner'), { recursive: true });
  for (let n = 0; n < 30; n += 1) await writeFile(work('smoke-test', `f${n}.txt`), `file ${n}`);
  await writeFile(work('smoke-test', 'inner', 'deep.txt'), 'deeper');
  const { files: connectorFiles, checked, result } = await run({ path: 'smoke-test' });
  // The card lists the first 20 names; the count says the rest.
  expect((checked.names as string[]).length).toBe(20);
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  const detail = result.receipt.detail;
  expect(detail.deleted_count).toBe(31);
  expect((detail.deleted_names as string[]).length).toBe(20);
  expect(existsSync(work('smoke-test'))).toBe(false);
  const trash = String(detail.trash_id);
  expect(existsSync(path.join(root, 'work', '.trash', 'job_01', trash, 'manifest.json'))).toBe(
    true,
  );
  // Restored, a file now at one of the paths is never replaced: that one stays in the trash.
  await mkdir(work('smoke-test'));
  await writeFile(work('smoke-test', 'f0.txt'), 'written since');
  const restore = connectorAction(
    'files.restore',
    { trash_id: trash },
    'act_01J0000000000000000000RST',
  );
  const back = await connectorFiles.execute(restore, connectorContext(restore));
  if (back.outcome !== 'succeeded') throw new Error('expected a restore receipt');
  expect(back.receipt.detail).toMatchObject({ restored_count: 30 });
  expect((back.receipt.detail.kept as { path: string }[])[0]?.path).toBe('smoke-test/f0.txt');
  expect(await readFile(work('smoke-test', 'f0.txt'), 'utf8')).toBe('written since');
  expect(await readFile(work('smoke-test', 'f29.txt'), 'utf8')).toBe('file 29');
  expect(await readFile(work('smoke-test', 'inner', 'deep.txt'), 'utf8')).toBe('deeper');
  // Once the path is free again, the rest comes back too.
  await rm(work('smoke-test', 'f0.txt'));
  const again = connectorAction(
    'files.restore',
    { trash_id: trash },
    'act_01J0000000000000000000RS2',
  );
  expect((await connectorFiles.execute(again, connectorContext(again))).outcome).toBe('succeeded');
  expect(await readFile(work('smoke-test', 'f0.txt'), 'utf8')).toBe('file 0');
  expect(existsSync(path.join(root, 'work', '.trash', 'job_01', trash))).toBe(false);
});

test('a folder delete takes only what was checked; a file added since stays, with its folder', async () => {
  await mkdir(files('reports'));
  await writeFile(files('reports', 'q1.pdf'), 'one');
  await writeFile(files('reports', 'q2.pdf'), 'two');
  const {
    files: connectorFiles,
    action,
    checked,
  } = await prepared({
    path: 'reports',
    area: 'artifacts',
  });
  expect(checked.names).toEqual(['q1.pdf', 'q2.pdf']);
  expect(checked.reason).toBe("It is in the person's Files.");
  // Approved as two files; a third is saved before the delete is sent. The
  // state differs, so nothing is taken and the agent is told to ask again.
  await writeFile(files('reports', 'q3.pdf'), 'three');
  await expect(connectorFiles.execute(action, connectorContext(action))).rejects.toThrow(
    'changed after this delete was decided',
  );
  expect(await readFile(files('reports', 'q1.pdf'), 'utf8')).toBe('one');
});

test('the trash is swept after its days, and only the trash', async () => {
  await writeFile(work('old.txt'), 'old');
  const { result } = await run({ path: 'old.txt' });
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  const trash = path.join(root, 'work', '.trash', 'job_01', String(result.receipt.detail.trash_id));
  const roots = { workRoot: path.join(root, 'work'), spacesRoot: path.join(root, 'spaces') };
  expect(await sweepTrash(roots, 7)).toBe(0);
  expect(existsSync(trash)).toBe(true);
  expect(await sweepTrash(roots, 7, Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
  expect(existsSync(trash)).toBe(false);
  expect(existsSync(work())).toBe(true);
});

test('a file added while a folder is being deleted stays, and its folder with it', async () => {
  await mkdir(files('reports'));
  await writeFile(files('reports', 'q1.pdf'), 'one');
  await writeFile(files('reports', 'q3.pdf'), 'added after the check');
  const trashed = await moveToTrash(
    filesTrash(await realpath(path.join(root, 'spaces')), 'sp_01', 'job_01'),
    [{ path: 'reports/q1.pdf', hash: sha('one') }],
    { days: 7, folders: ['reports'] },
  );
  expect(trashed.moved).toEqual(['reports/q1.pdf']);
  expect(trashed.kept).toEqual([
    { path: 'reports', reason: 'something was added to it after the delete was decided' },
  ]);
  expect(await readFile(files('reports', 'q3.pdf'), 'utf8')).toBe('added after the check');
  expect(existsSync(files('reports', 'q1.pdf'))).toBe(false);
});

test('a file that changed is checked in the trash and moved back, not deleted', async () => {
  await writeFile(work('notes.md'), 'changed since the check');
  const trashed = await moveToTrash(
    {
      area: 'work',
      base: await realpath(path.join(root, 'work')),
      origin: ['job_01'],
      trash: ['.trash', 'job_01'],
    },
    [{ path: 'notes.md', hash: sha('as checked') }],
    { days: 7 },
  );
  expect(trashed).toMatchObject({ trash_id: null, moved: [] });
  expect(trashed.kept).toEqual([
    { path: 'notes.md', reason: 'it changed after the delete was decided' },
  ]);
  expect(await readFile(work('notes.md'), 'utf8')).toBe('changed since the check');
});

const workPlace = async () => ({
  area: 'work' as const,
  base: await realpath(path.join(root, 'work')),
  origin: ['job_01'],
  trash: ['.trash', 'job_01'],
});

test('the trash keeps to its size: the oldest goes first, and a delete larger than it all is refused', async () => {
  const place = await workPlace();
  await writeFile(work('old.bin'), 'a'.repeat(600));
  const first = await moveToTrash(place, [{ path: 'old.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
    now: new Date(Date.now() - 60_000),
  });
  expect(first.trash_id).not.toBeNull();
  await writeFile(work('new.bin'), 'b'.repeat(600));
  const second = await moveToTrash(place, [{ path: 'new.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
  });
  // Both would pass 1000 bytes: the older delete makes room, and says so.
  expect(second.evicted).toEqual([String(first.trash_id)]);
  expect(await hasTrash(place, String(first.trash_id))).toBe(false);
  expect(await hasTrash(place, String(second.trash_id))).toBe(true);
  // Larger than the whole trash: nothing moves, and the reason says why.
  await writeFile(work('huge.bin'), 'c'.repeat(1500));
  const refused = await moveToTrash(place, [{ path: 'huge.bin', hash: null }], {
    days: 7,
    maxBytes: 1000,
  });
  expect(refused).toMatchObject({ trash_id: null, moved: [] });
  expect(refused.kept[0]?.reason).toContain('the trash holds at most');
  expect(existsSync(work('huge.bin'))).toBe(true);
});

test('a move cut short by a crash still restores what reached the trash', async () => {
  const place = await workPlace();
  await writeFile(work('a.txt'), 'first');
  await writeFile(work('b.txt'), 'second');
  // A crash after the first file moved: the manifest names both, only one is there.
  const id = 'del_0000000000001_aaaaaaaaaaaa';
  const items = path.join(root, 'work', '.trash', 'job_01', id, 'items');
  await mkdir(items, { recursive: true });
  await writeFile(
    path.join(root, 'work', '.trash', 'job_01', id, 'manifest.json'),
    JSON.stringify({
      version: 1,
      area: 'work',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      items: [
        { path: 'a.txt', item: '0' },
        { path: 'b.txt', item: '1' },
      ],
      folders: [],
    }),
  );
  await writeFile(path.join(items, '0'), 'first');
  await rm(work('a.txt'));
  expect(await hasTrash(place, id)).toBe(true);
  const back = await restoreFromTrash(place, id);
  expect(back).toEqual({ restored: ['a.txt'], kept: [] });
  expect(await readFile(work('a.txt'), 'utf8')).toBe('first');
  expect(await readFile(work('b.txt'), 'utf8')).toBe('second');
  expect(existsSync(path.join(root, 'work', '.trash', 'job_01', id))).toBe(false);
});

test('the sweep keeps trash until the time its receipt promised, whatever the setting is now', async () => {
  await writeFile(work('kept.txt'), 'kept');
  const { result } = await run({ path: 'kept.txt' });
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  const roots = { workRoot: path.join(root, 'work'), spacesRoot: path.join(root, 'spaces') };
  // Lowered to one day, three days on: the receipt said seven, so it stays.
  expect(await sweepTrash(roots, 1, Date.now() + 3 * 86_400_000)).toBe(0);
  expect(await sweepTrash(roots, 1, Date.now() + 8 * 86_400_000)).toBe(1);
});

test('a workspace delete whose records cannot be read asks first', async () => {
  await writeFile(work('upload.csv'), 'a,b');
  const bound = await connector().prepare?.(
    { path: 'upload.csv' },
    ctx,
    null as unknown as Query,
    'files.delete',
  );
  if (!bound) throw new Error('files.delete is not prepared');
  const checked = bound.checked as Record<string, unknown>;
  expect(checked.owner).toBe('person');
  expect(String(checked.reason)).toContain('could not check');
});

test('an unsettled action can make a file the person’s, but never Melete’s', () => {
  const given = {
    kind: 'files.save_attachment',
    status: 'succeeded',
    canonical_payload: { path: 'upload.csv' },
    receipt: { detail: { path: 'upload.csv' } },
  };
  // A save whose outcome is not known yet may have put the file there.
  for (const status of ['admitted', 'dispatched', 'unknown', 'unresolved'])
    expect(
      fileRecords([{ ...given, status }]).personInWork.has('upload.csv'),
      `save ${status}`,
    ).toBe(true);
  // A delete or move that may not have happened leaves the file the person's.
  for (const status of ['dispatched', 'unknown', 'unresolved']) {
    const deleted = fileRecords([
      given,
      { kind: 'files.delete', status, canonical_payload: { path: 'upload.csv' }, receipt: null },
    ]);
    expect(deleted.personInWork.has('upload.csv'), `delete ${status}`).toBe(true);
    const moved = fileRecords([
      given,
      {
        kind: 'files.move',
        status,
        canonical_payload: { from: 'upload.csv', to: 'renamed.csv' },
        receipt: null,
      },
    ]);
    expect([...moved.personInWork].sort(), `move ${status}`).toEqual(['renamed.csv', 'upload.csv']);
    // A new file in the person's Files is Melete's only once its write settled.
    const written = fileRecords([
      {
        kind: 'files.write',
        status,
        canonical_payload: { path: 'new.md', area: 'artifacts' },
        receipt: { detail: { created: true, content_hash: 'h' } },
      },
    ]);
    expect(written.madeInFiles.has('new.md'), `write ${status}`).toBe(false);
  }
  // A denied or failed action changed nothing.
  for (const status of ['denied', 'failed', 'proposed', 'needs_approval'])
    expect(fileRecords([{ ...given, status }]).personInWork.size, `save ${status}`).toBe(0);
});

test("one conversation cannot restore another conversation's trash", async () => {
  await writeFile(work('notes.md'), 'hello');
  const { result } = await run({ path: 'notes.md' });
  if (result.outcome !== 'succeeded') throw new Error('expected a receipt');
  const trash = String(result.receipt.detail.trash_id);
  await mkdir(path.join(root, 'work', 'job_02'), { recursive: true });
  const restore = {
    ...connectorAction('files.restore', { trash_id: trash }, 'act_01J0000000000000000000XJB'),
    job_id: 'job_02',
  };
  await expect(connector().execute(restore, connectorContext(restore))).rejects.toThrow(
    'nothing in the trash',
  );
  expect(existsSync(work('notes.md'))).toBe(false);
  expect(existsSync(path.join(root, 'work', 'job_02', 'notes.md'))).toBe(false);
  expect(existsSync(path.join(root, 'work', '.trash', 'job_01', trash))).toBe(true);
});
