import { describe, expect, test } from 'bun:test';
import type { CommandOutput } from './docker-engine.ts';
import {
  DOCKER_HOST_COMMANDS,
  type DockerHostFacts,
  dockerHostFacts,
  isDockerDesktop,
  judgeDockerHost,
  judgeDockerMachine,
  judgeSocketProbe,
  longPathFacts,
  type MachineAccess,
  MIN_DESKTOP_MEMORY_BYTES,
  parseDockerInfo,
  pipePath,
  readDockerHost,
  socketProbeCommand,
} from './docker-host.ts';

const GIB = 1024 ** 3;
const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' });
const failed = (stderr = 'error'): CommandOutput => ({ code: 1, stdout: '', stderr });
const info = (fields: Record<string, unknown>) =>
  ok(
    JSON.stringify({
      OSType: 'linux',
      OperatingSystem: 'Docker Desktop',
      KernelVersion: '6.6.87.2-microsoft-standard-WSL2',
      MemTotal: 8 * GIB,
      DockerRootDir: '/var/lib/docker',
      ...fields,
    }),
  );
const desktop = (fields: Record<string, unknown> = {}): DockerHostFacts =>
  dockerHostFacts({
    platform: 'win32',
    env: {},
    info: info(fields),
    context: ok('npipe:////./pipe/dockerDesktopLinuxEngine\n'),
    exists: () => true,
  });

describe('docker info', () => {
  test('the fields the judgement reads are taken from its JSON', () => {
    expect(parseDockerInfo(info({}))).toEqual({
      osType: 'linux',
      operatingSystem: 'Docker Desktop',
      kernelVersion: '6.6.87.2-microsoft-standard-WSL2',
      memTotal: 8 * GIB,
      dockerRootDir: '/var/lib/docker',
    });
  });

  test('no engine, or an answer that is not docker info, is no information', () => {
    expect(parseDockerInfo(failed('error during connect'))).toBeNull();
    expect(parseDockerInfo(ok('1.48 28.0.0'))).toBeNull();
    expect(parseDockerInfo(ok('{"ServerErrors":["x"]}'))).toBeNull();
  });

  test('Docker Desktop is told apart from Docker Engine on Linux', () => {
    expect(isDockerDesktop(parseDockerInfo(info({})))).toBe(true);
    expect(isDockerDesktop(parseDockerInfo(info({ OperatingSystem: 'Ubuntu 24.04.3 LTS' })))).toBe(
      false,
    );
    expect(isDockerDesktop(null)).toBe(false);
  });
});

describe('the endpoint the client uses', () => {
  test('DOCKER_HOST wins over the context, and a pipe endpoint is tested on Windows', () => {
    const tested: string[] = [];
    const facts = dockerHostFacts({
      platform: 'win32',
      env: { DOCKER_HOST: 'npipe:////./pipe/docker_engine' },
      info: info({}),
      context: ok('npipe:////./pipe/dockerDesktopLinuxEngine'),
      exists: (path) => {
        tested.push(path);
        return true;
      },
    });
    expect(facts.endpoint).toBe('npipe:////./pipe/docker_engine');
    expect(tested).toEqual(['\\\\.\\pipe\\docker_engine']);
    expect(facts.pipePresent).toBe(true);
  });

  test('the context endpoint is used when DOCKER_HOST is unset or empty', () => {
    expect(desktop().endpoint).toBe('npipe:////./pipe/dockerDesktopLinuxEngine');
    const empty = dockerHostFacts({
      platform: 'win32',
      env: { DOCKER_HOST: ' ' },
      info: info({}),
      context: ok('npipe:////./pipe/docker_engine'),
      exists: () => true,
    });
    expect(empty.endpoint).toBe('npipe:////./pipe/docker_engine');
    // With no context to ask, the Windows client's default pipe is the endpoint.
    const unknown = dockerHostFacts({
      platform: 'win32',
      env: {},
      info: failed(),
      context: failed(),
      exists: () => false,
    });
    expect(unknown).toMatchObject({
      endpoint: 'npipe:////./pipe/docker_engine',
      pipePresent: false,
    });
  });

  test('a pipe is only looked for on Windows and only for a pipe endpoint', () => {
    const never = () => {
      throw new Error('no pipe to test');
    };
    const linux = dockerHostFacts({
      platform: 'linux',
      env: {},
      info: info({ OperatingSystem: 'Debian GNU/Linux 12 (bookworm)' }),
      context: ok('unix:///var/run/docker.sock'),
      exists: never,
    });
    expect(linux.pipePresent).toBeNull();
    const tcp = dockerHostFacts({
      platform: 'win32',
      env: { DOCKER_HOST: 'tcp://localhost:2375' },
      info: info({}),
      context: failed(),
      exists: never,
    });
    expect(tcp.pipePresent).toBeNull();
    expect(pipePath('npipe:///./pipe/docker_engine')).toBe('\\\\.\\pipe\\docker_engine');
    expect(pipePath('unix:///var/run/docker.sock')).toBeNull();
  });
});

