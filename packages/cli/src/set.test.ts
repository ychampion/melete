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
    expect(context.printed()).toBe('Set WEB_PORT=3201.\n');
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
    expect(context.printed()).toBe('Set ELEVENLABS_API_KEY.\n');
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

  test('without deploy/.env it is refused and points at init', async () => {
    const context = testContext(temporaryDeployDir());
    expect(await runSet(context, ['WEB_PORT=3201'])).toBe(2);
    expect(context.errors()).toContain('bun run melete init');
  });
});
