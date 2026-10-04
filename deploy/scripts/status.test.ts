import { describe, expect, test } from 'bun:test';
import {
  type Check,
  judgeModel,
  judgeStatus,
  parseComposePs,
  parseDfAvailable,
  render,
  type StatusFacts,
} from './status.ts';

const GB = 1024 ** 3;

const env = {
  COMPOSE_PROJECT_NAME: 'melete',
  MELETE_DEFAULT_PROVIDER: 'anthropic',
  MELETE_DEFAULT_MODEL: 'claude-model',
  ANTHROPIC_API_KEY: 'sk-secret-value',
  MELETE_ENABLE_FAKE_PROVIDER: 'false',
  MELETE_IMAGE_TAG: 'main',
  WEB_PORT: '3101',
};

const healthy: StatusFacts = {
  docker: [],
  dockerVersions: 'Engine 28.3.0, Compose 2.39.1',
  env,
  freeBytes: 40 * GB,
  images: [
    { name: 'postgres:17-alpine', present: true },
    { name: 'ghcr.io/ychampion/melete-service:main', present: true },
  ],
  services: ['postgres', 'melete-cells', 'melete', 'runtime', 'web'].map((service) => ({
    service,
    state: 'running',
    health: 'healthy',
  })),
  health: { status: 'ok', database: 'ok' },
  setupNeeded: false,
};

const find = (checks: Check[], name: string) => checks.find((check) => check.name === name);

describe('the installation report', () => {
  test('a healthy installation is ready, and no key is ever printed', () => {
    const checks = judgeStatus(healthy);
    expect(checks.filter((check) => check.level !== 'ok')).toEqual([]);
    const text = render(checks);
    expect(text).toContain('Ready.');
    expect(text).not.toContain('sk-secret-value');
    expect(JSON.stringify(checks)).not.toContain('sk-secret-value');
  });

  test('without deploy/.env it names configure and stops there', () => {
    const checks = judgeStatus({ ...healthy, env: null, images: null, services: null });
    expect(find(checks, 'Configuration')).toMatchObject({ level: 'fail' });
    expect(find(checks, 'Configuration')?.fix).toContain('configure.ts --connect-in-app');
    expect(find(checks, 'Services')).toBeUndefined();
  });

  test('a Docker problem fails with the reason', () => {
    const checks = judgeStatus({ ...healthy, docker: ['Docker Engine 27.5 is too old.'] });
    expect(find(checks, 'Docker')).toMatchObject({
      level: 'fail',
      detail: 'Docker Engine 27.5 is too old.',
    });
    // What depends on the engine is not reported as a second, misleading failure.
    expect(find(checks, 'Images')).toBeUndefined();
    expect(find(checks, 'Services')).toBeUndefined();
  });

  test('free space below the first-install minimum warns, and below the update floor fails', () => {
    expect(find(judgeStatus({ ...healthy, freeBytes: 6 * GB }), 'Disk')?.level).toBe('warn');
    expect(find(judgeStatus({ ...healthy, freeBytes: 2 * GB }), 'Disk')?.level).toBe('fail');
    expect(find(judgeStatus({ ...healthy, freeBytes: null }), 'Disk')?.level).toBe('warn');
  });

  test('a missing image names pull for published images and a build otherwise', () => {
    const missing = [{ name: 'ghcr.io/ychampion/melete-web:main', present: false }];
    expect(find(judgeStatus({ ...healthy, images: missing }), 'Images')?.fix).toContain(' pull');
    const built = judgeStatus({
      ...healthy,
      env: { ...env, MELETE_IMAGE_TAG: '' },
      images: [{ name: 'melete-web:local', present: false }],
    });
    expect(find(built, 'Images')?.fix).toContain('--build');
  });

  test('services: none started, one unhealthy, one still starting', () => {
    const none = judgeStatus({ ...healthy, services: [] });
    expect(find(none, 'Services')).toMatchObject({ level: 'fail', detail: 'Not started.' });
    expect(find(none, 'Services')?.fix).toContain('up -d --no-build --wait');

    const services = healthy.services ?? [];
    const sick = judgeStatus({
      ...healthy,
      services: services.map((s) => (s.service === 'runtime' ? { ...s, health: 'unhealthy' } : s)),
    });
    expect(find(sick, 'Services')).toMatchObject({ level: 'fail', detail: 'runtime unhealthy' });

    const starting = judgeStatus({
      ...healthy,
      services: services.map((s) => (s.service === 'melete' ? { ...s, health: 'starting' } : s)),
    });
    expect(find(starting, 'Services')?.level).toBe('warn');
  });

  test('the API and the account', () => {
    expect(find(judgeStatus({ ...healthy, health: null }), 'API')?.level).toBe('fail');
    expect(
      find(
        judgeStatus({ ...healthy, health: { status: 'degraded', database: 'unreachable' } }),
        'API',
      )?.level,
    ).toBe('fail');
    const fresh = judgeStatus({ ...healthy, setupNeeded: true });
    expect(find(fresh, 'Account')).toMatchObject({ level: 'warn' });
    expect(find(fresh, 'Account')?.fix).toContain('http://localhost:3101');
    expect(render(fresh)).toContain('Running, with 1 thing(s) to finish.');
  });

  test('the computer is checked only when it is turned on', () => {
    expect(find(judgeStatus(healthy), 'Computer')?.detail).toBe('Off (optional).');
    const on = { ...env, MELETE_SANDBOX_PROVIDER: 'docker' };
    expect(find(judgeStatus({ ...healthy, env: on }), 'Computer')?.level).toBe('fail');
    const withImage = judgeStatus({
      ...healthy,
      env: on,
      images: [{ name: 'ghcr.io/ychampion/melete-sandbox:main', present: true }],
    });
    expect(find(withImage, 'Computer')?.level).toBe('ok');
  });

  test('voice and the public address are reported without their secrets', () => {
    const checks = judgeStatus({
      ...healthy,
      env: { ...env, ELEVENLABS_API_KEY: 'el-secret', MELETE_PUBLIC_URL: 'https://m.example.net/' },
    });
    expect(find(checks, 'Voice')?.detail).toBe('On.');
    expect(find(checks, 'Public address')?.detail).toContain('https://m.example.net/api/mcp');
    expect(render(checks)).not.toContain('el-secret');
  });
});

