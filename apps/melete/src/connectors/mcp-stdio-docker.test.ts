import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { type McpStdioLaunch, mcpStdioLaunch } from '@melete/contracts';
import { DockerError } from '../runtime/docker.ts';
import { EgressProxy } from './mcp-egress.ts';
import { StdioCapacityError, type StdioLaunchSpec } from './mcp-stdio.ts';
import {
  type AttachedStream,
  DEFAULT_STDIO_IMAGES,
  type DockerStdioApi,
  DockerStdioLauncher,
  DockerStreamDemuxer,
  npmName,
  ownedDirectories,
  REGISTRY_DESTINATIONS,
  stdioCommands,
} from './mcp-stdio-docker.ts';
import { MCP_PROTOCOL_VERSION, openLineMcpTransport } from './mcp-transport.ts';

const CONNECTION = 'conn_01J00000000000000000000000';
const PREFIX = `melete-mcp-${CONNECTION.toLowerCase()}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMAGE = `ghcr.io/example/notes:1.0@${DIGEST}`;
type Mount = { Type: string; Source: string; Target: string; ReadOnly: boolean };
type Body = Record<string, unknown> & {
  User: string;
  Env: string[];
  Entrypoint?: string[];
  Cmd?: string[];
  OpenStdin: boolean;
  HostConfig: Record<string, unknown> & { Mounts: Mount[] };
};

/** Frames one payload the way Docker multiplexes a non-TTY container's streams. */
function frame(kind: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = kind;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const digestOf = (reference: string) =>
  /@(sha256:[a-f0-9]{64})$/.exec(reference)?.[1] ??
  `sha256:${createHash('sha256').update(reference).digest('hex')}`;

/** A Docker engine that records every request and runs an MCP server on each attached stream. */
class FakeEngine implements DockerStdioApi {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, Body>();
  readonly archives: string[] = [];
  readonly pulls: string[] = [];
  readonly images = new Map<string, string>();
  readonly streams = new Map<string, { end(): void }>();
  readonly networks = new Set<string>();
  readonly volumes = new Set<string>();
  /** A field the engine records with less isolation than it was asked for. */
  weakens?: 'CapDrop' | 'User' | 'Privileged' | 'PidsLimit' | 'Memory' | 'SecurityOpt' | 'Mount';
  /** The engine makes networks routable whatever it is asked. */
  routable = false;
  /** Another image answers to the pinned reference. */
  swapped = false;
  prepareStatus = 0;
  private counter = 0;

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    this.calls.push(`${method} ${path}`);
    const [route = ''] = path.split('?');
    let match = /^\/images\/(.+)\/json$/.exec(route);
    if (match) {
      const reference = decodeURIComponent(match[1] ?? '');
      const digest = this.images.get(reference);
      if (!digest) throw new DockerError(404, 'GET', route);
      return {
        Id: `sha256:${createHash('sha256').update(reference).digest('hex')}`,
        RepoDigests: [
          `${reference.split(/[:@]/)[0]}@${this.swapped ? `sha256:${'f'.repeat(64)}` : digest}`,
        ],
      };
    }
    if (route === '/volumes/create') {
      const request = body as { Name: string; Labels: Record<string, string> };
      this.volumes.add(request.Name);
      return request;
    }
    if (route === '/networks/create') {
      const name = (body as { Name: string }).Name;
      this.networks.add(name);
      return { Id: name };
    }
    if (route === '/containers/create') {
      const id = createHash('sha256')
        .update(`container-${this.counter++}`)
        .digest('hex');
      this.bodies.set(id, structuredClone(body) as Body);
      return { Id: id };
    }
    match = /^\/containers\/([a-f0-9]{64})\/json$/.exec(route);
    if (match) {
      const created = this.bodies.get(match[1] ?? '');
      if (!created) throw new DockerError(404, 'GET', route);
      const host = created.HostConfig;
      const weak = this.weakens;
      return {
        Config: { User: weak === 'User' ? '0:0' : created.User },
        HostConfig: {
          ...host,
          CapDrop: weak === 'CapDrop' ? [] : host.CapDrop,
          Privileged: weak === 'Privileged' ? true : host.Privileged,
          PidsLimit: weak === 'PidsLimit' ? 0 : host.PidsLimit,
          Memory: weak === 'Memory' ? 0 : host.Memory,
          SecurityOpt: weak === 'SecurityOpt' ? [] : host.SecurityOpt,
        },
        Mounts: [
          ...host.Mounts.map((mount) => ({
            Type: 'volume',
            Name: mount.Source,
            Destination: mount.Target,
            RW: !mount.ReadOnly,
          })),
          ...(weak === 'Mount'
            ? [{ Type: 'bind', Source: '/', Destination: '/host', RW: true }]
            : [{ Type: 'volume', Name: 'e'.repeat(64), Destination: '/image-volume', RW: true }]),
        ],
      };
    }
    if (/^\/containers\/[a-f0-9]{64}\/wait$/.test(route)) return { StatusCode: this.prepareStatus };
    match = /^\/containers\/([^/]+)$/.exec(route);
    if (match && method === 'DELETE') {
      this.streams.get(match[1] ?? '')?.end();
      return null;
    }
    match = /^\/networks\/([^/]+)$/.exec(route);
    if (match && method === 'GET') {
      if (!this.networks.has(match[1] ?? '')) throw new DockerError(404, 'GET', route);
      // A real engine lists members by full id; the service knows itself by its short one.
      return { Internal: !this.routable, Containers: { 'service-container-full-id': {} } };
    }
    if (match && method === 'DELETE') {
      this.networks.delete(match[1] ?? '');
      return null;
    }
    match = /^\/volumes\/([^/]+)$/.exec(route);
    if (match && method === 'DELETE') {
      this.volumes.delete(match[1] ?? '');
      return null;
    }
    if (route === '/containers/json')
      return [...this.bodies.keys()].map((Id) => ({ Id, Labels: this.bodies.get(Id)?.Labels }));
    if (route === '/networks')
      return [...this.networks].map((Id) => ({ Id, Labels: this.labels(CONNECTION) }));
    if (route === '/volumes')
      return {
        Volumes: [
          { Name: 'melete-mcp-conn_kept-data', Labels: this.labels('conn_kept') },
          { Name: 'melete-mcp-conn_gone-data', Labels: this.labels('conn_gone') },
          { Name: 'melete-mcp-conn_gone-pkg', Labels: this.labels('conn_gone') },
          { Name: 'someone-else', Labels: { 'com.melete.project': 'melete' } },
        ],
      };
    return null;
  }

  private labels(connection: string) {
    return {
      'com.melete.mcp-launcher': 'v1',
      'com.melete.project': 'melete',
      'com.melete.connection': connection,
    };
  }

  async pull(image: string) {
    this.pulls.push(image);
    this.images.set(image, digestOf(image));
  }

  async putArchive(container: string, path: string) {
    this.archives.push(`${container} ${path}`);
    this.calls.push(`ARCHIVE ${container}`);
  }

  async attach(container: string): Promise<AttachedStream> {
    this.calls.push(`ATTACH ${container}`);
    let data: ((bytes: Uint8Array) => void) | undefined;
    let closed: (() => void) | undefined;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      closed?.();
    };
    this.streams.set(container, { end });
    return {
      write: (bytes) => {
        for (const line of bytes.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === undefined) continue;
          const reply = frame(
            1,
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
            })}\n`,
          );
          // A diagnostic on stderr, then the reply split across reads: only stdout is the protocol.
          queueMicrotask(() => {
            data?.(frame(2, 'a diagnostic line\n'));
            data?.(reply.subarray(0, 5));
            data?.(reply.subarray(5));
          });
        }
      },
      onData: (listener) => {
        data = listener;
      },
      onClose: (listener) => {
        closed = listener;
        if (ended) listener();
      },
      destroy: end,
    };
  }

  /** The request paths without their query strings, in order. */
  routes(): string[] {
    return this.calls.map((call) => call.split('?')[0] ?? call);
  }

  created(): Body[] {
    return [...this.bodies.values()];
  }
}

