import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type AttemptBundle, prefixedId } from '@melete/contracts';
import {
  engineSettingsFromEnvironment,
  HERMES_PINNED_COMMIT,
  renderEngineConfig,
} from '@melete/runtime-hermes';
import { stringify } from 'yaml';
import { modelApiMode } from '../gateway/providers.ts';
import { ATTEMPT_LOG_CONFIG } from './docker.ts';
import { EngineRegistry, type ProcessTable } from './engines.ts';
import { resolvePython } from './python.ts';

const exec = promisify(execFile);
export type RuntimeInstance = {
  baseUrl: string;
  token: string;
  coldStartMs: number;
  stop(): Promise<void>;
};
export interface RuntimeSupervisor {
  readonly kind: 'process' | 'docker';
  launch(bundle: AttemptBundle, signal: AbortSignal): Promise<RuntimeInstance>;
  /** Called once at startup, before any launch. */
  initialize?(): Promise<void>;
  close(): Promise<void>;
}
export type SupervisorOptions = {
  workRoot: string;
  brokerUrl: string;
  engineRoot: string;
  python: string;
  runtimePackage: string;
  startupTimeoutMs?: number;
  dockerImage: string;
  dockerNetwork: string;
  dockerWorkVolume: string;
  /** How engines are found and ended; the host's own process table unless a test supplies one. */
  processes?: ProcessTable;
};

