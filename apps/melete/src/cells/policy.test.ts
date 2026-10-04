import { describe, expect, test } from 'bun:test';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import {
  DEFAULT_STDIO_IMAGES,
  STDIO_LIMITS,
  stdioContainerBody,
} from '../connectors/mcp-stdio-docker.ts';
import { LocalCellHost } from '../runtime/cell-host-local.ts';
import { DockerError } from '../runtime/docker.ts';
import { DockerSandboxHost } from '../sandbox/adapters/docker.ts';
import { type CellsLookup, type CellsPolicyConfig, judge, redactContainer } from './policy.ts';

const PROJECT = 'melete';
const SANDBOX_PROJECT = 'melete-ab12cd34';
const RUNTIME_ID = `sha256:${'a'.repeat(64)}`;
const SANDBOX_ID = `sha256:${'b'.repeat(64)}`;
const SERVER_ID = `sha256:${'c'.repeat(64)}`;
const LOCAL_ID = `sha256:${'d'.repeat(64)}`;

const config: CellsPolicyConfig = {
  project: PROJECT,
  sandboxProject: SANDBOX_PROJECT,
  runtimeImage: 'melete-runtime:local',
  sandboxImage: 'melete-sandbox:local',
  mcpImages: [DEFAULT_STDIO_IMAGES.node, DEFAULT_STDIO_IMAGES.python],
  workVolume: `${PROJECT}_work`,
};

type Labels = Record<string, string>;

/**
 * A small engine: what exists, judged by the policy before every call, so the
 * real clients' requests are what is tested.
 */
class Engine {
  containers = new Map<string, { Id: string; Name: string; Labels: Labels; Running: boolean }>();
  networks = new Map<string, { Id: string; Name: string; Internal: boolean; Labels: Labels }>();
  volumes = new Map<string, { Name: string; Labels: Labels }>();
  images = new Map<string, { Id: string; RepoDigests: string[]; Config: { Labels: Labels } }>();
  execs = new Map<string, { ContainerID: string }>();
  refused: string[] = [];