/** Records what each grant allowed, so a test can see where a container could go. */
class RecordingProxy extends EgressProxy {
  readonly granted: string[][] = [];
  override grant(entries: readonly string[]) {
    this.granted.push([...entries]);
    return super.grant(entries);
  }
}

const spec = (launch: Partial<McpStdioLaunch>, connectionId = CONNECTION): StdioLaunchSpec => ({
  connectionId,
  spaceId: 'sp_01',
  launch: mcpStdioLaunch.parse({
    runner: 'image',
    source: IMAGE,
    secret_env_names: ['NOTES_TOKEN'],
    ...launch,
  }),
  env: { NOTES_TOKEN: 'sealed-value' },
});
const signal = () => AbortSignal.timeout(10_000);
const launcherFor = (engine: FakeEngine, extra: Record<string, unknown> = {}) =>
  new DockerStdioLauncher({ project: 'melete', socket: 'unused', docker: engine, ...extra });
const inContainer = (engine: FakeEngine, proxy = new RecordingProxy()) =>
  launcherFor(engine, { selfId: 'service-container', egressPort: 0, proxy });

describe('the Docker stdio launcher', () => {
  test('a server with no destinations has no network, its own volume, no privileges and no log', async () => {
    const engine = new FakeEngine();
    const launcher = launcherFor(engine);
    const channel = await launcher.start(spec({ args: ['--root', '/data'] }), signal());
    // The service speaks to it over the attached streams, which Docker multiplexes.
    const transport = openLineMcpTransport(channel);
    expect(await transport.request('initialize', {})).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
    });

    expect(engine.pulls).toEqual([IMAGE]);
    const [body] = engine.created();
    if (!body) throw new Error('No container was created');
    expect(body).toMatchObject({
      User: '10001:10001',
      WorkingDir: '/data/home',
      Cmd: ['--root', '/data'],
      Tty: false,
      OpenStdin: true,
      NetworkDisabled: true,
      Labels: {
        'com.melete.mcp-launcher': 'v1',
        'com.melete.project': 'melete',
        'com.melete.connection': CONNECTION,
      },
    });
    expect(body.Entrypoint).toBeUndefined();
    expect(body.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      PidsLimit: 128,
      Memory: 512 * 1024 ** 2,
      MemorySwap: 512 * 1024 ** 2,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none', Config: {} },
      Mounts: [{ Type: 'volume', Source: `${PREFIX}-data`, Target: '/data', ReadOnly: false }],
    });
    for (const key of ['Binds', 'Devices', 'CapAdd', 'PidMode', 'IpcMode', 'UsernsMode'])
      expect(body.HostConfig).not.toHaveProperty(key);
    // The server's environment is its home and its sealed variables, nothing of the service's.
    expect(body.Env).toEqual(['HOME=/data/home', 'TMPDIR=/tmp', 'NOTES_TOKEN=sealed-value']);
    expect(engine.networks.size).toBe(0);
    // The volume is made writable, then the streams are attached before the server can say anything.
    const order = engine.routes().filter((route) => /create|ARCHIVE|ATTACH|start$/.test(route));
    expect(order.map((route) => route.split(' ')[1]?.replace(/[a-f0-9]{64}/, 'ID'))).toEqual([
      '/volumes/create',
      '/containers/create',
      'ID',
      'ID',
      '/containers/ID/start',
    ]);
    expect(order[2]?.startsWith('ARCHIVE')).toBe(true);
    expect(order[3]?.startsWith('ATTACH')).toBe(true);
    // Written into the volume, the one writable place Docker accepts an archive for.
    expect(engine.archives[0]?.endsWith(' /data')).toBe(true);

    await transport.close();
    // The container goes, and any volume its image declared goes with it.
    expect(engine.calls.at(-1)).toMatch(/^DELETE \/containers\/[a-f0-9]{64}\?force=true&v=true$/);
  });

  test('a container the engine recorded with any less isolation is removed unstarted', async () => {
    for (const weakens of [
      'CapDrop',
      'User',
      'Privileged',
      'PidsLimit',
      'Memory',
      'SecurityOpt',
      'Mount',
    ] as const) {
      const engine = new FakeEngine();
      engine.weakens = weakens;
      await expect(launcherFor(engine).start(spec({}), signal())).rejects.toThrow('restrictions');
      expect([weakens, engine.routes().some((route) => route.endsWith('/start'))]).toEqual([
        weakens,
        false,
      ]);
      expect(engine.routes().some((route) => route.startsWith('ATTACH'))).toBe(false);
      expect(engine.calls.at(-1)).toMatch(/^DELETE \/containers\/[a-f0-9]{64}\?force=true&v=true$/);
    }
  });

  test('an image runs only if the host holds the content its digest names', async () => {
    const engine = new FakeEngine();
    engine.swapped = true;
    await expect(launcherFor(engine).start(spec({}), signal())).rejects.toThrow('digest');
    expect(engine.created()).toHaveLength(0);
  });

  test('npx fetches into a package volume the server can only read, with no secret and no config', async () => {
    const engine = new FakeEngine();
    const proxy = new RecordingProxy();
    const launcher = inContainer(engine, proxy);
    const channel = await launcher.start(
      spec({ runner: 'npx', source: '@example/notes-server@1.0.0', args: ['/data/home'] }),
      signal(),
    );
    const [prepare, server] = engine.created();
    if (!prepare || !server) throw new Error('Expected a preparation and a server');
    expect(prepare.Entrypoint).toEqual([
      'npm',
      'install',
      '--prefix',
      '/pkg/npm',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '@example/notes-server@1.0.0',
    ]);
    expect(prepare.OpenStdin).toBe(false);
    // Preparation sees only the package volume, keeps its home and caches in memory, and reads
    // no configuration: nothing the server ever wrote can reach it.
    expect(prepare.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${PREFIX}-pkg`, Target: '/pkg', ReadOnly: false },
    ]);
    expect(prepare.Env).toEqual(
      expect.arrayContaining([
        'HOME=/tmp',
        'NPM_CONFIG_USERCONFIG=/tmp/no-user-npmrc',
        'NPM_CONFIG_GLOBALCONFIG=/tmp/no-global-npmrc',
        'NPM_CONFIG_CACHE=/tmp/npm-cache',
        'UV_NO_CONFIG=1',
        'UV_PYTHON_PREFERENCE=only-system',
      ]),
    );
    expect(prepare.Env.some((entry) => entry.startsWith('NOTES_TOKEN'))).toBe(false);
    expect(prepare.Env).toContainEqual(
      expect.stringMatching(/^HTTPS_PROXY=http:\/\/mcp:[\w-]+@melete-egress:\d+$/),
    );
    expect(prepare.HostConfig.NetworkMode).toBe(`${PREFIX}-net`);
    expect(engine.archives.some((entry) => entry.endsWith(' /pkg'))).toBe(true);
    expect(proxy.granted).toEqual([[...REGISTRY_DESTINATIONS.npx]]);
    expect(engine.calls).toContain(`POST /networks/${PREFIX}-net/connect`);
    expect(engine.calls).toContain(`DELETE /networks/${PREFIX}-net`);

    // The server writes its own volume, reads the package, and has no network.
    expect(server.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${PREFIX}-data`, Target: '/data', ReadOnly: false },
      { Type: 'volume', Source: `${PREFIX}-pkg`, Target: '/pkg', ReadOnly: true },
    ]);
    expect(server.HostConfig.NetworkMode).toBe('none');
    expect(server.Entrypoint?.slice(0, 2)).toEqual(['node', '-e']);
    expect(server.Entrypoint?.slice(3)).toEqual(['@example/notes-server', '-']);
    expect(server.Cmd).toEqual(['/data/home']);
    expect(server.Env).toEqual(['HOME=/data/home', 'TMPDIR=/tmp', 'NOTES_TOKEN=sealed-value']);
    await channel.close();

    // Preparation happens once for each service start.
    const again = await launcher.start(
      spec({ runner: 'npx', source: '@example/notes-server@1.0.0', args: ['/data/home'] }),
      signal(),
    );
    expect(engine.created()).toHaveLength(3);
    await again.close();
    await launcher.close();
  });

  test('a preparation that fails starts no server', async () => {
    const engine = new FakeEngine();
    engine.prepareStatus = 1;
    const launcher = inContainer(engine);
    await expect(
      launcher.start(spec({ runner: 'uvx', source: 'mcp-server-fetch==2026.1.1' }), signal()),
    ).rejects.toThrow('prepared');
    expect(engine.created()).toHaveLength(1);
    expect(engine.routes().filter((route) => route.startsWith('ATTACH'))).toHaveLength(0);
    await launcher.close();
  });

  test('named destinations are reached through the proxy alone, on an internal network of its own', async () => {
    const engine = new FakeEngine();
    const proxy = new RecordingProxy();
    const launcher = inContainer(engine, proxy);
    const channel = await launcher.start(spec({ egress: ['api.example.com'] }), signal());
    const [server] = engine.created();
    if (!server) throw new Error('No server');
    expect(server.HostConfig.NetworkMode).toBe(`${PREFIX}-net`);
    expect(server.NetworkDisabled).toBe(false);
    expect(proxy.granted).toEqual([['api.example.com']]);
    expect(engine.calls).toContain(`GET /networks/${PREFIX}-net`);
    expect(engine.calls).toContain(`POST /networks/${PREFIX}-net/connect`);
    const proxyAddress = server.Env.find((entry) => entry.startsWith('HTTPS_PROXY=')) ?? '';
    const [, token = '', port = ''] = /mcp:([\w-]+)@melete-egress:(\d+)$/.exec(proxyAddress) ?? [];
    const ask = () =>
      new Promise<string>((resolve) => {
        const socket = connect(Number(port), '127.0.0.1');
        let text = '';
        socket.on('data', (bytes) => {
          text += bytes.toString();
        });
        socket.on('close', () => resolve(text));
        socket.on('error', () => resolve(text));
        socket.write(
          'CONNECT elsewhere.example.com:443 HTTP/1.1\r\nHost: elsewhere.example.com:443\r\n' +
            `Proxy-Authorization: Basic ${Buffer.from(`mcp:${token}`).toString('base64')}\r\n\r\n`,
        );
        setTimeout(() => socket.destroy(), 2_000);
      });
    // The token opens only what was named.
    expect(await ask()).toContain('403');
    await channel.close();
    // Stopping the server ends its grant and its network.
    expect(await ask()).toContain('407');
    expect(engine.calls).toContain(`DELETE /networks/${PREFIX}-net`);
    await launcher.close();
  });

  test('a network the engine made routable is removed and no server joins it', async () => {
    const engine = new FakeEngine();
    engine.routable = true;
    const launcher = inContainer(engine);
    await expect(launcher.start(spec({ egress: ['api.example.com'] }), signal())).rejects.toThrow(
      'internal',
    );
    expect(engine.calls.some((call) => call.includes('/connect'))).toBe(false);
    expect(engine.created()).toHaveLength(0);
    await launcher.close();
  });

  test('the deployment runs no more servers than it allows, and a stopped one frees its place', async () => {
    const engine = new FakeEngine();
    const launcher = launcherFor(engine, { maxServers: 2 });
    const first = await launcher.start(spec({}, 'conn_first'), signal());
    await launcher.start(spec({}, 'conn_second'), signal());
    expect(launcher.full()).toBe(true);
    await expect(launcher.start(spec({}, 'conn_third'), signal())).rejects.toBeInstanceOf(
      StdioCapacityError,
    );
    expect(engine.created()).toHaveLength(2);
    await first.close();
    expect(launcher.full()).toBe(false);
    await launcher.start(spec({}, 'conn_third'), signal());
    // A start that fails gives its place back.
    engine.weakens = 'CapDrop';
    await expect(launcher.start(spec({}, 'conn_fourth'), signal())).rejects.toThrow();
    engine.weakens = undefined;
    expect(launcher.full()).toBe(true);
  });

  test('without its own container the service refuses any network and any package runner', () => {
    const launcher = launcherFor(new FakeEngine());
    expect(launcher.refuses(spec({}).launch)).toBeNull();
    expect(launcher.refuses(spec({ egress: ['api.example.com'] }).launch)).toContain('container');
    expect(launcher.refuses(spec({ runner: 'npx', source: 'notes-server' }).launch)).toContain(
      'container',
    );
  });

  test('a server that ends on its own takes its container with it', async () => {
    const engine = new FakeEngine();
    const launcher = launcherFor(engine);
    const channel = await launcher.start(spec({}), signal());
    let ended = false;
    channel.onClose(() => {
      ended = true;
    });
    const [id] = engine.bodies.keys();
    engine.streams.get(id ?? '')?.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ended).toBe(true);
    expect(engine.calls).toContain(`DELETE /containers/${id}?force=true&v=true`);
  });

  test('removal takes both volumes; a restart keeps only live connections', async () => {
    const engine = new FakeEngine();
    const launcher = launcherFor(engine, { selfId: 'service-container' });
    // A server that never had a network: nothing is disconnected, which an engine answers with 500.
    await launcher.destroy(CONNECTION);
    expect(engine.calls.some((call) => call.includes('/disconnect'))).toBe(false);
    engine.calls.length = 0;
    engine.networks.add(`${PREFIX}-net`);
    await launcher.destroy(CONNECTION);
    expect(engine.calls).toEqual(
      expect.arrayContaining([
        `DELETE /containers/${PREFIX}?force=true&v=true`,
        `DELETE /containers/${PREFIX}-prepare?force=true&v=true`,
        `POST /networks/${PREFIX}-net/disconnect`,
        `DELETE /networks/${PREFIX}-net`,
        `DELETE /volumes/${PREFIX}-data`,
        `DELETE /volumes/${PREFIX}-pkg`,
      ]),
    );
    engine.calls.length = 0;
    await launcher.reconcile(new Set(['conn_kept']));
    expect(engine.calls).toContain('DELETE /volumes/melete-mcp-conn_gone-data');
    expect(engine.calls).toContain('DELETE /volumes/melete-mcp-conn_gone-pkg');
    expect(engine.calls).not.toContain('DELETE /volumes/melete-mcp-conn_kept-data');
    expect(engine.calls).not.toContain('DELETE /volumes/someone-else');
  });
});

