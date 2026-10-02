import { randomBytes } from 'node:crypto';
import {
  type AttemptBundle,
  type AttemptOutcome,
  canonicalTimeZone,
  type EventSink,
  prefixedId,
  type RuntimeAdapter,
  type RuntimeCapabilities,
} from '@melete/contracts';
import {
  attemptEngineFeatures,
  type CatalogState,
  engineConfigEnvironment,
  engineSettingsFromEnvironment,
  type FetchLike,
  HermesRuntimeAdapter,
  type ParkedActions,
} from '@melete/runtime-hermes';
import { modelApiMode } from '../gateway/providers.ts';
import type { InstanceView } from '../ops/instance.ts';
import type { CellHandle, CellHost } from './cell-host.ts';
import { type DockerApi, DockerError, DockerSocketApi, LocalCellHost } from './cell-host-local.ts';

export {
  ATTEMPT_LOG_CONFIG,
  type DockerApi,
  DockerError,
  DockerSocketApi,
} from './cell-host-local.ts';

/**
 * The values a spare engine container is started without and handed with its
 * attempt; while it loads it reports any of them being read (process_launcher.py).
 * Everything else it is given follows from the model and the space's features,
 * and must equal what the attempt would have been given.
 */
export const CONTAINER_ATTEMPT_KEYS = [
  'MELETE_ATTEMPT_TOKEN',
  'MELETE_ATTEMPT_ID',
  'MELETE_JOB_ID',
  'MELETE_MODEL_KEY',
  'HERMES_TIMEZONE',
] as const;
/** Where a spare engine answers once it has loaded, and takes its attempt. */
export const SPARE_HANDOFF_PATH = '/melete/handoff';
/** The launcher's exit status when the engine read an attempt value while it loaded. */
const SPARE_UNUSABLE_EXIT = 3;

export type DockerRuntimeOptions = {
  project: string;
  image: string;
  socket: string;
  workRoot: string;
  workVolume: string;
  probeUrl: string;
  probeKey: string;
  parkedActions: ParkedActions;
  pendingWait?: (bundle: AttemptBundle) => Promise<import('@melete/contracts').WaitSpec | null>;
  catalogState?: CatalogState;
  /** The port the service's broker binds. Cells reach it as `melete` on their own network. */
  brokerPort?: number;
  startTimeoutMs?: number;
  /**
   * How many engine containers are kept loaded ahead of the next attempts.
   * Each holds an idle engine's memory and saves an attempt the engine's start.
   * None unless configured.
   */
  spares?: number;
  /** Docker supplies HOSTNAME as the service container's short id. */
  selfId?: string;
  /**
   * This service instance, when several share the engine and the workspace
   * volume. Its cells and their directories carry its id, and reconciliation
   * removes only its own, unlabelled ones, and those of instances `running`
   * no longer lists. Left out, every cell of the project is this service's.
   */
  instance?: InstanceView;
  docker?: DockerApi;
  /** Where cells run; by default the engine behind `socket` (or `docker`). */
  host?: CellHost;
  fetch?: FetchLike;
};

/** What a container engine is given that follows from its model and features, not its attempt. */
type EngineSetup = { key: string; environment: string[] };
/**
 * An engine container started before its attempt, with its own network, home
 * and empty workspace directory. `ready` settles once it has loaded, false when
 * it could not be started or used; its resources are then already removed.
 */
type Spare = {
  id: string;
  key: string;
  apiKey: string;
  cell: CellHandle;
  url?: string;
  loaded: boolean;
  ready: Promise<boolean>;
  stop: AbortController;
};

/** A claimed attempt gets one mount root and one network with exactly the broker peer. */
export class DockerHermesRuntimeAdapter implements RuntimeAdapter {
  private readonly host: CellHost;
  private readonly request: FetchLike;
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, Promise<AttemptOutcome>>();
  private initialized?: Promise<void>;
  /** Engines loaded ahead of their attempts, oldest first. */
  private readonly spares: Spare[] = [];
  /** Removals of spares no attempt took. */
  private readonly retiring = new Set<Promise<void>>();
  /** Jobs whose workspace an engine container has mounted, and how many do. */
  private readonly mounted = new Map<string, number>();
  /** Off for good once a spare could not be used: every later one would fail the same way. */
  private spareCount: number;

