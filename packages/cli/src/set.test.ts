import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { runSet } from './commands/set.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const read = (deployDir: string, file: string) => readFileSync(join(deployDir, file), 'utf8');

const writeContract = (deployDir: string, value: object) =>
  writeFileSync(join(deployDir, DEPLOY_FILE), JSON.stringify({ contract: 1, ...value }));

describe('melete set', () => {
  test('an ordinary setting is rewritten where it stands and reported', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['WEB_PORT=3201'])).toBe(0);
    expect(read(deployDir, '.env')).toContain('\nWEB_PORT=3201\n');
    expect(context.printed()).toStartWith('Set WEB_PORT=3201.\n');
    // Compose reads deploy/.env when it creates a container, so the web service is recreated.
    expect(context.printed()).toContain('up -d --force-recreate web');
  });

  test('a secret on the command line is refused with nothing changed', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['ANTHROPIC_API_KEY=sk-typed'])).toBe(2);
    expect(read(deployDir, '.env')).toBe(before);
    expect(context.errors()).toContain('--from-env ANTHROPIC_API_KEY');
    expect(context.errors()).not.toContain('sk-typed');
  });

  test('a network pool the service refuses is not written, even with --force; one it takes is', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    for (const args of [
      ['MELETE_NETWORK_POOL=10.214.0.0/25'],
      ['--force', 'MELETE_NETWORK_POOL=127.0.0.0/16'],
    ]) {
      const context = testContext(deployDir);
      expect(await runSet(context, args)).toBe(2);
      expect(read(deployDir, '.env')).toBe(before);
      expect(context.errors()).toContain(
        'The service does not start with it, so nothing was changed.',
      );
    }
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_NETWORK_POOL=10.214.0.0/16'])).toBe(0);
    expect(read(deployDir, '.env')).toContain('\nMELETE_NETWORK_POOL=10.214.0.0/16\n');
  });

  test('a key from the environment is written and only named', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(
      await runSet(context, ['--from-env', 'ELEVENLABS_API_KEY'], {
        ELEVENLABS_API_KEY: 'el-secret',
      }),
    ).toBe(0);
    expect(read(deployDir, '.env')).toContain('ELEVENLABS_API_KEY=el-secret');
    expect(context.printed()).toStartWith('Set ELEVENLABS_API_KEY.\n');
    expect(context.printed()).not.toContain('el-secret');
  });

  test('changing the image tag keeps the contract in step', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeContract(deployDir, { disk: { min_free_mb: 600, pull_margin_mb: 200 } });
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_IMAGE_TAG=v0.3.0'])).toBe(0);
    const contract = JSON.parse(read(deployDir, DEPLOY_FILE));
    expect(contract.images).toEqual({
      registry: 'ghcr.io/ychampion',
      tag: 'v0.3.0',
      channel: 'release',
    });
    // What the operator set by hand is kept.
    expect(contract.disk).toEqual({ min_free_mb: 600, pull_margin_mb: 200 });
    expect(context.printed()).toContain(`Updated ${DEPLOY_FILE} to match.`);
  });

  test('an invalid contract refuses a setting it records, with deploy/.env unchanged', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    writeFileSync(join(deployDir, DEPLOY_FILE), '{"contract":1,"disk":{"min_free_gb":1}}');
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_IMAGE_TAG=v0.3.0'])).toBe(2);
    expect(read(deployDir, '.env')).toBe(before);
  });

  test('a setting the contract does not record leaves the contract alone', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeFileSync(join(deployDir, DEPLOY_FILE), '{"contract":1}');
    expect(await runSet(testContext(deployDir), ['WEB_PORT=3201'])).toBe(0);
    expect(read(deployDir, DEPLOY_FILE)).toBe('{"contract":1}');
  });

  test('while another melete command holds the lock, set is refused with nothing changed', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    mkdirSync(join(deployDir, '.melete', 'lock'), { recursive: true });
    writeFileSync(
      join(deployDir, '.melete', 'lock', 'holder'),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        command: 'deploy',
        since: '',
      }),
    );
    const context = testContext(deployDir);
    expect(await runSet(context, ['WEB_PORT=3201'])).toBe(2);
    expect(read(deployDir, '.env')).toBe(before);
    expect(context.errors()).toContain('Another melete command holds');
  });

  test('a misspelt name is refused with the setting it is closest to', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_PUBLC_URL=https://assistant.example.net'])).toBe(2);
    expect(read(deployDir, '.env')).toBe(before);
    expect(context.errors()).toContain('did you mean MELETE_PUBLIC_URL?');
    // --force writes a name of the operator's own.
    expect(await runSet(context, ['MY_OVERLAY_SETTING=1', '--force'])).toBe(0);
    expect(read(deployDir, '.env')).toContain('MY_OVERLAY_SETTING=1');
  });

  test("an overlay's setting is accepted before the overlay is turned on", async () => {
    // docs/DEPLOYMENT.md, "A managed Postgres database": the authority file comes before database.external.
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_DATABASE_CA_FILE=/etc/melete/database-ca.pem'])).toBe(0);
    expect(read(deployDir, '.env')).toContain(
      'MELETE_DATABASE_CA_FILE=/etc/melete/database-ca.pem',
    );
  });

  test('a setting no service reads says nothing needs to restart; an image tag says deploy', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['MELETE_IMAGE_TAG=v0.3.0'])).toBe(0);
    expect(context.printed()).toContain('Apply it with bun run melete deploy.');
  });

  test('--clear empties a key without it being typed', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['--clear', 'ANTHROPIC_API_KEY'])).toBe(0);
    expect(read(deployDir, '.env')).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(context.printed()).toStartWith('Cleared ANTHROPIC_API_KEY.\n');
    expect(context.printed()).toContain('--force-recreate melete');
  });

  test('without deploy/.env it is refused and points at init', async () => {
    const context = testContext(temporaryDeployDir());
    expect(await runSet(context, ['WEB_PORT=3201'])).toBe(2);
    expect(context.errors()).toContain('bun run melete init');
  });
});

