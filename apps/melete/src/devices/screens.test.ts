/**
 * A paired computer's screenshots are kept by the service, beside the job
 * workspaces and in none of them, where only the service's own user can go.
 * Writing one never follows a link or a second name out of that store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEVICE_SCREENS_DIRECTORY,
  LEGACY_SCREEN_PATH,
  moveJobScreens,
  moveWorkspaceScreens,
  moveWorkspaceScreensUntilDone,
  readDeviceScreen,
  saveDeviceScreen,
} from './screens.ts';

const JOB = 'job_shot1';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const roots: string[] = [];
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'melete-shot-'));
  roots.push(root);
  const work = path.join(root, 'work');
  const outside = path.join(root, 'spaces', 'sp_other', 'artifacts');
  await mkdir(path.join(work, JOB), { recursive: true });
  await mkdir(outside, { recursive: true });
  return {
    work,
    job: path.join(work, JOB),
    store: path.join(work, DEVICE_SCREENS_DIRECTORY),
    outside,
  };
};

describe("a paired computer's screenshot", () => {
  test('is kept beside the workspaces with owner-only access, and nothing lands in the job', async () => {
    const { work, job, store } = await fixture();
    await saveDeviceScreen(work, JOB, 'act_1', PNG);
    const file = path.join(store, JOB, 'act_1.png');
    expect(new Uint8Array(await readFile(file))).toEqual(PNG);
    expect(await readdir(job)).toEqual([]);
    expect(new Uint8Array(await readDeviceScreen(work, JOB, 'act_1', 1024))).toEqual(PNG);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(store)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(store, JOB))).mode & 0o777).toBe(0o700);
    }
    // The same action again replaces its own picture, whatever its size was.
    await saveDeviceScreen(work, JOB, 'act_1', PNG.subarray(0, 4));
    expect(new Uint8Array(await readFile(file))).toEqual(PNG.subarray(0, 4));
    await expect(readDeviceScreen(work, JOB, 'act_1', 2)).rejects.toThrow();
  });

  test('is refused when the store leads elsewhere', async () => {
    const { work, store, outside } = await fixture();
    await symlink(outside, store, directoryLink);
    await expect(saveDeviceScreen(work, JOB, 'act_2', PNG)).rejects.toThrow();
    await expect(readDeviceScreen(work, JOB, 'act_2', 1024)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test("is refused when the job's folder in the store leads elsewhere", async () => {
    const { work, store, outside } = await fixture();
    await mkdir(store);
    await symlink(outside, path.join(store, JOB), directoryLink);
    await expect(saveDeviceScreen(work, JOB, 'act_3', PNG)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'is refused when its name is a link to a file elsewhere',
    async () => {
      const { work, store, outside } = await fixture();
      const victim = path.join(outside, 'notes.md');
      await writeFile(victim, 'kept');
      await mkdir(path.join(store, JOB), { recursive: true });
      await symlink(victim, path.join(store, JOB, 'act_4.png'), 'file');
      await expect(saveDeviceScreen(work, JOB, 'act_4', PNG)).rejects.toThrow();
      expect(await readFile(victim, 'utf8')).toBe('kept');
    },
  );

  test('is refused when its name is a second name for a file elsewhere', async () => {
    const { work, store, outside } = await fixture();
    const victim = path.join(outside, 'notes.md');
    await writeFile(victim, 'kept');
    await mkdir(path.join(store, JOB), { recursive: true });
    await link(victim, path.join(store, JOB, 'act_5.png'));
    await expect(saveDeviceScreen(work, JOB, 'act_5', PNG)).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toBe('kept');
  });

  test('names only a job and an action', async () => {
    const { work } = await fixture();
    await expect(saveDeviceScreen(work, '../job_shot1', 'act_6', PNG)).rejects.toThrow();
    await expect(saveDeviceScreen(work, JOB, 'act_6/../../x', PNG)).rejects.toThrow();
  });
});

describe('screenshots an earlier version left in a workspace', () => {
  test('move to the store once, and anything else in that folder stays', async () => {
    const { work, job, store } = await fixture();
    await mkdir(path.join(job, 'device'));
    await writeFile(path.join(job, 'device', 'screenshot-act_7.png'), PNG);
    await writeFile(path.join(job, 'device', 'notes.txt'), 'mine');
    expect(await moveWorkspaceScreens(work)).toBe(1);
    expect(await readdir(path.join(job, 'device'))).toEqual(['notes.txt']);
    expect(new Uint8Array(await readFile(path.join(store, JOB, 'act_7.png')))).toEqual(PNG);
    expect(await moveWorkspaceScreens(work)).toBe(0);
  });

  test('a second name for a file is copied out and only that name removed', async () => {
    const { work, job, store, outside } = await fixture();
    await mkdir(path.join(job, 'device'));
    const victim = path.join(outside, 'notes.md');
    await writeFile(victim, 'kept');
    await link(victim, path.join(job, 'device', 'screenshot-act_9.png'));
    expect(await moveJobScreens(work, JOB)).toBe(1);
    // The emptied folder goes, the other name is untouched, the copy is the store's own.
    expect(await readdir(job)).toEqual([]);
    expect(await readFile(victim, 'utf8')).toBe('kept');
    expect(await readFile(path.join(store, JOB, 'act_9.png'), 'utf8')).toBe('kept');
    if (process.platform !== 'win32') expect((await stat(victim)).nlink).toBe(1);
  });

  test('each attempt moves its own job first, and other jobs are left for the start-up move', async () => {
    const { work, job } = await fixture();
    await mkdir(path.join(job, 'device'));
    await writeFile(path.join(job, 'device', 'screenshot-act_10.png'), PNG);
    await mkdir(path.join(work, 'job_shot2', 'device'), { recursive: true });
    await writeFile(path.join(work, 'job_shot2', 'device', 'screenshot-act_11.png'), PNG);
    expect(await moveJobScreens(work, JOB)).toBe(1);
    expect(await readdir(path.join(work, 'job_shot2', 'device'))).toEqual([
      'screenshot-act_11.png',
    ]);
    expect(await moveJobScreens(work, 'job_nothing')).toBe(0);
    await expect(moveJobScreens(work, '../outside')).rejects.toThrow();
  });

  test('a failed start-up move is said and tried again until it is done', async () => {
    const { work, job } = await fixture();
    await mkdir(path.join(job, 'device'));
    await writeFile(path.join(job, 'device', 'screenshot-act_12.png'), PNG);
    // The store's place is taken by a file, so the first try fails.
    const store = path.join(work, DEVICE_SCREENS_DIRECTORY);
    await writeFile(store, 'in the way');
    const said: string[] = [];
    const done = moveWorkspaceScreensUntilDone(work, (line) => said.push(line), 20);
    await Bun.sleep(60);
    expect(said.some((line) => line.includes('trying again'))).toBe(true);
    await rm(store);
    await done;
    expect(said.at(-1)).toBe('moved 1 device screenshot(s) out of job workspaces');
  });

  test('the workspace sync recognises exactly those names', () => {
    expect(LEGACY_SCREEN_PATH.test('device/screenshot-act_01ABC.png')).toBe(true);
    for (const other of [
      'device/notes.txt',
      'device/screenshot-act_1.png.txt',
      'sub/device/screenshot-act_1.png',
      'device/screenshot-x.png',
    ])
      expect(LEGACY_SCREEN_PATH.test(other)).toBe(false);
  });

  test('a missing workspace root moves nothing', async () => {
    expect(await moveWorkspaceScreens(path.join(tmpdir(), 'melete-no-such-root'))).toBe(0);
  });
});