/** Only platform plumbing crosses into the runtime; service secrets never do. */
export function platformEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}
export function attemptEnvironment(
  bundle: AttemptBundle,
  brokerUrl: string,
  token: string,
): Record<string, string> {
  return {
    HERMES_EXEC_ASK: '1',
    HERMES_ACCEPT_HOOKS: '1',
    API_SERVER_ENABLED: '1',
    API_SERVER_KEY: token,
    MELETE_ATTEMPT_TOKEN: bundle.attempt.token,
    MELETE_ATTEMPT_ID: bundle.attempt.id,
    MELETE_JOB_ID: bundle.attempt.job_id,
    MELETE_BROKER_URL: brokerUrl,
    MELETE_MODEL_KEY: `melete-surrogate-${bundle.attempt.id}`,
    MELETE_MODEL_PROVIDER: bundle.model.provider,
    MELETE_MODEL_NAME: bundle.model.model,
    MELETE_MODEL_API_MODE: modelApiMode(bundle.model.provider, bundle.model.model),
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

/** Validate a service-owned job directory before handing any path to a runtime. */
export async function jobWorkspace(root: string, jobId: string): Promise<string> {
  prefixedId('job').parse(jobId);
  await mkdir(root, { recursive: true });
  const base = await realpath(root);
  const path = join(base, jobId);
  let created = false;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('A job workspace cannot be a link');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await mkdir(path, { mode: 0o770 });
    created = true;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error('The job workspace must be an ordinary directory under MELETE_WORK_DIR.');
  }
  // mkdir applies the service's umask. The runtime has a different UID and
  // needs the shared group's write bit on this newly created directory.
  if (created) await chmod(path, 0o770);
  return path;
}

export async function waitRuntimeAddress(
  path: string,
  signal: AbortSignal,
  timeout: number,
  exited: () => boolean,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    signal.throwIfAborted();
    if (exited()) throw new Error('Hermes exited before reporting its listener');
    try {
      const { port } = JSON.parse(await readFile(path, 'utf8')) as { port: number };
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid runtime listener report');
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Hermes did not report its listener within ${timeout}ms`);
}
async function waitReady(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
  timeout: number,
  exited?: () => boolean,
) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    signal.throwIfAborted();
    if (exited?.()) throw new Error('Hermes exited before its API became ready');
    try {
      const response = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) return Date.now() - started;
    } catch {
      signal.throwIfAborted();
    }
    await Bun.sleep(100);
  }
  throw new Error(`Hermes did not become ready within ${timeout}ms`);
}

/** Terminate the owned tree, including children which never observe the abort signal. */
export async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    // An exited process's PID can be reused by an unrelated application.
    if (child.exitCode !== null || child.signalCode !== null) return;
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
    }).catch((error) => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    await Bun.sleep(200);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise<void>((done) => child.once('exit', () => done())),
      Bun.sleep(5000).then(() => {
        if (child.exitCode === null && child.signalCode === null)
          throw new Error('Runtime process tree did not stop');
      }),
    ]);
  }
}

export class ProcessRuntimeSupervisor implements RuntimeSupervisor {
  readonly kind = 'process' as const;
  private readonly active = new Set<() => Promise<void>>();
  private readonly starting = new Set<Promise<RuntimeInstance>>();
  private readonly deferredHomes = new Set<string>();
  private readonly shutdown = new AbortController();
  private observerBridge?: Promise<unknown>;
  private readonly engines: EngineRegistry;
  private swept?: Promise<void>;
  constructor(
    readonly options: SupervisorOptions,
    private readonly stopTree: (child: ChildProcess) => Promise<void> = stopProcessTree,
  ) {
    this.engines = new EngineRegistry(options.workRoot, options.processes);
  }
  /**
   * Engines outlive a service that crashes: they are detached, and nothing else
   * ends them. The next start ends the ones this installation recorded.
   */
  initialize(): Promise<void> {
    this.swept ??= this.engines.sweep().then(({ stopped }) => {
      if (stopped.length)
        process.stderr.write(`Stopped ${stopped.length} engine(s) left by an earlier run\n`);
    });
    return this.swept;
  }
  launch(bundle: AttemptBundle, outerSignal: AbortSignal): Promise<RuntimeInstance> {
    const pending = this.launchOwned(bundle, outerSignal).finally(() =>
      this.starting.delete(pending),
    );
    this.starting.add(pending);
    return pending;
  }
  private async launchOwned(
    bundle: AttemptBundle,
    outerSignal: AbortSignal,
  ): Promise<RuntimeInstance> {
    const started = Date.now();
    const signal = AbortSignal.any([outerSignal, this.shutdown.signal]);
    signal.throwIfAborted();
    const pin = (await readFile(join(this.options.engineRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (pin !== HERMES_PINNED_COMMIT)
      throw new Error(`Hermes checkout must be pinned at ${HERMES_PINNED_COMMIT}`);
    // Process mode needs the same hash-checked observer bridge as the image.
    // Preparing it once before any owned engine starts avoids modifying a live import.
    this.observerBridge ??= exec(
      this.options.python,
      [join(this.options.runtimePackage, 'patches', 'observer_bridge.py'), this.options.engineRoot],
      { windowsHide: true, timeout: 15000, env: platformEnvironment() },
    );
    await this.observerBridge;
    const workspace = await jobWorkspace(this.options.workRoot, bundle.attempt.job_id);
    const home = await mkdtemp(join(await realpath(tmpdir()), 'melete-runtime-'));
    const token = randomBytes(32).toString('base64url');
    const addressFile = join(home, 'runtime-address.json');
    let child: ChildProcess | undefined;
    let stopPromise: Promise<void> | undefined;
    let homeRemoved = false;
    const removeHome = async () => {
      if (homeRemoved) return;
      // Only the exact temporary home created here is eligible for cleanup.
      const absolute = resolve(home);
      if (
        dirname(absolute) !== (await realpath(tmpdir())) ||
        (await realpath(home)) !== absolute ||
        (await lstat(home)).isSymbolicLink()
      )
        throw new Error('Unverified runtime temporary home');
      try {
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['EBUSY', 'EPERM'].includes(String(error.code))
          )
        )
          throw error;
        // Windows may retain a file handle briefly after the process exits.
        // Cleanup must not replace a completed engine outcome with a crash.
        this.deferredHomes.add(home);
        process.stderr.write(`Runtime stopped; temporary home cleanup deferred: ${home}\n`);
      }
      homeRemoved = true;
    };
    const stop = () =>
      (stopPromise ??= (async () => {
        try {
          if (child) await this.stopTree(child);
        } catch (error) {
          // The home holds the attempt's capability, so it goes even when the
          // kill did not. A later stop, or close(), tries the kill again.
          stopPromise = undefined;
          await removeHome().catch(() => {});
          throw error;
        }
        // Only a stopped engine loses its record; one that would not stop is
        // still found and ended by the next start.
        await this.engines.forget(bundle.attempt.id);
        await removeHome();
        this.active.delete(stop);
      })());
    this.active.add(stop);
    try {
      await mkdir(join(home, 'plugins'), { recursive: true });
      await cp(
        join(this.options.runtimePackage, 'melete_plugin'),
        join(home, 'plugins', 'melete'),
        { recursive: true },
      );
      const environment = attemptEnvironment(bundle, this.options.brokerUrl, token);
      // No boot script runs on this path: the engine is started directly, so the
      // whole configuration — the attempt's capability included — is rendered
      // here from the same options the image is built with.
      const config = renderEngineConfig({
        provider: encodeURIComponent(bundle.model.provider),
        model: bundle.model.model,
        brokerUrl: this.options.brokerUrl,
        modelApiMode: environment.MELETE_MODEL_API_MODE,
        capability: bundle.attempt.token,
        ...engineSettingsFromEnvironment(),
      });
      await writeFile(join(home, 'config.yaml'), stringify(config), { mode: 0o600 });
      signal.throwIfAborted();
      const spawnedAt = Date.now();
      child = spawn(
        resolvePython(this.options.python),
        [join(this.options.runtimePackage, 'process_launcher.py')],
        {
          cwd: workspace,
          detached: process.platform !== 'win32',
          windowsHide: true,
          env: {
            ...platformEnvironment(),
            ...environment,
            HERMES_HOME: home,
            HOME: home,
            USERPROFILE: home,
            API_SERVER_HOST: '127.0.0.1',
            API_SERVER_PORT: '0',
            MELETE_RUNTIME_ADDRESS_FILE: addressFile,
            TERMINAL_CWD: workspace,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let startupError: Error | undefined;
      child.once('error', (error) => {
        startupError = error;
      });
      await this.engines.record(bundle.attempt.id, child, home, spawnedAt);
      let log = '';
      const collect = (data: Buffer) => {
        log = (log + data.toString()).slice(-16_000);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const abort = () => {
        void stop().catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const timeout = this.options.startupTimeoutMs ?? 60_000;
        const launchStarted = Date.now();
        const exited = () => Boolean(startupError) || child?.exitCode !== null;
        const baseUrl = await waitRuntimeAddress(addressFile, signal, timeout, exited);
        await waitReady(
          baseUrl,
          token,
          signal,
          Math.max(1, timeout - (Date.now() - launchStarted)),
          exited,
        );
        return {
          baseUrl,
          token,
          coldStartMs: Date.now() - started,
          stop: async () => {
            signal.removeEventListener('abort', abort);
            await stop();
          },
        };
      } catch (error) {
        signal.removeEventListener('abort', abort);
        // Redact the only two credentials this process received before exposing its log.
        const safe = log
          .replaceAll(bundle.attempt.token, '[attempt token]')
          .replaceAll(token, '[runtime key]');
        throw new Error(`${startupError?.message ?? String(error)}\n${safe}`);
      }
    } catch (error) {
      await stop();
      throw error;
    }
  }
  async close() {
    this.shutdown.abort(new Error('Service stopping'));
    await Promise.allSettled([...this.starting]);
    // Retained homes are cleaned even when an engine still refuses to stop.
    const stopped = await Promise.allSettled([...this.active].map((stop) => stop()));
    for (const home of this.deferredHomes) {
      if (
        dirname(resolve(home)) !== (await realpath(tmpdir())) ||
        (await realpath(home)) !== resolve(home) ||
        (await lstat(home)).isSymbolicLink()
      )
        throw new Error('Unverified deferred runtime home');
      try {
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        this.deferredHomes.delete(home);
      } catch {
        process.stderr.write(`Runtime temporary home retained for later cleanup: ${home}\n`);
      }
    }
    const failed = stopped.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** The arguments are shared with the boundary tests; no shell interprets them. */
export function dockerRunArguments(
  bundle: AttemptBundle,
  options: SupervisorOptions,
  name: string,
  environment: Record<string, string>,
): string[] {
  prefixedId('job').parse(bundle.attempt.job_id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.dockerWorkVolume))
    throw new Error('Invalid Docker work volume');
  return [
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    options.dockerNetwork,
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '256',
    '--memory',
    '2g',
    '--init',
    '--log-driver',
    ATTEMPT_LOG_CONFIG.Type,
    ...Object.entries(ATTEMPT_LOG_CONFIG.Config).flatMap(([key, value]) => [
      '--log-opt',
      `${key}=${value}`,
    ]),
    '--mount',
    `type=volume,src=${options.dockerWorkVolume},dst=/work,volume-subpath=${bundle.attempt.job_id}`,
    '--tmpfs',
    '/tmp:rw,size=64m,mode=1777',
    '--tmpfs',
    '/var/lib/hermes:rw,size=64m,uid=10001,gid=10001,mode=0700',
    '--workdir',
    '/work',
    ...Object.keys(environment)
      .sort()
      .flatMap((key) => ['--env', key]),
    options.dockerImage,
  ];
}

export class DockerRuntimeSupervisor implements RuntimeSupervisor {
  readonly kind = 'docker' as const;
  private readonly active = new Set<() => Promise<void>>();
  private readonly starting = new Set<Promise<RuntimeInstance>>();
  private readonly shutdown = new AbortController();
  constructor(
    readonly options: SupervisorOptions,
    private readonly command: (
      args: string[],
      environment: NodeJS.ProcessEnv,
    ) => Promise<string> = async (args, environment) =>
      (
        await exec('docker', args, {
          env: environment,
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim(),
  ) {}
  private async docker(args: string[], environment = platformEnvironment()): Promise<string> {
    return this.command(args, environment);
  }
  launch(bundle: AttemptBundle, outerSignal: AbortSignal): Promise<RuntimeInstance> {
    const pending = this.launchOwned(bundle, outerSignal).finally(() =>
      this.starting.delete(pending),
    );
    this.starting.add(pending);
    return pending;
  }
  private async launchOwned(
    bundle: AttemptBundle,
    outerSignal: AbortSignal,
  ): Promise<RuntimeInstance> {
    const started = Date.now();
    const signal = AbortSignal.any([outerSignal, this.shutdown.signal]);
    signal.throwIfAborted();
    const network = JSON.parse(
      await this.docker(['network', 'inspect', this.options.dockerNetwork]),
    ) as { Internal?: boolean }[];
    if (network[0]?.Internal !== true)
      throw new Error('The runtime Docker network must be internal');
    const image = JSON.parse(await this.docker(['image', 'inspect', this.options.dockerImage])) as {
      Config?: { Labels?: Record<string, string> };
    }[];
    if (image[0]?.Config?.Labels?.['com.melete.hermes.commit'] !== HERMES_PINNED_COMMIT)
      throw new Error('Runtime image does not carry the pinned Hermes commit');
    signal.throwIfAborted();
    await jobWorkspace(this.options.workRoot, bundle.attempt.job_id);
    const name = `melete-${bundle.attempt.id.toLowerCase()}`;
    const token = randomBytes(32).toString('base64url');
    const environment = {
      ...attemptEnvironment(bundle, this.options.brokerUrl, token),
      API_SERVER_HOST: '0.0.0.0',
      API_SERVER_PORT: '8790',
      HERMES_HOME: '/var/lib/hermes',
    };
    let creation: Promise<string> | undefined;
    let stopPromise: Promise<void> | undefined;
    const stop = () =>
      (stopPromise ??= (async () => {
        await creation?.catch(() => {});
        await this.docker(['rm', '--force', name]).catch((error) => {
          if (!String(error).includes('No such container')) throw error;
        });
        this.active.delete(stop);
      })());
    this.active.add(stop);
    const abort = () => {
      void stop().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      creation = this.docker(dockerRunArguments(bundle, this.options, name, environment), {
        ...platformEnvironment(),
        ...environment,
      });
      await creation;
      signal.throwIfAborted();
      const inspection = JSON.parse(await this.docker(['inspect', name])) as {
        NetworkSettings?: { Networks?: Record<string, unknown> };
      }[];
      const networks = Object.keys(inspection[0]?.NetworkSettings?.Networks ?? {});
      if (networks.length !== 1 || networks[0] !== this.options.dockerNetwork)
        throw new Error('Runtime joined an unexpected network');
      const baseUrl = `http://${name}:8790`;
      await waitReady(baseUrl, token, signal, this.options.startupTimeoutMs ?? 60_000);
      return {
        baseUrl,
        token,
        coldStartMs: Date.now() - started,
        stop: async () => {
          signal.removeEventListener('abort', abort);
          await stop();
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', abort);
      await stop();
      throw error;
    }
  }
  async close() {
    this.shutdown.abort(new Error('Service stopping'));
    await Promise.allSettled([...this.starting]);
    await Promise.all([...this.active].map((stop) => stop()));
  }
}
