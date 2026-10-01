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
import { type AttemptBundle, canonicalTimeZone, prefixedId } from '@melete/contracts';
import {
  attemptEngineFeatures,
  type EngineConfig,
  engineSettingsFromEnvironment,
  HERMES_PINNED_COMMIT,
  renderEngineConfig,
  renderSoul,
} from '@melete/runtime-hermes';
import { stringify } from 'yaml';
import { modelApiMode } from '../gateway/providers.ts';
import { newId } from '../ids.ts';
import { ATTEMPT_LOG_CONFIG } from './docker.ts';
import { EngineRegistry, type ProcessTable } from './engines.ts';
import { resolvePython } from './python.ts';

const exec = promisify(execFile);
export type RuntimeInstance = {
  baseUrl: string;
  token: string;
  coldStartMs: number;
  /**
   * The workspace as the engine sees it: the job's own directory for a process
   * engine, `/work` inside a container. For the service's own use; the prompt
   * never carries a host path (see `promptWorkspace`).
   */
  workspace: string;
  stop(): Promise<void>;
};
export interface RuntimeSupervisor {
  readonly kind: 'process' | 'docker';
  launch(bundle: AttemptBundle, signal: AbortSignal): Promise<RuntimeInstance>;
  /** Called once at startup, before any launch. */
  initialize?(): Promise<void>;
  /** Prepares an engine ahead of an attempt with this model, where the supervisor can. */
  warm?(model: AttemptBundle['model']): void;
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
  /**
   * Keep one engine started ahead of the next attempt (process supervisor
   * only). It costs an idle engine's memory and saves each attempt the
   * engine's own start.
   */
  prewarm?: boolean;
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
/** What every engine is given, whatever its attempt. */
export function engineConstants(brokerUrl: string): Record<string, string> {
  return {
    HERMES_EXEC_ASK: '1',
    HERMES_ACCEPT_HOOKS: '1',
    API_SERVER_ENABLED: '1',
    MELETE_BROKER_URL: brokerUrl,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}
export function attemptEnvironment(
  bundle: AttemptBundle,
  brokerUrl: string,
  token: string,
): Record<string, string> {
  return {
    ...engineConstants(brokerUrl),
    API_SERVER_KEY: token,
    MELETE_ATTEMPT_TOKEN: bundle.attempt.token,
    MELETE_ATTEMPT_ID: bundle.attempt.id,
    MELETE_JOB_ID: bundle.attempt.job_id,
    MELETE_MODEL_KEY: `melete-surrogate-${bundle.attempt.id}`,
    MELETE_MODEL_PROVIDER: bundle.model.provider,
    MELETE_MODEL_NAME: bundle.model.model,
    MELETE_MODEL_API_MODE: modelApiMode(bundle.model.provider, bundle.model.model),
    // The engine dates the conversation in this zone, read before its config.
    // A space with no profile is UTC, never the host's zone.
    HERMES_TIMEZONE: canonicalTimeZone(bundle.time_zone),
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

/**
 * The values an engine is given that belong to its attempt. A spare engine is
 * started without them and handed them with the attempt; while it imports, it
 * watches for any of them being read (see process_launcher.py).
 */
export const ATTEMPT_ENVIRONMENT_KEYS = [
  'API_SERVER_KEY',
  'MELETE_ATTEMPT_TOKEN',
  'MELETE_ATTEMPT_ID',
  'MELETE_JOB_ID',
  'MELETE_MODEL_KEY',
  'MELETE_MODEL_PROVIDER',
  'MELETE_MODEL_NAME',
  'MELETE_MODEL_API_MODE',
  'HERMES_TIMEZONE',
  'TERMINAL_CWD',
] as const;
/** What the launcher prints once a spare engine can take an attempt, or why it cannot. */
export const SPARE_READY = 'melete-spare:ready';
export const SPARE_UNUSABLE = 'melete-spare:unusable';

/** One engine process and the temporary home it owns. */
type Engine = {
  home: string;
  addressFile: string;
  /** The name its registry record is kept under. */
  recordId: string;
  child?: ChildProcess;
  startupError?: Error;
  log: string;
  stop(): Promise<void>;
};

/**
 * An engine started before its attempt exists, for the configuration the next
 * attempt is expected to have. Only an attempt whose configuration, less its
 * capability, is exactly `key` can take it. `engine` settles once the engine
 * has loaded, with nothing when it could not be started or used. `abandon`
 * stops it wherever it has got to, and it then settles with nothing.
 */
type Spare = { key: string; engine: Promise<Engine | undefined>; abandon: () => void };

export class ProcessRuntimeSupervisor implements RuntimeSupervisor {
  readonly kind = 'process' as const;
  private readonly active = new Set<() => Promise<void>>();
  private readonly starting = new Set<Promise<unknown>>();
  private readonly deferredHomes = new Set<string>();
  private readonly shutdown = new AbortController();
  private observerBridge?: Promise<unknown>;
  private readonly engines: EngineRegistry;
  private swept?: Promise<void>;
  private spare?: Spare;
  /** Off unless configured, and off for good once a spare could not be used. */
  private prewarm: boolean;
  constructor(
    readonly options: SupervisorOptions,
    private readonly stopTree: (child: ChildProcess) => Promise<void> = stopProcessTree,
  ) {
    this.engines = new EngineRegistry(options.workRoot, options.processes);
    this.prewarm = options.prewarm === true;
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
  /**
   * Starts a spare engine for this model, when prewarming is on and none is
   * held, so the next attempt does not wait for the engine to load.
   */
  warm(model: AttemptBundle['model'], tools: AttemptBundle['tools'] = []): void {
    if (!this.prewarm || this.spare || this.shutdown.signal.aborted) return;
    const config = this.engineConfig(model, attemptEngineFeatures(tools));
    const abandoned = new AbortController();
    const engine = this.startSpare(config, abandoned.signal).catch((error: unknown) => {
      process.stderr.write(
        `spare engine not started: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    });
    // Held from now, so an attempt that starts while it loads waits for it.
    const spare: Spare = {
      key: JSON.stringify(config),
      engine,
      abandon: () => abandoned.abort(),
    };
    this.spare = spare;
    this.starting.add(engine);
    void engine.then((ready) => {
      this.starting.delete(engine);
      if (!ready && this.spare === spare) this.spare = undefined;
    });
  }
  launch(bundle: AttemptBundle, outerSignal: AbortSignal): Promise<RuntimeInstance> {
    const pending = this.launchOwned(bundle, outerSignal).finally(() =>
      this.starting.delete(pending),
    );
    this.starting.add(pending);
    return pending;
  }
  private engineConfig(
    model: AttemptBundle['model'],
    features: ReturnType<typeof attemptEngineFeatures>,
    capability?: string,
  ): EngineConfig {
    return renderEngineConfig({
      provider: encodeURIComponent(model.provider),
      model: model.model,
      brokerUrl: this.options.brokerUrl,
      modelApiMode: modelApiMode(model.provider, model.model),
      capability,
      ...engineSettingsFromEnvironment(),
      // A space with a sandbox runs the engine's terminal there, and only there.
      features,
    });
  }
  /** Everything an engine is given that follows from its home rather than its attempt. */
  private homeEnvironment(engine: Engine): Record<string, string> {
    return {
      HERMES_HOME: engine.home,
      HOME: engine.home,
      USERPROFILE: engine.home,
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: '0',
      MELETE_RUNTIME_ADDRESS_FILE: engine.addressFile,
      // The engine would otherwise copy its bundled skill library into every
      // fresh home; no attempt is offered those skills.
      HERMES_BUNDLED_SKILLS: join(engine.home, 'no-bundled-skills'),
      // The supervisor owns this process's lifetime, not the engine's own
      // service-manager logic.
      HERMES_GATEWAY_EXTERNAL_SUPERVISOR: '1',
      // Every model call goes to the broker over the loopback, so the engine's
      // check that its own CA bundle loads, which parses it on each start, has
      // nothing to protect. Verification itself is unchanged.
      HERMES_SKIP_SSL_GUARD: '1',
      // Compiled bytecode is kept beside the job workspaces and reused, rather
      // than recompiled by every engine; the source checkout is never written.
      PYTHONDONTWRITEBYTECODE: '',
      PYTHONPYCACHEPREFIX: join(this.options.workRoot, '.melete-bytecode'),
    };
  }
  private async checkEngineRoot() {
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
  }
  /** A fresh temporary home holding the plugin, the configuration and the identity. */
  private async createEngine(config: EngineConfig, recordId: string): Promise<Engine> {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'melete-runtime-'));
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
    const engine: Engine = {
      home,
      addressFile: join(home, 'runtime-address.json'),
      recordId,
      log: '',
      stop: () =>
        (stopPromise ??= (async () => {
          try {
            if (engine.child) await this.stopTree(engine.child);
          } catch (error) {
            // The home holds the attempt's capability, so it goes even when the
            // kill did not. A later stop, or close(), tries the kill again.
            stopPromise = undefined;
            await removeHome().catch(() => {});
            throw error;
          }
          // Only a stopped engine loses its record; one that would not stop is
          // still found and ended by the next start.
          await this.engines.forget(recordId);
          await removeHome();
          this.active.delete(engine.stop);
        })()),
    };
    this.active.add(engine.stop);
    try {
      await mkdir(join(home, 'plugins'), { recursive: true });
      await cp(
        join(this.options.runtimePackage, 'melete_plugin'),
        join(home, 'plugins', 'melete'),
        { recursive: true },
      );
      // No boot script runs on this path: the engine is started directly, so the
      // whole configuration — the attempt's capability included — is rendered
      // here from the same options the image is built with.
      await writeFile(join(home, 'config.yaml'), stringify(config), { mode: 0o600 });
      // Melete's identity takes the engine's identity slot; without it the
      // engine seeds its own stock persona into the fresh home.
      await writeFile(join(home, 'SOUL.md'), renderSoul(), { mode: 0o600 });
    } catch (error) {
      await engine.stop();
      throw error;
    }
    return engine;
  }
  private async spawnEngine(
    engine: Engine,
    cwd: string,
    environment: Record<string, string>,
    stdin: 'ignore' | 'pipe',
  ): Promise<ChildProcess> {
    const spawnedAt = Date.now();
    const child = spawn(
      resolvePython(this.options.python),
      [join(this.options.runtimePackage, 'process_launcher.py')],
      {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...platformEnvironment(), ...environment },
        stdio: [stdin, 'pipe', 'pipe'],
      },
    );
    engine.child = child;
    child.once('error', (error) => {
      engine.startupError = error;
    });
    const collect = (data: Buffer) => {
      engine.log = (engine.log + data.toString()).slice(-16_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    // An engine whose stdin closes early reads end of input and stops itself.
    child.stdin?.on('error', () => {});
    await this.engines.record(engine.recordId, child, engine.home, spawnedAt);
    return child;
  }
  /**
   * A spare runs the launcher's import phase with the configuration the next
   * attempt is expected to have, less its capability, and then waits.
   */
  private async startSpare(
    config: EngineConfig,
    abandoned: AbortSignal,
  ): Promise<Engine | undefined> {
    const ended = AbortSignal.any([this.shutdown.signal, abandoned]);
    await this.checkEngineRoot();
    const engine = await this.createEngine(config, newId('att'));
    if (ended.aborted) {
      await engine.stop();
      return undefined;
    }
    const child = await this.spawnEngine(
      engine,
      engine.home,
      {
        ...engineConstants(this.options.brokerUrl),
        ...this.homeEnvironment(engine),
        MELETE_RUNTIME_SPARE: '1',
        MELETE_RUNTIME_SPARE_KEYS: ATTEMPT_ENVIRONMENT_KEYS.join(','),
        // Its own until the attempt's replaces it; see process_launcher.py.
        TERMINAL_CWD: engine.home,
      },
      'pipe',
    );
    const usable = await new Promise<boolean>((resolve) => {
      const settle = (ready: boolean) => {
        ended.removeEventListener('abort', stopping);
        resolve(ready);
      };
      const stopping = () => settle(false);
      // The engine's output is collected from the moment it starts, so what it
      // said before this listened is read from there.
      const check = () => {
        if (engine.log.includes(SPARE_READY)) settle(true);
        // Ended while it was being spawned: the listener below would never hear it.
        else if (engine.log.includes(SPARE_UNUSABLE) || child.exitCode !== null || ended.aborted)
          settle(false);
      };
      child.stdout?.on('data', check);
      child.once('exit', () => settle(false));
      child.once('error', () => settle(false));
      ended.addEventListener('abort', stopping, { once: true });
      check();
    });
    if (usable && child.exitCode === null && !ended.aborted) return engine;
    if (engine.log.includes(SPARE_UNUSABLE)) {
      // The engine read something of its attempt while it loaded; every later
      // spare would too, so attempts go back to starting their own.
      this.prewarm = false;
      process.stderr.write(
        `Spare engines are off: ${engine.log.slice(engine.log.indexOf(SPARE_UNUSABLE)).split('\n')[0]}\n`,
      );
    }
    await engine.stop().catch(() => {});
    return undefined;
  }
  /**
   * The spare, when it was prepared for exactly this configuration: however far
   * along it is, it is ahead of an engine started now. Any other spare is stopped.
   */
  private async takeSpare(key: string, signal: AbortSignal): Promise<Engine | undefined> {
    const spare = this.spare;
    if (!spare) return undefined;
    this.spare = undefined;
    const setAside = () => {
      spare.abandon();
      void spare.engine.then((engine) => engine?.stop()).catch(() => {});
    };
    if (spare.key !== key) {
      setAside();
      return undefined;
    }
    // The attempt waits for the spare no longer than it would for an engine of
    // its own to start, and not at all once it is cancelled.
    const allowance = this.options.startupTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const given = new Promise<'cancelled' | 'late'>((resolve) => {
      cancel = () => resolve('cancelled');
      timer = setTimeout(() => resolve('late'), allowance);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    const engine = await Promise.race([spare.engine, given]);
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (engine === 'cancelled' || engine === 'late') {
      setAside();
      if (engine === 'late') {
        // Every later attempt would wait out the same allowance first.
        this.prewarm = false;
        process.stderr.write(
          `Spare engines are off: a spare had not loaded after ${Math.round(allowance / 1000)}s\n`,
        );
      }
      signal.throwIfAborted();
      return undefined;
    }
    if (engine?.child?.exitCode === null) return engine;
    await engine?.stop().catch(() => {});
    return undefined;
  }
  private async launchOwned(
    bundle: AttemptBundle,
    outerSignal: AbortSignal,
  ): Promise<RuntimeInstance> {
    const started = Date.now();
    const signal = AbortSignal.any([outerSignal, this.shutdown.signal]);
    signal.throwIfAborted();
    await this.checkEngineRoot();
    const workspace = await jobWorkspace(this.options.workRoot, bundle.attempt.job_id);
    const token = randomBytes(32).toString('base64url');
    const features = attemptEngineFeatures(bundle.tools);
    const config = this.engineConfig(bundle.model, features, bundle.attempt.token);
    const attempt: Record<string, string> = {
      ...attemptEnvironment(bundle, this.options.brokerUrl, token),
      TERMINAL_CWD: workspace,
    };
    let engine = this.prewarm
      ? await this.takeSpare(JSON.stringify(this.engineConfig(bundle.model, features)), signal)
      : undefined;
    try {
      if (engine) {
        // The spare has loaded against this configuration without the
        // capability; the file it starts from now carries it.
        await writeFile(join(engine.home, 'config.yaml'), stringify(config), { mode: 0o600 });
        signal.throwIfAborted();
        const handoff = Object.fromEntries(
          ATTEMPT_ENVIRONMENT_KEYS.map((key) => [key, attempt[key] ?? ''] as const),
        );
        engine.child?.stdin?.end(`${JSON.stringify({ cwd: workspace, env: handoff })}\n`);
      } else {
        engine = await this.createEngine(config, bundle.attempt.id);
        signal.throwIfAborted();
        await this.spawnEngine(
          engine,
          workspace,
          { ...attempt, ...this.homeEnvironment(engine) },
          'ignore',
        );
      }
    } catch (error) {
      await engine?.stop();
      throw error;
    }
    const owned = engine;
    const abort = () => {
      void owned.stop().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const timeout = this.options.startupTimeoutMs ?? 60_000;
      const launchStarted = Date.now();
      const exited = () => Boolean(owned.startupError) || owned.child?.exitCode !== null;
      const baseUrl = await waitRuntimeAddress(owned.addressFile, signal, timeout, exited);
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
        workspace,
        stop: async () => {
          signal.removeEventListener('abort', abort);
          try {
            await owned.stop();
          } finally {
            // The next attempt most likely has this one's configuration.
            this.warm(bundle.model, bundle.tools);
          }
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', abort);
      await owned.stop();
      // Redact the only two credentials this process received before exposing its log.
      const safe = owned.log
        .replaceAll(bundle.attempt.token, '[attempt token]')
        .replaceAll(token, '[runtime key]');
      throw new Error(`${owned.startupError?.message ?? String(error)}\n${safe}`);
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
        // The job's directory is mounted at /work, which is also the workdir.
        workspace: '/work',
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
