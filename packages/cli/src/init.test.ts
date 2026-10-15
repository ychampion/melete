import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions, parseServiceImage, runInit } from './commands/init.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { changingCalls, ok, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const container = (
  service: string,
  image: string,
  files: string[],
  state: { running?: boolean; oneoff?: boolean } = {},
) => ({
  Config: {
    Image: image,
    Labels: {
      'com.docker.compose.project': 'melete',
      'com.docker.compose.service': service,
      'com.docker.compose.project.config_files': files.join(','),
      'com.docker.compose.oneoff': state.oneoff ? 'True' : 'False',
    },
  },
  State: { Running: state.running ?? true },
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
      backup: { dir: '~/melete-backups', keep: 3, max_age_days: 30 },
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

  test('the sandbox profile is adopted from COMPOSE_PROFILES, with no image holder container', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '34a9140', COMPOSE_PROFILES: 'other, sandbox' });
    await runInit(testContext(deployDir, engine(running)), ['--adopt']);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).profiles).toEqual([
      'sandbox',
    ]);
  });

  test('a one-off or stopped service container never decides the adopted image', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '34a9140' });
    const leftovers = [
      container('melete', 'ghcr.io/ychampion/melete-service:0ld0ne1', files, { oneoff: true }),
      container('melete', 'ghcr.io/ychampion/melete-service:0ld0ne2', files, { running: false }),
      ...running,
    ];
    const context = testContext(deployDir, engine(leftovers));
    expect(await runInit(context, ['--adopt'])).toBe(0);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).images.tag).toBe(
      '34a9140',
    );
    // Compose is asked for the stack's own containers only.
    expect(context.docker.calls[0]).toContain('label=com.docker.compose.oneoff=False');
  });

  test('service containers that disagree on the image are refused, with no file written', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const split = [
      container('melete', 'ghcr.io/ychampion/melete-service:aaaaaaa', files),
      container('melete', 'ghcr.io/ychampion/melete-service:bbbbbbb', files),
    ];
    const context = testContext(deployDir, engine(split));
    expect(await runInit(context, ['--adopt'])).toBe(2);
    expect(context.errors()).toContain('run different images');
    expect(existsSync(join(deployDir, DEPLOY_FILE))).toBe(false);
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

/** An engine where project `name` has containers from `folders` and these volumes. */
const using = (name: string, folders: string[], volumes: string[] = []) =>
  [
    [
      `docker ps --all --filter label=com.docker.compose.project=${name} --format`,
      ok(folders.map((folder) => `dir=${folder}\n`).join('')),
    ],
    [
      `docker volume ls --quiet --filter label=com.docker.compose.project=${name}`,
      ok(volumes.join('\n')),
    ],
  ] as [string, ReturnType<typeof ok>][];

describe('melete init', () => {
  test('a new installation runs configure, then writes the contract from its deploy/.env', async () => {
    const deployDir = temporaryDeployDir();
    const context = testContext(deployDir, using('melete', []), {
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

  test('--hosted marks the new installation hosted, and --public-url reaches configure', async () => {
    const deployDir = temporaryDeployDir();
    const context = testContext(deployDir, using('melete', []), {
      attach: async (command) => {
        context.attached.push([...command]);
        writeEnv(deployDir, { MELETE_IMAGE_TAG: 'main' });
        return 0;
      },
    });
    const args = ['--connect-in-app', '--public-url', 'https://assistant.example.net', '--hosted'];
    expect(await runInit(context, args)).toBe(0);
    expect(context.attached[0]?.slice(2)).toEqual(args);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).hosted).toBe(true);
  });

  test('a configure refusal leaves no contract behind', async () => {
    const deployDir = temporaryDeployDir();
    const context = testContext(deployDir, using('melete', []), { attach: async () => 1 });
    expect(await runInit(context, [])).toBe(2);
    expect(existsSync(join(deployDir, DEPLOY_FILE))).toBe(false);
    expect(existsSync(join(deployDir, '.melete'))).toBe(false);
  });

  test('an installation that is already configured is pointed at --adopt', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runInit(context, [])).toBe(2);
    expect(context.errors()).toContain('init --adopt');
    expect(context.attached).toEqual([]);
  });

  test('--adopt takes only the disk floors and the backup folder', () => {
    expect(() => initOptions(['--adopt', '--fake'])).toThrow('belongs to a new installation');
    expect(() => initOptions(['--min-free-mb', 'lots'])).toThrow('whole number');
    expect(initOptions(['--adopt', '--backup-dir', '~/backups/two'])).toMatchObject({
      adopt: true,
      backupDir: '~/backups/two',
    });
    expect(() => initOptions(['--backup-dir', 'relative/folder'])).toThrow('--backup-dir');
    expect(() => initOptions(['--project', 'Melete Two'])).toThrow('--project');
    expect(() => initOptions(['--adopt', '--force'])).toThrow(
      '--force belongs to a new installation',
    );
    expect(initOptions(['--force', '--fake'])).toMatchObject({
      force: true,
      configure: ['--fake'],
    });
  });
});

describe('a second installation on one machine', () => {
  const configuring = (deployDir: string, rules: [string, ReturnType<typeof ok>][], env = {}) => {
    const context = testContext(deployDir, rules, {
      attach: async (command) => {
        context.attached.push([...command]);
        writeEnv(deployDir, env);
        return 0;
      },
    });
    return context;
  };

  test("--project and the ports reach configure, and backups get a folder of the project's own", async () => {
    const deployDir = temporaryDeployDir();
    const context = configuring(deployDir, using('melete2', []), {
      COMPOSE_PROJECT_NAME: 'melete2',
      MELETE_PORT: '3200',
      WEB_PORT: '3201',
    });
    const args = ['--fake', '--project', 'melete2', '--api-port', '3200', '--web-port', '3201'];
    expect(await runInit(context, args)).toBe(0);
    expect(context.attached[0]?.slice(2)).toEqual(args);
    const contract = JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8'));
    expect(contract.project).toBe('melete2');
    expect(contract.backup.dir).toBe('~/melete-backups/melete2');
    expect(context.printed()).toContain('Backups go to ~/melete-backups/melete2.');
  });

  test('--backup-dir names the folder, and is not handed to configure', async () => {
    const deployDir = temporaryDeployDir();
    const context = configuring(deployDir, using('melete', []));
    expect(await runInit(context, ['--fake', '--backup-dir', '/srv/backups/two'])).toBe(0);
    expect(context.attached[0]?.slice(2)).toEqual(['--fake']);
    const contract = JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8'));
    expect(contract.backup).toEqual({ dir: '/srv/backups/two', keep: 3, max_age_days: 30 });
  });

  test("a project name another installation's containers use is refused before anything is written", async () => {
    const deployDir = temporaryDeployDir();
    const context = configuring(
      deployDir,
      using('melete', ['/srv/melete/deploy', '/srv/melete/deploy'], ['melete_pgdata']),
    );
    expect(await runInit(context, ['--fake'])).toBe(2);
    expect(context.errors()).toContain(
      'Another installation, in /srv/melete/deploy, already runs as the Compose project melete',
    );
    expect(context.errors()).toContain('--project melete2 --api-port 3200 --web-port 3201');
    expect(context.attached).toEqual([]);
    expect(readdirSync(deployDir)).not.toContain('.env');
    expect(changingCalls(context.docker.calls)).toEqual([]);
  });

  test("a stopped installation's volumes are refused too: its database would not open", async () => {
    const deployDir = temporaryDeployDir();
    const context = configuring(deployDir, using('melete2', [], ['melete2_pgdata']));
    expect(await runInit(context, ['--fake', '--project', 'melete2'])).toBe(2);
    expect(context.errors()).toContain('Compose project melete2 already has 1 volume(s)');
    expect(context.attached).toEqual([]);
  });

  test('a free name goes ahead; an engine that does not answer is refused, unless --force', async () => {
    const free = temporaryDeployDir();
    expect(await runInit(configuring(free, using('melete', [])), ['--fake'])).toBe(0);
    const silent = temporaryDeployDir();
    const refused = configuring(silent, []);
    expect(await runInit(refused, ['--fake', '--project', 'melete2'])).toBe(2);
    expect(refused.errors()).toContain(
      'Docker did not answer, so whether the Compose project melete2 is already in use on this engine could not be checked',
    );
    expect(refused.errors()).toContain('pass --force');
    expect(refused.attached).toEqual([]);
    expect(readdirSync(silent)).not.toContain('.env');
    const forced = configuring(silent, []);
    expect(await runInit(forced, ['--fake', '--force'])).toBe(0);
    // --force is init's own; configure.ts never sees it.
    expect(forced.attached[0]?.slice(2)).toEqual(['--fake']);
  });

  test('a refused init leaves no deploy/.melete behind, and keeps one that was there', async () => {
    const refusals: [string, ReturnType<typeof configuring>, string[]][] = [];
    const inUse = temporaryDeployDir();
    refusals.push([inUse, configuring(inUse, using('melete', ['/srv/melete/deploy'])), ['--fake']]);
    const silent = temporaryDeployDir();
    refusals.push([silent, configuring(silent, []), ['--fake']]);
    const configureRefused = temporaryDeployDir();
    refusals.push([
      configureRefused,
      testContext(configureRefused, using('melete', []), { attach: async () => 1 }),
      ['--fake'],
    ]);
    const adopt = temporaryDeployDir();
    writeEnv(adopt);
    refusals.push([adopt, testContext(adopt, [['docker ps --all --quiet', ok('')]]), ['--adopt']]);
    for (const [deployDir, context, args] of refusals) {
      expect(await runInit(context, args)).toBe(2);
      expect(readdirSync(deployDir)).not.toContain('.melete');
    }
    const kept = temporaryDeployDir();
    mkdirSync(join(kept, '.melete'));
    writeFileSync(join(kept, '.melete', 'history.jsonl'), '');
    expect(await runInit(configuring(kept, []), ['--fake'])).toBe(2);
    expect(readdirSync(join(kept, '.melete'))).toEqual(['history.jsonl']);
  });
});
