/**
 * Commands in the agent's computer can change its workspace while a files
 * tool is between checking a path and opening it. Each test here makes that
 * change at exactly that point: once the path check has passed, a directory on
 * the way is swapped for a link to somewhere the agent may not reach. The open
 * after the check must still land only where the check looked, or fail.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { DEVICE_SCREENS_DIRECTORY, moveJobScreens } from '../devices/screens.ts';
import type { SandboxHandle, SandboxProvider } from '../sandbox/types.ts';
import { readWorkspaceFile, syncIn } from '../sandbox/workspace.ts';
import { createFilesConnector, holdBeneath, openBeneath, pathCheck, READ_FLAGS } from './files.ts';
import { connectorAction, connectorContext } from './test-fixtures.ts';

const linux = process.platform === 'linux';
const realCheck = pathCheck.noLinks;

let root: string;
let work: string;
let outside: string;
let artifacts: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-race-')));
  work = path.join(root, 'work', 'job_01');
  outside = path.join(root, 'outside');
  artifacts = path.join(root, 'spaces', 'sp_01', 'artifacts');
  await Promise.all([
    mkdir(work, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
    mkdir(outside),
  ]);
});
afterEach(async () => {
  pathCheck.noLinks = realCheck;
  if (!path.basename(root).startsWith('melete-race-')) throw new Error('refusing cleanup');
  await rm(root, { recursive: true, force: true });
});

/**
 * Once a path check whose last name is `when` has passed, move `directory`
 * aside and put a link to `to` in its place. Returns how often that happened.
 */
function swapAfterCheck(directory: string, to: string, when: string): () => number {
  let swapped = 0;
  pathCheck.noLinks = async (base, segments, createParents) => {
    const checked = await realCheck(base, segments, createParents);
    if (!swapped && segments.at(-1) === when) {
      swapped += 1;
      await rename(directory, `${directory}-aside`);
      await symlink(to, directory, 'dir');
    }
    return checked;
  };
  return () => swapped;
}

const connector = () =>
  createFilesConnector({
    workRoot: path.join(root, 'work'),
    spacesRoot: path.join(root, 'spaces'),
  });
const execute = async (kind: string, payload: Record<string, unknown>) => {
  const action = connectorAction(kind, payload);
  return connector().execute(action, connectorContext(action));
};
const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error: error as Error }),
  );

test.skipIf(!linux)(
  'a read whose parent becomes a link after the check reads nothing outside',
  async () => {
    await mkdir(path.join(work, 'sub'));
    await writeFile(path.join(work, 'sub', 'notes.txt'), 'mine');
    await writeFile(path.join(outside, 'notes.txt'), 'another job’s secret');
    const swapped = swapAfterCheck(path.join(work, 'sub'), outside, 'notes.txt');
    const result = await settle(execute('files.read', { path: 'sub/notes.txt' }));
    expect(swapped()).toBe(1);
    expect(JSON.stringify(result.value)).not.toContain('secret');
    expect(result.error?.message).toContain('symbolic links');
  },
);

test.skipIf(!linux)(
  'a listing whose folder becomes a link after the check lists nothing outside',
  async () => {
    await mkdir(path.join(work, 'sub'));
    await writeFile(path.join(outside, 'secret-name.txt'), 'x');
    const swapped = swapAfterCheck(path.join(work, 'sub'), outside, 'sub');
    const result = await settle(execute('files.list', { path: 'sub' }));
    expect(swapped()).toBe(1);
    expect(JSON.stringify(result.value)).not.toContain('secret-name');
    expect(result.error?.message).toContain('symbolic links');
  },
);

test.skipIf(!linux)(
  'a write whose parent becomes a link to the person’s Files after the check lands nowhere',
  async () => {
    await mkdir(path.join(work, 'sub'));
    const swapped = swapAfterCheck(path.join(work, 'sub'), artifacts, 'planted.txt');
    const result = await settle(execute('files.write', { path: 'sub/planted.txt', content: 'x' }));
    expect(swapped()).toBe(1);
    expect(result.error).not.toBeNull();
    expect(await readdir(artifacts)).toEqual([]);
  },
);

