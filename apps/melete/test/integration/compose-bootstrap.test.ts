import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import { parse } from 'yaml';
import { loadEnv } from '../../src/env.ts';
import { bootstrap } from '../../src/index.ts';
import { DockerSocketApi } from '../../src/runtime/docker.ts';
import { testDatabase, unusedTestPort } from '../helpers/database.ts';

test('Compose runtime selection boots the service and initializes its Docker supervisor', async () => {
  const handle = await testDatabase();
  if (!handle) throw new Error('Postgres unavailable');
  const root = await mkdtemp(join(tmpdir(), 'melete-compose-bootstrap-'));
  const compose = parse(
    await readFile(new URL('../../../../deploy/docker-compose.yml', import.meta.url), 'utf8'),
  ) as { services: { melete: { environment: Record<string, string> } } };
  const calls: Array<{ method: string; path: string }> = [];
  // Replace only daemon I/O: migrations, memory startup, queues and listeners are real.
  const daemon = spyOn(DockerSocketApi.prototype, 'request').mockImplementation(
    async (method, path) => {
      calls.push({ method, path });
      if (method !== 'GET') throw new Error('An empty installation must not mutate Docker');
      if (path === '/containers/compose-bootstrap/json')
        return {
          Id: 'compose-bootstrap',
          Config: {
            Labels: {
              'com.docker.compose.project': 'melete',
              'com.docker.compose.service': 'melete',
            },
          },
        };
      if (path.startsWith('/images/'))
        return {
          Id: `sha256:${'a'.repeat(64)}`,
          Config: {
            Labels: {
              'com.melete.hermes.commit': HERMES_PINNED_COMMIT,
              'com.melete.plugin.sha256': 'b'.repeat(64),
            },
          },
        };
      if (path.startsWith('/containers/json?') || path.startsWith('/networks?')) return [];
      if (path.startsWith('/volumes?')) return { Volumes: [] };
      throw new Error(`Unexpected daemon inspection: ${path}`);
    },
  );
  const priorHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'compose-bootstrap';
  let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    const port = await unusedTestPort();
    service = await bootstrap({
      workers: false,
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: handle.url,
        MELETE_RUNTIME_ADAPTER: compose.services.melete.environment.MELETE_RUNTIME_ADAPTER,
        MELETE_CAPABILITY_KEY: 'c'.repeat(32),
        MELETE_APPROVAL_KEY: 'a'.repeat(32),
        MELETE_RUNTIME_KEY: 'r'.repeat(32),
        MELETE_BROKER_BIND: `127.0.0.1:${port}`,
        MELETE_BROKER_URL: `http://127.0.0.1:${port}`,
        MELETE_SPACES_DIR: join(root, 'spaces'),
        MELETE_ARTIFACTS_DIR: join(root, 'artifacts'),
        MELETE_RESTRICTIONS_DIR: join(root, 'restrictions'),
        MELETE_WORK_DIR: join(root, 'work'),
      }),
    });
    const health = await service.app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      database: 'ok',
      runtime_adapter: 'docker',
    });
    expect(service.runner).toBeDefined();
    expect(service.broker).toBeDefined();
    expect(service.effectBoundary?.server.listening).toBe(true);
    expect((await service.app.request('/jobs')).status).toBe(401);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  } finally {
    try {
      await service?.close();
    } finally {
      daemon.mockRestore();
      if (priorHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = priorHostname;
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);
