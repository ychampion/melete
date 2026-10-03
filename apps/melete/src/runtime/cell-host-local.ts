/**
 * Attempt cells on the Docker engine the service itself runs on, reached over
 * its socket. Each cell's private network has the service container as its
 * only peer (alias `melete`), and its /work is the job's directory on the
 * workspace volume the service shares.
 */
import { prefixedId } from '@melete/contracts';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import { type InstanceView, stoppedInstances } from '../ops/instance.ts';
import type { CellHandle, CellHost, CellSpec, CellState } from './cell-host.ts';
import { DOCKER_API_VERSION, type DockerVersionSource } from './docker-engine.ts';
import { ADOPTING, LocalWorkspaceFs, type Removable, SPARE_DIRECTORY } from './workspace-fs.ts';

const OWNER = 'com.melete.attempt-supervisor';
const PROJECT = 'com.melete.project';
const ATTEMPT = 'com.melete.attempt';
const JOB = 'com.melete.job';
/** The service instance that started a cell, when several share one engine. */
const INSTANCE = 'com.melete.instance';
/**
 * Marks an engine container started ahead of its attempt; its labels name no
 * attempt or job. Once an attempt takes it, its container name is that attempt's.
 */
const SPARE = 'com.melete.spare';
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

export type LocalCellHostOptions = {
  project: string;
  image: string;
  workRoot: string;
  workVolume: string;
  /** Docker supplies HOSTNAME as the service container's short id. */
  selfId?: string;
  /**
   * This service instance, when several share the engine and the workspace
   * volume. Its cells and their directories carry its id, and reconciliation
   * removes only its own, unlabelled ones, and those of instances `running`
   * no longer lists. Left out, every cell of the project is this service's.
   */
  instance?: InstanceView;
  docker: DockerApi;
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

/** A claimed attempt gets one mount root and one network with exactly the broker peer. */
export class LocalCellHost implements CellHost {
  readonly id = 'local';
  private readonly docker: DockerApi;
  private readonly workspace: LocalWorkspaceFs;
  private self = '';
  private image = '';

  constructor(private readonly options: LocalCellHostOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project))
      throw new Error('Invalid Docker compose project');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.workVolume))
      throw new Error('Invalid workspace volume name');
    if (!options.image) throw new Error('Runtime image and API key are required');
    this.docker = options.docker;
    this.workspace = new LocalWorkspaceFs(options.workRoot);
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

  /**
   * Whether a container name is the one a cold engine for some attempt would
   * carry, which a spare is renamed to when an attempt takes it (`rename`).
   */
  private attemptContainerName(name: string): boolean {
    const prefix = `/${this.options.project}-att_`;
    if (!name.startsWith(prefix)) return false;
    const attempt = `att_${name.slice(prefix.length).toUpperCase()}`;
    return (
      prefixedId('att').safeParse(attempt).success && `/${this.names(attempt).container}` === name
    );
  }

  /** The resource names an owned container, network or volume must carry, or nothing. */
  private expectedNames(labels?: Labels): Names | undefined {
    if (this.owned(labels)) return this.names(labels?.[ATTEMPT] ?? '');
    if (this.ownedSpare(labels)) return this.spareNames(labels?.[SPARE] ?? '');
    return undefined;
  }

  private instanceLabel(): Labels {
    return this.options.instance ? { [INSTANCE]: this.options.instance.id } : {};
  }

  /** A spare's or a set-aside workspace's directory carries the instance, as `<instance>.<name>`. */
  private scoped(prefix: string, name: string): string {
    return this.options.instance
      ? `${prefix}${this.options.instance.id}.${name}`
      : `${prefix}${name}`;
  }

  /**
   * Which instances' leftovers may be removed: at a start, this instance's own
   * and those of instances no longer running; later, only the latter. Cells
   * from before instances were labelled count as this instance's at a start.
   */
  private async removable(starting: boolean): Promise<Removable> {
    const instance = this.options.instance;
    if (!instance) return async () => starting;
    const stopped = await stoppedInstances(instance, (name) => this.containerRunning(name));
    return async (owner) =>
      owner === undefined || owner === instance.id ? starting : stopped(owner);
  }

  /** Whether a container by this name runs on this engine: another instance's service, say. */
  private async containerRunning(name: string): Promise<boolean> {
    try {
      const found = (await this.docker.request('GET', `/containers/${name}/json`)) as {
        State?: { Running?: boolean };
      };
      return found.State?.Running !== false;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return false;
      throw error;
    }
  }

  private owned(labels?: Labels): boolean {
    return (
      labels?.[OWNER] === 'v1' &&
      labels[PROJECT] === this.options.project &&
      prefixedId('att').safeParse(labels[ATTEMPT]).success &&
      prefixedId('job').safeParse(labels[JOB]).success
    );
  }

  async verify(): Promise<{ engine: string; imageId: string }> {
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
    return { engine: this.self, imageId: this.image };
  }

  async reconcile(scope: 'start' | 'stopped'): Promise<void> {
    const removable = await this.removable(scope === 'start');
    await this.removeLeftovers(removable);
    await this.workspace.reconcileCellDirectories(removable, this.options.instance?.id ?? 'local');
  }

  private async removeLeftovers(removable: Removable) {
    const ours = (labels: Labels) => removable(labels[INSTANCE]);
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
      if (!names || !(await ours(container.Labels))) continue;
      // A spare an attempt took carries that attempt's name; its network and home keep the spare's.
      const named =
        container.Names.includes(`/${names.container}`) ||
        (this.ownedSpare(container.Labels) &&
          container.Names.some((name) => this.attemptContainerName(name)));
      if (!named) throw new Error('An owned attempt container has an unexpected name');
      await this.remove('DELETE', `/containers/${container.Id}?force=true`);
    }
    const networks = (await this.docker.request('GET', `/networks?filters=${filter}`)) as Array<{
      Id: string;
      Name: string;
      Labels: Labels;
    }>;
    for (const network of networks) {
      const names = this.expectedNames(network.Labels);
      if (!names || !(await ours(network.Labels))) continue;
      if (network.Name !== names.network)
        throw new Error('An owned attempt network has an unexpected name');
      const detail = (await this.docker.request('GET', `/networks/${network.Id}`)) as {
        Containers: Record<string, unknown>;
      };
      if (Object.keys(detail.Containers ?? {}).some((id) => id !== this.self)) {
        // Another instance's network may still hold its own service container.
        if (
          network.Labels[INSTANCE] !== undefined &&
          network.Labels[INSTANCE] !== this.options.instance?.id
        )
          continue;
        throw new Error('An abandoned attempt network contains an unexpected peer');
      }
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
      if (!names || !(await ours(volume.Labels))) continue;
      if (volume.Name !== names.home)
        throw new Error('An owned runtime home has an unexpected name');
      await this.remove('DELETE', `/volumes/${volume.Name}`);
    }
  }

  cell(spec: CellSpec): CellHandle {
    const cell = spec.cell;
    const spare = 'spare' in cell;
    const resources: Resources = spare ? this.spareNames(cell.spare) : this.names(cell.attempt);
    const labels: Labels = {
      [OWNER]: 'v1',
      [PROJECT]: this.options.project,
      ...(spare ? { [SPARE]: cell.spare } : { [ATTEMPT]: cell.attempt, [JOB]: cell.job }),
      ...this.instanceLabel(),
    };
    // The directory mounted at /work: the job's own, or the spare's until a job takes it.
    const directory = spare ? this.scoped(SPARE_DIRECTORY, cell.spare) : cell.job;
    /** Once a spare carries its attempt's name, its directory is that job's workspace. */
    let claimed = false;
    return {
      brokerPeer: 'local-network',
      start: async (signal) => {
        if (spare) await this.workspace.cellDirectory(directory);
        else await this.workspace.cellWorkspace(directory);
        await this.provisionCell(resources, labels, signal);
        return this.startContainer(resources, labels, spec.environment, directory, signal);
      },
      state: async (): Promise<CellState> => {
        const container = (await this.docker.request(
          'GET',
          `/containers/${resources.containerId}/json`,
        )) as ContainerInfo;
        return { status: container.State?.Status, exitCode: container.State?.ExitCode };
      },
      adopt: async (jobId) => {
        if (!spare) throw new Error('Only a spare takes over a job workspace');
        await this.workspace.adopt(directory, jobId, this.scoped(ADOPTING, jobId));
      },
      rename: async (attempt) => {
        // Labels cannot change after creation, so the container takes the name a
        // cold engine for this attempt would have: an operator (or a check) finds
        // the container serving an attempt by its name either way.
        const name = this.names(attempt).container;
        await this.docker.request(
          'POST',
          `/containers/${resources.containerId}/rename?name=${encodeURIComponent(name)}`,
        );
        resources.container = name;
        claimed = true;
      },
      release: async () => {
        await this.cleanup(resources);
        if (spare && !claimed) await this.workspace.removeCellDirectory(directory);
      },
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
}