describe('renaming the Compose project', () => {
  /** An engine whose project `melete` has containers started from these folders. */
  const engineWith = (folders: string[]) => {
    const calls: string[] = [];
    const run = (command: readonly string[]) => {
      calls.push(command.join(' '));
      const line = command.join(' ');
      if (line.startsWith('docker ps --all --filter label=com.docker.compose.project=melete '))
        return { code: 0, stdout: folders.map((folder) => `dir=${folder}\n`).join(''), stderr: '' };
      if (line.startsWith('docker volume ls')) return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'no such command in this test' };
    };
    return { calls, run };
  };

  test('is refused while this checkout has containers in the project, and allowed with --force', async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir);
    const engine = engineWith([deployDir]);
    const context = testContext(deployDir, [], { run: engine.run });
    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2'])).toBe(2);
    expect(read(deployDir, '.env')).toBe(before);
    expect(context.errors()).toContain(
      'Compose project melete has containers started from this checkout',
    );
    expect(engine.calls[0]).toStartWith(
      'docker ps --all --filter label=com.docker.compose.project=melete --format',
    );

    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2', '--force'])).toBe(0);
    expect(read(deployDir, '.env')).toMatch(/^COMPOSE_PROJECT_NAME=melete2$/m);
  });

  test("a container with no folder label could be this checkout's, so it still refuses", async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir, [], { run: engineWith(['']).run });
    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2'])).toBe(2);
  });

  test("another installation's containers under the same name do not stop a second checkout", async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir, [], {
      run: engineWith(['/srv/melete/deploy', '/srv/melete/deploy']).run,
    });
    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2'])).toBe(0);
    expect(read(deployDir, '.env')).toMatch(/^COMPOSE_PROJECT_NAME=melete2$/m);
    expect(context.printed()).toContain(
      "Compose project melete's containers belong to the installation in /srv/melete/deploy, not to this checkout",
    );
  });

  test('is allowed when the current project has no containers', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir, [], {
      run: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2'])).toBe(0);
  });

  test('is refused when the engine cannot be asked', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const context = testContext(deployDir);
    expect(await runSet(context, ['COMPOSE_PROJECT_NAME=melete2'])).toBe(2);
    expect(context.errors()).toContain('could not be checked');
  });

  test("is refused when the new name is another checkout's installation, the default included", async () => {
    const deployDir = temporaryDeployDir();
    const before = writeEnv(deployDir, { COMPOSE_PROJECT_NAME: 'melete2' });
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const run = (command: readonly string[]) => {
      const line = command.join(' ');
      // `melete` runs from another checkout; this one's `melete2` has nothing yet.
      if (line.startsWith('docker ps --all --filter label=com.docker.compose.project=melete '))
        return ok('dir=/srv/melete/deploy\n');
      if (line.startsWith('docker ps --all --filter label=com.docker.compose.project='))
        return ok('');
      if (line.startsWith('docker volume ls')) return ok('');
      return { code: 1, stdout: '', stderr: 'no such command in this test' };
    };
    for (const setting of ['COMPOSE_PROJECT_NAME=melete', 'COMPOSE_PROJECT_NAME=']) {
      const context = testContext(deployDir, [], { run });
      expect(await runSet(context, [setting])).toBe(2);
      expect(context.errors()).toContain(
        'Compose project melete is the installation in /srv/melete/deploy',
      );
      expect(read(deployDir, '.env')).toBe(before);
    }
    expect(
      await runSet(testContext(deployDir, [], { run }), ['COMPOSE_PROJECT_NAME=melete3']),
    ).toBe(0);
  });
});

describe('COMPOSE_PROFILES', () => {
  test('is a setting melete set takes, and the contract follows it', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeContract(deployDir, {});
    const context = testContext(deployDir);
    expect(await runSet(context, ['COMPOSE_PROFILES=sandbox'])).toBe(0);
    expect(read(deployDir, '.env')).toMatch(/^COMPOSE_PROFILES=sandbox$/m);
    expect(JSON.parse(read(deployDir, DEPLOY_FILE)).profiles).toEqual(['sandbox']);
    expect(context.printed()).toContain('Apply it with bun run melete deploy.');

    expect(await runSet(testContext(deployDir), ['COMPOSE_PROFILES='])).toBe(0);
    expect(JSON.parse(read(deployDir, DEPLOY_FILE)).profiles).toEqual([]);
  });

  test('another setting leaves a profile written into the contract by hand', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeContract(deployDir, { profiles: ['sandbox'] });
    expect(await runSet(testContext(deployDir), ['MELETE_IMAGE_TAG=v0.3.0'])).toBe(0);
    expect(JSON.parse(read(deployDir, DEPLOY_FILE)).profiles).toEqual(['sandbox']);
  });
});
