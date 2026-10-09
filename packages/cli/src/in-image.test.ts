/**
 * Inside the service image the host's Docker, Compose files and deploy/.env are
 * out of reach by design. There, check, doctor and status report the host's
 * rules as skipped, which never fails the report; on the host they are unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from './commands/check.ts';
import { runDoctor } from './commands/doctor.ts';
import { runStatus } from './commands/status.ts';
import { SERVICE_IMAGE_MARKER } from './context.ts';
import { type Report, renderReport, reportSchema } from './schema.ts';
import { type TestContext, testContext } from './testing.ts';

const IMAGE = { [SERVICE_IMAGE_MARKER]: '1' };

/** The service image's /app/deploy: its scripts, and none of the installation's files. */
function imageDeployDir(): string {
  const deployDir = join(mkdtempSync(join(tmpdir(), 'melete-image-deploy-')), 'deploy');
  mkdirSync(join(deployDir, 'scripts'), { recursive: true });
  return deployDir;
}

/** A context whose Docker client has no engine to talk to, as in the service container. */
function noEngine(deployDir: string, overrides: Parameters<typeof testContext>[2] = {}) {
  return testContext(
    deployDir,
    [
      ['docker version', { code: 1, stderr: 'Cannot connect to the Docker daemon' }],
      ['docker compose version', { code: 1, stderr: 'Cannot connect to the Docker daemon' }],
      ['docker info', { code: 1, stderr: 'Cannot connect to the Docker daemon' }],
    ],
    overrides,
  );
}

const parsed = (context: TestContext): Report => reportSchema.parse(JSON.parse(context.printed()));
const level = (value: Report, id: string) =>
  value.results.find((result) => result.id === id)?.level;

describe('doctor in the service image', () => {
  test('host rules are skipped, the exit code is ok, and Docker is never asked', async () => {
    const context = noEngine(imageDeployDir(), { environment: IMAGE });
    expect(await runDoctor(context, true, true)).toBe(0);
    const value = parsed(context);
    expect(value.ok).toBe(true);
    for (const id of [
      'deploy.contract',
      'docker.engine',
      'disk.free_mb',
      'memory.total_mb',
      'ports.published',
      'images.present',
      'images.registry_reachable',
    ])
      expect(`${id} ${level(value, id)}`).toBe(`${id} skip`);
    expect(value.results.find((result) => result.id === 'docker.engine')?.detail).toBe(
      'Skipped: run on the host to check this.',
    );
    expect(context.docker.calls).toEqual([]);
  });

  test('without --offline it still makes no network call from the container', async () => {
    const fetched: string[] = [];
    const context = noEngine(imageDeployDir(), {
      environment: IMAGE,
      fetch: async (url) => {
        fetched.push(url);
        return new Response(null);
      },
    });
    expect(await runDoctor(context, true, false)).toBe(0);
    expect(fetched).toEqual([]);
  });

  test('the browser worker is still judged from the service settings', async () => {
    const config = mkdtempSync(join(tmpdir(), 'melete-image-config-'));
    const connections = join(config, 'connections.json');
    writeFileSync(connections, '[{"id":"conn_browser1","kind":"browser"}]\n');
    const context = noEngine(imageDeployDir(), {
      environment: { ...IMAGE, MELETE_CONNECTIONS_FILE: connections },
    });
    expect(await runDoctor(context, true, true)).toBe(1);
    const value = parsed(context);
    expect(level(value, 'browser.worker')).toBe('fail');
    expect(level(value, 'docker.engine')).toBe('skip');
  });

  test('the readable report names the skipped rules and passes', async () => {
    const context = noEngine(imageDeployDir(), { environment: IMAGE });
    await runDoctor(context, false, true);
    const text = context.printed();
    expect(text).toMatch(/^ {2}skip {2}docker\.engine +Skipped: run on the host to check this\.$/m);
    expect(text).toContain('doctor: passed. 7 skipped here; run it on the host to check those.');
  });
});

describe('doctor on the host is unchanged', () => {
  test('without the marker, an engine that does not answer fails', async () => {
    const context = noEngine(imageDeployDir());
    expect(await runDoctor(context, true, true)).toBe(1);
    const value = parsed(context);
    expect(level(value, 'docker.engine')).toBe('fail');
    expect(value.results.some((result) => result.level === 'skip')).toBe(false);
  });

  test('a marker with any other value is not the image', async () => {
    const context = noEngine(imageDeployDir(), { environment: { [SERVICE_IMAGE_MARKER]: '0' } });
    expect(await runDoctor(context, true, true)).toBe(1);
    expect(level(parsed(context), 'docker.engine')).toBe('fail');
  });
});

describe('check in the service image', () => {
  test('the installation files are skipped and the exit code is ok', () => {
    const context = noEngine(imageDeployDir(), { environment: IMAGE });
    expect(runCheck(context, true)).toBe(0);
    const value = parsed(context);
    for (const id of ['deploy.contract', 'env.file', 'compose.files', 'compose.boundaries'])
      expect(`${id} ${level(value, id)}`).toBe(`${id} skip`);
  });

  test('on the host a missing deploy/.env still fails', () => {
    const context = noEngine(imageDeployDir());
    expect(runCheck(context, true)).toBe(1);
    expect(level(parsed(context), 'env.file')).toBe('fail');
  });
});

describe('status in the service image', () => {
  const healthy = async (url: string) =>
    url.endsWith('/health')
      ? Response.json({ status: 'ok', database: 'ok' })
      : Response.json({ needed: false });

  test('host rules are skipped; the API and the account are asked of the service', async () => {
    const asked: string[] = [];
    const context = noEngine(imageDeployDir(), {
      environment: {
        ...IMAGE,
        MELETE_API_BIND: 'melete-api',
        PORT: '8787',
        MELETE_DEFAULT_PROVIDER: 'anthropic',
        MELETE_DEFAULT_MODEL: 'a-model',
        ANTHROPIC_API_KEY: 'sk-test-value',
      },
      fetch: async (url) => {
        asked.push(url);
        return healthy(url);
      },
    });
    expect(await runStatus(context, true)).toBe(0);
    const value = parsed(context);
    for (const id of [
      'deploy.contract',
      'status.docker',
      'status.disk',
      'status.configuration',
      'status.images',
      'status.services',
    ])
      expect(`${id} ${level(value, id)}`).toBe(`${id} skip`);
    expect(level(value, 'status.api')).toBe('ok');
    expect(level(value, 'status.account')).toBe('ok');
    expect(level(value, 'status.model')).toBe('ok');
    expect(asked).toEqual(['http://melete-api:8787/health', 'http://melete-api:8787/setup']);
    expect(context.docker.calls).toEqual([]);
  });

  test('a service that does not answer still fails', async () => {
    const context = noEngine(imageDeployDir(), {
      environment: IMAGE,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    expect(await runStatus(context, true)).toBe(1);
    expect(level(parsed(context), 'status.api')).toBe('fail');
  });

  test('on the host an engine that does not answer fails', async () => {
    const context = noEngine(imageDeployDir(), { fetch: healthy });
    expect(await runStatus(context, true)).toBe(1);
    expect(level(parsed(context), 'status.docker')).toBe('fail');
  });
});

test('a skipped rule alone never fails a report', () => {
  const value: Report = {
    command: 'doctor',
    ok: true,
    results: [
      { id: 'docker.engine', level: 'skip', detail: 'Skipped: run on the host to check this.' },
    ],
  };
  expect(renderReport(value)).toContain('doctor: passed. 1 skipped here');
});