describe('what runs in a server container', () => {
  test('each package runner runs what it prepared, from the read-only package volume', () => {
    const launch = (value: Record<string, unknown>) => mcpStdioLaunch.parse(value);
    const npm = stdioCommands(
      launch({ runner: 'npx', source: '@scope/pkg@1.0.0', command: 'pkg-server', args: ['a'] }),
    );
    expect(npm.prepare?.entrypoint?.at(-1)).toBe('@scope/pkg@1.0.0');
    expect(npm.run.entrypoint?.slice(3)).toEqual(['@scope/pkg', 'pkg-server']);
    expect(npm.run.argv).toEqual(['a']);
    expect(npmName('@scope/pkg@1.0.0')).toBe('@scope/pkg');
    expect(npmName('pkg@^2')).toBe('pkg');
    expect(npmName('pkg')).toBe('pkg');
    expect(stdioCommands(launch({ runner: 'uvx', source: 'mcp-server-fetch@2026.1.1' }))).toEqual({
      prepare: {
        image: DEFAULT_STDIO_IMAGES.python,
        entrypoint: ['uv', 'tool', 'install', '--force', 'mcp-server-fetch==2026.1.1'],
      },
      run: {
        image: DEFAULT_STDIO_IMAGES.python,
        entrypoint: ['/pkg/uv/bin/mcp-server-fetch'],
        argv: [],
      },
    });
    expect(stdioCommands(launch({ runner: 'image', source: IMAGE, command: 'serve' }))).toEqual({
      run: { image: IMAGE, entrypoint: ['serve'] },
    });
  });

  test('stdout frames are reassembled across reads and stderr is dropped', () => {
    const out: string[] = [];
    const demuxer = new DockerStreamDemuxer((bytes) => out.push(bytes.toString()));
    const stream = Buffer.concat([frame(1, 'hello '), frame(2, 'noise'), frame(1, 'world\n')]);
    for (let index = 0; index < stream.length; index += 3)
      demuxer.push(stream.subarray(index, index + 3));
    expect(out.join('')).toBe('hello world\n');
    expect(() => demuxer.push(Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 65]))).toThrow('invalid');
  });

  test('the volume directories are a valid archive owned by the server user', () => {
    const tar = Buffer.from(ownedDirectories(['./', 'home/']));
    expect(tar.length).toBe(512 * 4);
    const header = tar.subarray(512, 1024);
    expect(header.subarray(0, 5).toString()).toBe('home/');
    expect(header.subarray(108, 115).toString()).toBe('0023421');
    expect(String.fromCharCode(header[156] ?? 0)).toBe('5');
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
    expect(Number.parseInt(header.subarray(148, 154).toString(), 8)).toBe(sum);
    expect(() => ownedDirectories(['../etc/'])).toThrow();
    expect(() => ownedDirectories(['/etc/'])).toThrow();
  });
});