  constructor(private readonly options: DockerRuntimeOptions) {
    this.host =
      options.host ??
      new LocalCellHost({
        project: options.project,
        image: options.image,
        workRoot: options.workRoot,
        workVolume: options.workVolume,
        selfId: options.selfId,
        instance: options.instance,
        docker: options.docker ?? new DockerSocketApi(options.socket),
      });
    if (!options.image || !options.probeKey)
      throw new Error('Runtime image and API key are required');
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.spareCount = Math.max(0, Math.floor(options.spares ?? 0));
  }

  /** Reconcile this project's abandoned cells before any replacement can start. */
  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  private async initializeOnce() {
    await this.host.verify();
    await this.host.reconcile('start');
  }

  /**
   * Removes the cells of instances that stopped while this one runs. With
   * several instances on one engine, one of them does this now and then.
   */
  async removeStopped(): Promise<void> {
    await this.initialize();
    await this.host.reconcile('stopped');
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    this.shutdown.signal.throwIfAborted();
    const engine = await this.waitForApi(
      this.options.probeUrl,
      this.options.probeKey,
      this.shutdown.signal,
    );
    // Each attempt mounts only its own job's directory and an engine home volume
    // that is removed with the attempt.
    return { ...engine, workspace: 'job' };
  }

  start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal): Promise<AttemptOutcome> {
    this.shutdown.signal.throwIfAborted();
    signal.throwIfAborted();
    prefixedId('att').parse(bundle.attempt.id);
    prefixedId('job').parse(bundle.attempt.job_id);
    if (!/^[a-zA-Z0-9_-]+$/.test(bundle.model.provider))
      throw new Error('Invalid model gateway provider name');
    if (this.active.has(bundle.attempt.id)) throw new Error('The attempt already has a runtime');
    const pending = this.run(bundle, sink, AbortSignal.any([signal, this.shutdown.signal]));
    this.active.set(bundle.attempt.id, pending);
    void pending.finally(() => this.active.delete(bundle.attempt.id)).catch(() => {});
    return pending;
  }

  private brokerUrl() {
    return `http://melete:${this.options.brokerPort ?? 8788}`;
  }

  /**
   * Everything a container engine is given that follows from the model and the
   * space's features rather than its attempt, and the key a spare must match
   * for an attempt to take it: exactly what the attempt would have been given.
   */
  private engineSetup(model: AttemptBundle['model'], tools: AttemptBundle['tools']): EngineSetup {
    const broker = this.brokerUrl();
    const environment = [
      `MELETE_MODEL_PROVIDER=${model.provider}`,
      `MELETE_MODEL_NAME=${model.model}`,
      `MELETE_MODEL_API_MODE=${modelApiMode(model.provider, model.model)}`,
      // The image carries the rendered configuration; these are the parts
      // of it that follow the model this attempt was granted, worked out
      // by the same renderer and applied by the entrypoint at boot.
      ...Object.entries(
        engineConfigEnvironment({
          provider: model.provider,
          model: model.model,
          brokerUrl: broker,
          vision: model.vision,
          ...engineSettingsFromEnvironment(),
          // TERMINAL_ENV, when the space has a sandbox; the boot script
          // writes the terminal section from it and refuses any other.
          features: attemptEngineFeatures(tools),
        }),
      ).map(([key, value]) => `${key}=${value}`),
    ];
    return { key: JSON.stringify([broker, environment]), environment };
  }

  /** What every engine container is given before anything of its model or attempt. */
  private baseEnvironment(apiKey: string): string[] {
    const broker = this.brokerUrl();
    return [
      'HERMES_HOME=/var/lib/hermes',
      'HERMES_EXEC_ASK=1',
      'HERMES_ACCEPT_HOOKS=1',
      'API_SERVER_ENABLED=1',
      'API_SERVER_HOST=0.0.0.0',
      'API_SERVER_PORT=8790',
      `API_SERVER_KEY=${apiKey}`,
      `MELETE_BROKER_URL=${broker}`,
      `HTTP_PROXY=${broker}`,
      `HTTPS_PROXY=${broker}`,
      'NO_PROXY=melete,localhost,127.0.0.1',
    ];
  }

  private attemptValues(
    bundle: AttemptBundle,
  ): Record<(typeof CONTAINER_ATTEMPT_KEYS)[number], string> {
    return {
      MELETE_ATTEMPT_TOKEN: bundle.attempt.token,
      MELETE_ATTEMPT_ID: bundle.attempt.id,
      MELETE_JOB_ID: bundle.attempt.job_id,
      MELETE_MODEL_KEY: `melete-surrogate-${bundle.attempt.id}`,
      HERMES_TIMEZONE: canonicalTimeZone(bundle.time_zone),
    };
  }

  private mount(jobId: string) {
    this.mounted.set(jobId, (this.mounted.get(jobId) ?? 0) + 1);
  }

  private unmount(jobId: string) {
    const count = (this.mounted.get(jobId) ?? 1) - 1;
    if (count > 0) this.mounted.set(jobId, count);
    else this.mounted.delete(jobId);
  }

  private async run(
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    // Counted before anything waits, so a spare is never handed a workspace
    // another container of this job still has mounted.
    const sharing = this.mounted.has(bundle.attempt.job_id);
    this.mount(bundle.attempt.job_id);
    let cell: CellHandle | undefined;
    try {
      await this.initialize();
      signal.throwIfAborted();
      const setup = this.engineSetup(bundle.model, bundle.tools);
      const warm = sharing ? undefined : await this.claimSpare(setup, bundle, signal);
      let url: string;
      let apiKey: string;
      if (warm) {
        ({ cell, url, apiKey } = warm);
      } else {
        apiKey = randomBytes(32).toString('hex');
        const values = this.attemptValues(bundle);
        cell = this.host.cell({
          cell: { attempt: bundle.attempt.id, job: bundle.attempt.job_id },
          environment: [
            ...this.baseEnvironment(apiKey),
            ...CONTAINER_ATTEMPT_KEYS.map((key) => `${key}=${values[key]}`),
            ...setup.environment,
          ],
        });
        url = await cell.start(signal);
      }
      await this.waitForApi(url, apiKey, signal);
      return await new HermesRuntimeAdapter({
        baseUrl: url,
        token: apiKey,
        parkedActions: this.options.parkedActions,
        pendingWait: this.options.pendingWait,
        catalogState: this.options.catalogState,
        fetch: (input, init) =>
          this.request(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          }),
      }).start(bundle, sink, signal);
    } finally {
      try {
        if (cell) await cell.release();
      } finally {
        this.unmount(bundle.attempt.job_id);
      }
    }
  }

  /**
   * Keeps spares loaded for this model and these tools' features, up to the
   * configured number. The oldest spare set up for anything else gives way.
   */
  warm(model: AttemptBundle['model'], tools: AttemptBundle['tools'] = []): void {
    if (this.shutdown.signal.aborted || this.spareCount < 1) return;
    const setup = this.engineSetup(model, tools);
    if (this.spares.some((spare) => spare.key === setup.key)) return;
    while (this.spares.length >= this.spareCount) {
      const oldest = this.spares.shift();
      if (oldest) this.retire(oldest);
    }
    this.startSpare(setup);
  }

  private startSpare(setup: EngineSetup) {
    const id = randomBytes(12).toString('hex');
    const apiKey = randomBytes(32).toString('hex');
    const spare: Spare = {
      id,
      key: setup.key,
      apiKey,
      cell: this.host.cell({
        cell: { spare: id },
        environment: [
          ...this.baseEnvironment(apiKey),
          ...setup.environment,
          'MELETE_RUNTIME_SPARE=1',
          `MELETE_RUNTIME_SPARE_KEYS=${CONTAINER_ATTEMPT_KEYS.join(',')}`,
        ],
      }),
      loaded: false,
      ready: Promise.resolve(false),
      stop: new AbortController(),
    };
    const signal = AbortSignal.any([spare.stop.signal, this.shutdown.signal]);
    spare.ready = this.loadSpare(spare, signal).then(
      () => {
        spare.loaded = true;
        return true;
      },
      async (error: unknown) => {
        if (!signal.aborted)
          process.stderr.write(
            `spare engine not started: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        const index = this.spares.indexOf(spare);
        if (index >= 0) this.spares.splice(index, 1);
        await this.removeSpare(spare).catch(() => {});
        return false;
      },
    );
    this.spares.push(spare);
  }

  private async loadSpare(spare: Spare, signal: AbortSignal) {
    await this.initialize();
    signal.throwIfAborted();
    spare.url = await spare.cell.start(signal);
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 120_000);
    for (let tries = 1; Date.now() < deadline; tries++) {
      signal.throwIfAborted();
      try {
        const response = await this.request(`${spare.url}${SPARE_HANDOFF_PATH}`, {
          headers: { authorization: `Bearer ${spare.apiKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch {
        signal.throwIfAborted();
      }
      if (tries % 8 === 0) {
        const state = await spare.cell.state();
        if (state.status === 'exited') {
          if (state.exitCode === SPARE_UNUSABLE_EXIT) {
            // The engine read an attempt's value while it loaded; every later
            // spare would too, so attempts go back to starting their own.
            this.spareCount = 0;
            throw new Error('spare engines are off: the engine reads its attempt while it loads');
          }
          throw new Error('the spare engine exited while it loaded');
        }
      }
      await pause(250, signal);
    }
    throw new Error('the spare engine did not load before its startup deadline');
  }

  /**
   * A loaded spare for exactly this setup, now carrying this attempt, or
   * nothing, and the attempt starts its own engine. The attempt waits for a
   * spare still loading no longer than an engine of its own takes to start.
   */
  private async claimSpare(
    setup: EngineSetup,
    bundle: AttemptBundle,
    signal: AbortSignal,
  ): Promise<{ cell: CellHandle; url: string; apiKey: string } | undefined> {
    if (this.spareCount < 1) return undefined;
    const matching = this.spares.filter((spare) => spare.key === setup.key);
    const spare = matching.find((candidate) => candidate.loaded) ?? matching[0];
    if (spare) this.spares.splice(this.spares.indexOf(spare), 1);
    // The next attempt most likely has this one's setup.
    this.warm(bundle.model, bundle.tools);
    if (!spare) return undefined;
    const allowance = this.options.startTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const given = new Promise<'cancelled' | 'late'>((resolve) => {
      cancel = () => resolve('cancelled');
      timer = setTimeout(() => resolve('late'), allowance);
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    const loaded = await Promise.race([spare.ready, given]);
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (loaded !== true) {
      if (loaded === 'late') {
        this.spareCount = 0;
        process.stderr.write(
          `Spare engines are off: a spare had not loaded after ${Math.round(allowance / 1000)}s\n`,
        );
      }
      if (loaded !== false) this.retire(spare);
      signal.throwIfAborted();
      return undefined;
    }
    const cell = spare.cell;
    try {
      await cell.adopt(bundle.attempt.job_id);
      signal.throwIfAborted();
      const response = await this.request(`${spare.url}${SPARE_HANDOFF_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${spare.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cwd: '/work', env: this.attemptValues(bundle) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      await response.body?.cancel();
      if (response.status !== 204) throw new Error(`the spare engine answered ${response.status}`);
      await cell.rename(bundle.attempt.id);
    } catch (error) {
      await cell.release();
      signal.throwIfAborted();
      // The job's workspace is intact either way; the attempt starts its own engine.
      process.stderr.write(
        `spare engine not used: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
    return { cell, url: spare.url ?? '', apiKey: spare.apiKey };
  }

  /** Stops a spare no attempt took, wherever it has got to, and removes what it owned. */
  private retire(spare: Spare) {
    spare.stop.abort(new Error('Spare engine retired'));
    const removal = spare.ready
      .then((loaded) => (loaded ? this.removeSpare(spare) : undefined))
      .catch(() => {});
    this.retiring.add(removal);
    void removal.finally(() => this.retiring.delete(removal));
  }

  private async removeSpare(spare: Spare) {
    await spare.cell.release();
  }

  private async waitForApi(url: string, key: string, signal: AbortSignal) {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 120_000);
    const adapter = new HermesRuntimeAdapter({
      baseUrl: url,
      token: key,
      parkedActions: this.options.parkedActions,
      fetch: (input, init) =>
        this.request(input, {
          ...init,
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        }),
    });
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        return await adapter.capabilities();
      } catch (error) {
        if (error instanceof Error && error.message.includes('no durable run idempotency'))
          throw error;
        signal.throwIfAborted();
        await pause(100, signal);
      }
    }
    throw new Error('The Hermes API did not become ready before its startup deadline');
  }

  beginShutdown(): void {
    this.shutdown.abort(new Error('Runtime supervisor stopping'));
  }

  async close(): Promise<void> {
    this.beginShutdown();
    for (const spare of this.spares.splice(0)) this.retire(spare);
    // The runner races an abort against start(), so runner.stop alone cannot await child removal.
    const results = await Promise.allSettled([...this.active.values(), ...this.retiring]);
    // Any leftovers are reconciled at the next boot. Emit no capability-bearing exception text.
    if (
      results.some((result) => result.status === 'rejected' && result.reason instanceof DockerError)
    )
      throw new Error('An owned runtime resource could not be removed during shutdown');
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
