/**
 * Sandboxes on this service's own Docker engine: one container per agent,
 * with a desktop the agent can drive and a person can watch.
 *
 * The service already holds the engine socket to supervise attempts, so this
 * adapter needs no account and no key. Each sandbox is a container from a local
 * image, running as an unprivileged user on a read-only root filesystem with
 * every capability dropped, no privilege escalation, the engine's default
 * seccomp profile, an init process and bounded CPU, memory, processes and
 * temporary storage. It mounts nothing from the host: its only persistent
 * storage is two named volumes of its own, `/work` and the agent's home.
 *
 * Egress is one of two things. `deny_all` is no network at all. `open` is an
 * internal network of the container's own whose only other member is this
 * service, and the egress guard there, which tunnels HTTPS to public addresses
 * and nothing else (see docker-egress.ts).
 *
 * A workspace is the container itself. Suspending it records it idle; a
 * container nobody has used for the idle period is stopped, and anything that
 * uses it again starts it: files persist on the volumes, processes do not.
 *
 * Commands follow the service's marker protocol like every other adapter: the
 * adapter runs the wrapped argv under `timeout -s KILL`, and anything it cannot
 * vouch for is reported as such, never guessed.
 */

import { DockerError, DockerSocketApi } from '../../runtime/docker.ts';
import { DOCKER_API_VERSION } from '../../runtime/docker-engine.ts';
import { LABEL_CONNECTION, LABEL_PROJECT, LABEL_SESSION, ownedLabels } from '../manifest.ts';
import { reattachByMarker } from '../marker.ts';
import {
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  SandboxAdapterRefusal,
  type SandboxCapabilities,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
  type StartFact,
} from '../types.ts';
import { SandboxEgressGuard } from './docker-egress.ts';
import { type TarEntry, tarArchive } from './docker-tar.ts';

const MiB = 1024 * 1024;
export const DOCKER_SANDBOX_UID = 10004;
export const DOCKER_SANDBOX_HOME = '/home/agent';
export const DOCKER_SANDBOX_WORK = '/work';
/** The desktop matches the live view's viewport, so a frame and an input need no scaling. */
export const DOCKER_DESKTOP = { width: 1024, height: 768 } as const;
const OWNER = 'com.melete.sandbox';
const LIFETIME = 'com.melete.sandbox.lifetime';
const EGRESS = 'com.melete.sandbox.egress';
const BASE = 'com.melete.sandbox.name';
export const EGRESS_ALIAS = 'melete-egress';
const NAME = /^melete-sbx-[a-z0-9][a-z0-9_.-]{0,160}$/;
const NOT_FOUND_EXIT = 3;
const NOT_REGULAR_EXIT = 4;
const LISTING_LIMIT = 16 * MiB;
const KILL_GRACE_MS = 15_000;
const QUOTA_CHECK_MS = 20_000;
/**
 * Enter the working directory and, past the disk allowance, lower the largest
 * file the command may write; or report, as the marker wrapper's own setup
 * failure does, that nothing ran. Then run the command under a hard kill.
 */
const LAUNCHER =
  'cd "$1" 2>/dev/null || exit 112; if [ "$2" != keep ]; then ulimit -f "$2" 2>/dev/null || exit 112; fi; shift 2; exec "$@"';
/**
 * Past the allowance a command may still remove files, but may not grow any
 * file beyond this, in the 512-byte blocks of `/bin/sh`'s `ulimit -f`.
 */
export const OVER_ALLOWANCE_FILE_BLOCKS = (2 * 1024 * 1024) / 512;
const LIST = '[ -d "$1" ] || exit 3; cd "$1" && exec find . -mindepth 1 -printf "%y %s %m %P\\0"';
const READ =
  '[ -e "$1" ] || [ -L "$1" ] || exit 3; [ -f "$1" ] || exit 4; exec head -c "$2" -- "$1"';
const USAGE = 'exec du -sk -x /work /home/agent 2>/dev/null';

export type DockerSandboxSettings = {
  socket: string;
  /**
   * This installation's label. The idle clock stops only its own containers,
   * never another installation's on the same engine.
   */
  project: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** The two volumes together, and the largest any one file may grow. */
  diskMb: number;
  idleSeconds: number;
  /** Where the egress guard listens, inside the service's container. */
  egressPort: number;
  /** The service's own container, which joins each open sandbox's network as its guard. */
  selfId?: string;
};

export const DOCKER_SANDBOX_DEFAULTS: Omit<DockerSandboxSettings, 'socket' | 'project'> = {
  cpus: 1,
  memoryMb: 2048,
  pids: 512,
  diskMb: 4096,
  idleSeconds: 900,
  egressPort: 8791,
};

export function dockerCapabilities(): SandboxCapabilities {
  return {
    adapter: 'docker',
    isolation: 'container',
    // `open` is public HTTPS through the service's egress guard; there is no
    // allow-list of ranges, so one is refused rather than widened.
    egress: ['deny_all', 'open'],
    persistence: ['none', 'pause'],
    maxLifetimeSeconds: 86_400,
    maxIdleSeconds: null,
    streaming: false,
    reattach: 'marker_only',
    ports: 'none',
    image: 'registry',
    billing: 'per_second',
    regions: [],
    maxUploadBytes: 8 * MiB,
  };
}

type Method = 'GET' | 'POST' | 'DELETE';

