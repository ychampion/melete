import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  HERMES_PINNED_COMMIT,
  HermesRuntimeAdapter,
  type ParkedActions,
} from '@melete/runtime-hermes';
import { modelApiMode } from '../gateway/providers.ts';
import { DOCKER_API_VERSION, type DockerVersionSource } from './docker-engine.ts';

const OWNER = 'com.melete.attempt-supervisor';
const PROJECT = 'com.melete.project';
const ATTEMPT = 'com.melete.attempt';
const JOB = 'com.melete.job';
/** Marks an engine container started ahead of its attempt; it names no attempt or job. */
const SPARE = 'com.melete.spare';
/** A spare's own workspace directory, until an attempt's job takes it over. */
const SPARE_DIRECTORY = '.spare-';
/** Where a job's workspace is set aside while a spare's directory becomes it. */
const ADOPTING = '.adopt-';
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
/** The Compose services' log bound; an attempt must not be the one container without it. */
export const ATTEMPT_LOG_CONFIG = {
  Type: 'json-file',
  Config: { 'max-size': '10m', 'max-file': '5' },
} as const;
type Labels = Record<string, string>;
type Method = 'GET' | 'POST' | 'DELETE';

export interface DockerApi {
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    method: Method,
    path: string,
  ) {
    // Docker errors can include the submitted configuration. Never log its Env.
    super(`Docker ${method} ${path.split('?')[0]} answered ${status}`);
  }
}

/** Only this trusted service has the socket; no cell receives it or a Docker client. */
export class DockerSocketApi implements DockerApi, DockerVersionSource {
  constructor(private readonly socket: string) {}