test.skipIf(!linux)(
  'a write never creates a folder through a link, even one planted before the check',
  async () => {
    await symlink(artifacts, path.join(work, 'sub'), 'dir');
    // No check runs at all: the walk alone must refuse.
    pathCheck.noLinks = async (base, segments) => path.join(base, ...segments);
    const result = await settle(
      execute('files.write', { path: 'sub/deeper/planted.txt', content: 'x' }),
    );
    expect(result.error?.message).toContain('symbolic links');
    expect(await readdir(artifacts)).toEqual([]);
  },
);

test.skipIf(!linux)(
  'a move into the person’s Files whose source folder becomes a link moves nothing',
  async () => {
    await mkdir(path.join(work, 'sub'));
    await writeFile(path.join(work, 'sub', 'notes.txt'), 'mine');
    await writeFile(path.join(outside, 'notes.txt'), 'another job’s secret');
    const swapped = swapAfterCheck(path.join(work, 'sub'), outside, 'notes.txt');
    const result = await settle(
      execute('files.move', { from: 'sub/notes.txt', to: 'kept.txt', to_area: 'artifacts' }),
    );
    expect(swapped()).toBe(1);
    expect(result.error).not.toBeNull();
    expect(await readdir(artifacts)).toEqual([]);
    expect(await readFile(path.join(outside, 'notes.txt'), 'utf8')).toBe('another job’s secret');
  },
);

test.skipIf(!linux)(
  'a file moved into the person’s Files keeps no second name in the workspace',
  async () => {
    await writeFile(path.join(work, 'notes.txt'), 'mine');
    await link(path.join(work, 'notes.txt'), path.join(work, 'kept.txt'));
    const moved = await execute('files.move', {
      from: 'notes.txt',
      to: 'notes.txt',
      to_area: 'artifacts',
    });
    expect(moved.outcome).toBe('succeeded');
    // A later command in the agent's computer edits the name it kept.
    await writeFile(path.join(work, 'kept.txt'), 'changed without asking');
    expect(await readFile(path.join(artifacts, 'notes.txt'), 'utf8')).toBe('mine');
    await expect(readFile(path.join(work, 'notes.txt'))).rejects.toThrow();
  },
);

test.skipIf(!linux)(
  'a file moved into the person’s Files cannot be written through a handle held open before',
  async () => {
    await writeFile(path.join(work, 'notes.txt'), 'mine');
    const held = await open(path.join(work, 'notes.txt'), 'r+');
    try {
      const moved = await execute('files.move', {
        from: 'notes.txt',
        to: 'notes.txt',
        to_area: 'artifacts',
      });
      expect(moved.outcome).toBe('succeeded');
      await held.write('changed without asking', 0);
      await held.sync();
    } finally {
      await held.close();
    }
    expect(await readFile(path.join(artifacts, 'notes.txt'), 'utf8')).toBe('mine');
  },
);

test.skipIf(!linux)(
  'a workspace read whose parent becomes a link after the check reads nothing outside',
  async () => {
    await mkdir(path.join(work, 'sub'));
    await writeFile(path.join(work, 'sub', 'out.txt'), 'mine');
    await writeFile(path.join(outside, 'out.txt'), 'secret');
    const swapped = swapAfterCheck(path.join(work, 'sub'), outside, 'out.txt');
    const result = await settle(
      readWorkspaceFile(path.join(root, 'work'), 'job_01', 'sub/out.txt', 1024),
    );
    expect(swapped()).toBe(1);
    expect(String(result.value ?? '')).not.toContain('secret');
    expect(result.error).not.toBeNull();
  },
);