/** What the provider needs from the engine beyond plain JSON requests. */
export interface DockerSandboxApi {
  request(method: Method, path: string, body?: unknown): Promise<unknown>;
  /** Start an exec and hand back its multiplexed output as it arrives. */
  startExec(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  putArchive(container: string, path: string, tar: Uint8Array, signal: AbortSignal): Promise<void>;
}

export class DockerSandboxSocket extends DockerSocketApi implements DockerSandboxApi {
  constructor(private readonly path: string) {
    super(path);
  }

  async startExec(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(`http://localhost/v${DOCKER_API_VERSION}/exec/${id}/start`, {
      unix: this.path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Detach: false, Tty: false }),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new DockerError(response.status, 'POST', `/exec/${id}/start`);
    }
    return response.body;
  }

  async putArchive(
    container: string,
    path: string,
    tar: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `http://localhost/v${DOCKER_API_VERSION}/containers/${container}/archive?path=${encodeURIComponent(path)}&copyUIDGID=1`,
      {
        unix: this.path,
        method: 'PUT',
        headers: { 'content-type': 'application/x-tar' },
        body: tar,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      },
    );
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new DockerError(response.status, 'POST', '/containers/archive');
  }
}

const notFound = (error: unknown) => error instanceof DockerError && error.status === 404;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Demultiplexed output of one exec, each stream kept up to its own cap. */
export class ExecCapture {
  stdout: Uint8Array[] = [];
  stderr: Uint8Array[] = [];
  stdoutBytes = 0;
  stderrBytes = 0;
  stdoutTotal = 0;
  private pending = new Uint8Array(0);

  constructor(
    private readonly maxStdout: number,
    private readonly maxStderr: number,
    private readonly onStdout?: (bytes: Uint8Array) => void,
  ) {}

  push(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    joined.set(this.pending);
    joined.set(chunk, this.pending.byteLength);
    let offset = 0;
    while (joined.byteLength - offset >= 8) {
      const kind = joined[offset];
      const size = new DataView(joined.buffer, joined.byteOffset + offset + 4, 4).getUint32(0);
      if (
        kind === undefined ||
        kind > 2 ||
        joined[offset + 1] ||
        joined[offset + 2] ||
        joined[offset + 3]
      )
        throw new Error('the Docker exec stream is not multiplexed as expected');
      if (joined.byteLength - offset - 8 < size) break;
      const payload = joined.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size;
      if (kind === 1) {
        this.stdoutTotal += payload.byteLength;
        if (this.onStdout) this.onStdout(payload.slice());
        else this.keep('stdout', payload);
      } else if (kind === 2) this.keep('stderr', payload);
    }
    this.pending = joined.slice(offset);
  }

  private keep(which: 'stdout' | 'stderr', payload: Uint8Array) {
    const max = which === 'stdout' ? this.maxStdout : this.maxStderr;
    const held = which === 'stdout' ? this.stdoutBytes : this.stderrBytes;
    const room = Math.max(0, max - held);
    if (!room) return;
    const kept = payload.slice(0, room);
    this[which].push(kept);
    if (which === 'stdout') this.stdoutBytes += kept.byteLength;
    else this.stderrBytes += kept.byteLength;
  }

