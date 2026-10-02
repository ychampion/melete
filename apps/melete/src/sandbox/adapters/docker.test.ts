/**
 * The docker adapter against an engine held in memory: what it asks the engine
 * to create, how it runs and reads back commands, files and the desktop, and
 * how it stops, resumes and clears away its sandboxes. The same adapter runs
 * against a real engine in docker.live.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sandboxLabels } from '../manifest.ts';
import {
  type EgressPolicy,
  SandboxAdapterRefusal,
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import {
  DOCKER_SANDBOX_DEFAULTS,
  DOCKER_SANDBOX_UID,
  DockerSandboxHost,
  type DockerSandboxSettings,
  EGRESS_ALIAS,
  ExecCapture,
  isDesktopProvider,
  OVER_ALLOWANCE_FILE_BLOCKS,
} from './docker.ts';
import { SandboxEgressGuard } from './docker-egress.ts';
import { type ExecAnswer, FakeDocker, readTar } from './docker-fixtures.ts';

// biome-ignore lint/suspicious/noExplicitAny: engine request bodies are asserted field by field.
type EngineBody = Record<string, any>;
const signal = () => AbortSignal.timeout(10_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const SELF = 'a1b2c3d4e5f6';

function setup(
  options: { settings?: Partial<DockerSandboxSettings>; open?: boolean; start?: number } = {},
) {
  const engine = new FakeDocker();
  engine.images.add('melete-sandbox:local');
  let now = options.start ?? 1_000_000;
  const guard = new SandboxEgressGuard();
  // The guard is never asked to listen in these tests; granting is what is checked.
  guard.listen = async () => 0;
  const host = new DockerSandboxHost(
    {
      socket: '/var/run/docker.sock',
      project: 'proj',
      ...DOCKER_SANDBOX_DEFAULTS,
      ...(options.open ? { selfId: SELF } : {}),
      ...options.settings,
    },
    engine,
    { guard, now: () => now },
  );
  return {
    engine,
    host,
    guard,
    advance(ms: number) {
      now += ms;
    },
  };
}

function spec(
  session = 'sbx_one',
  egress: EgressPolicy = { kind: 'deny_all' },
  extra: Partial<SandboxSpec> = {},
): SandboxSpec {
  return {
    image: 'melete-sandbox:local',
    egress,
    region: null,
    lifetimeSeconds: 3_600,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({
      project: 'proj',
      connection: 'conn_one',
      space: 'sp_one',
      job: 'job_one',
      attempt: 'att_one',
      session,
    }),
    env: { LANG: 'C.UTF-8' },
    ...extra,
  };
}

const NAME = 'melete-sbx-proj-sbx_one';
const handleOf = (providerSandboxId: string): SandboxHandle => ({
  providerSandboxId,
  imageDigest: null,
  region: null,
});

/** Answers the adapter's own disk check, and the test's command with `answer`. */
function commands(engine: FakeDocker, answer: (argv: string[]) => ExecAnswer, usedKb = 12) {
  engine.onExec = (cmd) => {
    if (cmd[0] === '/bin/sh' && cmd[2]?.startsWith('exec du '))
      return { stdout: `${usedKb}\t/work\n` };
    return answer(cmd);
  };
}

