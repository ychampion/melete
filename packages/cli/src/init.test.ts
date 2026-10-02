import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions, parseServiceImage, runInit } from './commands/init.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { changingCalls, ok, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const container = (service: string, image: string, files: string[]) => ({
  Config: {
    Image: image,
    Labels: {
      'com.docker.compose.project': 'melete',
      'com.docker.compose.service': service,
      'com.docker.compose.project.config_files': files.join(','),
    },
  },
});

const files = [
  '/srv/melete/deploy/docker-compose.yml',
  '/srv/melete/deploy/docker-compose.browser.yml',
];
const running = [
  container('postgres', 'postgres:17-alpine', files),
  container('melete', 'ghcr.io/ychampion/melete-service:34a9140', files),
  container('web', 'ghcr.io/ychampion/melete-web:34a9140', files),
  container('browser', 'ghcr.io/ychampion/melete-browser:34a9140', files),
];

const engine = (containers: object[]) =>
  [
    [
      'docker ps --all --quiet --filter label=com.docker.compose.project=melete',
      ok('a1\nb2\nc3\nd4\n'),
    ],
    ['docker inspect a1 b2 c3 d4', ok(JSON.stringify(containers))],
  ] as [string, ReturnType<typeof ok>][];

describe('melete init --adopt', () => {
  test('it writes the contract from the running stack and changes nothing else', async () => {
    const deployDir = temporaryDeployDir();
    const env = writeEnv(deployDir, { MELETE_IMAGE_TAG: '34a9140' });
    const before = readdirSync(deployDir).sort();
    const context = testContext(deployDir, engine(running));
    expect(
      await runInit(context, ['--adopt', '--min-free-mb', '600', '--pull-margin-mb', '200']),
    ).toBe(0);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8'))).toEqual({
      contract: 1,
      project: 'melete',
      images: { registry: 'ghcr.io/ychampion', tag: '34a9140', channel: 'main' },
      profiles: [],
      overlays: ['browser'],
      disk: { min_free_mb: 600, pull_margin_mb: 200 },
      backup: { dir: '~/melete-backups', keep: 3 },
      public_ports: false,
      database: { external: false },
      blobs: { store: 'local' },
      cells: { hosts: [] },
    });
    // One new file, and the lock is gone; deploy/.env is byte for byte the same.
    expect(
      readdirSync(deployDir)
        .filter((name) => name !== '.melete')
        .sort(),
    ).toEqual([...before, DEPLOY_FILE].sort());
    expect(readdirSync(join(deployDir, '.melete'))).toEqual([]);
    expect(readFileSync(join(deployDir, '.env'), 'utf8')).toBe(env);
    expect(changingCalls(context.docker.calls)).toEqual([]);
    expect(context.attached).toEqual([]);
  });

  test('the sandbox profile is adopted when its image holder exists', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '34a9140' });
    const withSandbox = [...running.slice(0, 3), container('sandbox-image', 'x', files)];
    await runInit(testContext(deployDir, engine(withSandbox)), ['--adopt']);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).profiles).toEqual([
      'sandbox',
    ]);
  });

  test('a difference between deploy/.env and what runs is pointed out', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: 'main' });
    const context = testContext(deployDir, engine(running));
    expect(await runInit(context, ['--adopt'])).toBe(0);
    expect(context.printed()).toContain(
      'deploy/.env names image tag main, but the stack runs 34a9140',
    );
  });

  test('an existing contract is refused with nothing changed', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeFileSync(join(deployDir, DEPLOY_FILE), '{"contract":1}');
    const context = testContext(deployDir, engine(running));
    expect(await runInit(context, ['--adopt'])).toBe(2);
    expect(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).toBe('{"contract":1}');
    expect(context.docker.calls).toEqual([]);
  });

  test('a project with no service container is refused, and no file is written', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir, [['docker ps --all --quiet', ok('')]]);
    expect(await runInit(context, ['--adopt'])).toBe(2);
    expect(existsSync(join(deployDir, DEPLOY_FILE))).toBe(false);
    expect(context.errors()).toContain('has no melete service container');
  });

  test('without deploy/.env there is nothing to adopt', async () => {
    const context = testContext(temporaryDeployDir());
    expect(await runInit(context, ['--adopt'])).toBe(2);
    expect(context.errors()).toContain('no installation here to adopt');
  });

  test('service images are read as a registry and a tag', () => {
    expect(parseServiceImage('ghcr.io/ychampion/melete-service:main')).toEqual({
      registry: 'ghcr.io/ychampion',
      tag: 'main',
      channel: 'main',
    });
    expect(parseServiceImage('registry.example:5000/team/melete-service:v0.2.0')?.channel).toBe(
      'release',
    );
    expect(parseServiceImage('melete-service:local')).toEqual({
      registry: null,
      tag: 'local',
      channel: 'local',
    });
    expect(parseServiceImage('nginx:latest')).toBeNull();
  });
});

describe('melete init', () => {
  test('a new installation runs configure, then writes the contract from its deploy/.env', async () => {
    const deployDir = temporaryDeployDir();
    const context = testContext(deployDir, [], {
      attach: async (command) => {
        context.attached.push([...command]);
        writeEnv(deployDir, { MELETE_IMAGE_TAG: '' });
        return 0;
      },
    });
    expect(await runInit(context, ['--fake', '--tailscale', '--min-free-mb', '2048'])).toBe(0);
    expect(context.attached[0]?.slice(1)).toEqual([
      join(deployDir, 'scripts', 'configure.ts'),
      '--fake',
      '--tailscale',
    ]);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8'))).toMatchObject({
      images: { registry: null, tag: 'local', channel: 'local' },
      overlays: ['tailscale'],
      disk: { min_free_mb: 2048, pull_margin_mb: 512 },
    });
  });

  test('a configure refusal leaves no contract behind', async () => {
    const deployDir = temporaryDeployDir();
    const context = testContext(deployDir, [], { attach: async () => 1 });
    expect(await runInit(context, [])).toBe(2);
    expect(existsSync(join(deployDir, DEPLOY_FILE))).toBe(false);
  });

  test('an installation that is already configured is pointed at --adopt', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runInit(context, [])).toBe(2);
    expect(context.errors()).toContain('init --adopt');
    expect(context.attached).toEqual([]);
  });

  test('--adopt takes only the disk floors', () => {
    expect(() => initOptions(['--adopt', '--fake'])).toThrow('belongs to a new installation');
    expect(() => initOptions(['--min-free-mb', 'lots'])).toThrow('whole number');
  });
});