describe('the model as deploy/.env sets it', () => {
  test('a key in the file is ok; an empty one points at the app', () => {
    expect(judgeModel(env).level).toBe('ok');
    const empty = judgeModel({ ...env, ANTHROPIC_API_KEY: '' });
    expect(empty.level).toBe('warn');
    expect(empty.fix).toContain('Settings › Models');
  });

  test('the practice model warns, and a setting that stops the service fails', () => {
    expect(
      judgeModel({ MELETE_DEFAULT_PROVIDER: 'fake', MELETE_ENABLE_FAKE_PROVIDER: 'true' }).level,
    ).toBe('warn');
    expect(judgeModel({ MELETE_DEFAULT_PROVIDER: 'ollama' }).level).toBe('fail');
  });
});

describe('reading Compose and df', () => {
  test('both shapes of compose ps json', () => {
    const lines =
      '{"Service":"web","State":"running","Health":"healthy"}\n{"Service":"melete","State":"exited","Health":""}\n';
    expect(parseComposePs(lines)).toEqual([
      { service: 'web', state: 'running', health: 'healthy' },
      { service: 'melete', state: 'exited', health: '' },
    ]);
    expect(parseComposePs('[{"Service":"web","State":"running","Health":"starting"}]')).toEqual([
      { service: 'web', state: 'running', health: 'starting' },
    ]);
    expect(parseComposePs('')).toEqual([]);
  });

  test('the available column of df -Pk', () => {
    const df =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdd 1000 200 800 20% /docker-root\n';
    expect(parseDfAvailable(df)).toBe(800 * 1024);
    expect(parseDfAvailable('nonsense')).toBeNull();
  });
});
