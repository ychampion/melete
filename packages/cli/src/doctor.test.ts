import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DoctorFacts, judgeDoctor, publishedByProject, runDoctor } from './commands/doctor.ts';
import { defaultDeployConfig } from './deploy-config.ts';
import { reportSchema } from './schema.ts';
import { changingCalls, ok, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const MB = 1024 ** 2;

const healthy: DoctorFacts = {
  config: defaultDeployConfig(),
  contract: { id: 'deploy.contract', level: 'ok', detail: 'melete.deploy.json, contract 1' },
  docker: [],
  dockerVersions: 'Engine 28.3.0, Compose 2.39.1',
  dockerNotes: [],
  remoteEngine: null,
  freeBytes: 20_000 * MB,
  memoryBytes: 8192 * MB,
  ports: [
    { service: 'melete', host: '127.0.0.1', port: 3100, free: true, ours: false },
    { service: 'web', host: '127.0.0.1', port: 3101, free: true, ours: false },
  ],
  images: [{ name: 'ghcr.io/ychampion/melete-service:main', present: true }],
  registry: {
    url: 'https://ghcr.io/v2/',
    answered: true,
    detail: 'https://ghcr.io/v2/ answers (401).',
  },
};

const find = (facts: DoctorFacts, id: string) =>
  judgeDoctor(facts).find((result) => result.id === id);
const withFloor = (min_free_mb: number) => ({
  ...healthy.config,
  disk: { ...healthy.config.disk, min_free_mb },
});

describe('melete doctor', () => {
  test('a healthy host passes, with disk reported in MB', () => {
    const results = judgeDoctor(healthy);
    expect(results.filter((result) => result.level !== 'ok')).toEqual([]);
    expect(results.find((result) => result.id === 'disk.free_mb')?.detail).toBe(
      '20000 MB free where Docker keeps its images; the floor is 4096 MB.',
    );
  });

  test("the disk floor is the contract's, so a small host can pass below 1 GB", () => {
    const small = { ...healthy, freeBytes: 1000 * MB };
    expect(find(small, 'disk.free_mb')?.level).toBe('fail');
    expect(find({ ...small, config: withFloor(600) }, 'disk.free_mb')?.level).toBe('ok');
    expect(find({ ...small, config: withFloor(1001) }, 'disk.free_mb')?.level).toBe('fail');
  });

  test("a port another program holds fails; the stack's own port does not", () => {
    const taken = {
      ...healthy,
      ports: [
        { service: 'melete', host: '127.0.0.1', port: 3100, free: false, ours: true },
        { service: 'web', host: '127.0.0.1', port: 3101, free: false, ours: false },
      ],
    };
    expect(find(taken, 'ports.3100')?.level).toBe('ok');
    expect(find(taken, 'ports.3101')).toMatchObject({
      level: 'fail',
      fix: expect.stringContaining('WEB_PORT'),
    });
  });

  test('a missing image or an unreachable registry warns rather than fails', () => {
    const facts = {
      ...healthy,
      images: [{ name: 'ghcr.io/ychampion/melete-web:main', present: false }],
      registry: { url: 'https://ghcr.io/v2/', answered: false, detail: 'timed out' },
    };
    expect(find(facts, 'images.present')?.level).toBe('warn');
    expect(find(facts, 'images.registry_reachable')?.level).toBe('warn');
  });

  test('without an engine, only the engine is reported', () => {
    const results = judgeDoctor({ ...healthy, docker: ['Docker Engine 27.5 is too old.'] });
    expect(results.map((result) => result.id)).toEqual(['deploy.contract', 'docker.engine']);
  });

  test("published ports are read from Compose's JSON rows", () => {
    const rows = [
      { Service: 'melete', Publishers: [{ PublishedPort: 3100, TargetPort: 8787 }] },
      { Service: 'runtime', Publishers: [{ PublishedPort: 0, TargetPort: 8790 }] },
    ];
    expect([...publishedByProject(rows.map((row) => JSON.stringify(row)).join('\n'))]).toEqual([
      3100,
    ]);
    expect([...publishedByProject(JSON.stringify(rows))]).toEqual([3100]);
  });

  test("it gathers with read-only commands and judges against the contract's floors", async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      JSON.stringify({ contract: 1, disk: { min_free_mb: 600, pull_margin_mb: 200 } }),
    );
    const dockerRoot = mkdtempSync(join(tmpdir(), 'melete-docker-root-'));
    const probed: string[] = [];
    const fetched: string[] = [];
    const context = testContext(
      deployDir,
      [
        ['docker info --format {{.DockerRootDir}}', ok(dockerRoot)],
        ['docker image inspect', ok('sha256:abc')],
      ],
      {
        portFree: async (host, port) => {
          probed.push(`${host}:${port}`);
          return port !== 3101;
        },
        fetch: async (url) => {
          fetched.push(url);
          return new Response(null, { status: 401 });
        },
      },
    );
    // Compose answers by sub-command: the image list, then the running services.
    const run = context.run;
    context.run = (command) => {
      if (command.includes('config') || command.includes('ps'))
        context.docker.calls.push([...command]);
      if (command.includes('config') && command.includes('--images'))
        return {
          code: 0,
          stdout: 'postgres:17-alpine\nghcr.io/ychampion/melete-service:main\n',
          stderr: '',
        };
      if (command.includes('ps'))
        return {
          code: 0,
          stdout: JSON.stringify({ Service: 'web', Publishers: [{ PublishedPort: 3101 }] }),
          stderr: '',
        };
      return run(command);
    };
    expect(await runDoctor(context, true, false)).toBe(0);
    const value = reportSchema.parse(JSON.parse(context.printed()));
    expect(value.results.find((result) => result.id === 'disk.free_mb')?.detail).toContain(
      'the floor is 600 MB',
    );
    // 3101 is held by the stack's own web container, so it is not probed.
    expect(probed).toEqual(['127.0.0.1:3100']);
    expect(value.results.find((result) => result.id === 'ports.3101')?.level).toBe('ok');
    expect(fetched).toEqual(['https://ghcr.io/v2/']);
    const asked = context.docker.calls.map((call) => call.join(' '));
    expect(
      asked.filter((line) => / compose .*(config --images|ps --format json)$/.test(line)),
    ).toHaveLength(2);
    expect(changingCalls(context.docker.calls)).toEqual([]);
  });

  test('--offline makes no network call', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const fetched: string[] = [];
    const context = testContext(deployDir, [], {
      fetch: async (url) => {
        fetched.push(url);
        return new Response(null);
      },
    });
    await runDoctor(context, true, true);
    expect(fetched).toEqual([]);
  });
});
