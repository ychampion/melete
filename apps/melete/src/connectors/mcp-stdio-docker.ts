/**
 * The local container backend for stdio MCP servers.
 *
 * Each connection gets one container at a time and one kept volume. The
 * container runs as an unprivileged user on a read-only root filesystem with
 * every capability dropped, no privilege escalation, Docker's default seccomp
 * profile, bounded memory, processes and CPU, and no log of what it says. Its
 * only mount is the connection's own volume at `/data`; it never sees the
 * Docker socket, the service's files or the service's environment.
 *
 * With no destinations named it has no network at all (`none`). With some, it
 * joins an internal network of its own whose one other member is the service,
 * and reaches the named destinations through the egress proxy only. A package
 * runner is prepared once per service start in a separate container that may
 * reach the package registry and nothing else; the server then runs offline
 * from what was prepared.
 *
 * The service speaks to the server over the container's attached standard
 * input and output, through the Docker socket the runtime supervisor already
 * uses, so a server with no network is still reachable.
 */
import { connect } from 'node:net';
import type { McpStdioLaunch } from '@melete/contracts';
import { type DockerApi, DockerError, DockerSocketApi } from '../runtime/docker.ts';
import { DOCKER_API_VERSION } from '../runtime/docker-engine.ts';
import { type EgressGrant, EgressProxy } from './mcp-egress.ts';
import { StdioCapacityError, type StdioLauncher, type StdioLaunchSpec } from './mcp-stdio.ts';
import type { StdioChannel } from './mcp-transport.ts';

const OWNER = 'com.melete.mcp-launcher';
const PROJECT = 'com.melete.project';
const CONNECTION = 'com.melete.connection';
const USER = '10001:10001';
/** The address a server's proxy settings name; the service answers to it on each egress network. */
const EGRESS_ALIAS = 'melete-egress';
/** Where each runner's package registry lives; a prepare container reaches these and nothing else. */
export const REGISTRY_DESTINATIONS = {
  npx: ['registry.npmjs.org'],
  uvx: ['pypi.org', 'files.pythonhosted.org'],
} as const;
export const STDIO_LIMITS = {
  memoryBytes: 512 * 1024 ** 2,
  pids: 128,
  nanoCpus: 1_000_000_000,
  tmpfs: 'rw,nosuid,nodev,size=64m,mode=1777',
  prepareTmpfs: 'rw,nosuid,nodev,size=256m,mode=1777',
  /** Servers running at once across the whole deployment. */
  servers: 16,
} as const;

/** What the backend needs from Docker beyond plain API requests. */
export interface DockerStdioApi extends DockerApi {
  /** Pull a public image; resolves once the engine reports it is complete. */
  pull(image: string, signal: AbortSignal): Promise<void>;
  /** Write a tar archive into a created container's filesystem. */
  putArchive(container: string, path: string, tar: Uint8Array): Promise<void>;
  /** The container's multiplexed standard streams, attached before it starts. */
  attach(container: string): Promise<AttachedStream>;
  /** The last lines a stopped container wrote, for a preparation that failed. */
  logs?(container: string): Promise<string>;
}

export type AttachedStream = {
  write(bytes: Uint8Array | string): void;
  onData(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  destroy(): void;
};

export type DockerStdioOptions = {
  project: string;
  socket: string;
  /** The service's own container, which joins a server's egress network as the proxy. */
  selfId?: string;
  /** The port the egress proxy listens on inside the service's container. */
  egressPort?: number;
  nodeImage?: string;
  pythonImage?: string;
  docker?: DockerStdioApi;
  proxy?: EgressProxy;
  /** How long a package runner's preparation may take. */
  prepareTimeoutMs?: number;
  /** Servers running at once across the deployment; a start beyond it is refused. */
  maxServers?: number;
};

export const DEFAULT_STDIO_IMAGES = {
  node: 'node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85',
  python:
    'ghcr.io/astral-sh/uv:0.12.17-python3.12-alpine@sha256:4c7eb663267624fa1f5b0316b3a51b427578bcb1d93459e1b6dfb5e9875beb0f',
} as const;

/**
 * Docker multiplexes a non-TTY container's stdout and stderr on one stream:
 * an 8-byte header (stream, three zero bytes, big-endian length), then that
 * many bytes. Only stdout is the server's protocol; stderr is dropped.
 */
export class DockerStreamDemuxer {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly stdout: (bytes: Buffer) => void,
    /** Keep stderr as well, for a log rather than a protocol. */
    private readonly both = false,
  ) {}

  push(bytes: Uint8Array): void {
    this.pending = Buffer.concat([this.pending, bytes]);
    for (;;) {
      if (this.pending.length < 8) return;
      const kind = this.pending[0];
      const size = this.pending.readUInt32BE(4);
      if (kind === undefined || kind > 3 || this.pending[1] || this.pending[2] || this.pending[3])
        throw new Error('Docker stream frame header is invalid');
      if (this.pending.length < 8 + size) return;
      const payload = this.pending.subarray(8, 8 + size);
      this.pending = this.pending.subarray(8 + size);
      if (kind === 1 || (this.both && kind === 2)) this.stdout(Buffer.from(payload));
    }
  }
}

