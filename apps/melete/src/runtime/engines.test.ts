import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineRegistry, type ProcessTable, systemProcesses } from './engines.ts';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

type Fake = {
  running: Record<number, string>;
  notEngines?: Set<number>;
  /** A kill that fails outright, or one that returns while the process lives on. */
  failKill?: Set<number>;
  ignoreKill?: Set<number>;
  failStamp?: Set<number>;
};

/** A fake process tree: pid to start stamp, and the pids a sweep ended. */
function table(fake: Fake) {
  const killed: number[] = [];
  const processes: ProcessTable = {
    startedAt: async (pid) => {
      if (fake.failStamp?.has(pid)) throw new Error('process table timed out');
      const stamp = fake.running[pid];
      return stamp ? { stamp, atMs: null } : null;
    },
    isEngine: async (pid) => !fake.notEngines?.has(pid),
    killTree: async (pid) => {
      if (fake.failKill?.has(pid)) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      killed.push(pid);
      if (!fake.ignoreKill?.has(pid)) delete fake.running[pid];
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

const live = (pid: number) => ({ pid, exitCode: null, signalCode: null });
const attempt = (n: number) => `att_01J0000000000000000000000${n}`;

describe('engines left by a crashed service', () => {
  test('a recorded engine still running as the same process is stopped and its home removed', async () => {
    const { processes, killed } = table({ running: { 4101: 'boot-1:900' } });
    const registry = new EngineRegistry(await workRoot(), processes);
    const home = await runtimeHome();
    expect(await registry.record(attempt(1), live(4101), home, Date.now())).toBe(true);
    // A new service starts over the same work root after the crash.
    const restarted = new EngineRegistry(join(registry.directory, '..'), processes);
    expect(await restarted.sweep()).toEqual({
      stopped: [attempt(1)],
      cleared: [attempt(1)],
      kept: [],
    });
    expect(killed).toEqual([4101]);
    expect(await exists(home)).toBe(false);
    expect(await readdir(registry.directory)).toEqual([]);
  });

  test('a pid now held by a different process is never killed', async () => {
    const fake: Fake = { running: { 4102: 'boot-1:900' } };
    const { processes, killed } = table(fake);
    const registry = new EngineRegistry(await workRoot(), processes);
    const home = await runtimeHome();
    await registry.record(attempt(2), live(4102), home, Date.now());
    fake.running[4102] = 'boot-1:12000'; // the engine died and the pid was reused
    expect((await registry.sweep()).stopped).toEqual([]);
    expect(killed).toEqual([]);
    expect(await exists(home)).toBe(false);
  });

  test('a process that matches the stamp but is not an engine is never killed', async () => {
    const { processes, killed } = table({
      running: { 4106: 'boot-1:900' },
      notEngines: new Set([4106]),
    });
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record(attempt(6), live(4106), await runtimeHome(), Date.now());
    expect((await registry.sweep()).stopped).toEqual([]);
    expect(killed).toEqual([]);
  });

  test("another installation's engines and anything outside a runtime home are left alone", async () => {
    const { processes, killed } = table({ running: { 4103: 'boot-1:900', 4104: 'boot-1:901' } });
    const ours = new EngineRegistry(await workRoot(), processes);
    const theirs = new EngineRegistry(await workRoot(), processes);
    const theirHome = await runtimeHome();
    await theirs.record(attempt(3), live(4103), theirHome, Date.now());
    const unrelated = await mkdtemp(join(tmpdir(), 'melete-unrelated-'));
    cleanup.push(unrelated);
    await mkdir(ours.directory, { recursive: true });
    await writeFile(
      join(ours.directory, `${attempt(4)}.json`),
      JSON.stringify({ attempt_id: attempt(4), pid: 4104, started: 'boot-1:901', home: unrelated }),
    );
    await ours.sweep();
    expect(killed).toEqual([4104]);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(theirHome)).toBe(true);
    expect(await readdir(theirs.directory)).toHaveLength(1);
  });

  test('a stopped engine forgets its record', async () => {
    const { processes } = table({ running: { 4105: 'boot-1:900' } });
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record(attempt(5), live(4105), await runtimeHome(), Date.now());
    await registry.forget(attempt(5));
    expect(await readdir(registry.directory)).toEqual([]);
    expect(await registry.sweep()).toEqual({ stopped: [], cleared: [], kept: [] });
  });

  test('a torn record is dropped without stopping the sweep', async () => {
    const { processes, killed } = table({ running: { 4107: 'boot-1:900' } });
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record(attempt(7), live(4107), await runtimeHome(), Date.now());
    await writeFile(join(registry.directory, `${attempt(8)}.json`), '');
    await writeFile(join(registry.directory, `${attempt(9)}.json`), '{"attempt_id":"att_');
    const result = await registry.sweep();
    expect(result.stopped).toEqual([attempt(7)]);
    expect(killed).toEqual([4107]);
    expect(await readdir(registry.directory)).toEqual([]);
  });

  test('a record is written whole, with nothing left beside it', async () => {
    const { processes } = table({ running: { 4110: 'boot-1:900' } });
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record(attempt(1), live(4110), await runtimeHome(), Date.now());
    expect(await readdir(registry.directory)).toEqual([`${attempt(1)}.json`]);
    const saved = JSON.parse(
      await readFile(join(registry.directory, `${attempt(1)}.json`), 'utf8'),
    );
    expect(saved).toMatchObject({ attempt_id: attempt(1), pid: 4110, started: 'boot-1:900' });
  });

  test('a record that fails to sweep is kept for the next start, and the rest are still swept', async () => {
    const fake: Fake = {
      running: { 4111: 'boot-1:900', 4112: 'boot-1:901', 4113: 'boot-1:902' },
      failKill: new Set([4111]),
    };
    const { processes, killed } = table(fake);
    const registry = new EngineRegistry(await workRoot(), processes);
    await registry.record(attempt(1), live(4111), await runtimeHome(), Date.now());
    await registry.record(attempt(2), live(4112), await runtimeHome(), Date.now());
    await registry.record(attempt(3), live(4113), await runtimeHome(), Date.now());
    fake.failStamp = new Set([4112]); // the process table stops answering for this one
    const result = await registry.sweep();
    expect(result.stopped).toEqual([attempt(3)]);
    expect(result.kept.sort()).toEqual([attempt(1), attempt(2)]);
    expect(killed).toEqual([4113]);
    expect((await readdir(registry.directory)).sort()).toEqual([
      `${attempt(1)}.json`,
      `${attempt(2)}.json`,
    ]);
  });

  test('an engine the kill did not end keeps its record and its home', async () => {
    const { processes, killed } = table({
      running: { 4114: 'boot-1:900' },
      ignoreKill: new Set([4114]),
    });
    const registry = new EngineRegistry(await workRoot(), processes);
    const home = await runtimeHome();
    await registry.record(attempt(4), live(4114), home, Date.now());
    const result = await registry.sweep();
    expect(killed).toEqual([4114]);
    expect(result).toEqual({ stopped: [], cleared: [], kept: [attempt(4)] });
    expect(await exists(home)).toBe(true);
    expect(await readdir(registry.directory)).toEqual([`${attempt(4)}.json`]);
  });

  test('an engine that already exited, or a stamp from after the spawn, is not recorded', async () => {
    const { processes } = table({ running: { 4115: 'boot-1:900' } });
    const root = await workRoot();
    const home = await runtimeHome();
    const registry = new EngineRegistry(root, processes);
    expect(
      await registry.record(
        attempt(5),
        { pid: 4115, exitCode: 1, signalCode: null },
        home,
        Date.now(),
      ),
    ).toBe(false);
    const later = new EngineRegistry(root, {
      ...processes,
      startedAt: async () => ({ stamp: 'boot-1:99999', atMs: Date.now() + 60_000 }),
    });
    expect(await later.record(attempt(6), live(4115), home, Date.now())).toBe(false);
    expect(await exists(registry.directory)).toBe(false);
  });

  test('the host process table knows this process and no process at an unused pid', async () => {
    const first = await systemProcesses.startedAt(process.pid);
    expect(first).not.toBeNull();
    expect((await systemProcesses.startedAt(process.pid))?.stamp).toBe(first?.stamp);
    if (first && first.atMs !== null) expect(first.atMs).toBeLessThanOrEqual(Date.now() + 2000);
    if (process.platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      expect(first?.stamp).toContain(boot);
    }
    expect(await systemProcesses.startedAt(2_147_483_000)).toBeNull();
    // This test runner is not an engine.
    expect(await systemProcesses.isEngine(process.pid, '/nowhere/melete-runtime-x')).toBe(false);
  }, 30_000);
});