describe('creating a sandbox', () => {
  test('a container is hardened, limited and holds only its own two volumes', async () => {
    const { engine, host } = setup({
      settings: { cpus: 1.5, memoryMb: 1024, pids: 300, diskMb: 2048 },
    });
    const handle = await host.create(spec(), signal());
    expect(handle.providerSandboxId).toBe(NAME);
    expect(handle.imageDigest).toBe('sha256:image');
    const container = engine.containers.get(NAME);
    expect(container?.running).toBe(true);
    const body = container?.body as EngineBody;
    expect(body.User).toBe(`${DOCKER_SANDBOX_UID}:${DOCKER_SANDBOX_UID}`);
    expect(body.NetworkDisabled).toBe(true);
    expect(body.Env).not.toContainEqual(expect.stringMatching(/PROXY=/i));
    const hostConfig = body.HostConfig;
    expect(hostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Init: true,
      PidsLimit: 300,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      RestartPolicy: { Name: 'no' },
      Ulimits: [
        { Name: 'fsize', Soft: 2048 * 1024 * 1024, Hard: 2048 * 1024 * 1024 },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
    });
    // Nothing from the host: no bind, no device, no socket.
    expect(hostConfig.Binds).toBeUndefined();
    expect(hostConfig.Devices).toBeUndefined();
    expect(hostConfig.CapAdd).toBeUndefined();
    expect(hostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `${NAME}-work`, Target: '/work' },
      { Type: 'volume', Source: `${NAME}-home`, Target: '/home/agent' },
    ]);
    expect(hostConfig.LogConfig.Config['max-size']).toBe('1m');
    expect([...engine.volumes.keys()].sort()).toEqual([`${NAME}-home`, `${NAME}-work`]);
    expect(engine.networks.size).toBe(0);
    // Every resource carries the labels reconciliation judges by.
    for (const labels of [container?.labels, ...engine.volumes.values()])
      expect(labels).toMatchObject({
        'melete.owner': 'v1',
        'melete.project': 'proj',
        'melete.connection': 'conn_one',
        'melete.session': 'sbx_one',
        'com.melete.sandbox.name': NAME,
      });
  });

  test('open egress is an internal network whose only way out is the service', async () => {
    const { engine, host, guard } = setup({ open: true });
    await host.create(spec('sbx_one', { kind: 'open' }), signal());
    const network = engine.networks.get(`${NAME}-net`);
    const create = engine.calls.find((call) => call.path === '/networks/create')
      ?.body as EngineBody;
    expect(create).toMatchObject({
      Internal: true,
      Options: {
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
      },
    });
    expect([...(network?.members ?? [])]).toEqual([SELF]);
    const connect = engine.calls.find((call) => call.path.endsWith('/connect'))?.body as EngineBody;
    expect(connect.EndpointConfig.Aliases).toEqual([EGRESS_ALIAS]);
    const body = engine.containers.get(NAME)?.body as EngineBody;
    expect(body.HostConfig.NetworkMode).toBe(`${NAME}-net`);
    expect(body.NetworkDisabled).toBe(false);
    expect(body.Env).toContain(`HTTPS_PROXY=http://${EGRESS_ALIAS}:8791`);
    // The guard admits this container's address and no other.
    const address = engine.containers.get(NAME)?.networks[`${NAME}-net`] ?? '';
    expect(guard.granted(NAME)).toEqual([address]);
  });

  test('open egress is refused when the service cannot be the way out', async () => {
    const { engine, host } = setup();
    await expect(host.create(spec('sbx_one', { kind: 'open' }), signal())).rejects.toBeInstanceOf(
      SandboxAdapterRefusal,
    );
    expect(engine.volumes.size).toBe(0);
  });

  test('an allow-list of ranges is refused rather than widened', async () => {
    const { host } = setup({ open: true });
    await expect(
      host.create(spec('sbx_one', { kind: 'cidr_allowlist', cidrs: ['1.1.1.1/32'] }), signal()),
    ).rejects.toThrow('cannot enforce cidr_allowlist');
    expect(host.capabilities.egress).toEqual(['deny_all', 'open']);
  });

  test('a missing image says how to build it, before anything is made', async () => {
    const { engine, host } = setup();
    await expect(
      host.create(spec('sbx_one', { kind: 'deny_all' }, { image: 'nope:local' }), signal()),
    ).rejects.toThrow(/not on this Docker engine; build it first/);
    expect(engine.volumes.size + engine.containers.size).toBe(0);
  });

  test('a container the engine refuses leaves no volume or network behind', async () => {
    const { engine, host } = setup({ open: true });
    engine.failNext = { match: /^POST \/containers\/create/, status: 500 };
    await expect(host.create(spec('sbx_one', { kind: 'open' }), signal())).rejects.toThrow(
      'the sandbox could not be created',
    );
    expect(engine.volumes.size).toBe(0);
    expect(engine.networks.size).toBe(0);
    expect(engine.containers.size).toBe(0);
  });

  test('names are the adapter own, and nothing else is ever sent to the engine', async () => {
    expect(DockerSandboxHost.nameFor('Proj', 'SBX/One two')).toBe('melete-sbx-proj-sbx-one-two');
    const { engine, host } = setup();
    const before = engine.calls.length;
    for (const foreign of ['postgres', 'melete-other', '../melete-sbx-x', 'melete-sbx-'])
      await expect(
        host.exec(
          handleOf(foreign),
          {
            marker: 'act_1',
            argv: ['true'],
            cwd: '/work',
            timeoutMs: 1000,
            maxOutputBytes: 100,
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(SandboxAdapterRefusal);
    expect(engine.calls.length).toBe(before);
    expect(await host.inspect(handleOf('postgres'), signal())).toBe('gone');
    expect(engine.calls.at(-1)?.path).toBe('/version');
  });
});

describe('running a command', () => {
  const exec = (
    host: DockerSandboxHost,
    extra: Partial<Parameters<DockerSandboxHost['exec']>[1]> = {},
  ) =>
    host.exec(
      handleOf(NAME),
      {
        marker: 'act_1',
        argv: ['sh', '-c', 'echo hi'],
        cwd: '/work',
        timeoutMs: 5_000,
        maxOutputBytes: 64,
        ...extra,
      },
      signal(),
    );

  test('the command runs under a hard kill in its directory, and both streams come back', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    let seen: string[] = [];
    commands(engine, (argv) => {
      seen = argv;
      return { stdout: 'out-', stderr: 'err', exitCode: 3, chunk: 3 };
    });
    const outcome = await exec(host);
    expect(seen).toEqual([
      '/bin/sh',
      '-c',
      'cd "$1" 2>/dev/null || exit 112; if [ "$2" != keep ]; then ulimit -f "$2" 2>/dev/null || exit 112; fi; shift 2; exec "$@"',
      'melete-launch',
      '/work',
      'keep',
      'timeout',
      '-s',
      'KILL',
      '5',
      'sh',
      '-c',
      'echo hi',
    ]);
    expect(outcome).toMatchObject({
      started: 'yes',
      state: 'exited',
      exitCode: 3,
      timedOut: false,
      captureLimited: false,
      totalBytes: 7,
    });
    expect(text(outcome.output)).toBe('out-err');
  });

  test("a command's own environment is set on its exec only, never in its words", async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    commands(engine, () => ({ stdout: 'ok', exitCode: 0 }));
    await exec(host, { env: { TZ: 'Europe/Paris', GH_PROMPT_DISABLED: '1' } });
    await exec(host, { marker: 'act_2' });
    const launched = engine.calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.path.endsWith('/exec') &&
        (call.body as EngineBody)?.Cmd?.[3] === 'melete-launch',
    );
    expect(launched).toHaveLength(2);
    const [first, second] = launched.map((call) => call.body as EngineBody);
    expect(first?.Env).toEqual(['TZ=Europe/Paris', 'GH_PROMPT_DISABLED=1']);
    expect(JSON.stringify(first?.Cmd)).not.toContain('Europe/Paris');
    expect(second).not.toHaveProperty('Env');
  });

  test('markers are kept on the home volume, which an idle stop keeps', () => {
    const { host } = setup();
    expect(host.capabilities.markerRoot).toBe('/home/agent/.melete/exec');
  });

  test('output above the cap is cut and says so', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    commands(engine, () => ({ stdout: 'x'.repeat(100), chunk: 7 }));
    const outcome = await exec(host, { maxOutputBytes: 10 });
    expect(outcome.output.byteLength).toBe(10);
    expect(outcome.totalBytes).toBe(100);
    expect(outcome.captureLimited).toBe(true);
  });

  test('a kill at the deadline is a timeout; an unreported exit is lost', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    commands(engine, () => ({ exitCode: 137 }));
    expect(await exec(host, { timeoutMs: 40 })).toMatchObject({
      state: 'killed',
      timedOut: true,
      signal: 'SIGKILL',
      exitCode: null,
    });
    // The same exit well before the deadline is the command's own.
    expect(await exec(host, { timeoutMs: 60_000 })).toMatchObject({
      state: 'exited',
      timedOut: false,
      exitCode: 137,
    });
    commands(engine, () => ({ exitCode: null }));
    expect(await exec(host)).toMatchObject({ state: 'lost', exitCode: null });
  });

  test('how far a failed command got decides what is reported', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    commands(engine, () => ({}));
    await exec(host); // the disk check is now cached, so the next failure is the command's own
    engine.failNext = { match: /^POST \/containers\/[^/]+\/exec$/, status: 500 };
    await expect(exec(host)).rejects.toBeInstanceOf(SandboxStartRefused);
    commands(engine, () => ({ failStart: true }));
    const lost = await exec(host).catch((error) => error);
    expect(lost).toBeInstanceOf(SandboxTransportError);
    expect(lost.started).toBe('unknown');
    commands(engine, () => ({ stdout: 'partial output', breakAfter: 12 }));
    const broken = await exec(host).catch((error) => error);
    expect(broken).toBeInstanceOf(SandboxTransportError);
    expect(broken.started).toBe('yes');
  });

  test('a stopped container starts again for the command: the automatic resume', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const container = engine.containers.get(NAME);
    if (container) container.running = false;
    commands(engine, () => ({ stdout: 'back' }));
    expect(text((await exec(host)).output)).toBe('back');
    expect(container?.running).toBe(true);
  });

  test('past the disk allowance a command may remove files but grow none', async () => {
    const { engine, host, advance } = setup({ settings: { diskMb: 256 } });
    await host.create(spec(), signal());
    const limits: string[] = [];
    const record = (argv: string[]) => {
      limits.push(argv[5] ?? '');
      return {};
    };
    commands(engine, record, 300 * 1024);
    await exec(host);
    expect(limits).toEqual([String(OVER_ALLOWANCE_FILE_BLOCKS)]);
    expect(OVER_ALLOWANCE_FILE_BLOCKS * 512).toBe(2 * 1024 * 1024);
    // The figure is kept for a while, then measured again.
    commands(engine, record, 10);
    await exec(host);
    advance(21_000);
    await exec(host);
    expect(limits).toEqual([
      String(OVER_ALLOWANCE_FILE_BLOCKS),
      String(OVER_ALLOWANCE_FILE_BLOCKS),
      'keep',
    ]);
  });

  test('what the adapter cannot run as asked is refused before the engine is called', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const before = engine.calls.length;
    await expect(exec(host, { cwd: 'work' })).rejects.toBeInstanceOf(SandboxAdapterRefusal);
    await expect(exec(host, { timeoutMs: 0 })).rejects.toBeInstanceOf(SandboxAdapterRefusal);
    await expect(exec(host, { stdin: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      SandboxAdapterRefusal,
    );
    expect(engine.calls.length).toBe(before);
  });
});

