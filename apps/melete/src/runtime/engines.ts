import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prefixedId } from '@melete/contracts';
import { z } from 'zod';

const exec = promisify(execFile);
const HOME_PREFIX = 'melete-runtime-';

/** What the host can say about a process: when it started, and how to end its tree. */
export type ProcessTable = {
  /** An opaque start stamp, or null when no such process is running. */
  startedAt(pid: number): Promise<string | null>;
  killTree(pid: number): Promise<void>;
};

const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && ['ENOENT', 'ESRCH'].includes(String(error.code));

export const systemProcesses: ProcessTable = {
  async startedAt(pid) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
      if (process.platform === 'linux') {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        // Field 22, counted after the parenthesised command name, which may hold spaces.
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        return start ? `linux:${start}` : null;
      }
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
        return /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
      }
      const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 15_000,
      });
      const start = stdout.trim();
      return start ? `ps:${start}` : null;
    } catch (error) {
      if (missing(error) || (error instanceof Error && 'code' in error && error.code === 1))
        return null;
      throw error;
    }
  },
  async killTree(pid) {
    if (process.platform === 'win32') {
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

  /** Written as soon as the engine exists, before it can outlive this process. */
  async record(attemptId: string, pid: number, home: string): Promise<void> {
    const started = await this.processes.startedAt(pid);
    if (!started) return;
    await mkdir(this.directory, { recursive: true });
    const value: EngineRecord = { attempt_id: attemptId, pid, started, home };
    await writeFile(this.path(attemptId), JSON.stringify(value), { mode: 0o600 });
  }

  async forget(attemptId: string): Promise<void> {
    await unlink(this.path(attemptId)).catch((error) => {
      if (!missing(error)) throw error;
    });
  }

  /**
   * Ends every recorded engine still running under the same process it was
   * recorded as, removes its temporary home, and clears the record. A pid now
   * held by a different process is left alone.
   */
  async sweep(): Promise<{ stopped: string[]; cleared: string[] }> {
    const stopped: string[] = [];
    const cleared: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (missing(error)) return { stopped, cleared };
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = join(this.directory, entry);
      const parsed = engineRecord.safeParse(
        JSON.parse(await readFile(file, 'utf8').catch(() => 'null')),
      );
      if (!parsed.success || !prefixedId('att').safeParse(parsed.data.attempt_id).success) {
        await unlink(file).catch(() => {});
        continue;
      }
      const engine = parsed.data;
      if ((await this.processes.startedAt(engine.pid)) === engine.started) {
        await this.processes.killTree(engine.pid);
        stopped.push(engine.attempt_id);
      }
      await this.removeHome(engine.home);
      await unlink(file).catch(() => {});
      cleared.push(engine.attempt_id);
    }
    return { stopped, cleared };
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
