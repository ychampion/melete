import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../../apps/melete/src/env.ts';
import type { DockerHostFacts } from '../../apps/melete/src/runtime/docker-host.ts';
import {
  ConfigureRefusal,
  configureOptions,
  createdMessage,
  databaseUrl,
  dockerSocketGroup,
  failureReport,
  providerSettings,
  sandboxProject,
  setupCodeNote,
  voiceSettings,
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

describe('the provider the configuration is written for', () => {
  const example = {
    MELETE_DEFAULT_PROVIDER: 'fireworks',
    MELETE_DEFAULT_MODEL: 'accounts/fireworks/models/deepseek-v4p1-flash',
  };

  test('--provider and --model are read, and --fake takes neither', () => {
    expect(configureOptions(['--provider', 'anthropic', '--model', 'claude-sonnet-5'])).toEqual({
      fake: false,
      nodeName: null,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(() => configureOptions(['--provider'])).toThrow('--provider needs a value');
    expect(() => configureOptions(['--provider', 'ollama'])).toThrow('not a provider');
    expect(() => configureOptions(['--fake', '--provider', 'anthropic'])).toThrow(
      '--fake runs the scripted demonstration provider',
    );
  });

  test('the default is production: the example provider, with its key from the environment', () => {
    expect(
      providerSettings({ fake: false }, example, { FIREWORKS_API_KEY: ' fw-secret ' }),
    ).toEqual({
      MELETE_DEFAULT_PROVIDER: 'fireworks',
      MELETE_DEFAULT_MODEL: 'accounts/fireworks/models/deepseek-v4p1-flash',
      MELETE_ENABLE_FAKE_PROVIDER: 'false',
      MELETE_ENABLE_TEST_CONNECTOR: 'false',
      FIREWORKS_API_KEY: 'fw-secret',
    });
  });

  test('an ElevenLabs key in the environment is written; none leaves voice off', () => {
    expect(voiceSettings({ ELEVENLABS_API_KEY: ' el-key ' })).toEqual({
      ELEVENLABS_API_KEY: 'el-key',
    });
    expect(voiceSettings({})).toEqual({});
    expect(voiceSettings({ ELEVENLABS_API_KEY: '  ' })).toEqual({});
    expect(() => voiceSettings({ ELEVENLABS_API_KEY: 'el key' })).toThrow(ConfigureRefusal);
  });

  test('a production run without its key is refused, naming the variable to set', () => {
    expect(() => providerSettings({ fake: false }, example, {})).toThrow(ConfigureRefusal);
    expect(() => providerSettings({ fake: false }, example, {})).toThrow(
      'Set FIREWORKS_API_KEY in this command',
    );
    expect(() =>
      providerSettings({ fake: false, provider: 'anthropic', model: 'claude' }, example, {
        FIREWORKS_API_KEY: 'fw-secret',
      }),
    ).toThrow('Set ANTHROPIC_API_KEY');
    expect(() =>
      providerSettings({ fake: false, provider: 'anthropic' }, example, { ANTHROPIC_API_KEY: 'a' }),
    ).toThrow('Name the model with --model');
  });

  test('a key with a space or a line break is refused, naming only its variable', () => {
    const lineBreak = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    for (const key of [
      'fw-secret part',
      `fw-secret${lineBreak}MELETE_ENABLE_TEST_CONNECTOR=true`,
      `fw${tab}secret`,
    ]) {
      const refusal = (() => {
        try {
          providerSettings({ fake: false }, example, { FIREWORKS_API_KEY: key });
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(refusal).toBeInstanceOf(ConfigureRefusal);
      expect((refusal as Error).message).toContain(
        'FIREWORKS_API_KEY contains a space or a line break',
      );
      expect((refusal as Error).message).not.toContain('secret');
    }
  });

  test('only the demonstration turns on the scripted provider and the test connector', () => {
    expect(providerSettings({ fake: true }, example, {})).toMatchObject({
      MELETE_DEFAULT_PROVIDER: 'fake',
      MELETE_ENABLE_FAKE_PROVIDER: 'true',
      MELETE_ENABLE_TEST_CONNECTOR: 'true',
    });
  });

  test('a sign-in provider needs no key, and an OpenAI-compatible one needs its address', () => {
    expect(
      providerSettings({ fake: false, provider: 'chatgpt', model: 'gpt-6' }, example, {}),
    ).toMatchObject({ MELETE_DEFAULT_PROVIDER: 'chatgpt', MELETE_ENABLE_FAKE_PROVIDER: 'false' });
    expect(() =>
      providerSettings({ fake: false, provider: 'openai-compatible', model: 'm' }, example, {}),
    ).toThrow('Set OPENAI_COMPAT_BASE_URL');
    expect(
      providerSettings({ fake: false, provider: 'openai-compatible', model: 'm' }, example, {
        OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1',
        OPENAI_COMPAT_API_KEY: 'local',
      }),
    ).toMatchObject({
      OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1',
      OPENAI_COMPAT_API_KEY: 'local',
    });
  });
});

describe('--connect-in-app, for a key pasted into the app', () => {
  const example = {
    MELETE_DEFAULT_PROVIDER: 'fireworks',
    MELETE_DEFAULT_MODEL: 'accounts/fireworks/models/deepseek-v4p1-flash',
  };

  test('it is read, and refused beside --fake', () => {
    expect(configureOptions(['--connect-in-app'])).toEqual({
      fake: false,
      nodeName: null,
      inApp: true,
    });
    expect(() => configureOptions(['--fake', '--connect-in-app'])).toThrow(
      '--connect-in-app has nothing to do',
    );
  });

  test('it writes the real provider with no key, and no demonstration', () => {
    const settings = providerSettings({ fake: false, inApp: true }, example, {});
    expect(settings).toEqual({
      MELETE_DEFAULT_PROVIDER: 'fireworks',
      MELETE_DEFAULT_MODEL: 'accounts/fireworks/models/deepseek-v4p1-flash',
      MELETE_ENABLE_FAKE_PROVIDER: 'false',
      MELETE_ENABLE_TEST_CONNECTOR: 'false',
    });
  });

  test('a key already in the environment is left out, so the app can manage it', () => {
    const settings = providerSettings({ fake: false, inApp: true }, example, {
      FIREWORKS_API_KEY: 'fw-secret',
    });
    expect(Object.values(settings)).not.toContain('fw-secret');
    expect(settings).not.toHaveProperty('FIREWORKS_API_KEY');
  });

  test('another provider still needs its model, and an OpenAI-compatible one its address', () => {
    expect(() =>
      providerSettings({ fake: false, inApp: true, provider: 'anthropic' }, example, {}),
    ).toThrow('Name the model with --model');
    expect(() =>
      providerSettings(
        { fake: false, inApp: true, provider: 'openai-compatible', model: 'm' },
        example,
        {},
      ),
    ).toThrow('Set OPENAI_COMPAT_BASE_URL');
    expect(
      providerSettings(
        { fake: false, inApp: true, provider: 'openai-compatible', model: 'm' },
        example,
        { OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1', OPENAI_COMPAT_API_KEY: 'k' },
      ),
    ).toEqual({
      MELETE_DEFAULT_PROVIDER: 'openai-compatible',
      MELETE_DEFAULT_MODEL: 'm',
      MELETE_ENABLE_FAKE_PROVIDER: 'false',
      MELETE_ENABLE_TEST_CONNECTOR: 'false',
      OPENAI_COMPAT_BASE_URL: 'http://192.168.1.20:11434/v1',
    });
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
      text: 'There is no /var/run/docker.sock on this machine, and the Compose file mounts it into melete-cells. Start Docker Engine, or link its socket to that path.\n',
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

  test('the setup code is said once, with a link that carries it', () => {
    const note = setupCodeNote('ABCD-EFGH-JKMN-PQRS-TVWX', 'http://127.0.0.1:3101');
    expect(note).toContain('  ABCD-EFGH-JKMN-PQRS-TVWX\n');
    expect(note).toContain('http://127.0.0.1:3101/#/welcome?code=ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(note).toContain('melete account setup-code');
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

describe('the sandbox label configure writes', () => {
  test('is one the service accepts, and a new one each time', () => {
    const first = sandboxProject();
    expect(first).toMatch(/^melete-[0-9a-f]{8}$/);
    expect(loadEnv({ MELETE_SANDBOX_PROJECT: first }).MELETE_SANDBOX_PROJECT).toBe(first);
    expect(sandboxProject()).not.toBe(first);
  });
});

describe('the database address configure writes', () => {
  test('names the user and database Postgres is created with', () => {
    expect(databaseUrl({ POSTGRES_USER: 'melete', POSTGRES_DB: 'melete' }, 'a1b2')).toBe(
      'postgres://melete:a1b2@postgres:5432/melete',
    );
    const url = new URL(databaseUrl({ POSTGRES_USER: 'assistant', POSTGRES_DB: 'home' }, 'c3d4'));
    expect(url.username).toBe('assistant');
    expect(url.pathname).toBe('/home');
    expect(loadEnv({ DATABASE_URL: url.href }).DATABASE_URL).toBe(url.href);
  });

  test('falls back to the Compose defaults when the template leaves them empty', () => {
    expect(databaseUrl({ POSTGRES_USER: '', POSTGRES_DB: ' ' }, 'e5f6')).toBe(
      'postgres://melete:e5f6@postgres:5432/melete',
    );
  });
});