/** One ustar directory entry per path, owned by the server's user, so its kept volume is writable. */
export function ownedDirectories(paths: readonly string[], uid = 10001, gid = 10001): Uint8Array {
  const blocks: Buffer[] = [];
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
  for (const path of paths) {
    if (!/^(?:\.|[a-z0-9]+(?:\/[a-z0-9]+)*)\/$/.test(path) || path.length > 99)
      throw new Error('Invalid tar path');
    const header = Buffer.alloc(512);
    header.write(path, 0, 'utf8');
    header.write(octal(0o700, 8), 100);
    header.write(octal(uid, 8), 108);
    header.write(octal(gid, 8), 116);
    header.write(octal(0, 12), 124);
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136);
    header.write('        ', 148);
    header.write('5', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * The server's volume: its root and the home its environment points into. Both
 * volumes are written into directly, because Docker refuses an archive for a
 * read-only root filesystem anywhere outside a volume.
 */
const DATA_DIRECTORIES = ['./', 'home/'];
/** The package volume: written by preparation alone, and read-only to the server. */
const PACKAGE_DIRECTORIES = ['./', 'npm/', 'uv/'];

/** `@scope/name@1.0` is the npm package `@scope/name`. */
export function npmName(source: string): string {
  const at = source.indexOf('@', 1);
  return at > 0 ? source.slice(0, at) : source;
}

/** The package name alone, for a runner that wants a command named after it. */
function pythonName(source: string): string {
  return /^[A-Za-z0-9._-]+/.exec(source)?.[0] ?? source;
}

/** `name@1.0` is `name==1.0` to uv. */
function pythonRequirement(source: string): string {
  const at = source.indexOf('@');
  return at > 0 ? `${source.slice(0, at)}==${source.slice(at + 1)}` : source;
}

/**
 * Starts a prepared npm package's program the way npx picks it, from the
 * package's own `bin`, as a child sharing the standard streams. It needs only
 * the read-only package volume, so the server never writes where its code is.
 */
const NPM_LAUNCHER = [
  "const {spawn}=require('child_process'),fs=require('fs'),path=require('path');",
  'const [,name,wanted,...args]=process.argv;',
  "const root=path.join('/pkg/npm/node_modules',name);",
  "const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));",
  "const short=name.split('/').pop();",
  "const bins=typeof pkg.bin==='string'?{[short]:pkg.bin}:(pkg.bin||{});",
  'const keys=Object.keys(bins);',
  "const chosen=wanted!=='-'?wanted:(keys.length===1?keys[0]:short);",
  "if(!bins[chosen]){process.stderr.write('no program named '+chosen+String.fromCharCode(10));process.exit(127)}",
  "const child=spawn(process.execPath,[path.join(root,bins[chosen]),...args],{stdio:'inherit'});",
  "for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));",
  "child.on('exit',(code,signal)=>process.exit(code??(signal?1:0)));",
].join('');

export type StdioCommand = { image: string; argv?: string[]; entrypoint?: string[] };

/** What runs in the server's container, and what prepares a package runner's volume first. */
export function stdioCommands(
  launch: McpStdioLaunch,
  images: { node: string; python: string } = DEFAULT_STDIO_IMAGES,
): { run: StdioCommand; prepare?: StdioCommand } {
  if (launch.runner === 'npx')
    return {
      prepare: {
        image: images.node,
        entrypoint: [
          'npm',
          'install',
          '--prefix',
          '/pkg/npm',
          '--no-save',
          '--no-audit',
          '--no-fund',
          launch.source,
        ],
      },
      run: {
        image: images.node,
        entrypoint: ['node', '-e', NPM_LAUNCHER, npmName(launch.source), launch.command ?? '-'],
        argv: launch.args,
      },
    };
  if (launch.runner === 'uvx')
    return {
      prepare: {
        image: images.python,
        entrypoint: ['uv', 'tool', 'install', '--force', pythonRequirement(launch.source)],
      },
      run: {
        image: images.python,
        entrypoint: [`/pkg/uv/bin/${launch.command ?? pythonName(launch.source)}`],
        argv: launch.args,
      },
    };
  return {
    run: {
      image: launch.source,
      ...(launch.command ? { entrypoint: [launch.command] } : {}),
      ...(launch.args.length ? { argv: launch.args } : {}),
    },
  };
}

/** The running server: a home in its own volume and a scratch `/tmp`. */
const SERVER_ENV = ['HOME=/data/home', 'TMPDIR=/tmp'];
/**
 * Preparation keeps nothing but the package. Its home and caches are in
 * memory, it reads no user, global or project configuration, and uv uses the
 * image's own Python rather than one it would fetch.
 */
const PREPARE_ENV = [
  'HOME=/tmp',
  'TMPDIR=/tmp',
  'NPM_CONFIG_CACHE=/tmp/npm-cache',
  'NPM_CONFIG_USERCONFIG=/dev/null',
  'NPM_CONFIG_GLOBALCONFIG=/dev/null',
  'NPM_CONFIG_UPDATE_NOTIFIER=false',
  'UV_CACHE_DIR=/tmp/uv-cache',
  'UV_TOOL_DIR=/pkg/uv/tools',
  'UV_TOOL_BIN_DIR=/pkg/uv/bin',
  'UV_NO_CONFIG=1',
  'UV_PYTHON_PREFERENCE=only-system',
  'UV_LINK_MODE=copy',
];

export type StdioMount = { volume: string; target: '/data' | '/pkg'; readOnly: boolean };

/** The create body for a server or preparation container. Pure, so its restrictions are tested. */
export function stdioContainerBody(input: {
  image: string;
  command: StdioCommand;
  labels: Record<string, string>;
  mounts: readonly StdioMount[];
  network?: string;
  env: readonly string[];
  interactive: boolean;
  /** Preparation downloads into memory, so it has more of it. */
  tmpfs?: string;
  /** Preparation holds no secret, so a failed one can say what went wrong. */
  keepLog?: boolean;
  workdir: string;
}): Record<string, unknown> {
  return {
    Image: input.image,
    ...(input.command.entrypoint ? { Entrypoint: input.command.entrypoint } : {}),
    ...(input.command.argv ? { Cmd: input.command.argv } : {}),
    User: USER,
    WorkingDir: input.workdir,
    Env: [...input.env],
    Labels: input.labels,
    AttachStdin: input.interactive,
    AttachStdout: input.interactive,
    AttachStderr: input.interactive,
    OpenStdin: input.interactive,
    StdinOnce: input.interactive,
    Tty: false,
    NetworkDisabled: !input.network,
    HostConfig: {
      NetworkMode: input.network ?? 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      PidsLimit: STDIO_LIMITS.pids,
      Memory: STDIO_LIMITS.memoryBytes,
      MemorySwap: STDIO_LIMITS.memoryBytes,
      NanoCpus: STDIO_LIMITS.nanoCpus,
      Tmpfs: { '/tmp': input.tmpfs ?? STDIO_LIMITS.tmpfs },
      RestartPolicy: { Name: 'no' },
      // What a server says may be private; it is read from the attached stream and never kept.
      LogConfig: input.keepLog
        ? { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } }
        : { Type: 'none', Config: {} },
      Mounts: input.mounts.map((mount) => ({
        Type: 'volume',
        Source: mount.volume,
        Target: mount.target,
        ReadOnly: mount.readOnly,
      })),
    },
    ...(input.network ? { NetworkingConfig: { EndpointsConfig: { [input.network]: {} } } } : {}),
  };
}

type Names = {
  container: string;
  prepare: string;
  network: string;
  volume: string;
  packages: string;
};

/** Docker over its socket, including the hijacked attach that `fetch` cannot make. */
export class DockerStdioSocket extends DockerSocketApi implements DockerStdioApi {
  constructor(private readonly path: string) {
    super(path);
  }

  async pull(image: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(
      `http://localhost/v${DOCKER_API_VERSION}/images/create?fromImage=${encodeURIComponent(image)}`,
      { unix: this.path, method: 'POST', signal },
    );
    if (!response.ok) throw new DockerError(response.status, 'POST', '/images/create');
    // The engine streams progress as JSON lines; a failure arrives as one with `error`.
    const text = await response.text();
    for (const line of text.split('\n'))
      if (line.trim() && 'error' in (JSON.parse(line) as object))
        throw new Error('The image could not be pulled');
  }

  async putArchive(container: string, path: string, tar: Uint8Array): Promise<void> {
    const response = await fetch(
      `http://localhost/v${DOCKER_API_VERSION}/containers/${container}/archive?path=${encodeURIComponent(path)}&copyUIDGID=1`,
      {
        unix: this.path,
        method: 'PUT',
        headers: { 'content-type': 'application/x-tar' },
        body: tar,
        signal: AbortSignal.timeout(30_000),
      },
    );
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new DockerError(response.status, 'POST', '/containers/archive');
  }

  async logs(container: string): Promise<string> {
    const response = await fetch(
      `http://localhost/v${DOCKER_API_VERSION}/containers/${container}/logs?stdout=1&stderr=1&tail=20`,
      { unix: this.path, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return '';
    const chunks: string[] = [];
    // Both streams, in the order they were written.
    const demuxer = new DockerStreamDemuxer((bytes) => chunks.push(bytes.toString()), true);
    demuxer.push(new Uint8Array(await response.arrayBuffer()));
    return chunks
      .join('')
      .replace(/[^\x20-\x7e\n]/g, '')
      .trim()
      .slice(-2000);
  }

  attach(container: string): Promise<AttachedStream> {
    if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Invalid container id');
    return new Promise((resolve, reject) => {
      const socket = connect({ path: this.path });
      let head = Buffer.alloc(0);
      let upgraded = false;
      const listeners: Array<(bytes: Uint8Array) => void> = [];
      const early: Uint8Array[] = [];
      let closed = false;
      let onClose: (() => void) | undefined;
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(30_000, () => {
        if (!upgraded) fail(new Error('Docker attach timed out'));
      });
      socket.once('connect', () => {
        socket.write(
          `POST /v${DOCKER_API_VERSION}/containers/${container}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n` +
            'Host: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n',
        );
      });
      socket.on('error', (error) => {
        if (!upgraded) fail(error);
      });
      socket.on('close', () => {
        closed = true;
        onClose?.();
      });
      socket.on('data', (chunk: Buffer) => {
        if (upgraded) {
          if (listeners.length) for (const listener of listeners) listener(chunk);
          else early.push(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 16_384) fail(new Error('Docker attach answered too much'));
          return;
        }
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'));
        if (!status || !['101', '200'].includes(status[1] ?? '')) {
          fail(new Error(`Docker attach answered ${status?.[1] ?? 'nothing'}`));
          return;
        }
        upgraded = true;
        socket.setTimeout(0);
        const rest = head.subarray(end + 4);
        if (rest.length) early.push(rest);
        resolve({
          write: (bytes) => {
            if (!closed) socket.write(bytes);
          },
          onData: (listener) => {
            listeners.push(listener);
            for (const chunk of early.splice(0)) listener(chunk);
          },
          onClose: (listener) => {
            onClose = listener;
            if (closed) listener();
          },
          destroy: () => socket.destroy(),
        });
      });
    });
  }
}

/** Stdio MCP servers in local containers, reached through the Docker socket. */
export class DockerStdioLauncher implements StdioLauncher {
  readonly backend = 'docker';
  private readonly docker: DockerStdioApi;
  private readonly images: { node: string; python: string };
  private proxy?: Promise<{ proxy: EgressProxy; port: number }>;
  private readonly prepared = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private live = 0;

  constructor(private readonly options: DockerStdioOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project))
      throw new Error('Invalid Docker compose project');
    this.docker = options.docker ?? new DockerStdioSocket(options.socket);
    this.images = {
      node: options.nodeImage ?? DEFAULT_STDIO_IMAGES.node,
      python: options.pythonImage ?? DEFAULT_STDIO_IMAGES.python,
    };
  }

  refuses(launch: McpStdioLaunch): string | null {
    // Any network, even a package registry's, is reached through the service's own container.
    if ((launch.egress.length || launch.runner !== 'image') && !this.options.selfId)
      return 'A server that reaches a network, or is fetched by npx or uvx, needs the service to run in its container.';
    return null;
  }

  /** True when a start now would pass the deployment's limit on running servers. */
  full(): boolean {
    return this.live >= (this.options.maxServers ?? STDIO_LIMITS.servers);
  }

  private names(connectionId: string): Names {
    if (!/^conn_[A-Za-z0-9]+$/.test(connectionId)) throw new Error('Invalid connection id');
    const prefix = `${this.options.project}-mcp-${connectionId.toLowerCase()}`;
    return {
      container: prefix,
      prepare: `${prefix}-prepare`,
      network: `${prefix}-net`,
      volume: `${prefix}-data`,
      packages: `${prefix}-pkg`,
    };
  }

  private labels(connectionId: string): Record<string, string> {
    return { [OWNER]: 'v1', [PROJECT]: this.options.project, [CONNECTION]: connectionId };
  }

  private owned(labels: Record<string, string> | undefined, connectionId?: string): boolean {
    return (
      labels?.[OWNER] === 'v1' &&
      labels[PROJECT] === this.options.project &&
      /^conn_[A-Za-z0-9]+$/.test(labels[CONNECTION] ?? '') &&
      (connectionId === undefined || labels[CONNECTION] === connectionId)
    );
  }

  private async remove(method: 'DELETE' | 'POST', path: string, body?: unknown) {
    try {
      await this.docker.request(method, path, body);
    } catch (error) {
      if (!(error instanceof DockerError && (error.status === 404 || error.status === 409)))
        throw error;
    }
  }

  private egress(): Promise<{ proxy: EgressProxy; port: number }> {
    this.proxy ??= (async () => {
      const proxy = this.options.proxy ?? new EgressProxy();
      const port = await proxy.listen(this.options.egressPort ?? 8789);
      return { proxy, port };
    })();
    return this.proxy;
  }

  /**
   * The image's id, pulled first when the host does not have it. A reference
   * that pins a digest runs only if the image on this host carries that
   * digest, whatever its tag now points to.
   */
  private async image(reference: string, signal: AbortSignal): Promise<string> {
    const path = `/images/${encodeURIComponent(reference)}/json`;
    type Found = { Id: string; RepoDigests?: string[] | null };
    let found: Found | undefined;
    try {
      found = (await this.docker.request('GET', path)) as Found;
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
    if (!found) {
      await this.docker.pull(reference, signal);
      found = (await this.docker.request('GET', path)) as Found;
    }
    const digest = /@(sha256:[a-f0-9]{64})$/.exec(reference)?.[1];
    if (digest && !(found.RepoDigests ?? []).some((entry) => entry.endsWith(`@${digest}`)))
      throw new Error('The image on this host is not the one its digest names');
    return found.Id;
  }

  private async volume(connectionId: string, name: string) {
    const volume = (await this.docker.request('POST', '/volumes/create', {
      Name: name,
      Labels: this.labels(connectionId),
    })) as { Name: string; Labels: Record<string, string> };
    // Creating a volume that exists returns it; one that belongs to anything else is refused.
    if (volume.Name !== name || !this.owned(volume.Labels, connectionId))
      throw new Error('Refusing a volume that belongs to another owner');
  }

  /** An internal network with only the server and the service, which serves as its proxy. */
  private async network(connectionId: string, names: Names): Promise<string> {
    const self = this.options.selfId;
    if (!self) throw new Error('Egress needs the service to run in its container');
    await this.remove('DELETE', `/networks/${names.network}`);
    const created = (await this.docker.request('POST', '/networks/create', {
      Name: names.network,
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Labels: this.labels(connectionId),
    })) as { Id: string };
    // An engine that made it routable would give the server the host's network.
    const recorded = (await this.docker.request('GET', `/networks/${created.Id}`)) as {
      Internal?: boolean;
    };
    if (recorded.Internal !== true) {
      await this.remove('DELETE', `/networks/${created.Id}`);
      throw new Error('The server network was not created internal');
    }
    await this.docker.request('POST', `/networks/${created.Id}/connect`, {
      Container: self,
      EndpointConfig: { Aliases: [EGRESS_ALIAS] },
    });
    return created.Id;
  }

  private async dropNetwork(names: Names) {
    // Most servers never had one, and engines answer a disconnect from a missing network with
    // 500, not 404, so the network is looked up first.
    let network: { Containers?: Record<string, unknown> | null };
    try {
      network = (await this.docker.request('GET', `/networks/${names.network}`)) as typeof network;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return;
      throw error;
    }
    const self = this.options.selfId;
    if (self && Object.keys(network.Containers ?? {}).some((id) => id.startsWith(self)))
      await this.remove('POST', `/networks/${names.network}/disconnect`, {
        Container: self,
        Force: true,
      });
    await this.remove('DELETE', `/networks/${names.network}`);
  }

  private async proxyEnv(destinations: readonly string[]): Promise<{
    env: string[];
    grant: EgressGrant;
  }> {
    const { proxy, port } = await this.egress();
    const grant = proxy.grant(destinations);
    const address = `http://mcp:${grant.token}@${EGRESS_ALIAS}:${port}`;
    return {
      grant,
      env: [
        `HTTP_PROXY=${address}`,
        `HTTPS_PROXY=${address}`,
        `http_proxy=${address}`,
        `https_proxy=${address}`,
        'NO_PROXY=',
        'no_proxy=',
      ],
    };
  }

  /** Create, verify, and make its volume writable to it, before anything runs in a container. */
  private async create(
    name: string,
    body: Record<string, unknown>,
    network: string | undefined,
    mounts: readonly StdioMount[],
    writable: { path: '/data' | '/pkg'; directories: string[] },
  ): Promise<string> {
    await this.remove('DELETE', `/containers/${name}?force=true&v=true`);
    const created = (await this.docker.request(
      'POST',
      `/containers/create?name=${name}`,
      body,
    )) as { Id: string };
    const inspected = (await this.docker.request('GET', `/containers/${created.Id}/json`)) as {
      Config?: { User?: string };
      HostConfig: {
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        CapDrop: string[] | null;
        SecurityOpt?: string[] | null;
        Privileged?: boolean;
        PidsLimit?: number | null;
        Memory?: number;
      };
      Mounts?: { Type: string; Name?: string; Destination: string; RW: boolean }[];
    };
    const recorded = inspected.Mounts ?? [];
    const ours = mounts.every((mount) =>
      recorded.some(
        (entry) =>
          entry.Type === 'volume' &&
          entry.Name === mount.volume &&
          entry.Destination === mount.target &&
          entry.RW === !mount.readOnly,
      ),
    );
    // An image may declare volumes of its own; they are anonymous, go with the container, and
    // are all it gets besides ours.
    const others = recorded.filter((entry) => !mounts.some((mount) => mount.volume === entry.Name));
    const anonymous = others.every(
      (entry) => entry.Type === 'volume' && /^[a-f0-9]{64}$/.test(entry.Name ?? ''),
    );
    const host = inspected.HostConfig;
    // What the engine recorded is what runs; anything less isolated is removed unstarted.
    if (
      inspected.Config?.User !== USER ||
      host.NetworkMode !== (network ?? 'none') ||
      host.ReadonlyRootfs !== true ||
      !host.CapDrop?.includes('ALL') ||
      !host.SecurityOpt?.includes('no-new-privileges:true') ||
      host.Privileged !== false ||
      host.PidsLimit !== STDIO_LIMITS.pids ||
      host.Memory !== STDIO_LIMITS.memoryBytes ||
      !ours ||
      !anonymous
    ) {
      await this.remove('DELETE', `/containers/${created.Id}?force=true&v=true`);
      throw new Error('The server container was not created with its restrictions');
    }
    await this.docker.putArchive(created.Id, writable.path, ownedDirectories(writable.directories));
    return created.Id;
  }

  /** Fetch a package runner's package into the volume, reaching only its registry. */
  private async prepare(
    spec: StdioLaunchSpec,
    names: Names,
    command: StdioCommand,
    signal: AbortSignal,
  ) {
    const key = `${spec.connectionId}\n${spec.launch.source}`;
    if (this.prepared.has(key) || spec.launch.runner === 'image') return;
    const registry = REGISTRY_DESTINATIONS[spec.launch.runner];
    const image = await this.image(command.image, signal);
    await this.network(spec.connectionId, names);
    const { env, grant } = await this.proxyEnv(registry);
    // Only the package volume: nothing the server ever wrote in its own volume reaches here.
    const mounts: StdioMount[] = [{ volume: names.packages, target: '/pkg', readOnly: false }];
    let id: string | undefined;
    try {
      id = await this.create(
        names.prepare,
        stdioContainerBody({
          image,
          command,
          labels: this.labels(spec.connectionId),
          mounts,
          network: names.network,
          // A package's install scripts run here with no secret: only the running server gets them.
          env: [...PREPARE_ENV, ...env],
          interactive: false,
          tmpfs: STDIO_LIMITS.prepareTmpfs,
          keepLog: true,
          workdir: '/tmp',
        }),
        names.network,
        mounts,
        { path: '/pkg', directories: PACKAGE_DIRECTORIES },
      );
      signal.throwIfAborted();
      await this.docker.request('POST', `/containers/${id}/start`);
      const waited = Promise.race([
        this.docker.request('POST', `/containers/${id}/wait`) as Promise<{ StatusCode: number }>,
        new Promise<never>((_, reject) => {
          const timeout = AbortSignal.any([
            signal,
            AbortSignal.timeout(this.options.prepareTimeoutMs ?? 5 * 60_000),
          ]);
          timeout.addEventListener('abort', () => reject(new Error('Preparation timed out')), {
            once: true,
          });
        }),
      ]);
      if ((await waited).StatusCode !== 0) {
        const said = await this.docker.logs?.(id).catch(() => '');
        throw new Error(`The package could not be prepared${said ? `: ${said}` : ''}`);
      }
      this.prepared.add(key);
    } finally {
      grant.revoke();
      if (id) await this.remove('DELETE', `/containers/${id}?force=true&v=true`);
      await this.dropNetwork(names);
    }
  }

  async start(spec: StdioLaunchSpec, signal: AbortSignal): Promise<StdioChannel> {
    const refusal = this.refuses(spec.launch);
    if (refusal) throw new Error(refusal);
    const names = this.names(spec.connectionId);
    // One server per connection: a start waits for the previous container to be gone.
    await this.running.get(spec.connectionId);
    if (this.full()) throw new StdioCapacityError();
    this.live += 1;
    let counted = true;
    const uncount = () => {
      if (counted) this.live -= 1;
      counted = false;
    };
    try {
      return await this.run(spec, names, signal, uncount);
    } catch (error) {
      uncount();
      throw error;
    }
  }

  private async run(
    spec: StdioLaunchSpec,
    names: Names,
    signal: AbortSignal,
    uncount: () => void,
  ): Promise<StdioChannel> {
    const { run, prepare } = stdioCommands(spec.launch, this.images);
    await this.volume(spec.connectionId, names.volume);
    if (prepare) await this.volume(spec.connectionId, names.packages);
    if (prepare) await this.prepare(spec, names, prepare, signal);
    signal.throwIfAborted();
    const image = await this.image(run.image, signal);
    const egress = spec.launch.egress.length
      ? {
          network: await this.network(spec.connectionId, names),
          ...(await this.proxyEnv(spec.launch.egress)),
        }
      : undefined;
    let id: string | undefined;
    let stream: AttachedStream | undefined;
    const release = async () => {
      uncount();
      egress?.grant.revoke();
      stream?.destroy();
      if (id) await this.remove('DELETE', `/containers/${id}?force=true&v=true`);
      if (egress) await this.dropNetwork(names);
    };
    // Its own volume to write, and the prepared package to read, never to change.
    const mounts: StdioMount[] = [
      { volume: names.volume, target: '/data', readOnly: false },
      ...(prepare ? [{ volume: names.packages, target: '/pkg' as const, readOnly: true }] : []),
    ];
    try {
      id = await this.create(
        names.container,
        stdioContainerBody({
          image,
          command: run,
          labels: this.labels(spec.connectionId),
          mounts,
          network: egress ? names.network : undefined,
          env: [
            ...SERVER_ENV,
            ...(egress?.env ?? []),
            ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          ],
          interactive: true,
          workdir: '/data/home',
        }),
        egress ? names.network : undefined,
        mounts,
        { path: '/data', directories: DATA_DIRECTORIES },
      );
      stream = await this.docker.attach(id);
      signal.throwIfAborted();
      await this.docker.request('POST', `/containers/${id}/start`);
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
    const attached = stream;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= release();
      this.running.set(
        spec.connectionId,
        stopping.catch(() => {}),
      );
      return stopping;
    };
    const decoder = new TextDecoder();
    return {
      write: (text) => attached.write(text),
      onData: (listener) => {
        const demuxer = new DockerStreamDemuxer((bytes) =>
          listener(decoder.decode(bytes, { stream: true })),
        );
        attached.onData((bytes) => {
          try {
            demuxer.push(bytes);
          } catch {
            void stop();
          }
        });
      },
      onClose: (listener) =>
        attached.onClose(() => {
          // The server ended on its own: its container goes with it.
          void stop().catch(() => {});
          listener();
        }),
      close: () => stop(),
    };
  }

  async destroy(connectionId: string): Promise<void> {
    const names = this.names(connectionId);
    await this.running.get(connectionId);
    for (const container of [names.container, names.prepare])
      await this.remove('DELETE', `/containers/${container}?force=true&v=true`);
    await this.dropNetwork(names);
    await this.remove('DELETE', `/volumes/${names.volume}`);
    await this.remove('DELETE', `/volumes/${names.packages}`);
    for (const key of this.prepared)
      if (key.startsWith(`${connectionId}\n`)) this.prepared.delete(key);
  }

  async reconcile(keep: ReadonlySet<string>): Promise<void> {
    const filter = encodeURIComponent(
      JSON.stringify({ label: [`${OWNER}=v1`, `${PROJECT}=${this.options.project}`] }),
    );
    // No server outlives the service process that started it.
    const containers = (await this.docker.request(
      'GET',
      `/containers/json?all=true&filters=${filter}`,
    )) as Array<{ Id: string; Labels: Record<string, string> }>;
    for (const container of containers)
      if (this.owned(container.Labels))
        await this.remove('DELETE', `/containers/${container.Id}?force=true&v=true`);
    const networks = (await this.docker.request('GET', `/networks?filters=${filter}`)) as Array<{
      Id: string;
      Labels: Record<string, string>;
    }>;
    for (const network of networks) {
      if (!this.owned(network.Labels)) continue;
      if (this.options.selfId)
        await this.remove('POST', `/networks/${network.Id}/disconnect`, {
          Container: this.options.selfId,
          Force: true,
        });
      await this.remove('DELETE', `/networks/${network.Id}`);
    }
    // Kept data outlives a restart, but not the connection it belonged to.
    const volumes = (await this.docker.request('GET', `/volumes?filters=${filter}`)) as {
      Volumes: Array<{ Name: string; Labels: Record<string, string> }> | null;
    };
    for (const volume of volumes.Volumes ?? [])
      if (this.owned(volume.Labels) && !keep.has(volume.Labels[CONNECTION] ?? ''))
        await this.remove('DELETE', `/volumes/${volume.Name}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
    const proxy = await this.proxy?.catch(() => undefined);
    await proxy?.proxy.close();
  }
}
