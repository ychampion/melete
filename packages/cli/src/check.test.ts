// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose substitutions, not templates.
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeCheck, runCheck } from './commands/check.ts';
import { readInstallation } from './installation.ts';
import { reportSchema } from './schema.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const contract = (deployDir: string, value: object) =>
  writeFileSync(join(deployDir, 'melete.deploy.json'), JSON.stringify({ contract: 1, ...value }));

const EXTERNAL_URL = `postgres://melete:${'e'.repeat(32)}@db.example.net:5432/melete?sslmode=require`;

const judge = (deployDir: string) => judgeCheck(readInstallation(deployDir, 'linux'));
const find = (deployDir: string, id: string) => judge(deployDir).find((result) => result.id === id);
const failed = (deployDir: string) =>
  judge(deployDir)
    .filter((result) => result.level === 'fail')
    .map((result) => result.id);

describe('melete check', () => {
  test('a configured installation with its contract passes every rule, without asking Docker', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    contract(deployDir, {});
    // Judged with this machine's real file modes.
    const base = testContext(deployDir);
    const context = { ...base, machine: { ...base.machine, platform: process.platform } };
    expect(runCheck(context, true)).toBe(0);
    const value = reportSchema.parse(JSON.parse(base.printed()));
    // What an installation for other people needs is a warning on one not marked
    // hosted; the browser worker is turned on once the account exists.
    expect(
      value.results.filter((result) => result.level !== 'ok').map((result) => result.id),
    ).toEqual(['hosted.public_url', 'hosted.alerts', 'hosted.operator_token', 'browser.worker']);
    expect(value.results.every((result) => result.level !== 'fail')).toBe(true);
    expect(value.results.map((result) => result.id)).toEqual(
      expect.arrayContaining([
        'deploy.contract',
        'env.service',
        'ports.loopback_only',
        'images.tag_matches_contract',
        'compose.boundaries',
      ]),
    );
    expect(base.docker.calls).toEqual([]);
  });

  test('a missing secret fails under its own rule id and its value is never printed', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_MASTER_KEY: '' });
    contract(deployDir, {});
    expect(find(deployDir, 'env.master_key')).toMatchObject({
      level: 'fail',
      fix: expect.stringContaining('--from-env MELETE_MASTER_KEY'),
    });
    const context = testContext(deployDir);
    expect(runCheck(context, false)).toBe(1);
    expect(context.printed()).not.toContain('sk-test-value');
    expect(context.printed()).not.toContain('d'.repeat(48));
  });

  test("a setting the service's own schema refuses fails the check", () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_SANDBOX_PROVIDER: 'docker', MELETE_SANDBOX_PROJECT: '' });
    contract(deployDir, { profiles: ['sandbox'] });
    expect(failed(deployDir)).toEqual(['env.service.sandbox_project']);
  });

  test('the template database password fails', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: 'postgres://melete:CHANGE_ME@postgres:5432/melete' });
    contract(deployDir, {});
    expect(failed(deployDir)).toContain('env.database_url');
  });

  test('a port published beyond loopback fails unless the contract allows public ports', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    contract(deployDir, {});
    const compose = join(deployDir, 'docker-compose.yml');
    writeFileSync(
      compose,
      readFileSync(compose, 'utf8').replace(
        '"127.0.0.1:${WEB_PORT:-3101}:3000"',
        '"${WEB_PORT:-3101}:3000"',
      ),
    );
    expect(find(deployDir, 'ports.loopback_only')).toMatchObject({
      level: 'fail',
      detail: expect.stringContaining('web on every address:3101'),
    });
    contract(deployDir, { public_ports: true });
    expect(find(deployDir, 'ports.loopback_only')?.level).toBe('warn');
  });

  test('an IPv4 or IPv6 address other than loopback counts as public', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    contract(deployDir, {});
    const compose = join(deployDir, 'docker-compose.yml');
    const text = readFileSync(compose, 'utf8');
    writeFileSync(
      compose,
      text.replace('"127.0.0.1:${WEB_PORT:-3101}:3000"', '"0.0.0.0:3101:3000"'),
    );
    expect(find(deployDir, 'ports.loopback_only')?.level).toBe('fail');
    writeFileSync(compose, text.replace('"127.0.0.1:${WEB_PORT:-3101}:3000"', '"[::]:3101:3000"'));
    expect(find(deployDir, 'ports.loopback_only')?.level).toBe('fail');
    writeFileSync(compose, text.replace('"127.0.0.1:${WEB_PORT:-3101}:3000"', '"[::1]:3101:3000"'));
    expect(find(deployDir, 'ports.loopback_only')?.level).toBe('ok');
  });

  test('an image tag of local while a registry is set fails', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '' });
    contract(deployDir, {});
    expect(find(deployDir, 'images.tag_not_local')).toMatchObject({
      level: 'fail',
      fix: 'Run bun run melete set MELETE_IMAGE_TAG=main.',
    });
    // The registry may also come from deploy/.env alone, with no contract yet.
    const bare = temporaryDeployDir();
    writeEnv(bare, { MELETE_IMAGE_TAG: '', MELETE_IMAGE_REGISTRY: 'registry.example/team' });
    expect(failed(bare)).toContain('images.tag_not_local');
  });

  test('images built here pass when the contract says so', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '' });
    contract(deployDir, { images: { registry: null, tag: 'local', channel: 'local' } });
    expect(failed(deployDir)).toEqual([]);
  });

  test('deploy/.env running another tag, registry or project than the contract fails', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: '34a9140', COMPOSE_PROJECT_NAME: 'other' });
    contract(deployDir, { images: { registry: 'registry.example/team', tag: 'main' } });
    expect(failed(deployDir)).toEqual(
      expect.arrayContaining([
        'images.tag_matches_contract',
        'images.registry_matches_contract',
        'project.matches_env',
      ]),
    );
  });

  test('an overlay adds its own required settings', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { TS_AUTHKEY: '' });
    contract(deployDir, { overlays: ['tailscale'] });
    expect(failed(deployDir)).toEqual(['env.ts_authkey']);
  });

  test('a contract asking for what this checkout cannot run fails closed', () => {
    const deployDir = temporaryDeployDir();
    // An older checkout, from before the external database file.
    rmSync(join(deployDir, 'docker-compose.external-db.yml'));
    writeEnv(deployDir, { DATABASE_URL: EXTERNAL_URL });
    contract(deployDir, {
      database: { external: true },
      cells: { hosts: ['tcp+tls://cells-1:2376'] },
    });
    expect(failed(deployDir)).toEqual(['compose.files', 'database.supported', 'cells.supported']);
  });

  test('an invalid contract fails, and no contract only warns', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    expect(find(deployDir, 'deploy.contract')?.level).toBe('warn');
    expect(failed(deployDir)).toEqual([]);
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      '{"contract":1,"disk":{"min_free_mb":-1}}',
    );
    expect(find(deployDir, 'deploy.contract')).toMatchObject({
      level: 'fail',
      detail: expect.stringContaining('disk.min_free_mb'),
    });
  });

  test('no deploy/.env fails with the command that writes one', () => {
    const deployDir = temporaryDeployDir();
    expect(find(deployDir, 'env.file')).toMatchObject({
      level: 'fail',
      fix: 'Run bun run melete init.',
    });
  });

  test('a deploy/.env other accounts can read is warned about', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    const installation = readInstallation(deployDir, 'linux');
    const results = judgeCheck({ ...installation, envMode: 0o644 });
    expect(results.find((result) => result.id === 'env.file_private')?.level).toBe('warn');
    expect(
      judgeCheck({ ...installation, envMode: 0o600 }).some((r) => r.id === 'env.file_private'),
    ).toBe(false);
  });
});
