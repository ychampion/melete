import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineRegistry, type ProcessTable, systemProcesses } from './engines.ts';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

/** A fake process tree: pid to start stamp, and the pids a sweep ended. */
function table(running: Record<number, string>) {
  const killed: number[] = [];
  const processes: ProcessTable = {
    startedAt: async (pid) => running[pid] ?? null,
    killTree: async (pid) => {
      killed.push(pid);
      delete running[pid];
    },
  };
  return { processes, killed };
}

async function workRoot() {
  const root = await mkdtemp(join(tmpdir(), 'melete-engines-work-'));
  cleanup.push(root);
  return root;
}

async function runtimeHome() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'melete-runtime-'));
  cleanup.push(home);
  await writeFile(join(home, 'config.yaml'), 'capability: attempt-secret\n');
  return home;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('engines left by a crashed service', () => {
  test('a recorded engine still running as the same process is stopped and its home removed', async () => {
    const { processes, killed } = table({ 4101: 'boot-1:900' });
    const registry = new EngineRegistry(await workRoot(), processes);
    const home = await runtimeHome();
    await registry.record('att_01J00000000000000000000001', 4101, home);
    // A new service starts over the same work root after the crash.
    const restarted = new EngineRegistry(join(registry.directory, '..'), processes);
    expect(await restarted.sweep()).toEqual({
      stopped: ['att_01J00000000000000000000001'],
      cleared: ['att_01J00000000000000000000001'],
    });
    expect(killed).toEqual([4101]);
    expect(await exists(home)).toBe(false);
    expect(await readdir(registry.directory)).toEqual([]);
  });

  test('a pid now held by a different process is never killed', async () => {
    const running: Record<number, string> = { 4102: 'boot-1:900' };
    const { processes, killed } = table(running);
    const registry = new EngineRegistry(await workRoot(), processes);
    const home = await runtimeHome();
    await registry.record('att_01J00000000000000000000002', 4102, home);
    running[4102] = 'boot-1:12000'; // the engine died and the pid was reused
    expect((await registry.sweep()).stopped).toEqual([]);
    expect(killed).toEqual([]);
    expect(await exists(home)).toBe(false);
  });

  test("another installation's engines and anything outside a runtime home are left alone", async () => {
    const { processes, killed } = table({ 4103: 'boot-1:900', 4104: 'boot-1:901' });
    const ours = new EngineRegistry(await workRoot(), processes);
    const theirs = new EngineRegistry(await workRoot(), processes);
    const theirHome = await runtimeHome();
    await theirs.record('att_01J00000000000000000000003', 4103, theirHome);
    const unrelated = await mkdtemp(join(tmpdir(), 'melete-unrelated-'));
    cleanup.push(unrelated);
    await mkdir(ours.directory, { recursive: true });
    await writeFile(
      join(ours.directory, 'att_01J00000000000000000000004.json'),
      JSON.stringify({
        attempt_id: 'att_01J00000000000000000000004',
        pid: 4104,
        started: 'boot-1:901',
        home: unrelated,
      }),
    );
    await ours.sweep();
    expect(killed).toEqual([4104]);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(theirHome)).toBe(true);
    expect(await readdir(theirs.directory)).toHaveLength(1);
  });

  test('a stopped engine forgets its record', async () => {
    const { processes } = table({ 4105: 'boot-1:900' });
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record('att_01J00000000000000000000005', 4105, await runtimeHome());
    await registry.forget('att_01J00000000000000000000005');
    expect(await readdir(registry.directory)).toEqual([]);
    expect(await registry.sweep()).toEqual({ stopped: [], cleared: [] });
  });

  test('the host process table knows this process and no process at an unused pid', async () => {
    const first = await systemProcesses.startedAt(process.pid);
    expect(first).not.toBeNull();
    expect(await systemProcesses.startedAt(process.pid)).toBe(first);
    expect(await systemProcesses.startedAt(2_147_483_000)).toBeNull();
  }, 30_000);
});
