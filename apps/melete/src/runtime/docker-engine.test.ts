import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { bootstrap } from '../index.ts';
import { DockerSocketApi } from './docker.ts';
import {
  assertDockerEngine,
  compareVersions,
  DOCKER_API_VERSION,
  DOCKER_REQUIREMENT,
  type HostDockerOutputs,
  judgeHostDocker,
  REQUIRED_COMPOSE_VERSION,
} from './docker-engine.ts';

const socket = '/var/run/docker.sock';
const answers = (payload: unknown) => ({ version: async () => payload });
const engine = (Version: string, ApiVersion: string, MinAPIVersion = '1.24') => ({
  Version,
  ApiVersion,
  MinAPIVersion,
  Os: 'linux',
});

describe('the Docker Engine preflight over the socket', () => {
  test('an engine below the supervisor API fails with one message naming both requirements', async () => {
    const failure = await assertDockerEngine(answers(engine('27.5.1', '1.47')), socket).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain('Docker Engine 27.5.1 (API 1.47) is too old');
    expect(message).toContain('Docker Engine 28.0 or newer');
    expect(message).toContain(`API ${DOCKER_API_VERSION}`);
    expect(message).toContain(`Docker Compose ${REQUIRED_COMPOSE_VERSION} or newer`);
    expect(message).toContain(DOCKER_REQUIREMENT);
  });

  test('the exact supervisor API is accepted', async () => {
    expect(await assertDockerEngine(answers(engine('28.0.0', '1.48')), socket)).toEqual({
      version: '28.0.0',
      apiVersion: '1.48',
    });
  });

  test('a newer engine that still serves the supervisor API is accepted', async () => {
    expect(await assertDockerEngine(answers(engine('29.1.3', '1.52', '1.44')), socket)).toEqual({
      version: '29.1.3',
      apiVersion: '1.52',
    });
  });

  test('a two-digit minor is compared as a number, not as text', async () => {
    expect(compareVersions('1.100', '1.48')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '1.48')).toBeLessThan(0);
    expect(compareVersions('2.33.1', '2.33.1')).toBe(0);
    expect(compareVersions('2.33', '2.33.1')).toBeLessThan(0);
    await expect(assertDockerEngine(answers(engine('20.10.24', '1.41')), socket)).rejects.toThrow(
      'is too old',
    );
  });

  test('an engine that has dropped the supervisor API says so', async () => {
    await expect(
      assertDockerEngine(answers(engine('40.0.0', '1.70', '1.50')), socket),
    ).rejects.toThrow(
      `Docker Engine 40.0.0 no longer serves API ${DOCKER_API_VERSION} (its minimum is 1.50)`,
    );
  });

  test('an unreachable socket names the socket and the requirement, not a stack of causes', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const failure = await assertDockerEngine(
      {
        version: async () => {
          throw refused;
        },
      },
      socket,
    ).catch((error: unknown) => error);
    const message = (failure as Error).message;
    expect(message.split('\n')).toHaveLength(1);
    expect(message).toContain(`Cannot reach the Docker Engine at ${socket} (ECONNREFUSED)`);
    expect(message).toContain(DOCKER_REQUIREMENT);
  });

  test('an answer that is not an engine version is refused rather than trusted', async () => {
    for (const payload of [null, {}, { ApiVersion: 'latest' }, 'ok', { ApiVersion: 1.48 }])
      await expect(assertDockerEngine(answers(payload), socket)).rejects.toThrow(
        'did not report an API version',
      );
  });
});

describe('the socket client', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test('asks the unversioned endpoint, which an old engine still answers', async () => {
    const requests: Array<{ url: string; unix?: string }> = [];
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async (
        url: string,
        init?: { unix?: string },
      ) => {
        requests.push({ url: String(url), unix: init?.unix });
        return Response.json(engine('27.0.3', '1.46'));
      }) as unknown as typeof fetch),
    );
    const api = new DockerSocketApi('/run/fake.sock');
    await expect(assertDockerEngine(api, '/run/fake.sock')).rejects.toThrow('is too old');
    expect(requests).toEqual([{ url: 'http://localhost/version', unix: '/run/fake.sock' }]);
  });

  test('versioned requests use the one declared API version', async () => {
    const urls: string[] = [];
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
        urls.push(String(url));
        return Response.json([]);
      }) as unknown as typeof fetch),
    );
    await new DockerSocketApi('/run/fake.sock').request('GET', '/networks');
    expect(urls).toEqual([`http://localhost/v${DOCKER_API_VERSION}/networks`]);
  });
});

describe('the service in Docker runtime mode', () => {
  test('checks the engine before it opens the database or anything else', async () => {
    const order: string[] = [];
    const version = spyOn(DockerSocketApi.prototype, 'version').mockImplementation(async () => {
      order.push('version');
      return engine('26.1.4', '1.45');
    });
    const request = spyOn(DockerSocketApi.prototype, 'request').mockImplementation(async () => {
      order.push('request');
      return null;
    });
    try {
      await expect(
        bootstrap({
          workers: false,
          env: loadEnv({
            NODE_ENV: 'test',
            // Nothing listens here: reaching it would fail differently and much later.
            DATABASE_URL: 'postgres://melete:unused@127.0.0.1:1/melete',
            MELETE_RUNTIME_ADAPTER: 'docker',
            MELETE_CAPABILITY_KEY: 'c'.repeat(32),
            MELETE_APPROVAL_KEY: 'a'.repeat(32),
            MELETE_RUNTIME_KEY: 'r'.repeat(32),
          }),
        }),
      ).rejects.toThrow('Docker Engine 26.1.4 (API 1.45) is too old');
      expect(order).toEqual(['version']);
    } finally {
      version.mockRestore();
      request.mockRestore();
    }
  });
});

describe('the host check used by configure, upgrade and doctor', () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const host = (server: string, compose: string): HostDockerOutputs => ({
    engine: ok(server),
    compose: ok(compose),
  });

  test('a supported engine and Compose have no problems', () => {
    expect(judgeHostDocker(host('1.48 28.0.0\n', '2.33.1\n'))).toEqual([]);
    expect(judgeHostDocker(host('1.52 29.1.3', 'v2.40.3-desktop.1'))).toEqual([]);
  });

  test('an old engine and an old Compose are each named once', () => {
    const problems = judgeHostDocker(host('1.47 27.5.1', '2.32.4'));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Docker Engine 27.5.1 (API 1.47) is too old');
    expect(problems[1]).toContain('Docker Compose 2.32.4 is too old');
    expect(problems[1]).toContain(`${REQUIRED_COMPOSE_VERSION} or newer`);
    expect(judgeHostDocker(host('1.48 28.0.0', '2.33.0'))).toHaveLength(1);
    expect(judgeHostDocker(host('1.48 28.0.0', '2.27.1+ds1-0ubuntu1'))).toHaveLength(1);
  });

  test('a missing client, a stopped daemon and a missing Compose plugin are named', () => {
    const stopped = judgeHostDocker({
      engine: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
      compose: ok('2.33.1'),
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain('`docker version` did not reach a Docker Engine');
    const noPlugin = judgeHostDocker({
      engine: ok('1.48 28.0.0'),
      compose: { code: 1, stdout: '', stderr: "docker: 'compose' is not a docker command." },
    });
    expect(noPlugin).toHaveLength(1);
    expect(noPlugin[0]).toContain('`docker compose version` failed');
    expect(judgeHostDocker(host('', 'unknown'))).toHaveLength(2);
  });
});