  bytes(which: 'stdout' | 'stderr'): Uint8Array {
    const parts = this[which];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

type ContainerState = {
  Name?: string;
  Image?: string;
  State?: { Running?: boolean; Paused?: boolean; Status?: string; StartedAt?: string };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
};

type Listed = { Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string };

export type DesktopCommand =
  | { kind: 'screenshot' }
  | { kind: 'info' }
  | { kind: 'open'; url: string }
  | { kind: 'click'; x: number; y: number; button: 1 | 2 | 3; count: 1 | 2 | 3 }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: readonly string[] }
  | { kind: 'scroll'; x: number; y: number; dy: number }
  | { kind: 'input'; events: readonly unknown[] };

/** The sandbox adapter, plus the desktop the computer tools and the live view use. */
export interface DockerSandboxProvider extends SandboxProvider {
  readonly desktop: true;
  /** Run one desktop command; a screenshot answers PNG bytes, everything else JSON. */
  computer(
    handle: SandboxHandle,
    command: DesktopCommand,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  /** JPEG frames of the whole desktop until the signal ends them. */
  frames(handle: SandboxHandle, fps: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
  /** Whether the container is running now, without starting it. */
  running(handle: SandboxHandle, signal: AbortSignal): Promise<boolean>;
  /** Count as use, so the idle stop waits: a person watching is using it. */
  touch(handle: SandboxHandle): void;
}

export const isDesktopProvider = (provider: SandboxProvider): provider is DockerSandboxProvider =>
  (provider as Partial<DockerSandboxProvider>).desktop === true;

function argvFor(command: DesktopCommand): string[] {
  const coordinate = (value: number, max: number) => {
    if (!Number.isInteger(value) || value < 0 || value >= max)
      throw new SandboxAdapterRefusal(`a screen position must be a whole number below ${max}`);
    return String(value);
  };
  switch (command.kind) {
    case 'screenshot':
      return ['screenshot'];
    case 'info':
      return ['info'];
    case 'open': {
      let url: URL;
      try {
        url = new URL(command.url);
      } catch {
        throw new SandboxAdapterRefusal('an address to open must be a full http or https URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new SandboxAdapterRefusal('an address to open must be a full http or https URL');
      return ['open', url.href];
    }
    case 'click':
      return [
        'click',
        coordinate(command.x, DOCKER_DESKTOP.width),
        coordinate(command.y, DOCKER_DESKTOP.height),
        String(command.button),
        String(command.count),
      ];
    case 'type':
      if (!command.text.length || command.text.length > 4096 || command.text.includes('\0'))
        throw new SandboxAdapterRefusal('text to type is 1 to 4096 characters');
      return ['type', command.text];
    case 'key':
      if (
        !command.keys.length ||
        command.keys.length > 16 ||
        command.keys.some((key) => !/^[A-Za-z0-9_+]{1,48}$/.test(key))
      )
        throw new SandboxAdapterRefusal('keys are 1 to 16 names such as Return or ctrl+l');
      return ['key', ...command.keys];
    case 'scroll':
      if (!Number.isInteger(command.dy) || command.dy === 0 || Math.abs(command.dy) > 50)
        throw new SandboxAdapterRefusal('a scroll is 1 to 50 steps up or down');
      return [
        'scroll',
        coordinate(command.x, DOCKER_DESKTOP.width),
        coordinate(command.y, DOCKER_DESKTOP.height),
        String(command.dy),
      ];
    case 'input':
      return ['input', JSON.stringify(command.events)];
  }
}

/**
 * The engine-side half of the docker adapter, one per socket: the client, the
 * egress guard, and the idle clock every connection's sandboxes share.
 */
export class DockerSandboxHost implements DockerSandboxProvider {
  readonly capabilities = dockerCapabilities();
  readonly desktop = true as const;
  readonly guard: SandboxEgressGuard;
  private readonly activity = new Map<string, number>();
  private readonly lifetimes = new Map<string, number>();
  private readonly started = new Map<string, number>();
  private readonly usage = new Map<string, { at: number; kb: number }>();
  private reaper?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(
    readonly settings: DockerSandboxSettings,
    private readonly api: DockerSandboxApi = new DockerSandboxSocket(settings.socket),
    options: { guard?: SandboxEgressGuard; now?: () => number } = {},
  ) {
    this.guard = options.guard ?? new SandboxEgressGuard();
    this.now = options.now ?? Date.now;
  }

  // ---- naming -------------------------------------------------------------

  static nameFor(project: string, session: string): string {
    const name = `melete-sbx-${project}-${session}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    if (!NAME.test(name)) throw new SandboxAdapterRefusal('this sandbox cannot be given a name');
    return name;
  }

  private static checkName(handle: SandboxHandle | string): string {
    const name = typeof handle === 'string' ? handle : handle.providerSandboxId;
    // Only a name this adapter gave is ever sent to the engine as a sandbox.
    if (!NAME.test(name)) throw new SandboxAdapterRefusal('not a docker sandbox of this service');
    return name;
  }

  touch(handle: SandboxHandle): void {
    this.activity.set(DockerSandboxHost.checkName(handle), this.now());
  }

  // ---- engine helpers -----------------------------------------------------

  private async inspectContainer(name: string): Promise<ContainerState | null> {
    try {
      return (await this.api.request('GET', `/containers/${name}/json`)) as ContainerState;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  private networkOf(state: ContainerState): string | null {
    const names = Object.keys(state.NetworkSettings?.Networks ?? {});
    return names.find((network) => NAME.test(network) && network.endsWith('-net')) ?? null;
  }

  /** The service joins the sandbox's network, and the sandbox's address is granted. */
  private async grantEgress(name: string, state: ContainerState): Promise<void> {
    const network = this.networkOf(state);
    if (!network) return;
    const self = this.settings.selfId;
    if (!self)
      throw new SandboxAdapterRefusal('open egress needs the service to run in a container');
    await this.guard.listen(this.settings.egressPort);
    const inspected = (await this.api.request('GET', `/networks/${network}`)) as {
      Containers?: Record<string, unknown>;
    };
    if (!Object.keys(inspected.Containers ?? {}).some((id) => id.startsWith(self)))
      await this.api.request('POST', `/networks/${network}/connect`, {
        Container: self,
        EndpointConfig: { Aliases: [EGRESS_ALIAS] },
      });
    const address = state.NetworkSettings?.Networks?.[network]?.IPAddress;
    if (address) this.guard.allow(address, name);
  }

  /** Start a stopped container again: the automatic resume after an idle stop. */
  private async ensureRunning(name: string): Promise<ContainerState> {
    let state = await this.inspectContainer(name);
    if (!state) throw new SandboxGone(`the engine has no sandbox ${name}`);
    if (!state.State?.Running) {
      await this.api.request('POST', `/containers/${name}/start`).catch((error) => {
        // 304: it was started in between.
        if (!(error instanceof DockerError && error.status === 304)) throw error;
      });
      for (let tries = 0; tries < 50; tries += 1) {
        state = await this.inspectContainer(name);
        if (!state) throw new SandboxGone(`the engine has no sandbox ${name}`);
        if (state.State?.Running) break;
        await delay(100);
      }
      if (!state?.State?.Running) throw new Error(`the sandbox ${name} did not start`);
      this.started.set(name, this.now());
    } else if (state.State?.Paused) {
      await this.api.request('POST', `/containers/${name}/unpause`);
    }
    if (!this.started.has(name)) this.started.set(name, this.now());
    await this.grantEgress(name, state);
    this.activity.set(name, this.now());
    return state;
  }

  /**
   * One exec, demultiplexed. `phase` says how far it got when it failed:
   * `create` means nothing was started; `start` means the request left and
   * the process may or may not be running; `running` means it was.
   */
  private async execute(
    name: string,
    argv: readonly string[],
    options: {
      signal: AbortSignal;
      maxStdout: number;
      maxStderr: number;
      onStdout?: (bytes: Uint8Array) => void;
      deadlineMs?: number;
    },
  ): Promise<{ exitCode: number | null; capture: ExecCapture; durationMs: number }> {
    let id: string;
    try {
      const created = (await this.api.request('POST', `/containers/${name}/exec`, {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: argv,
        WorkingDir: '/',
      })) as { Id?: string };
      if (!created?.Id || !/^[a-f0-9]{64}$/.test(created.Id))
        throw new Error('the engine did not name the exec');
      id = created.Id;
    } catch (error) {
      throw Object.assign(new Error(describe(error)), { phase: 'create' as const, cause: error });
    }
    const capture = new ExecCapture(options.maxStdout, options.maxStderr, options.onStdout);
    const started = performance.now();
    const signals = [options.signal];
    if (options.deadlineMs) signals.push(AbortSignal.timeout(options.deadlineMs));
    const signal = AbortSignal.any(signals);
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.api.startExec(id, signal);
    } catch (error) {
      throw Object.assign(new Error(describe(error)), { phase: 'start' as const, cause: error });
    }
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) capture.push(value);
      }
    } catch (error) {
      throw Object.assign(new Error(describe(error)), { phase: 'running' as const, cause: error });
    }
    const durationMs = Math.round(performance.now() - started);
    for (let tries = 0; tries < 20; tries += 1) {
      const state = (await this.api.request('GET', `/exec/${id}/json`)) as {
        Running?: boolean;
        ExitCode?: number | null;
      };
      if (!state.Running)
        return {
          exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
          capture,
          durationMs,
        };
      await delay(50);
    }
    throw Object.assign(new Error('the exec did not report an exit'), {
      phase: 'running' as const,
    });
  }

  /** A command of the adapter's own, never the model's: listing, reading, measuring. */
  private async helper(
    name: string,
    script: string,
    args: readonly string[],
    signal: AbortSignal,
    maxStdout = LISTING_LIMIT,
  ) {
    await this.ensureRunning(name);
    try {
      return await this.execute(name, ['/bin/sh', '-c', script, 'melete', ...args], {
        signal,
        maxStdout: maxStdout + 1,
        maxStderr: 4096,
        deadlineMs: 120_000,
      });
    } catch (error) {
      throw new SandboxTransportError(`the sandbox did not answer: ${describe(error)}`);
    }
  }

  // ---- SandboxProvider ----------------------------------------------------

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
    signal.throwIfAborted();
    const session = spec.labels[LABEL_SESSION];
    const project = spec.labels[LABEL_PROJECT];
    if (!session || !project) throw new SandboxAdapterRefusal('a sandbox needs its session label');
    if (spec.egress.kind !== 'deny_all' && spec.egress.kind !== 'open')
      throw new SandboxAdapterRefusal(`the docker adapter cannot enforce ${spec.egress.kind}`);
    const open = spec.egress.kind === 'open';
    if (open && !this.settings.selfId)
      throw new SandboxAdapterRefusal(
        'open egress needs the service to run in a container on the same engine, so it can be the only way out',
      );
    let image: { Id?: string };
    try {
      image = (await this.api.request('GET', `/images/${encodeURIComponent(spec.image)}/json`)) as {
        Id?: string;
      };
    } catch (error) {
      if (notFound(error))
        throw new SandboxAdapterRefusal(
          `the image ${spec.image} is not on this Docker engine; build it first (docs/sandbox-docker.md)`,
        );
      throw error;
    }
    const name = DockerSandboxHost.nameFor(project, session);
    const cpus = spec.cpu ?? this.settings.cpus;
    const memory = (spec.memoryMb ?? this.settings.memoryMb) * MiB;
    const disk = (spec.diskMb ?? this.settings.diskMb) * MiB;
    const labels: Record<string, string> = {
      ...spec.labels,
      [OWNER]: 'v1',
      [BASE]: name,
      [LIFETIME]: String(spec.lifetimeSeconds),
      [EGRESS]: spec.egress.kind,
    };
    const volumes = [`${name}-work`, `${name}-home`];
    const network = `${name}-net`;
    const proxy = `http://${EGRESS_ALIAS}:${this.settings.egressPort}`;
    const env = [
      ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      `HOME=${DOCKER_SANDBOX_HOME}`,
      'USER=agent',
      'DISPLAY=:0',
      ...(open
        ? [
            `HTTPS_PROXY=${proxy}`,
            `https_proxy=${proxy}`,
            `HTTP_PROXY=${proxy}`,
            `http_proxy=${proxy}`,
            'NO_PROXY=localhost,127.0.0.1',
            'no_proxy=localhost,127.0.0.1',
          ]
        : []),
    ];
    const made: Array<() => Promise<unknown>> = [];
    try {
      for (const volume of volumes) {
        await this.api.request('POST', '/volumes/create', { Name: volume, Labels: labels });
        made.push(() => this.removeVolume(volume));
      }
      if (open) {
        await this.api.request('POST', '/networks/create', {
          Name: network,
          Driver: 'bridge',
          Internal: true,
          Labels: labels,
          Options: {
            'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
            'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
          },
        });
        made.push(() => this.removeNetwork(network));
      }
      await this.api.request('POST', `/containers/create?name=${name}`, {
        Image: spec.image,
        User: `${DOCKER_SANDBOX_UID}:${DOCKER_SANDBOX_UID}`,
        Hostname: 'sandbox',
        WorkingDir: DOCKER_SANDBOX_WORK,
        Env: env,
        Labels: labels,
        NetworkDisabled: !open,
        HostConfig: {
          NetworkMode: open ? network : 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Privileged: false,
          Init: true,
          IpcMode: 'private',
          PidsLimit: this.settings.pids,
          Memory: memory,
          MemorySwap: memory,
          NanoCpus: Math.round(cpus * 1e9),
          ShmSize: 256 * MiB,
          Tmpfs: {
            '/tmp': 'rw,nosuid,nodev,size=512m,mode=1777',
            '/var/tmp': 'rw,nosuid,nodev,size=256m,mode=1777',
          },
          // No one file may outgrow the whole allowance, and a crash asks for no
          // core file: a host that pipes cores to its crash handler reads this.
          Ulimits: [
            { Name: 'fsize', Soft: disk, Hard: disk },
            { Name: 'core', Soft: 0, Hard: 0 },
          ],
          RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
          Mounts: [
            { Type: 'volume', Source: volumes[0], Target: DOCKER_SANDBOX_WORK },
            { Type: 'volume', Source: volumes[1], Target: DOCKER_SANDBOX_HOME },
          ],
        },
        ...(open ? { NetworkingConfig: { EndpointsConfig: { [network]: {} } } } : {}),
      });
      made.push(() => this.api.request('DELETE', `/containers/${name}?force=1`));
      this.lifetimes.set(name, spec.lifetimeSeconds);
      await this.ensureRunning(name);
    } catch (error) {
      this.guard.revoke(name);
      for (const undo of made.reverse()) await undo().catch(() => {});
      if (error instanceof SandboxAdapterRefusal) throw error;
      throw new Error(`the sandbox could not be created: ${describe(error)}`);
    }
    return { providerSandboxId: name, imageDigest: image.Id ?? null, region: null };
  }

  async connect(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.ensureRunning(DockerSandboxHost.checkName(handle));
  }

  async running(handle: SandboxHandle, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const state = await this.inspectContainer(DockerSandboxHost.checkName(handle));
    return Boolean(state?.State?.Running);
  }

  async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
    const name = DockerSandboxHost.checkName(handle);
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
      throw new SandboxAdapterRefusal('a command timeout must be a positive number of ms');
    if (!spec.cwd.startsWith('/'))
      throw new SandboxAdapterRefusal('a working directory must be absolute');
    if (spec.stdin?.byteLength)
      throw new SandboxAdapterRefusal('the docker adapter takes a command without stdin');
    // Everything before the exec is created is provably not the command.
    let fileLimit: string;
    try {
      await this.ensureRunning(name);
      fileLimit = (await this.overAllowance(name, signal))
        ? String(OVER_ALLOWANCE_FILE_BLOCKS)
        : 'keep';
    } catch (error) {
      if (error instanceof SandboxAdapterRefusal) throw error;
      throw new SandboxStartRefused(`the command was not sent: ${describe(error)}`);
    }
    const argv = [
      '/bin/sh',
      '-c',
      LAUNCHER,
      'melete-launch',
      spec.cwd,
      fileLimit,
      'timeout',
      '-s',
      'KILL',
      String(spec.timeoutMs / 1000),
      ...spec.argv,
    ];
    let result: Awaited<ReturnType<DockerSandboxHost['execute']>>;
    try {
      result = await this.execute(name, argv, {
        signal,
        maxStdout: spec.maxOutputBytes,
        maxStderr: spec.maxOutputBytes,
        deadlineMs: spec.timeoutMs + KILL_GRACE_MS,
      });
    } catch (error) {
      const phase = (error as { phase?: string }).phase;
      if (phase === 'create') {
        // Refused before any process existed: a container that went away, or an engine that said no.
        throw new SandboxStartRefused(`the engine refused the command: ${describe(error)}`);
      }
      const started: StartFact = phase === 'running' ? 'yes' : 'unknown';
      throw new SandboxTransportError(`no answer about the command: ${describe(error)}`, started);
    } finally {
      this.activity.set(name, this.now());
    }
    const { exitCode, capture, durationMs } = result;
    const output = new Uint8Array([...capture.bytes('stdout'), ...capture.bytes('stderr')]).slice(
      0,
      spec.maxOutputBytes,
    );
    const totalBytes = capture.stdoutTotal + capture.stderrBytes;
    // `timeout -s KILL` dies with the group it kills, which the engine reports as 137.
    const timedOut = exitCode === 137 && durationMs >= spec.timeoutMs - 50;
    return {
      started: 'yes',
      state: timedOut ? 'killed' : exitCode === null ? 'lost' : 'exited',
      exitCode: timedOut ? null : exitCode,
      signal: timedOut ? 'SIGKILL' : null,
      timedOut,
      durationMs,
      output,
      totalBytes,
      captureLimited: totalBytes > output.byteLength,
    };
  }

  /**
   * Whether the volumes together hold more than the allowance, measured before
   * a command rather than enforced by the kernel: Docker's local volume driver
   * has no size limit on ordinary filesystems. Past it a command still runs, so
   * files can be removed, but no file may grow beyond a small bound until the
   * total is back under the allowance.
   */
  private async overAllowance(name: string, signal: AbortSignal): Promise<boolean> {
    const cached = this.usage.get(name);
    let kb = cached && this.now() - cached.at < QUOTA_CHECK_MS ? cached.kb : null;
    if (kb === null) {
      const measured = await this.execute(name, ['/bin/sh', '-c', USAGE], {
        signal,
        maxStdout: 4096,
        maxStderr: 1024,
        deadlineMs: 60_000,
      });
      kb = new TextDecoder()
        .decode(measured.capture.bytes('stdout'))
        .split('\n')
        .map((line) => Number(line.split(/\s+/)[0]))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
      this.usage.set(name, { at: this.now(), kb });
    }
    return kb > this.settings.diskMb * 1024;
  }

  reattach(handle: SandboxHandle, marker: string, signal: AbortSignal) {
    return reattachByMarker(this, handle, marker, signal);
  }

  async putFiles(
    handle: SandboxHandle,
    files: AsyncIterable<{ path: string; bytes: Uint8Array; mode: number }>,
    signal: AbortSignal,
  ): Promise<void> {
    const name = DockerSandboxHost.checkName(handle);
    const roots = [DOCKER_SANDBOX_WORK, DOCKER_SANDBOX_HOME];
    const byRoot = new Map<string, TarEntry[]>();
    const directories = new Map<string, Set<string>>();
    for await (const file of files) {
      if (file.bytes.byteLength > this.capabilities.maxUploadBytes)
        throw new SandboxAdapterRefusal('a file above the upload limit');
      const root = roots.find((each) => file.path.startsWith(`${each}/`));
      const relative = root ? file.path.slice(root.length + 1) : '';
      if (
        !root ||
        !relative ||
        relative.split('/').some((part) => !part || part === '..' || part === '.')
      )
        throw new SandboxAdapterRefusal(
          `an upload goes under /work or the home directory: ${file.path}`,
        );
      const entries = byRoot.get(root) ?? [];
      const seen = directories.get(root) ?? new Set<string>();
      const parts = relative.split('/');
      // Parents first, owned by the sandbox user, so it can write beside what arrived.
      for (let depth = 1; depth < parts.length; depth += 1) {
        const directory = parts.slice(0, depth).join('/');
        if (seen.has(directory)) continue;
        seen.add(directory);
        entries.push({
          name: directory,
          directory: true,
          mode: 0o755,
          uid: DOCKER_SANDBOX_UID,
          gid: DOCKER_SANDBOX_UID,
        });
      }
      entries.push({
        name: relative,
        directory: false,
        mode: (file.mode & 0o111) !== 0 ? 0o755 : 0o644,
        uid: DOCKER_SANDBOX_UID,
        gid: DOCKER_SANDBOX_UID,
        bytes: file.bytes,
      });
      byRoot.set(root, entries);
      directories.set(root, seen);
    }
    if (!byRoot.size) return;
    await this.ensureRunning(name);
    for (const [root, entries] of byRoot) {
      try {
        await this.api.putArchive(name, root, tarArchive(entries), signal);
      } catch (error) {
        throw new SandboxTransportError(
          `files could not be written to the sandbox: ${describe(error)}`,
        );
      }
    }
    this.usage.delete(name);
    this.activity.set(name, this.now());
  }

  async listFiles(handle: SandboxHandle, root: string, signal: AbortSignal): Promise<FileEntry[]> {
    const name = DockerSandboxHost.checkName(handle);
    const base = root.replace(/\/+$/, '') || '/';
    if (!base.startsWith('/')) throw new SandboxAdapterRefusal('a listing root must be absolute');
    const listed = await this.helper(name, LIST, [base], signal);
    if (listed.exitCode === NOT_FOUND_EXIT)
      throw new SandboxFileNotFound(`no such directory: ${root}`);
    if (listed.exitCode !== 0)
      throw new SandboxTransportError(`listing ${root} failed with exit ${listed.exitCode}`);
    const bytes = listed.capture.bytes('stdout');
    if (bytes.byteLength > LISTING_LIMIT)
      throw new SandboxAdapterRefusal('the listing is larger than the adapter reads');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new SandboxAdapterRefusal('the listing holds a name that is not UTF-8');
    }
    return text
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const match = /^([a-z]) (\d+) ([0-7]+) (.+)$/s.exec(record);
        if (!match) throw new SandboxAdapterRefusal('the listing could not be read');
        const [, type, size, mode, relative] = match as unknown as [
          string,
          string,
          string,
          string,
          string,
        ];
        if (type !== 'f' && type !== 'd' && type !== 'l')
          throw new SandboxAdapterRefusal(
            `the listing holds an entry of type ${type}: ${relative}`,
          );
        return {
          path: relative,
          size: type === 'f' ? Number(size) : 0,
          mode: Number.parseInt(mode, 8) & 0o777,
          symlink: type === 'l',
          directory: type === 'd',
        };
      });
  }