describe('files', () => {
  test('uploads are archives owned by the sandbox user, parents first', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const long = `${'deep/'.repeat(30)}file.txt`;
    async function* files() {
      yield { path: '/work/a/b/run.sh', bytes: new TextEncoder().encode('echo'), mode: 0o755 };
      yield { path: '/work/a/notes.md', bytes: new TextEncoder().encode('# hi'), mode: 0o600 };
      yield { path: `/work/${long}`, bytes: new TextEncoder().encode('long'), mode: 0o644 };
      yield { path: '/home/agent/.bashrc', bytes: new TextEncoder().encode('x=1'), mode: 0o644 };
    }
    await host.putFiles(handleOf(NAME), files(), signal());
    expect(engine.archives.map((archive) => archive.path)).toEqual(['/work', '/home/agent']);
    const work = readTar(engine.archives[0]?.tar ?? new Uint8Array());
    expect(work.slice(0, 4).map((entry) => [entry.name, entry.type, entry.mode])).toEqual([
      ['a/', '5', 0o755],
      ['a/b/', '5', 0o755],
      ['a/b/run.sh', '0', 0o755],
      ['a/notes.md', '0', 0o644],
    ]);
    expect(
      work.every((entry) => entry.uid === DOCKER_SANDBOX_UID && entry.gid === DOCKER_SANDBOX_UID),
    ).toBe(true);
    const longEntry = work.find((entry) => entry.name === long);
    expect(text(longEntry?.bytes ?? new Uint8Array())).toBe('long');
    expect(readTar(engine.archives[1]?.tar ?? new Uint8Array()).map((entry) => entry.name)).toEqual(
      ['.bashrc'],
    );
  });

  test('an upload outside /work and the home directory, or through .., is refused', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    for (const path of [
      '/etc/passwd',
      '/work/../etc/x',
      '/work/',
      '/workshop/x',
      '/home/agent/./x',
    ])
      await expect(
        host.putFiles(
          handleOf(NAME),
          (async function* () {
            yield { path, bytes: new Uint8Array([1]), mode: 0o644 };
          })(),
          signal(),
        ),
      ).rejects.toBeInstanceOf(SandboxAdapterRefusal);
    expect(engine.archives).toEqual([]);
  });

  test('a listing is read record by record; a missing directory and odd entries are said so', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    engine.onExec = (cmd) => {
      expect(cmd.slice(-1)).toEqual(['/work']);
      return { stdout: 'd 4096 755 src\0f 12 644 src/a b.txt\0l 7 777 link\0', chunk: 9 };
    };
    expect(await host.listFiles(handleOf(NAME), '/work/', signal())).toEqual([
      { path: 'src', size: 0, mode: 0o755, symlink: false, directory: true },
      { path: 'src/a b.txt', size: 12, mode: 0o644, symlink: false, directory: false },
      { path: 'link', size: 0, mode: 0o777, symlink: true, directory: false },
    ]);
    engine.onExec = () => ({ exitCode: 3 });
    await expect(host.listFiles(handleOf(NAME), '/work/gone', signal())).rejects.toBeInstanceOf(
      SandboxFileNotFound,
    );
    engine.onExec = () => ({ stdout: 'p 0 644 fifo\0' });
    await expect(host.listFiles(handleOf(NAME), '/work', signal())).rejects.toThrow(/type p/);
  });

  test('a read stops at its limit; a missing or irregular file is not found', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    engine.onExec = (cmd) => ({ stdout: 'abcdefgh'.slice(0, Number(cmd.at(-1))) });
    expect(text(await host.getFile(handleOf(NAME), '/work/a', 4, signal()))).toBe('abcd');
    for (const exitCode of [3, 4]) {
      engine.onExec = () => ({ exitCode });
      await expect(host.getFile(handleOf(NAME), '/work/a', 4, signal())).rejects.toBeInstanceOf(
        SandboxFileNotFound,
      );
    }
    await expect(host.getFile(handleOf(NAME), 'relative', 4, signal())).rejects.toBeInstanceOf(
      SandboxAdapterRefusal,
    );
  });
});

