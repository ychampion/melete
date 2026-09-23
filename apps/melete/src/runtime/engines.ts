import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prefixedId } from '@melete/contracts';
import { z } from 'zod';

const exec = promisify(execFile);
const HOME_PREFIX = 'melete-runtime-';
const LAUNCHER = 'process_launcher.py';
/** How far a start time read from the process table may trail the recorded spawn. */
const START_SLACK_MS = 2_000;

/** When a process started: an opaque stamp to compare, and wall time where the host gives one. */
export type ProcessStart = { stamp: string; atMs: number | null };

/** What the host can say about a process: when it started, what it is, and how to end its tree. */
export type ProcessTable = {
  /** Null when no such process is running. */
  startedAt(pid: number): Promise<ProcessStart | null>;
  /** Whether the process is a Melete engine: launched by the process launcher, or given this home. */
  isEngine(pid: number, home: string): Promise<boolean>;
  killTree(pid: number): Promise<void>;
};

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code));
const noProcess = (error: unknown) =>
  missing(error) || (error instanceof Error && 'code' in error && error.code === 1);

async function linuxStart(pid: number): Promise<ProcessStart | null> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // Field 22, counted after the parenthesised command name, which may hold spaces.
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!ticks) return null;
  // Ticks count from boot, so the boot names which boot they count from.
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const booted = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1];
  return {
    stamp: `linux:${boot}:${ticks}`,
    // USER_HZ is 100 on every Linux the service supports.
    atMs: booted ? Number(booted) * 1000 + Number(ticks) * 10 : null,
  };
}