  async getFile(
    handle: SandboxHandle,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const name = DockerSandboxHost.checkName(handle);
    if (!path.startsWith('/')) throw new SandboxAdapterRefusal('a file path must be absolute');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new SandboxAdapterRefusal('a read needs a byte limit');
    const read = await this.helper(name, READ, [path, String(maxBytes)], signal, maxBytes);
    if (read.exitCode === NOT_FOUND_EXIT || read.exitCode === NOT_REGULAR_EXIT)
      throw new SandboxFileNotFound(`no such file: ${path}`);
    if (read.exitCode !== 0)
      throw new SandboxTransportError(`reading ${path} failed with exit ${read.exitCode}`);
    return read.capture.bytes('stdout').slice(0, maxBytes);
  }

  async pause(handle: SandboxHandle, signal: AbortSignal): Promise<{ resumeRef: string }> {
    signal.throwIfAborted();
    const name = DockerSandboxHost.checkName(handle);
    const state = await this.inspectContainer(name);
    if (!state) throw new SandboxGone(`the engine has no sandbox ${name}`);
    // Kept as it is; the idle clock stops it, so a person can still watch or
    // take over right after the attempt that used it has ended.
    this.activity.set(name, this.now());
    return { resumeRef: name };
  }

  async resume(resumeRef: string, spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
    signal.throwIfAborted();
    const name = DockerSandboxHost.checkName(resumeRef);
    const recorded = (await this.inspectContainer(name))?.Config?.Labels?.[EGRESS];
    if (recorded && recorded !== spec.egress.kind)
      throw new SandboxAdapterRefusal('this workspace was created under another egress policy');
    const state = await this.ensureRunning(name);
    this.lifetimes.set(name, spec.lifetimeSeconds);
    return { providerSandboxId: name, imageDigest: state.Image ?? null, region: null };
  }