describe('the life of a sandbox', () => {
  test('a suspended container is kept for the agent, and resumes under the same egress only', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const { resumeRef } = await host.pause(handleOf(NAME), signal());
    expect(resumeRef).toBe(NAME);
    expect(engine.containers.get(NAME)?.running).toBe(true);
    const container = engine.containers.get(NAME);
    if (container) container.running = false;
    await expect(
      host.resume(resumeRef, spec('sbx_one', { kind: 'open' }), signal()),
    ).rejects.toThrow('another egress policy');
    const resumed = await host.resume(resumeRef, spec(), signal());
    expect(resumed.providerSandboxId).toBe(NAME);
    expect(container?.running).toBe(true);
  });

  test('destroying removes the container, its network and both volumes, and ends its grant', async () => {
    const { engine, host, guard } = setup({ open: true });
    await host.create(spec('sbx_one', { kind: 'open' }), signal());
    expect(guard.granted(NAME).length).toBe(1);
    await host.destroy(handleOf(NAME), signal());
    expect(engine.containers.size + engine.volumes.size + engine.networks.size).toBe(0);
    expect(guard.granted(NAME)).toEqual([]);
    // Destroying what is already gone is not an error.
    await host.destroy(handleOf(NAME), signal());
  });

  test('reconciliation removes only this installation connection leftovers', async () => {
    const { engine, host } = setup();
    await host.create(spec('sbx_live'), signal());
    await host.create(spec('sbx_orphan'), signal());
    const other = spec('sbx_other');
    await host.create(
      {
        ...other,
        labels: sandboxLabels({
          project: 'proj',
          connection: 'conn_two',
          space: 'sp_one',
          session: 'sbx_other',
        }),
      },
      signal(),
    );
    // A volume whose container never came to be.
    engine.volumes.set('melete-sbx-proj-sbx_lost-work', {
      ...spec('sbx_lost').labels,
      'com.melete.sandbox': 'v1',
      'com.melete.sandbox.name': 'melete-sbx-proj-sbx_lost',
    });
    const destroyed = await host.reconcile('proj', new Set(['sbx_live']), signal(), 'conn_one');
    expect(destroyed.sort()).toEqual(['melete-sbx-proj-sbx_lost', 'melete-sbx-proj-sbx_orphan']);
    expect([...engine.containers.keys()].sort()).toEqual([
      'melete-sbx-proj-sbx_live',
      'melete-sbx-proj-sbx_other',
    ]);
    expect(
      [...engine.volumes.keys()].some((name) => name.includes('orphan') || name.includes('lost')),
    ).toBe(false);
  });

  test('the idle clock stops what nobody used, and a lifetime stops what ran too long', async () => {
    const { engine, host, advance } = setup({ settings: { idleSeconds: 600 } });
    await host.create(spec('sbx_quiet'), signal());
    await host.create(spec('sbx_busy', { kind: 'deny_all' }, { lifetimeSeconds: 7_200 }), signal());
    advance(300_000);
    commands(engine, () => ({}));
    await host.exec(
      handleOf('melete-sbx-proj-sbx_busy'),
      { marker: 'act_1', argv: ['true'], cwd: '/work', timeoutMs: 1000, maxOutputBytes: 10 },
      signal(),
    );
    advance(400_000);
    expect(await host.reap(signal())).toEqual(['melete-sbx-proj-sbx_quiet']);
    expect(engine.containers.get('melete-sbx-proj-sbx_quiet')?.running).toBe(false);
    // Watching counts as use.
    for (let minute = 0; minute < 130; minute += 5) {
      host.touch(handleOf('melete-sbx-proj-sbx_busy'));
      advance(300_000);
    }
    expect(await host.reap(signal())).toEqual(['melete-sbx-proj-sbx_busy']);
    // Files stay; the next use starts it again.
    expect(engine.volumes.has('melete-sbx-proj-sbx_quiet-work')).toBe(true);
    await host.connect(handleOf('melete-sbx-proj-sbx_quiet'), signal());
    expect(engine.containers.get('melete-sbx-proj-sbx_quiet')?.running).toBe(true);
  });

  test('the idle clock leaves containers it did not make alone', async () => {
    const { engine, host, advance } = setup({ settings: { idleSeconds: 60 } });
    engine.containers.set('someone-else', {
      name: 'someone-else',
      body: {},
      running: true,
      networks: {},
      labels: { 'com.melete.sandbox': 'v1', 'melete.project': 'proj' },
    });
    // Another installation's sandbox on the same engine is its own idle clock's business.
    engine.containers.set('melete-sbx-other-sbx_one', {
      name: 'melete-sbx-other-sbx_one',
      body: {},
      running: true,
      networks: {},
      labels: { 'com.melete.sandbox': 'v1', 'melete.owner': 'v1', 'melete.project': 'other' },
    });
    advance(10_000_000);
    await host.reap(signal());
    advance(10_000_000);
    expect(await host.reap(signal())).toEqual([]);
    expect(engine.containers.get('someone-else')?.running).toBe(true);
    expect(engine.containers.get('melete-sbx-other-sbx_one')?.running).toBe(true);
  });
});