test.skipIf(!linux)(
  'a copy into the sandbox whose folder becomes a link after the listing sends nothing outside',
  async () => {
    await mkdir(path.join(work, 'src'));
    // The same size, so only where the bytes come from tells the two apart.
    await writeFile(path.join(work, 'src', 'main.py'), 'print(1)\n');
    await writeFile(path.join(outside, 'main.py'), 'secret!!\n');
    const sent: string[] = [];
    let swaps = 0;
    const provider = {
      async putFiles(_handle: SandboxHandle, files: AsyncIterable<{ bytes: Uint8Array }>) {
        // The workspace has been listed; the files are read as they are sent.
        await rename(path.join(work, 'src'), path.join(work, 'src-aside'));
        await symlink(outside, path.join(work, 'src'), 'dir');
        swaps += 1;
        for await (const file of files) sent.push(Buffer.from(file.bytes).toString('utf8'));
      },
    } as unknown as SandboxProvider;
    const swapped = () => swaps;
    const result = await settle(
      syncIn({
        provider,
        handle: { providerSandboxId: 'stub', imageDigest: null, region: null },
        workRoot: path.join(root, 'work'),
        jobId: 'job_01',
        signal: AbortSignal.timeout(5_000),
      }),
    );
    expect(swapped()).toBe(1);
    expect(sent.join('')).not.toContain('secret');
    expect(result.error).not.toBeNull();
  },
);

test.skipIf(!linux)(
  'moving old screenshots out follows no link swapped in for the device folder',
  async () => {
    const other = path.join(root, 'work', 'job_02', 'device');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'screenshot-act_02OTHER.png'), 'another job’s screen');
    await mkdir(path.join(work, 'device'));
    await writeFile(path.join(work, 'device', 'screenshot-act_01MINE.png'), 'mine');
    const swapped = swapAfterCheck(path.join(work, 'device'), other, 'device');
    const result = await settle(moveJobScreens(path.join(root, 'work'), 'job_01'));
    expect(swapped()).toBe(1);
    expect(result.error).not.toBeNull();
    // The other job's picture is where it was, and not filed under this job.
    expect(await readFile(path.join(other, 'screenshot-act_02OTHER.png'), 'utf8')).toBe(
      'another job’s screen',
    );
    const store = path.join(root, 'work', DEVICE_SCREENS_DIRECTORY, 'job_01');
    expect(await readdir(store).catch(() => [])).not.toContain('act_02OTHER.png');
  },
);

test.skipIf(!linux)(
  'the walk refuses a link on the way with no check before it, and creates nothing past it',
  async () => {
    const base = path.join(root, 'work');
    await symlink(outside, path.join(work, 'sub'), 'dir');
    await writeFile(path.join(outside, 'notes.txt'), 'secret');
    await expect(openBeneath(base, ['job_01', 'sub', 'notes.txt'], READ_FLAGS)).rejects.toThrow(
      'symbolic links',
    );
    await expect(holdBeneath(base, ['job_01', 'sub', 'made'], true)).rejects.toThrow(
      'symbolic links',
    );
    await symlink(path.join(outside, 'notes.txt'), path.join(work, 'last.txt'));
    await expect(openBeneath(base, ['job_01', 'last.txt'], READ_FLAGS)).rejects.toThrow(
      'symbolic links',
    );
    expect(await readdir(outside)).toEqual(['notes.txt']);
    const held = await holdBeneath(base, ['job_01', 'new', 'deeper'], true);
    await held.close();
    expect(await readdir(path.join(work, 'new'))).toEqual(['deeper']);
  },
);

