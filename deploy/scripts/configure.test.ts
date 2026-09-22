import { describe, expect, test } from 'bun:test';
import type { DockerHostFacts } from '../../apps/melete/src/runtime/docker-host.ts';
import {
  ConfigureRefusal,
  configureOptions,
  createdMessage,
  dockerSocketGroup,
  failureReport,
} from './configure.ts';
import { DEFAULT_NODE_NAME } from './tailscale-origin.ts';

describe('the configuration generator options', () => {
  test('the documented options are read', () => {
    expect(configureOptions([])).toEqual({ fake: false, nodeName: null });
    expect(configureOptions(['--fake'])).toEqual({ fake: true, nodeName: null });
    expect(configureOptions(['--tailscale'])).toEqual({
      fake: false,
      nodeName: DEFAULT_NODE_NAME,
    });
    expect(configureOptions(['--fake', '--tailscale', '--tailscale-hostname', 'desk'])).toEqual({
      fake: true,
      nodeName: 'desk',
    });
  });

  test('a misspelt option is refused before anything is written', () => {
    for (const [args, unknown] of [
      [['--fak'], '--fak'],
      [['-fake'], '-fake'],
      [['fake'], 'fake'],
      [['--tailscale', '--tailscale-host', 'desk'], '--tailscale-host'],
    ] as const)
      expect(() => configureOptions(args)).toThrow(`Unknown option ${unknown}.`);
  });
});

describe('the Docker socket group written as DOCKER_GID', () => {
  const GIB = 1024 ** 3;
  const host = (platform: NodeJS.Platform, operatingSystem: string): DockerHostFacts => ({
    platform,
    endpoint: null,
    pipePresent: null,
    info: {
      osType: 'linux',
      operatingSystem,
      kernelVersion: '6.8.0',
      memTotal: 8 * GIB,
      dockerRootDir: '/var/lib/docker',
    },
  });
  const access = (probe: string, code = 0) => {
    const calls: string[] = [];
    return {
      calls,
      statHost: async () => {
        calls.push('stat');
        return { isSocket: () => true, gid: 988 };
      },
      runProbe: (command: readonly string[]) => {
        calls.push(command.join(' '));
        return { code, stdout: probe, stderr: code ? 'Cannot connect' : '' };
      },
      probeImage: async () => 'postgres:17-alpine@sha256:pinned',
    };
  };

  test('Docker Engine on Linux: the host socket group, and no container is run', async () => {
    const linux = access('');
    expect(await dockerSocketGroup(host('linux', 'Ubuntu 24.04 LTS'), linux)).toBe(988);
    expect(linux.calls).toEqual(['stat']);
  });

  test('Docker Engine on Linux with no socket file: one plain refusal, not ENOENT', async () => {
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, stat '/var/run/docker.sock'"),
      { code: 'ENOENT' },
    );
    const failure = await dockerSocketGroup(host('linux', 'Ubuntu 24.04 LTS'), {
      ...access(''),
      statHost: async () => {
        throw enoent;
      },
    }).catch((error: unknown) => error);
    expect(failureReport(failure)).toEqual({
      text: 'There is no /var/run/docker.sock on this machine, and the Compose file mounts it into the service. Start Docker Engine, or link its socket to that path.\n',
      code: 1,
    });
    // Any other failure to stat is unexpected and keeps its stack.
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const other = await dockerSocketGroup(host('linux', 'Ubuntu 24.04 LTS'), {
      ...access(''),
      statHost: async () => {
        throw denied;
      },
    }).catch((error: unknown) => error);
    expect(other).toBe(denied);
    expect(failureReport(other)).toBeNull();
  });

  test('an engine on another machine: its socket group, measured from a container there', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const remote = access('998 660 socket\n');
      const facts = {
        ...host(platform, 'Ubuntu 24.04 LTS'),
        endpoint: 'ssh://deploy@droplet.example.net',
      };
      expect(await dockerSocketGroup(facts, remote)).toBe(998);
      expect(remote.calls).toHaveLength(1);
      expect(remote.calls[0]).toContain('source=/var/run/docker.sock,target=/var/run/docker.sock');
    }
  });

  test('Docker Desktop on Windows, macOS or Linux: the group measured from a container', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const desktop = access('0 760 socket\n');
      expect(await dockerSocketGroup(host(platform, 'Docker Desktop'), desktop)).toBe(0);
      expect(desktop.calls).toHaveLength(1);
      expect(desktop.calls[0]).toContain('postgres:17-alpine@sha256:pinned');
      expect(desktop.calls[0]).toContain('source=/var/run/docker.sock,target=/var/run/docker.sock');
    }
  });

  test('a socket the service could not use is refused before deploy/.env is written', async () => {
    await expect(
      dockerSocketGroup(host('win32', 'Docker Desktop'), access('0 755 socket')),
    ).rejects.toThrow('mode 755');
    await expect(dockerSocketGroup(host('win32', 'Docker Desktop'), access('', 1))).rejects.toThrow(
      'could not inspect /var/run/docker.sock on Docker Desktop (Cannot connect)',
    );
  });
});

describe('what configure prints', () => {
  test('the created line says what was done on each system', () => {
    expect(createdMessage('linux', true)).toBe(
      'Created deploy/.env with private permissions and the explicit fake provider.',
    );
    expect(createdMessage('darwin', false)).toBe('Created deploy/.env with private permissions.');
    const windows = createdMessage('win32', true);
    expect(windows).not.toContain('private permissions');
    expect(windows).toBe(
      'Created deploy/.env and the explicit fake provider. On Windows it has the permissions of its folder.',
    );
  });

  test('a refusal, such as a second run, is its message alone, with no stack', () => {
    const refusal = new ConfigureRefusal(
      'deploy/.env already exists. Keep it; edit its settings to change providers.',
    );
    expect(failureReport(refusal)).toEqual({
      text: 'deploy/.env already exists. Keep it; edit its settings to change providers.\n',
      code: 1,
    });
    // Anything unexpected keeps its stack, so a bug is not reported as advice.
    expect(failureReport(new Error('EACCES'))).toBeNull();
  });

  test('a socket the service could not use is a refusal', async () => {
    const facts: DockerHostFacts = {
      platform: 'win32',
      endpoint: null,
      pipePresent: null,
      info: null,
    };
    const failure = await dockerSocketGroup(facts, {
      statHost: async () => ({ isSocket: () => true, gid: 0 }),
      runProbe: () => ({ code: 0, stdout: '0 755 socket', stderr: '' }),
      probeImage: async () => 'postgres:17-alpine@sha256:pinned',
    }).catch((error: unknown) => error);
    expect(failureReport(failure)?.text).toContain('mode 755');
  });
});