describe('the desktop', () => {
  test('the docker host has a desktop and the others do not', () => {
    expect(isDesktopProvider(setup().host)).toBe(true);
    expect(isDesktopProvider({ capabilities: { adapter: 'e2b' } } as never)).toBe(false);
  });

  test('each action becomes one desktop command; a screenshot answers its bytes', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const seen: string[][] = [];
    engine.onExec = (cmd) => {
      seen.push(cmd);
      return { stdout: cmd[1] === 'screenshot' ? new Uint8Array([0x89, 0x50]) : '{"ok":true}' };
    };
    const handle = handleOf(NAME);
    expect([...(await host.computer(handle, { kind: 'screenshot' }, signal()))]).toEqual([
      0x89, 0x50,
    ]);
    await host.computer(handle, { kind: 'open', url: 'https://example.com/a b' }, signal());
    await host.computer(handle, { kind: 'click', x: 10, y: 20, button: 3, count: 2 }, signal());
    await host.computer(handle, { kind: 'type', text: 'hello; rm -rf /' }, signal());
    await host.computer(handle, { kind: 'key', keys: ['ctrl+l', 'Return'] }, signal());
    await host.computer(handle, { kind: 'scroll', x: 1, y: 2, dy: -3 }, signal());
    expect(seen).toEqual([
      ['melete-desktop', 'screenshot'],
      ['melete-desktop', 'open', 'https://example.com/a%20b'],
      ['melete-desktop', 'click', '10', '20', '3', '2'],
      ['melete-desktop', 'type', 'hello; rm -rf /'],
      ['melete-desktop', 'key', 'ctrl+l', 'Return'],
      ['melete-desktop', 'scroll', '1', '2', '-3'],
    ]);
  });

  test('what the desktop cannot take is refused before it is sent', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const handle = handleOf(NAME);
    const before = engine.calls.length;
    for (const command of [
      { kind: 'open', url: 'file:///etc/passwd' },
      { kind: 'open', url: 'javascript:alert(1)' },
      { kind: 'click', x: 1024, y: 0, button: 1, count: 1 },
      { kind: 'click', x: -1, y: 0, button: 1, count: 1 },
      { kind: 'click', x: 1.5, y: 0, button: 1, count: 1 },
      { kind: 'type', text: '' },
      { kind: 'type', text: 'a\0b' },
      { kind: 'key', keys: ['Return; reboot'] },
      { kind: 'key', keys: [] },
      { kind: 'scroll', x: 1, y: 1, dy: 0 },
      { kind: 'scroll', x: 1, y: 1, dy: 51 },
    ] as const)
      await expect(host.computer(handle, command as never, signal())).rejects.toBeInstanceOf(
        SandboxAdapterRefusal,
      );
    expect(engine.calls.length).toBe(before);
  });

  test('a desktop command that fails says what the desktop said', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    engine.onExec = () => ({ exitCode: 1, stderr: 'the browser did not open a window' });
    await expect(
      host.computer(handleOf(NAME), { kind: 'open', url: 'https://example.com/' }, signal()),
    ).rejects.toThrow('the desktop could not open: the browser did not open a window');
  });

  test('frames arrive whole however the stream is cut', async () => {
    const { engine, host } = setup();
    await host.create(spec(), signal());
    const frames = [new Uint8Array([0xff, 0xd8, 1, 2, 3]), new Uint8Array([0xff, 0xd8, 9])];
    const stream = new Uint8Array(frames.reduce((sum, frame) => sum + 4 + frame.byteLength, 0));
    let at = 0;
    for (const frame of frames) {
      new DataView(stream.buffer).setUint32(at, frame.byteLength);
      stream.set(frame, at + 4);
      at += 4 + frame.byteLength;
    }
    let argv: string[] = [];
    engine.onExec = (cmd) => {
      argv = cmd;
      return { stdout: stream, chunk: 3 };
    };
    const seen: number[][] = [];
    for await (const frame of host.frames(handleOf(NAME), 40, signal())) seen.push([...frame]);
    expect(argv).toEqual(['melete-desktop', 'stream', '--fps', '10']);
    // At most two wait for a slow viewer, so both arrive here.
    expect(seen).toEqual(frames.map((frame) => [...frame]));
  });
});

test('an exec stream that is not multiplexed is refused', () => {
  const capture = new ExecCapture(10, 10);
  expect(() => capture.push(new Uint8Array([7, 0, 0, 0, 0, 0, 0, 1, 65]))).toThrow(
    'not multiplexed',
  );
});