  async destroy(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = DockerSandboxHost.checkName(handle);
    this.guard.revoke(name);
    await this.api.request('DELETE', `/containers/${name}?force=1`).catch((error) => {
      if (!notFound(error)) throw error;
    });
    await this.removeNetwork(`${name}-net`);
    for (const volume of [`${name}-work`, `${name}-home`]) await this.removeVolume(volume);
    this.activity.delete(name);
    this.started.delete(name);
    this.lifetimes.delete(name);
    this.usage.delete(name);
  }

  private async removeNetwork(network: string): Promise<void> {
    const self = this.settings.selfId;
    if (self)
      await this.api
        .request('POST', `/networks/${network}/disconnect`, { Container: self, Force: true })
        .catch(() => {});
    await this.api.request('DELETE', `/networks/${network}`).catch((error) => {
      if (!notFound(error)) throw error;
    });
  }

  private async removeVolume(volume: string): Promise<void> {
    for (let tries = 0; ; tries += 1) {
      try {
        await this.api.request('DELETE', `/volumes/${volume}`);
        return;
      } catch (error) {
        if (notFound(error)) return;
        // A volume stays in use for a moment after its container is removed.
        if (error instanceof DockerError && error.status === 409 && tries < 10) {
          await delay(300);
          continue;
        }
        throw error;
      }
    }
  }