  /** Unversioned, so an engine too old for the API below can still say which one it is. */
  async version(): Promise<unknown> {
    const response = await fetch('http://localhost/version', {
      unix: this.socket,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DockerError(response.status, 'GET', '/version');
    return response.json();
  }

  async request(method: Method, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://localhost/v${DOCKER_API_VERSION}${path}`, {
      unix: this.socket,
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DockerError(response.status, method, path);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

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
  docker?: DockerApi;
  fetch?: FetchLike;
};

type Names = { container: string; network: string; home: string };
type Resources = Names & {
  containerId?: string;
  networkId?: string;
  attached?: boolean;
  volume?: boolean;
};
type ContainerInfo = {
  Id: string;
  Config: { Labels: Labels };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  State?: { Status?: string; ExitCode?: number };
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
  directory: string;
  resources: Resources;
  url?: string;
  loaded: boolean;
  ready: Promise<boolean>;
  stop: AbortController;
};

/** A claimed attempt gets one mount root and one network with exactly the broker peer. */
export class DockerHermesRuntimeAdapter implements RuntimeAdapter {
  private readonly docker: DockerApi;
  private readonly request: FetchLike;
  private readonly shutdown = new AbortController();
  private readonly active = new Map<string, Promise<AttemptOutcome>>();
  private initialized?: Promise<void>;
  private self = '';
  private image = '';
  /** Engines loaded ahead of their attempts, oldest first. */
  private readonly spares: Spare[] = [];
  /** Removals of spares no attempt took. */
  private readonly retiring = new Set<Promise<void>>();
  /** Jobs whose workspace an engine container has mounted, and how many do. */
  private readonly mounted = new Map<string, number>();
  /** Off for good once a spare could not be used: every later one would fail the same way. */
  private spareCount: number;

  constructor(private readonly options: DockerRuntimeOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project))
      throw new Error('Invalid Docker compose project');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.workVolume))
      throw new Error('Invalid workspace volume name');
    if (!options.image || !options.probeKey)
      throw new Error('Runtime image and API key are required');
    this.docker = options.docker ?? new DockerSocketApi(options.socket);
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.spareCount = Math.max(0, Math.floor(options.spares ?? 0));
  }

  private names(attempt: string): Names {
    prefixedId('att').parse(attempt);
    const prefix = `${this.options.project}-${attempt.toLowerCase()}`;
    return { container: prefix, network: `${prefix}-net`, home: `${prefix}-home` };
  }

  private spareNames(id: string): Names {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid spare engine id');
    const prefix = `${this.options.project}-spare-${id}`;
    return { container: prefix, network: `${prefix}-net`, home: `${prefix}-home` };
  }

  private ownedSpare(labels?: Labels): boolean {
    return (
      labels?.[OWNER] === 'v1' &&
      labels[PROJECT] === this.options.project &&
      /^[a-f0-9]{24}$/.test(labels[SPARE] ?? '') &&
      labels[ATTEMPT] === undefined &&
      labels[JOB] === undefined
    );
  }

  /** The resource names an owned container, network or volume must carry, or nothing. */
  private expectedNames(labels?: Labels): Names | undefined {
    if (this.owned(labels)) return this.names(labels?.[ATTEMPT] ?? '');
    if (this.ownedSpare(labels)) return this.spareNames(labels?.[SPARE] ?? '');
    return undefined;
  }

  private labels(bundle: AttemptBundle): Labels {
    return {
      [OWNER]: 'v1',
      [PROJECT]: this.options.project,
      [ATTEMPT]: bundle.attempt.id,
      [JOB]: bundle.attempt.job_id,
    };
  }

  private owned(labels?: Labels): boolean {
    return (
      labels?.[OWNER] === 'v1' &&
      labels[PROJECT] === this.options.project &&
      prefixedId('att').safeParse(labels[ATTEMPT]).success &&
      prefixedId('job').safeParse(labels[JOB]).success
    );
  }

  /** Reconcile this project's abandoned cells before any replacement can start. */
  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  private async initializeOnce() {
    const hostname = this.options.selfId ?? process.env.HOSTNAME ?? '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(hostname))
      throw new Error('The supervisor must run inside its Melete compose container');
    const self = (await this.docker.request(
      'GET',
      `/containers/${hostname}/json`,
    )) as ContainerInfo;
    if (
      self.Config.Labels['com.docker.compose.project'] !== this.options.project ||
      self.Config.Labels['com.docker.compose.service'] !== 'melete'
    )
      throw new Error('Refusing to attach a container outside the Melete compose service');
    this.self = self.Id;
    const image = (await this.docker.request(
      'GET',
      `/images/${encodeURIComponent(this.options.image)}/json`,
    )) as {
      Id: string;
      Config: { Labels: Labels };
    };
    if (
      image.Config.Labels['com.melete.hermes.commit'] !== HERMES_PINNED_COMMIT ||
      !/^[a-f0-9]{64}$/.test(image.Config.Labels['com.melete.plugin.sha256'] ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(image.Id)
    )
      throw new Error('The runtime image must carry the pinned Hermes commit and plugin digest');
    // Resolve the mutable local tag once. Every child uses this exact image id.
    this.image = image.Id;
    const filter = encodeURIComponent(
      JSON.stringify({ label: [`${OWNER}=v1`, `${PROJECT}=${this.options.project}`] }),
    );
    const containers = (await this.docker.request(
      'GET',
      `/containers/json?all=true&filters=${filter}`,
    )) as Array<{
      Id: string;
      Names: string[];
      Labels: Labels;
    }>;
    for (const container of containers) {
      const names = this.expectedNames(container.Labels);
      if (!names) continue;
      if (!container.Names.includes(`/${names.container}`))
        throw new Error('An owned attempt container has an unexpected name');
      await this.remove('DELETE', `/containers/${container.Id}?force=true`);
    }
    const networks = (await this.docker.request('GET', `/networks?filters=${filter}`)) as Array<{
      Id: string;
      Name: string;
      Labels: Labels;
    }>;
    for (const network of networks) {
      const names = this.expectedNames(network.Labels);
      if (!names) continue;
      if (network.Name !== names.network)
        throw new Error('An owned attempt network has an unexpected name');
      const detail = (await this.docker.request('GET', `/networks/${network.Id}`)) as {
        Containers: Record<string, unknown>;
      };
      if (Object.keys(detail.Containers ?? {}).some((id) => id !== this.self))
        throw new Error('An abandoned attempt network contains an unexpected peer');
      if (detail.Containers?.[this.self])
        await this.docker.request('POST', `/networks/${network.Id}/disconnect`, {
          Container: this.self,
          Force: true,
        });
      await this.remove('DELETE', `/networks/${network.Id}`);
    }
    const volumes = (await this.docker.request('GET', `/volumes?filters=${filter}`)) as {
      Volumes: Array<{ Name: string; Labels: Labels }> | null;
    };
    for (const volume of volumes.Volumes ?? []) {
      const names = this.expectedNames(volume.Labels);
      if (!names) continue;
      if (volume.Name !== names.home)
        throw new Error('An owned runtime home has an unexpected name');
      await this.remove('DELETE', `/volumes/${volume.Name}`);
    }
    await this.reconcileWorkspaces();
  }

  /**
   * A job workspace set aside while a spare's directory became it is put back,
   * and a spare directory no attempt took is removed. Both are left only by a
   * service that stopped in between; no attempt runs until this is done.
   */
  private async reconcileWorkspaces() {
    const root = await this.workspaceRoot();
    for (const entry of await readdir(root)) {
      if (entry.startsWith(ADOPTING)) {
        const jobId = prefixedId('job').parse(entry.slice(ADOPTING.length));
        await this.restoreSetAside(join(root, entry), join(root, jobId));
      } else if (entry.startsWith(SPARE_DIRECTORY)) {
        const path = join(root, entry);
        if ((await lstat(path)).isDirectory()) await rm(path, { recursive: true, force: true });
      }
    }
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

  private async workspaceRoot(): Promise<string> {
    const root = resolve(this.options.workRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error('The workspace root must be a real directory');
    return root;
  }

  /** A directory directly under the workspace root, created for the runtime's group. */
  private async ownedDirectory(name: string) {
    const path = join(await this.workspaceRoot(), name);
    await mkdir(path, { mode: 0o2770 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('Refusing a symlink or non-directory job workspace');
    await chmod(path, 0o2770);
    return path;
  }

  private async prepareWorkspace(jobId: string) {
    await this.ownedDirectory(prefixedId('job').parse(jobId));
  }

  /**
   * Makes the spare's directory, which its container has mounted at /work, the
   * job's workspace, with what the job already had in it. Each step is a rename
   * on the one volume; a stop between them leaves `.adopt-<job>`, which the next
   * start puts back (`reconcileWorkspaces`).
   */
  private async adoptWorkspace(directory: string, jobId: string) {
    const root = await this.workspaceRoot();
    const spare = join(root, directory);
    const job = join(root, prefixedId('job').parse(jobId));
    const spareStat = await lstat(spare);
    if (!spareStat.isDirectory() || spareStat.isSymbolicLink())
      throw new Error("Refusing a spare workspace that is not the spare's own directory");
    const existing = await lstat(job).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing) {
      await rename(spare, job);
      return;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error('Refusing a symlink or non-directory job workspace');
    const aside = join(root, `${ADOPTING}${jobId}`);
    await rename(job, aside);
    try {
      await rename(spare, job);
    } finally {
      // Whichever directory is the job's now, it ends with everything it had.
      await this.restoreSetAside(aside, job);
    }
  }

  /** Moves a set-aside workspace's entries back into the job's; the job's own win. */
  private async restoreSetAside(aside: string, job: string) {
    const exists = await lstat(job).catch(() => undefined);
    if (!exists) {
      await rename(aside, job);
      return;
    }
    if (!exists.isDirectory() || exists.isSymbolicLink())
      throw new Error('Refusing a symlink or non-directory job workspace');
    for (const entry of await readdir(aside)) {
      // Anything the spare wrote under the same name while it loaded gives way.
      await rm(join(job, entry), { recursive: true, force: true });
      await rename(join(aside, entry), join(job, entry));
    }
    await rmdir(aside);
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

  /** One private network with the broker as its sole peer, and a home volume. */
  private async provisionCell(resources: Resources, labels: Labels, signal: AbortSignal) {
    const network = (await this.docker.request('POST', '/networks/create', {
      Name: resources.network,
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Labels: labels,
    })) as { Id: string };
    resources.networkId = network.Id;
    signal.throwIfAborted();
    await this.docker.request('POST', `/networks/${network.Id}/connect`, {
      Container: this.self,
      EndpointConfig: { Aliases: ['melete'] },
    });
    resources.attached = true;
    const home = (await this.docker.request('POST', '/volumes/create', {
      Name: resources.home,
      Labels: labels,
    })) as { Name: string; Labels: Labels };
    if (
      home.Name !== resources.home ||
      this.expectedNames(home.Labels)?.home !== resources.home ||
      Object.entries(labels).some(([key, value]) => home.Labels[key] !== value)
    )
      throw new Error('Refusing a runtime home that belongs to another container');
    resources.volume = true;
    signal.throwIfAborted();
  }

  /** Creates and starts the engine container on its cell; returns its API address. */
  private async startContainer(
    resources: Resources,
    labels: Labels,
    environment: string[],
    workspace: string,
    signal: AbortSignal,
  ): Promise<string> {
    const created = (await this.docker.request(
      'POST',
      `/containers/create?name=${resources.container}`,
      {
        Image: this.image,
        User: '10001:10001',
        WorkingDir: '/work',
        Labels: labels,
        Env: environment,
        HostConfig: {
          NetworkMode: resources.network,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          PidsLimit: 256,
          Memory: 2 * 1024 ** 3,
          Tmpfs: { '/tmp': 'size=64m,mode=1777' },
          RestartPolicy: { Name: 'no' },
          LogConfig: ATTEMPT_LOG_CONFIG,
          Mounts: [
            {
              Type: 'volume',
              Source: this.options.workVolume,
              Target: '/work',
              VolumeOptions: { Subpath: workspace, NoCopy: true },
            },
            { Type: 'volume', Source: resources.home, Target: '/var/lib/hermes' },
          ],
        },
        NetworkingConfig: { EndpointsConfig: { [resources.network]: {} } },
      },
    )) as { Id: string };
    resources.containerId = created.Id;
    signal.throwIfAborted();
    await this.docker.request('POST', `/containers/${created.Id}/start`);
    const container = (await this.docker.request(
      'GET',
      `/containers/${created.Id}/json`,
    )) as ContainerInfo;
    const networks = container.NetworkSettings.Networks;
    const address = networks[resources.network]?.IPAddress;
    if (Object.keys(networks).length !== 1 || !address || !/^\d+\.\d+\.\d+\.\d+$/.test(address))
      throw new Error('The runtime must have exactly its private attempt network');
    return `http://${address}:8790`;
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
    let resources: Resources | undefined;
    try {
      await this.initialize();
      signal.throwIfAborted();
      const setup = this.engineSetup(bundle.model, bundle.tools);
      const warm = sharing ? undefined : await this.claimSpare(setup, bundle, signal);
      let url: string;
      let apiKey: string;
      if (warm) {
        ({ resources, url, apiKey } = warm);
      } else {
        await this.prepareWorkspace(bundle.attempt.job_id);
        const cell: Resources = this.names(bundle.attempt.id);
        resources = cell;
        const labels = this.labels(bundle);
        apiKey = randomBytes(32).toString('hex');
        await this.provisionCell(cell, labels, signal);
        const values = this.attemptValues(bundle);
        url = await this.startContainer(
          cell,
          labels,
          [
            ...this.baseEnvironment(apiKey),
            ...CONTAINER_ATTEMPT_KEYS.map((key) => `${key}=${values[key]}`),
            ...setup.environment,
          ],
          bundle.attempt.job_id,
          signal,
        );
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
        if (resources) await this.cleanup(resources);
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
    const spare: Spare = {
      id,
      key: setup.key,
      apiKey: randomBytes(32).toString('hex'),
      directory: `${SPARE_DIRECTORY}${id}`,
      resources: this.spareNames(id),
      loaded: false,
      ready: Promise.resolve(false),
      stop: new AbortController(),
    };
    const signal = AbortSignal.any([spare.stop.signal, this.shutdown.signal]);
    spare.ready = this.loadSpare(spare, setup, signal).then(
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

  private async loadSpare(spare: Spare, setup: EngineSetup, signal: AbortSignal) {
    await this.initialize();
    signal.throwIfAborted();
    await this.ownedDirectory(spare.directory);
    const labels = { [OWNER]: 'v1', [PROJECT]: this.options.project, [SPARE]: spare.id };
    await this.provisionCell(spare.resources, labels, signal);
    spare.url = await this.startContainer(
      spare.resources,
      labels,
      [
        ...this.baseEnvironment(spare.apiKey),
        ...setup.environment,
        'MELETE_RUNTIME_SPARE=1',
        `MELETE_RUNTIME_SPARE_KEYS=${CONTAINER_ATTEMPT_KEYS.join(',')}`,
      ],
      spare.directory,
      signal,
    );
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
        const container = (await this.docker.request(
          'GET',
          `/containers/${spare.resources.containerId}/json`,
        )) as ContainerInfo;
        if (container.State?.Status === 'exited') {
          if (container.State.ExitCode === SPARE_UNUSABLE_EXIT) {
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
  ): Promise<{ resources: Resources; url: string; apiKey: string } | undefined> {
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
    const resources = spare.resources;
    try {
      await this.adoptWorkspace(spare.directory, bundle.attempt.job_id);
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
    } catch (error) {
      await this.cleanup(resources);
      await this.removeSpareDirectory(spare);
      signal.throwIfAborted();
      // The job's workspace is intact either way; the attempt starts its own engine.
      process.stderr.write(
        `spare engine not used: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
    return { resources, url: spare.url ?? '', apiKey: spare.apiKey };
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
    await this.cleanup(spare.resources);
    await this.removeSpareDirectory(spare);
  }

  /** The spare's own directory, unless it has already become a job's workspace. */
  private async removeSpareDirectory(spare: Spare) {
    const path = join(await this.workspaceRoot(), spare.directory);
    const stat = await lstat(path).catch(() => undefined);
    if (stat?.isDirectory() && !stat.isSymbolicLink())
      await rm(path, { recursive: true, force: true });
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

  private async remove(method: Method, path: string, body?: unknown) {
    try {
      await this.docker.request(method, path, body);
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }

  private async cleanup(resources: Resources) {
    // This order leaves durable home reservations in place until the process is gone.
    if (resources.containerId)
      await this.remove('DELETE', `/containers/${resources.containerId}?force=true`);
    if (resources.networkId) {
      if (resources.attached)
        await this.remove('POST', `/networks/${resources.networkId}/disconnect`, {
          Container: this.self,
          Force: true,
        });
      await this.remove('DELETE', `/networks/${resources.networkId}`);
    }
    if (resources.volume) await this.remove('DELETE', `/volumes/${resources.home}`);
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