export const systemProcesses: ProcessTable = {
  async startedAt(pid) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
      if (process.platform === 'linux') return await linuxStart(pid);
      if (process.platform === 'win32') {
        const { stdout } = await exec(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { windowsHide: true, timeout: 15_000 },
        );
        const ticks = stdout.trim();
        if (!/^\d+$/.test(ticks)) return null;
        // .NET ticks are 100 ns intervals since 0001-01-01.
        return {
          stamp: `win32:${ticks}`,
          atMs: Number((BigInt(ticks) - 621_355_968_000_000_000n) / 10_000n),
        };
      }
      const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 15_000,
      });
      const start = stdout.trim();
      if (!start) return null;
      const atMs = Date.parse(start);
      return { stamp: `ps:${start}`, atMs: Number.isNaN(atMs) ? null : atMs };
    } catch (error) {
      if (noProcess(error)) return null;
      throw error;
    }
  },
  async isEngine(pid, home) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try {
      if (process.platform === 'linux') {
        const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
        if (environ.split('\0').includes(`HERMES_HOME=${home}`)) return true;
        const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        return cmdline.split('\0').some((part) => basename(part) === LAUNCHER);
      }
      const { stdout } =
        process.platform === 'win32'
          ? await exec(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CommandLine`,
              ],
              { windowsHide: true, timeout: 15_000 },
            )
          : await exec('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 15_000 });
      return stdout.includes(LAUNCHER);
    } catch (error) {
      if (noProcess(error)) return false;
      throw error;
    }
  },
  async killTree(pid) {
    if (process.platform === 'win32') {
      // Whether it worked is read back from the process table, not from taskkill.
      await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
      }).catch(() => {});
      return;
    }
    // Engines are started in their own process group, so the group ends with them.
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  },
};

const engineRecord = z.strictObject({
  attempt_id: z.string(),
  pid: z.number().int().positive(),
  started: z.string().min(1),
  home: z.string().min(1),
});
export type EngineRecord = z.infer<typeof engineRecord>;

/** The part of a spawned child a record needs. */
export type SpawnedEngine = {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
};

/**
 * The engines this installation started, kept beside its job workspaces so a
 * service that crashed can find them again. Nothing outside this directory is
 * ever listed, so another installation's engines are never touched.
 */
export class EngineRegistry {
  readonly directory: string;
  constructor(
    workRoot: string,
    readonly processes: ProcessTable = systemProcesses,
  ) {
    this.directory = join(workRoot, '.melete-engines');
  }

  private path(attemptId: string) {
    return join(this.directory, `${prefixedId('att').parse(attemptId)}.json`);
  }

  /**
   * Written as soon as the engine exists, before it can outlive this process,
   * and only while the stamp read is still the child's own: a child that
   * already exited may have handed its pid to something else.
   */
  async record(
    attemptId: string,
    child: SpawnedEngine,
    home: string,
    spawnedAtMs: number,
  ): Promise<boolean> {
    if (!child.pid) return false;
    const started = await this.processes.startedAt(child.pid);
    if (!started || child.exitCode !== null || child.signalCode !== null) return false;
    if (started.atMs !== null && started.atMs > spawnedAtMs + START_SLACK_MS) return false;
    await mkdir(this.directory, { recursive: true });
    const value: EngineRecord = {
      attempt_id: attemptId,
      pid: child.pid,
      started: started.stamp,
      home,
    };
    // A record torn by a crash must never be the one on disk.
    const temporary = join(this.directory, `.${randomBytes(8).toString('hex')}.tmp`);
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path(attemptId));
    return true;
  }

  async forget(attemptId: string): Promise<void> {
    await unlink(this.path(attemptId)).catch((error) => {
      if (!missing(error)) throw error;
    });
  }

  /**
   * Ends every recorded engine still running as the process it was recorded
   * as, removes its temporary home, and clears the record. A pid now held by a
   * different process is left alone. A record that cannot be settled, because
   * the kill failed or the process table did not answer, is kept for the next
   * start; the sweep never fails as a whole.
   */
  async sweep(): Promise<{ stopped: string[]; cleared: string[]; kept: string[] }> {
    const result = { stopped: [] as string[], cleared: [] as string[], kept: [] as string[] };
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (missing(error)) return result;
      process.stderr.write(`engine records unreadable: ${String(error)}\n`);
      return result;
    }
    for (const entry of entries) {
      const file = join(this.directory, entry);
      if (entry.endsWith('.tmp')) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      const engine = await this.read(file);
      if (!engine) {
        await unlink(file).catch(() => {});
        continue;
      }
      try {
        const outcome = await this.settle(engine);
        if (outcome === 'kept') {
          result.kept.push(engine.attempt_id);
          continue;
        }
        await unlink(file);
        if (outcome === 'stopped') result.stopped.push(engine.attempt_id);
        result.cleared.push(engine.attempt_id);
      } catch (error) {
        result.kept.push(engine.attempt_id);
        process.stderr.write(
          `engine ${engine.attempt_id} left for the next start: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return result;
  }

  private async read(file: string): Promise<EngineRecord | null> {
    try {
      const parsed = engineRecord.safeParse(JSON.parse(await readFile(file, 'utf8')));
      return parsed.success && prefixedId('att').safeParse(parsed.data.attempt_id).success
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  }

  /**
   * `stopped` when this sweep ended the engine, `cleared` when it was already
   * gone or the pid is no longer an engine, `kept` when it still runs after the kill.
   */
  private async settle(engine: EngineRecord): Promise<'stopped' | 'cleared' | 'kept'> {
    const current = await this.processes.startedAt(engine.pid);
    let outcome: 'stopped' | 'cleared' = 'cleared';
    if (current?.stamp === engine.started) {
      // Same start stamp but not an engine: not ours to end, nor its home to remove.
      if (!(await this.processes.isEngine(engine.pid, engine.home))) return 'cleared';
      await this.processes.killTree(engine.pid);
      if ((await this.processes.startedAt(engine.pid))?.stamp === engine.started) return 'kept';
      outcome = 'stopped';
    }
    await this.removeHome(engine.home);
    return outcome;
  }

  /** Only a runtime home this service creates: directly under the temp directory, never a link. */
  private async removeHome(home: string) {
    const absolute = resolve(home);
    if (!basename(absolute).startsWith(HOME_PREFIX)) return;
    if (dirname(absolute) !== (await realpath(tmpdir()))) return;
    const stat = await lstat(absolute).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
    await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