  async inspect(
    handle: SandboxHandle,
    signal: AbortSignal,
  ): Promise<'running' | 'paused' | 'gone'> {
    signal.throwIfAborted();
    const name = handle.providerSandboxId;
    if (!NAME.test(name)) {
      // A name this adapter never gives cannot be one of its sandboxes; the
      // engine is still asked, so an unreachable one is not taken for an answer.
      await this.api.request('GET', '/version');
      return 'gone';
    }
    const state = await this.inspectContainer(name);
    if (!state) return 'gone';
    return state.State?.Running && !state.State.Paused ? 'running' : 'paused';
  }

  private filters(
    project: string,
    connection: string | null,
    extra: Record<string, string[]> = {},
  ) {
    const label = [`${OWNER}=v1`, `melete.owner=v1`, `${LABEL_PROJECT}=${project}`];
    if (connection) label.push(`${LABEL_CONNECTION}=${connection}`);
    return encodeURIComponent(JSON.stringify({ label, ...extra }));
  }

  async reconcile(
    project: string,
    live: ReadonlySet<string>,
    signal: AbortSignal,
    connection: string | null,
  ): Promise<string[]> {
    signal.throwIfAborted();
    const destroyed: string[] = [];
    const containers = (await this.api.request(
      'GET',
      `/containers/json?all=1&filters=${this.filters(project, connection)}`,
    )) as Listed[];
    const present = new Set<string>();
    for (const container of containers) {
      const name = (container.Names?.[0] ?? '').replace(/^\//, '');
      if (!NAME.test(name) || !ownedLabels(container.Labels, project, connection)) continue;
      present.add(name);
      const session = container.Labels?.[LABEL_SESSION] ?? '';
      if (live.has(name) || live.has(container.Id) || (session && live.has(session))) continue;
      await this.destroy({ providerSandboxId: name, imageDigest: null, region: null }, signal);
      destroyed.push(name);
    }
    // A volume or network whose container never came to be, or went without them.
    const volumes =
      (
        (await this.api.request(
          'GET',
          `/volumes?filters=${this.filters(project, connection)}`,
        )) as {
          Volumes?: { Name: string; Labels?: Record<string, string> }[];
        }
      ).Volumes ?? [];
    const networks = (await this.api.request(
      'GET',
      `/networks?filters=${this.filters(project, connection)}`,
    )) as { Name: string; Labels?: Record<string, string> }[];
    const orphans = new Set<string>();
    for (const item of [...volumes, ...(networks ?? [])]) {
      const base = item.Labels?.[BASE] ?? '';
      const session = item.Labels?.[LABEL_SESSION] ?? '';
      if (!NAME.test(base) || present.has(base) || !ownedLabels(item.Labels, project, connection))
        continue;
      if (live.has(base) || (session && live.has(session))) continue;
      orphans.add(base);
    }
    for (const base of orphans) {
      await this.removeNetwork(`${base}-net`);
      for (const volume of [`${base}-work`, `${base}-home`]) await this.removeVolume(volume);
      destroyed.push(base);
    }
    return destroyed;
  }

  // ---- desktop ------------------------------------------------------------

  async computer(
    handle: SandboxHandle,
    command: DesktopCommand,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const name = DockerSandboxHost.checkName(handle);
    const argv = ['melete-desktop', ...argvFor(command)];
    await this.ensureRunning(name);
    const max = command.kind === 'screenshot' ? 8 * MiB : 64 * 1024;
    let result: Awaited<ReturnType<DockerSandboxHost['execute']>>;
    try {
      result = await this.execute(name, argv, {
        signal,
        maxStdout: max,
        maxStderr: 4096,
        deadlineMs: 60_000,
      });
    } finally {
      this.activity.set(name, this.now());
    }
    if (result.exitCode !== 0) {
      const said = new TextDecoder().decode(result.capture.bytes('stderr')).trim().slice(-300);
      throw new SandboxAdapterRefusal(
        `the desktop could not ${command.kind}${said ? `: ${said}` : ` (exit ${result.exitCode})`}`,
      );
    }
    return result.capture.bytes('stdout');
  }

  async *frames(
    handle: SandboxHandle,
    fps: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const name = DockerSandboxHost.checkName(handle);
    await this.ensureRunning(name);
    const queue: Uint8Array[] = [];
    const waiting: { wake: (() => void) | null } = { wake: null };
    let pending = new Uint8Array(0);
    let finished = false;
    let failure: unknown = null;
    const onStdout = (bytes: Uint8Array) => {
      const joined = new Uint8Array(pending.byteLength + bytes.byteLength);
      joined.set(pending);
      joined.set(bytes, pending.byteLength);
      let at = 0;
      while (joined.byteLength - at >= 4) {
        const size = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
        if (size > 4 * MiB) throw new Error('a desktop frame is larger than a frame may be');
        if (joined.byteLength - at - 4 < size) break;
        // At most two frames wait; a slow viewer is shown the newest.
        if (queue.length >= 2) queue.shift();
        queue.push(joined.slice(at + 4, at + 4 + size));
        at += 4 + size;
      }
      pending = joined.slice(at);
      this.activity.set(name, this.now());
      waiting.wake?.();
    };
    const running = this.execute(
      name,
      ['melete-desktop', 'stream', '--fps', String(Math.max(1, Math.min(10, Math.round(fps))))],
      { signal, maxStdout: 0, maxStderr: 2048, onStdout },
    )
      .catch((error) => {
        if (!signal.aborted) failure = error;
      })
      .finally(() => {
        finished = true;
        waiting.wake?.();
      });
    try {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          waiting.wake = resolve;
        });
        waiting.wake = null;
      }
    } finally {
      await Promise.race([running, delay(1000)]);
    }
    if (failure) throw failure;
  }

  // ---- idle stop and lifetime ----------------------------------------------

  /** Stop what nobody has used for the idle period, or what ran past its lifetime. */
  async reap(signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<string[]> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [`${OWNER}=v1`, `${LABEL_PROJECT}=${this.settings.project}`],
        status: ['running'],
      }),
    );
    const running = (await this.api.request(
      'GET',
      `/containers/json?filters=${filters}`,
    )) as Listed[];
    const stopped: string[] = [];
    const now = this.now();
    for (const container of running) {
      signal.throwIfAborted();
      const name = (container.Names?.[0] ?? '').replace(/^\//, '');
      if (!NAME.test(name)) continue;
      // A container this process has not seen used starts its idle clock now.
      const last = this.activity.get(name) ?? now;
      if (!this.activity.has(name)) this.activity.set(name, now);
      const since = this.started.get(name) ?? now;
      if (!this.started.has(name)) this.started.set(name, now);
      const lifetime =
        this.lifetimes.get(name) ??
        Number(container.Labels?.[LIFETIME] ?? Number.POSITIVE_INFINITY);
      const idle = now - last >= this.settings.idleSeconds * 1000;
      const expired = now - since >= lifetime * 1000;
      if (!idle && !expired) continue;
      this.guard.revoke(name);
      await this.api.request('POST', `/containers/${name}/stop?t=10`).catch((error) => {
        if (!(error instanceof DockerError && (error.status === 304 || error.status === 404)))
          throw error;
      });
      this.started.delete(name);
      stopped.push(name);
    }
    return stopped;
  }

  startReaper(everyMs = 60_000): void {
    this.reaper ??= setInterval(() => {
      void this.reap().catch((error) =>
        process.stderr.write(`docker sandbox idle stop failed: ${describe(error)}\n`),
      );
    }, everyMs);
    this.reaper.unref?.();
  }

  stopReaper(): void {
    clearInterval(this.reaper);
    this.reaper = undefined;
  }
}

const hosts = new Map<string, DockerSandboxHost>();

/** One host per socket in a process: one idle clock, one egress guard, one reaper. */
export function dockerSandboxHost(settings: DockerSandboxSettings): DockerSandboxHost {
  let host = hosts.get(settings.socket);
  if (!host) {
    host = new DockerSandboxHost(settings);
    host.startReaper();
    hosts.set(settings.socket, host);
  }
  return host;
}
