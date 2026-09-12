import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type AttemptBundle,
  type AttemptOutcome,
  type EventSink,
  prefixedId,
  type RuntimeAdapter,
  type RuntimeCapabilities,
} from '@melete/contracts';
import {
  type CatalogState,
  type FetchLike,
  HERMES_PINNED_COMMIT,
  HermesRuntimeAdapter,
  type ParkedActions,
} from '@melete/runtime-hermes';

const OWNER = 'com.melete.attempt-supervisor';
const PROJECT = 'com.melete.project';
const ATTEMPT = 'com.melete.attempt';
const JOB = 'com.melete.job';
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
export class DockerSocketApi implements DockerApi {
  constructor(private readonly socket: string) {}

  async request(method: Method, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://localhost/v1.48${path}`, {
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
  startTimeoutMs?: number;
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

  constructor(private readonly options: DockerRuntimeOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project))
      throw new Error('Invalid Docker compose project');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.workVolume))
      throw new Error('Invalid workspace volume name');
    if (!options.image || !options.probeKey)
      throw new Error('Runtime image and API key are required');
    this.docker = options.docker ?? new DockerSocketApi(options.socket);
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private names(attempt: string): Names {
    prefixedId('att').parse(attempt);
    const prefix = `${this.options.project}-${attempt.toLowerCase()}`;
    return { container: prefix, network: `${prefix}-net`, home: `${prefix}-home` };
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
      if (!this.owned(container.Labels)) continue;
      const names = this.names(container.Labels[ATTEMPT] ?? '');
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
      if (!this.owned(network.Labels)) continue;
      if (network.Name !== this.names(network.Labels[ATTEMPT] ?? '').network)
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
      if (!this.owned(volume.Labels)) continue;
      if (volume.Name !== this.names(volume.Labels[ATTEMPT] ?? '').home)
        throw new Error('An owned runtime home has an unexpected name');
      await this.remove('DELETE', `/volumes/${volume.Name}`);
    }
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    this.shutdown.signal.throwIfAborted();
    return this.waitForApi(this.options.probeUrl, this.options.probeKey, this.shutdown.signal);
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

  private async prepareWorkspace(jobId: string) {
    const root = resolve(this.options.workRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error('The workspace root must be a real directory');
    const path = join(root, prefixedId('job').parse(jobId));
    await mkdir(path, { mode: 0o2770 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('Refusing a symlink or non-directory job workspace');
    await chmod(path, 0o2770);
  }

  private async run(
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    await this.initialize();
    signal.throwIfAborted();
    await this.prepareWorkspace(bundle.attempt.job_id);
    const resources: Resources = this.names(bundle.attempt.id);
    const labels = this.labels(bundle);
    const apiKey = randomBytes(32).toString('hex');
    try {
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
        !this.owned(home.Labels) ||
        home.Labels[ATTEMPT] !== bundle.attempt.id
      )
        throw new Error('Refusing a runtime home that belongs to another container');
      resources.volume = true;
      signal.throwIfAborted();
      const created = (await this.docker.request(
        'POST',
        `/containers/create?name=${resources.container}`,
        {
          Image: this.image,
          User: '10001:10001',
          WorkingDir: '/work',
          Labels: labels,
          Env: [
            'HERMES_HOME=/var/lib/hermes',
            'HERMES_EXEC_ASK=1',
            'HERMES_ACCEPT_HOOKS=1',
            'API_SERVER_ENABLED=1',
            'API_SERVER_HOST=0.0.0.0',
            'API_SERVER_PORT=8790',
            `API_SERVER_KEY=${apiKey}`,
            'MELETE_BROKER_URL=http://melete:8788',
            'HTTP_PROXY=http://melete:8788',
            'HTTPS_PROXY=http://melete:8788',
            'NO_PROXY=melete,localhost,127.0.0.1',
            `MELETE_ATTEMPT_TOKEN=${bundle.attempt.token}`,
            `MELETE_ATTEMPT_ID=${bundle.attempt.id}`,
            `MELETE_JOB_ID=${bundle.attempt.job_id}`,
            `MELETE_MODEL_KEY=melete-surrogate-${bundle.attempt.id}`,
            `MELETE_MODEL_PROVIDER=${bundle.model.provider}`,
            `MELETE_MODEL_NAME=${bundle.model.model}`,
          ],
          HostConfig: {
            NetworkMode: resources.network,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            PidsLimit: 256,
            Memory: 2 * 1024 ** 3,
            Tmpfs: { '/tmp': 'size=64m,mode=1777' },
            RestartPolicy: { Name: 'no' },
            Mounts: [
              {
                Type: 'volume',
                Source: this.options.workVolume,
                Target: '/work',
                VolumeOptions: { Subpath: bundle.attempt.job_id, NoCopy: true },
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
      const url = `http://${address}:8790`;
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
      await this.cleanup(resources);
    }
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
        await pause(250, signal);
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
    // The runner races an abort against start(), so runner.stop alone cannot await child removal.
    const results = await Promise.allSettled([...this.active.values()]);
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