  constructor() {
    const runtime = {
      Id: RUNTIME_ID,
      RepoDigests: [],
      Config: {
        Labels: {
          'com.melete.hermes.commit': HERMES_PINNED_COMMIT,
          'com.melete.plugin.sha256': 'e'.repeat(64),
        },
      },
    };
    this.images.set('melete-runtime:local', runtime).set(RUNTIME_ID, runtime);
    const sandbox = { Id: SANDBOX_ID, RepoDigests: [], Config: { Labels: {} } };
    this.images.set('melete-sandbox:local', sandbox).set(SANDBOX_ID, sandbox);
    const server = {
      Id: SERVER_ID,
      RepoDigests: [`ghcr.io/example/server@sha256:${'f'.repeat(64)}`],
      Config: { Labels: {} },
    };
    this.images.set(SERVER_ID, server);
    this.images.set(LOCAL_ID, { Id: LOCAL_ID, RepoDigests: [], Config: { Labels: {} } });
    this.containers.set('self', {
      Id: 'self',
      Name: '/melete-melete-1',
      Labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'melete' },
      Running: true,
    });
    this.containers.set('postgres', {
      Id: 'postgres',
      Name: '/melete-postgres-1',
      Labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'postgres' },
      Running: true,
    });
    this.networks.set('melete_edge', {
      Id: 'melete_edge',
      Name: 'melete_edge',
      Internal: false,
      Labels: { 'com.docker.compose.project': PROJECT },
    });
  }

  lookup: CellsLookup = {
    container: async (id) => {
      const found = this.containers.get(id);
      return found ? { Id: found.Id, Name: found.Name, Config: { Labels: found.Labels } } : null;
    },
    network: async (id) => this.networks.get(id) ?? null,
    volume: async (name) => this.volumes.get(name) ?? null,
    image: async (reference) => this.images.get(reference) ?? null,
    exec: async (id) => this.execs.get(id) ?? null,
  };

  async ask(method: string, target: string, body?: unknown) {
    const url = new URL(target, 'http://engine');
    return judge(
      { method, path: url.pathname, query: url.searchParams, body },
      config,
      this.lookup,
    );
  }

  /** A Docker client seam that is judged first, then served from the maps. */
  api = {
    request: async (method: 'GET' | 'POST' | 'DELETE', target: string, body?: unknown) => {
      const verdict = await this.ask(method, target, body);
      if (!verdict.allow) {
        this.refused.push(`${method} ${target}: ${verdict.reason}`);
        throw new DockerError(verdict.status, method, target);
      }
      return this.serve(method, target, body);
    },
    startExec: async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    putArchive: async () => {},
  };

  private serve(method: string, target: string, body: unknown): unknown {
    const url = new URL(target, 'http://engine');
    const parts = url.pathname.split('/').slice(1);
    const value = body as Record<string, unknown>;
    if (url.pathname === '/version') return { ApiVersion: '1.48' };
    if (url.pathname === '/volumes/create') {
      const volume = { Name: String(value.Name), Labels: value.Labels as Labels };
      this.volumes.set(volume.Name, volume);
      return volume;
    }
    if (url.pathname === '/networks/create') {
      const network = {
        Id: String(value.Name),
        Name: String(value.Name),
        Internal: value.Internal === true,
        Labels: value.Labels as Labels,
      };
      this.networks.set(network.Id, network);
      return { Id: network.Id };
    }
    if (url.pathname === '/containers/create') {
      const name = url.searchParams.get('name') ?? '';
      this.containers.set(name, {
        Id: name,
        Name: `/${name}`,
        Labels: value.Labels as Labels,
        Running: false,
      });
      return { Id: name };
    }
    if (parts[0] === 'containers' && parts[2] === 'start') {
      const found = this.containers.get(parts[1] ?? '');
      if (found) found.Running = true;
      return null;
    }
    if (parts[0] === 'containers' && parts[2] === 'json') {
      const found = this.containers.get(parts[1] ?? '');
      if (!found) throw new DockerError(404, 'GET', target);
      return {
        Id: found.Id,
        Config: { Labels: found.Labels, Env: ['SECRET=1'] },
        State: { Running: found.Running, Status: found.Running ? 'running' : 'created' },
        NetworkSettings: {
          Networks: Object.fromEntries(
            [...this.networks.values()]
              .filter((network) => network.Name === `${found.Id}-net`)
              .map((network) => [network.Name, { IPAddress: '172.30.0.2' }]),
          ),
        },
      };
    }
    if (parts[0] === 'images' && parts[2] === 'json')
      return this.images.get(decodeURIComponent(parts[1] ?? ''));
    if (parts[0] === 'networks' && parts.length === 2 && method === 'GET')
      return { ...this.networks.get(parts[1] ?? ''), Containers: {} };
    return null;
  }
}

const runtimeLabels = (attempt: string): Labels => ({
  'com.melete.attempt-supervisor': 'v1',
  'com.melete.project': PROJECT,
  'com.melete.attempt': attempt,
  'com.melete.job': 'job_01J00000000000000000000000',
});

/** What an attempt cell asks for, as the runtime supervisor builds it. */
function attemptBody(name: string, overrides: Record<string, unknown> = {}, host: object = {}) {
  return {
    Image: RUNTIME_ID,
    User: '10001:10001',
    WorkingDir: '/work',
    Labels: runtimeLabels('att_01j00000000000000000000000'),
    Env: ['A=1'],
    HostConfig: {
      NetworkMode: `${name}-net`,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 256,
      Memory: 2 * 1024 ** 3,
      Tmpfs: { '/tmp': 'size=64m,mode=1777' },
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: {} },
      Mounts: [
        {
          Type: 'volume',
          Source: `${PROJECT}_work`,
          Target: '/work',
          VolumeOptions: { Subpath: 'job_01J00000000000000000000000', NoCopy: true },
        },
        { Type: 'volume', Source: `${name}-home`, Target: '/var/lib/hermes' },
      ],
      ...host,
    },
    NetworkingConfig: { EndpointsConfig: { [`${name}-net`]: {} } },
    ...overrides,
  };
}