test('a write into the person’s Files let through as new never replaces a file that appeared since', async () => {
  const action = connectorAction('files.write', {
    path: 'plan.md',
    area: 'artifacts',
    content: 'from the agent',
  });
  // Decided while the name was unused, so nobody was asked: the broker says
  // so with `only_new`.
  expect(connector().staysInSpace?.(action, 'sp_01')).toBe(true);
  const onlyNew = { ...connectorContext(action), only_new: true };
  await writeFile(path.join(artifacts, 'plan.md'), 'the person’s own plan');
  await expect(connector().execute(action, onlyNew)).rejects.toThrow('needs the person to approve');
  expect(await readFile(path.join(artifacts, 'plan.md'), 'utf8')).toBe('the person’s own plan');
  // A retry of a write that did land finds its own bytes and is done.
  await writeFile(path.join(artifacts, 'plan.md'), 'from the agent');
  expect((await connector().execute(action, onlyNew)).outcome).toBe('succeeded');
  // Approved, or covered by a standing permission to save files, saving over
  // theirs goes ahead: the broker does not say `only_new` then.
  await writeFile(path.join(artifacts, 'plan.md'), 'the person’s own plan');
  expect((await connector().execute(action, connectorContext(action))).outcome).toBe('succeeded');
  expect(await readFile(path.join(artifacts, 'plan.md'), 'utf8')).toBe('from the agent');
});

test('a move into the person’s Files never replaces a file that appeared since', async () => {
  await writeFile(path.join(work, 'notes.txt'), 'mine');
  const action = connectorAction('files.move', {
    from: 'notes.txt',
    to: 'notes.txt',
    to_area: 'artifacts',
  });
  expect(connector().staysInSpace?.(action, 'sp_01')).toBe(true);
  await writeFile(path.join(artifacts, 'notes.txt'), 'theirs');
  await expect(connector().execute(action, connectorContext(action))).rejects.toThrow(
    'already exists',
  );
  expect(await readFile(path.join(artifacts, 'notes.txt'), 'utf8')).toBe('theirs');
  expect(await readFile(path.join(work, 'notes.txt'), 'utf8')).toBe('mine');
});

test.skipIf(!linux)('the walk itself refuses a name that is not one plain name', async () => {
  const base = path.join(root, 'work');
  await writeFile(path.join(outside, 'notes.txt'), 'secret');
  for (const segments of [
    ['job_01', '..', '..', 'outside', 'notes.txt'],
    ['job_01', '.', 'notes.txt'],
    ['job_01', '', 'notes.txt'],
    ['job_01', 'sub/notes.txt'],
    ['job_01', `${outside}/notes.txt`],
    ['job_01', 'a\0b'],
  ])
    await expect(openBeneath(base, segments, READ_FLAGS)).rejects.toThrow('not allowed');
  await expect(holdBeneath(base, ['..'])).rejects.toThrow('not allowed');
});

test.skipIf(!linux)(
  'a file moved out of the person’s Files is readable in the agent’s computer',
  async () => {
    await execute('files.write', { path: 'kept.txt', area: 'artifacts', content: 'theirs' });
    expect((await lstat(path.join(artifacts, 'kept.txt'))).mode & 0o777).toBe(0o600);
    const action = {
      ...connectorAction('files.move', {
        from: 'kept.txt',
        to: 'back.txt',
        area: 'artifacts',
        to_area: 'work',
      }),
      authorization_ref: 'apr_01',
    };
    expect((await connector().execute(action, connectorContext(action))).outcome).toBe('succeeded');
    expect((await lstat(path.join(work, 'back.txt'))).mode & 0o777).toBe(0o644);
    expect(await readFile(path.join(work, 'back.txt'), 'utf8')).toBe('theirs');
  },
);

test.skipIf(!linux)(
  'a move within the person’s Files never replaces a file already at the name',
  async () => {
    await writeFile(path.join(artifacts, 'a.txt'), 'first');
    await writeFile(path.join(artifacts, 'b.txt'), 'second');
    await expect(
      execute('files.move', { from: 'a.txt', to: 'b.txt', area: 'artifacts' }),
    ).rejects.toThrow('already exists');
    expect(await readFile(path.join(artifacts, 'b.txt'), 'utf8')).toBe('second');
    expect(
      (await execute('files.move', { from: 'a.txt', to: 'c.txt', area: 'artifacts' })).outcome,
    ).toBe('succeeded');
    expect((await readdir(artifacts)).sort()).toEqual(['b.txt', 'c.txt']);
  },
);