describe('the host judgement', () => {
  test('Docker Desktop in Linux containers mode with enough memory has no problems', () => {
    expect(judgeDockerHost(desktop())).toEqual([]);
    expect(judgeDockerHost(desktop({ MemTotal: MIN_DESKTOP_MEMORY_BYTES }))).toEqual([]);
  });

  test('Windows containers mode is refused with the switch to make', () => {
    const problems = judgeDockerHost(desktop({ OSType: 'windows', MemTotal: 16 * GIB }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('runs windows containers');
    expect(problems[0]).toContain('Switch to Linux containers');
  });

  test('too little memory in the VM is refused, with the fix for the backend in use', () => {
    const wsl = judgeDockerHost(desktop({ MemTotal: 2 * GIB }));
    expect(wsl).toHaveLength(1);
    expect(wsl[0]).toContain('2.0 GiB of memory');
    expect(wsl[0]).toContain('.wslconfig');
    expect(wsl[0]).toContain('wsl --shutdown');
    const hyperv = judgeDockerHost(
      desktop({ MemTotal: 2 * GIB, KernelVersion: '6.10.14-linuxkit' }),
    );
    expect(hyperv[0]).toContain('Settings > Resources > Advanced');
    expect(hyperv[0]).not.toContain('.wslconfig');
  });

  test('memory is judged only for Docker Desktop, whose VM size is a setting', () => {
    const engine = judgeDockerHost({
      platform: 'linux',
      endpoint: 'unix:///var/run/docker.sock',
      pipePresent: null,
      info: parseDockerInfo(info({ OperatingSystem: 'Ubuntu 24.04 LTS', MemTotal: 2 * GIB })),
    });
    expect(engine).toEqual([]);
  });

  test('a missing pipe says Docker Desktop is not running, in place of the generic line', () => {
    const stopped = dockerHostFacts({
      platform: 'win32',
      env: {},
      info: failed('open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file'),
      context: ok('npipe:////./pipe/dockerDesktopLinuxEngine'),
      exists: () => false,
    });
    expect(desktop().pipePresent).toBe(true);
    expect(stopped.pipePresent).toBe(false);
    const problems = judgeDockerMachine(
      { engine: failed('error during connect'), compose: ok('v2.40.3-desktop.1') },
      stopped,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'Nothing answers on //./pipe/dockerDesktopLinuxEngine, so Docker Desktop is not running',
    );
    // With the pipe present, the engine's own line explains the failure.
    const reachable = judgeDockerMachine(
      { engine: failed('permission denied'), compose: ok('2.40.3') },
      { ...stopped, pipePresent: true },
    );
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toContain('`docker version` did not reach a Docker Engine');
  });

  test('an engine on another machine is refused; a local TCP endpoint is not', () => {
    const at = (endpoint: string) =>
      judgeDockerHost({ platform: 'linux', endpoint, pipePresent: null, info: null });
    for (const endpoint of ['ssh://deploy@build.example.net', 'tcp://10.0.0.5:2376']) {
      const problems = at(endpoint);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`points at ${endpoint}, another machine`);
    }
    for (const endpoint of [
      'tcp://localhost:2375',
      'tcp://127.0.0.1:2375',
      'tcp://[::1]:2375',
      'unix:///var/run/docker.sock',
      'npipe:////./pipe/docker_engine',
    ])
      expect(at(endpoint)).toEqual([]);
  });

  test('versions and host problems are reported together', () => {
    const problems = judgeDockerMachine(
      { engine: ok('1.47 27.5.1'), compose: ok('2.30.0') },
      desktop({ OSType: 'windows' }),
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('Docker Engine 27.5.1');
    expect(problems[1]).toContain('Docker Compose 2.30.0');
    expect(problems[2]).toContain('windows containers');
  });
});

describe('Windows path lengths', () => {
  const facts = (overrides: Partial<Parameters<typeof longPathFacts>[0]> = {}) =>
    longPathFacts({
      root: 'C:\\Users\\owner\\melete',
      registry: ok(
        '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    0x0\r\n',
      ),
      git: failed(''),
      tracked: ok('README.md\nconformance/memory/scenarios/a.json\n'),
      installed: ['.bun\\x'.padEnd(162, 'x')],
      ...overrides,
    });
  const judged = (paths: ReturnType<typeof facts>) =>
    judgeDockerHost({ platform: 'win32', endpoint: null, pipePresent: null, info: null, paths });

  test('the registry value, the Git setting and the deepest paths are read', () => {
    expect(facts()).toEqual({
      root: 'C:\\Users\\owner\\melete',
      deepestTracked: 'conformance/memory/scenarios/a.json'.length,
      deepestInstalled: 'node_modules/'.length + 162,
      longPathsEnabled: false,
      gitLongPaths: false,
    });
    const enabled = facts({
      registry: ok('    LongPathsEnabled    REG_DWORD    0x1\r\n'),
      git: ok('true\n'),
    });
    expect(enabled.longPathsEnabled).toBe(true);
    expect(enabled.gitLongPaths).toBe(true);
    expect(
      facts({ registry: failed('ERROR: The system was unable to find') }).longPathsEnabled,
    ).toBeNull();
  });

  test('a short clone fits whatever the settings', () => {
    expect(judged(facts())).toEqual([]);
  });

  test('a deep clone without long paths is refused with both fixes', () => {
    const deep = `C:\\Users\\owner\\OneDrive - Personal\\Documents\\${'projects\\'.repeat(6)}melete`;
    const problems = judged(facts({ root: deep }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("past Windows' 260-character limit");
    expect(problems[0]).toContain('C:\\melete');
    expect(problems[0]).toContain('LongPathsEnabled -Value 1');
    const unknown = judged(facts({ root: deep, registry: failed() }));
    expect(unknown[0]).toContain('not known to be enabled');
    expect(
      judged(facts({ root: deep, registry: ok('LongPathsEnabled    REG_DWORD    0x1') })),
    ).toEqual([]);
  });

  test("Git's own limit is judged against the tracked files and core.longpaths", () => {
    const root = `C:\\${'d'.repeat(200)}`;
    const problems = judged(
      facts({
        root,
        installed: [],
        tracked: ok(`${'t'.repeat(60)}\n`),
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('core.longpaths');
    expect(
      judged(facts({ root, installed: [], tracked: ok(`${'t'.repeat(60)}\n`), git: ok('true') })),
    ).toEqual([]);
  });
});

describe('gathering', () => {
  const machine = (platform: NodeJS.Platform): MachineAccess => ({
    platform,
    env: {},
    exists: () => true,
    installed: () => ['a/b.js'],
  });

  test('Windows adds the long-path commands, run against the checkout', () => {
    const asked: string[] = [];
    const run = (command: readonly string[]) => {
      asked.push(command.join(' '));
      if (command.join(' ') === DOCKER_HOST_COMMANDS.info.join(' ')) return info({});
      return ok('');
    };
    const facts = readDockerHost(run, 'C:\\melete', machine('win32'));
    expect(asked).toEqual([
      'docker info --format {{json .}}',
      'docker context inspect --format {{.Endpoints.docker.Host}}',
      'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem /v LongPathsEnabled',
      'git -C C:\\melete config --get core.longpaths',
      'git -C C:\\melete ls-files',
    ]);
    expect(facts.paths?.deepestInstalled).toBe('node_modules/a/b.js'.length);

    asked.length = 0;
    expect(readDockerHost(run, '/srv/melete', machine('linux')).paths).toBeUndefined();
    expect(asked).toHaveLength(2);
  });
});

describe('the socket as a container sees it', () => {
  test('the probe mounts the socket into the pinned image with no network', () => {
    const command = socketProbeCommand('postgres:17-alpine@sha256:abc');
    expect(command.join(' ')).toBe(
      'docker run --rm --network none --entrypoint stat --volume /var/run/docker.sock:/var/run/docker.sock postgres:17-alpine@sha256:abc -c %g %a %F /var/run/docker.sock',
    );
  });

  test("Docker Desktop's socket gives its group, root", () => {
    expect(judgeSocketProbe(ok('0 760 socket\n'))).toEqual({ gid: 0 });
    expect(judgeSocketProbe(ok('999 660 socket'))).toEqual({ gid: 999 });
    expect(judgeSocketProbe(ok('0 666 socket'))).toEqual({ gid: 0 });
  });

  test('a socket only its owner may write to is refused, since the service is not root', () => {
    const probe = judgeSocketProbe(ok('0 755 socket'));
    expect('problem' in probe && probe.problem).toContain('mode 755');
  });

  test('a probe that failed, or found no socket, is refused with the reason', () => {
    const failedRun = judgeSocketProbe(
      failed('docker: Error response from daemon: pull access denied'),
    );
    expect('problem' in failedRun && failedRun.problem).toContain('pull access denied');
    const directory = judgeSocketProbe(ok('0 755 directory'));
    expect('problem' in directory && directory.problem).toContain('is a directory, not a socket');
  });
});

describe('no docker program at all', () => {
  test('is said once, with where to get Docker for that system', () => {
    const missing = { code: 127, stdout: '', stderr: 'Executable not found in $PATH: "docker"' };
    const windows = dockerHostFacts({
      platform: 'win32',
      env: {},
      info: missing,
      context: missing,
      exists: () => false,
    });
    const problems = judgeDockerMachine({ engine: missing, compose: missing }, windows);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Install Docker Desktop');
    const linux = judgeDockerMachine(
      { engine: missing, compose: missing },
      { platform: 'linux', endpoint: null, pipePresent: null, info: null },
    );
    expect(linux).toHaveLength(1);
    expect(linux[0]).toContain('Install Docker Engine');
  });
});