const ATTEMPT = `${PROJECT}-att_01j00000000000000000000000`;

async function engineWithAttemptNetwork() {
  const engine = new Engine();
  engine.networks.set(`${ATTEMPT}-net`, {
    Id: `${ATTEMPT}-net`,
    Name: `${ATTEMPT}-net`,
    Internal: true,
    Labels: runtimeLabels('att_01j00000000000000000000000'),
  });
  return engine;
}

describe('melete-cells accepts the fixed profiles the service uses', () => {
  test('the runtime supervisor provisions and starts an attempt cell through it', async () => {
    const engine = new Engine();
    const host = new LocalCellHost({
      project: PROJECT,
      image: 'melete-runtime:local',
      workRoot: '/nonexistent',
      workVolume: `${PROJECT}_work`,
      selfId: 'self',
      docker: engine.api,
    });
    await host.verify();
    await host.reconcile('start').catch(() => {});
    const cell = host.cell({
      cell: { attempt: 'att_01J00000000000000000000000', job: 'job_01J00000000000000000000000' },
      environment: ['A=1'],
    } as never);
    // The workspace directory is the service's own filesystem, not the engine's.
    const provision = host as unknown as {
      provisionCell: (r: object, l: Labels, s: AbortSignal) => Promise<void>;
      startContainer: (
        r: object,
        l: Labels,
        e: string[],
        w: string,
        s: AbortSignal,
      ) => Promise<string>;
    };
    const resources = { container: ATTEMPT, network: `${ATTEMPT}-net`, home: `${ATTEMPT}-home` };
    const labels = runtimeLabels('att_01J00000000000000000000000');
    await provision.provisionCell(resources, labels, new AbortController().signal);
    const address = await provision.startContainer(
      resources,
      labels,
      ['A=1'],
      'job_01J00000000000000000000000',
      new AbortController().signal,
    );
    expect(address).toBe('http://172.30.0.2:8790');
    expect(engine.refused).toEqual([]);
    expect(cell).toBeDefined();
  });

  test("an agent's computer is created with and without its network", async () => {
    for (const egress of ['deny_all', 'open'] as const) {
      const engine = new Engine();
      const sandbox = new DockerSandboxHost(
        {
          socket: '/unused.sock',
          project: SANDBOX_PROJECT,
          cpus: 1,
          memoryMb: 2048,
          pids: 512,
          diskMb: 4096,
          idleSeconds: 600,
          egressPort: 8789,
          selfId: 'self',
        },
        engine.api,
      );
      // Only the create is under test; the guard's listener is not.
      (sandbox as unknown as { grantEgress: () => Promise<void> }).grantEgress = async () => {};
      await sandbox.create(
        {
          image: 'melete-sandbox:local',
          egress: egress === 'open' ? { kind: 'open' } : { kind: 'deny_all' },
          region: null,
          lifetimeSeconds: 3600,
          idleSeconds: null,
          workdir: '/work',
          labels: {
            'melete.owner': 'v1',
            'melete.project': SANDBOX_PROJECT,
            'melete.session': 'sbs_01J00000000000000000000000',
          },
          env: {},
        } as never,
        new AbortController().signal,
      );
      expect(engine.refused).toEqual([]);
    }
  });

  test('a stdio MCP server and its preparation are created', async () => {
    const engine = new Engine();
    const labels = {
      'com.melete.mcp-launcher': 'v1',
      'com.melete.project': PROJECT,
      'com.melete.connection': 'conn_01J00000000000000000000000',
    };
    engine.networks.set(`${PROJECT}-mcp-conn_01j00000000000000000000000-net`, {
      Id: 'n',
      Name: `${PROJECT}-mcp-conn_01j00000000000000000000000-net`,
      Internal: true,
      Labels: labels,
    });
    for (const network of [undefined, `${PROJECT}-mcp-conn_01j00000000000000000000000-net`]) {
      const verdict = await engine.ask(
        'POST',
        `/containers/create?name=${PROJECT}-mcp-conn_01j00000000000000000000000${network ? '-prepare' : ''}`,
        stdioContainerBody({
          image: SERVER_ID,
          command: { image: SERVER_ID, argv: ['server'] },
          labels,
          mounts: [
            {
              volume: `${PROJECT}-mcp-conn_01j00000000000000000000000-data`,
              target: '/data',
              readOnly: false,
            },
          ],
          ...(network ? { network } : {}),
          env: ['A=1'],
          interactive: !network,
          tmpfs: STDIO_LIMITS.tmpfs,
          workdir: '/data',
        }),
      );
      expect(verdict).toEqual({ allow: true });
    }
  });

  test('the configured runner images and digest-pinned images may be pulled', async () => {
    const engine = new Engine();
    for (const reference of [
      DEFAULT_STDIO_IMAGES.node,
      `ghcr.io/example/server:1.0@sha256:${'1'.repeat(64)}`,
    ])
      expect(
        (await engine.ask('POST', `/images/create?fromImage=${encodeURIComponent(reference)}`))
          .allow,
      ).toBe(true);
  });
});

describe('melete-cells refuses a container outside its profiles', () => {
  const refusals: Array<[string, (name: string) => object]> = [
    ['privileged mode', (name) => attemptBody(name, {}, { Privileged: true })],
    ['a host path mounted', (name) => attemptBody(name, {}, { Binds: ['/:/host'] })],
    [
      'a bind mount',
      (name) =>
        attemptBody(
          name,
          {},
          {
            Mounts: [
              { Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' },
            ],
          },
        ),
    ],
    [
      'host networking',
      (name) => attemptBody(name, { NetworkingConfig: undefined }, { NetworkMode: 'host' }),
    ],
    ['another network', (name) => attemptBody(name, {}, { NetworkMode: 'melete_edge' })],
    ['an added capability', (name) => attemptBody(name, {}, { CapAdd: ['SYS_ADMIN'] })],
    ['a device', (name) => attemptBody(name, {}, { Devices: [{ PathOnHost: '/dev/kmsg' }] })],
    ['the host PID namespace', (name) => attemptBody(name, {}, { PidMode: 'host' })],
    [
      'an unconfined seccomp profile',
      (name) =>
        attemptBody(name, {}, { SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }),
    ],
    ['a writable root', (name) => attemptBody(name, {}, { ReadonlyRootfs: false })],
    ['root', (name) => attemptBody(name, { User: '0:0' })],
    ['an arbitrary image', (name) => attemptBody(name, { Image: LOCAL_ID })],
    ['a command of its own', (name) => attemptBody(name, { Cmd: ['sh', '-c', 'id'] })],
    ['no profile labels', (name) => attemptBody(name, { Labels: { owner: 'someone' } })],
    [
      'the whole workspace volume',
      (name) =>
        attemptBody(
          name,
          {},
          {
            Mounts: [{ Type: 'volume', Source: `${PROJECT}_work`, Target: '/work' }],
          },
        ),
    ],
    [
      "the database's volume",
      (name) =>
        attemptBody(
          name,
          {},
          {
            Mounts: [{ Type: 'volume', Source: `${PROJECT}_pgdata`, Target: '/var/lib/hermes' }],
          },
        ),
    ],
  ];
  for (const [what, body] of refusals)
    test(`refuses ${what}`, async () => {
      const engine = await engineWithAttemptNetwork();
      // The unchanged request is accepted, so each refusal is the one change's.
      expect(
        (await engine.ask('POST', `/containers/create?name=${ATTEMPT}`, attemptBody(ATTEMPT)))
          .allow,
      ).toBe(true);
      const verdict = await engine.ask('POST', `/containers/create?name=${ATTEMPT}`, body(ATTEMPT));
      expect(verdict.allow).toBe(false);
    });

  test('refuses an MCP server image built on this host', async () => {
    const engine = new Engine();
    const labels = {
      'com.melete.mcp-launcher': 'v1',
      'com.melete.project': PROJECT,
      'com.melete.connection': 'conn_01J00000000000000000000000',
    };
    const verdict = await engine.ask(
      'POST',
      `/containers/create?name=${PROJECT}-mcp-conn_01j00000000000000000000000`,
      stdioContainerBody({
        image: LOCAL_ID,
        command: { image: LOCAL_ID },
        labels,
        mounts: [],
        env: [],
        interactive: true,
        workdir: '/data',
      }),
    );
    expect(verdict.allow).toBe(false);
  });

  test('refuses a volume with a driver option, which could name any host path', async () => {
    const engine = new Engine();
    const verdict = await engine.ask('POST', '/volumes/create', {
      Name: `${ATTEMPT}-home`,
      Labels: runtimeLabels('att_01j00000000000000000000000'),
      DriverOpts: { type: 'none', o: 'bind', device: '/' },
    });
    expect(verdict.allow).toBe(false);
  });

  test('refuses a network with a route out', async () => {
    const engine = new Engine();
    const verdict = await engine.ask('POST', '/networks/create', {
      Name: `${ATTEMPT}-net`,
      Driver: 'bridge',
      Internal: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Labels: runtimeLabels('att_01j00000000000000000000000'),
    });
    expect(verdict.allow).toBe(false);
  });

  test("refuses to act on containers outside the profiles, such as the database's", async () => {
    const engine = new Engine();
    for (const [method, target, body] of [
      ['DELETE', '/containers/postgres?force=1', undefined],
      ['POST', '/containers/postgres/stop', undefined],
      ['POST', '/containers/postgres/exec', { Cmd: ['psql'] }],
      ['PUT', '/containers/postgres/archive?path=/', undefined],
      ['POST', '/containers/self/exec', { Cmd: ['sh'] }],
    ] as const)
      expect((await engine.ask(method, target, body)).allow).toBe(false);
  });

  test("joins only the service to a cell's network, and only under its alias", async () => {
    const engine = await engineWithAttemptNetwork();
    const network = `/networks/${ATTEMPT}-net/connect`;
    expect(
      (
        await engine.ask('POST', network, {
          Container: 'self',
          EndpointConfig: { Aliases: ['melete'] },
        })
      ).allow,
    ).toBe(true);
    expect(
      (
        await engine.ask('POST', network, {
          Container: 'postgres',
          EndpointConfig: { Aliases: ['melete'] },
        })
      ).allow,
    ).toBe(false);
    expect(
      (
        await engine.ask('POST', network, {
          Container: 'self',
          EndpointConfig: { Aliases: ['postgres'] },
        })
      ).allow,
    ).toBe(false);
    expect(
      (await engine.ask('POST', '/networks/melete_edge/connect', { Container: 'self' })).allow,
    ).toBe(false);
  });

  test('refuses engine calls outside the list, and pulls by tag alone', async () => {
    const engine = new Engine();
    for (const [method, target] of [
      ['POST', '/build'],
      ['POST', '/swarm/init'],
      ['GET', '/containers/json?all=1'],
      ['POST', '/images/create?fromImage=alpine:latest'],
      ['POST', `/images/create?fromImage=10.0.0.1:5000/x@sha256:${'1'.repeat(64)}`],
      ['POST', '/images/create?fromSrc=http://example.com/root.tar'],
      ['POST', '/containers/..%2f..%2fversion/start'],
      ['DELETE', '/images/melete-runtime:local'],
    ] as const)
      expect((await engine.ask(method, target)).allow).toBe(false);
  });

  test("a container's inspection is passed back without its environment", () => {
    expect(
      redactContainer({ Id: 'x', Args: ['--password=x'], Config: { Env: ['A=1'], Labels: {} } }),
    ).toEqual({ Id: 'x', Config: { Labels: {} } });
  });
});
