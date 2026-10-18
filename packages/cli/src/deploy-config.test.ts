import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { composeArguments, parseArguments } from '../../../deploy/scripts/upgrade.ts';
import { judgeContract } from './commands/check.ts';
import { upgradeOverlayArguments } from './commands/upgrade.ts';
import {
  composeCommand,
  composeFiles,
  DEPLOY_FILE,
  defaultDeployConfig,
  loadDeployConfig,
  ownComposeFiles,
  parseDeployConfig,
} from './deploy-config.ts';
import { readInstallation } from './installation.ts';

const valid = (text: string) => {
  const loaded = parseDeployConfig(text);
  if (loaded.kind !== 'found') throw new Error(JSON.stringify(loaded));
  return loaded.config;
};

const issues = (text: string) => {
  const loaded = parseDeployConfig(text);
  return loaded.kind === 'invalid' ? loaded.issues.join('\n') : '';
};

describe('where backups go by default', () => {
  test('each project has a folder of its own; melete keeps the folder it always had', () => {
    expect(valid('{"contract":1}').backup.dir).toBe('~/melete-backups');
    expect(valid('{"contract":1,"project":"melete-two"}').backup).toEqual({
      dir: '~/melete-backups/melete-two',
      keep: 3,
      max_age_days: 30,
    });
    expect(valid('{"contract":1,"project":"melete-two","backup":{"keep":5}}').backup).toEqual({
      dir: '~/melete-backups/melete-two',
      keep: 5,
      max_age_days: 30,
    });
    expect(
      valid('{"contract":1,"project":"melete-two","backup":{"dir":"/srv/b"}}').backup.dir,
    ).toBe('/srv/b');
  });
});

describe('the deploy contract', () => {
  test('a file with only the contract number takes every default', () => {
    expect(valid('{"contract":1}')).toEqual(defaultDeployConfig());
    expect(defaultDeployConfig()).toMatchObject({
      project: 'melete',
      images: { registry: 'ghcr.io/ychampion', tag: 'main', channel: 'main' },
      disk: { min_free_mb: 4096, pull_margin_mb: 512 },
      public_ports: false,
    });
  });

  test('a floor below 1 GB is expressible in MB', () => {
    expect(valid('{"contract":1,"disk":{"min_free_mb":600,"pull_margin_mb":200}}').disk).toEqual({
      min_free_mb: 600,
      pull_margin_mb: 200,
    });
  });

  test('a contract this release does not know is refused rather than guessed at', () => {
    expect(issues('{"contract":2}')).toContain('this release reads contract 1');
  });

  test('a misspelt key is refused, so a floor never falls back to its default unnoticed', () => {
    expect(issues('{"contract":1,"disk":{"min_free_gb":1}}')).toContain('disk');
    expect(issues('{"contract":1,"publicPorts":true}')).not.toBe('');
  });

  test('images built here carry no registry, and published images carry one', () => {
    expect(
      valid('{"contract":1,"images":{"registry":null,"tag":"local","channel":"local"}}').images
        .registry,
    ).toBeNull();
    expect(issues('{"contract":1,"images":{"registry":null,"tag":"main"}}')).toContain('images');
    expect(issues('{"contract":1,"images":{"tag":"local"}}')).toContain('images');
  });

  test('the kernel Tailscale overlay is read on top of the ordinary one', () => {
    expect(issues('{"contract":1,"overlays":["tailscale-kernel"]}')).toContain('tailscale');
    const config = valid(
      '{"contract":1,"overlays":["tailscale-kernel","tailscale"],"profiles":["sandbox"]}',
    );
    const command = composeCommand('/srv/melete/deploy', config).join(' ');
    // Compose reads files in order: the base, then tailscale, then the kernel variant.
    expect(command).toMatch(
      /docker-compose\.yml -f .*docker-compose\.tailscale\.yml -f .*docker-compose\.tailscale-kernel\.yml --profile sandbox$/,
    );
  });

  test('text that is not JSON is named as such', () => {
    expect(issues('{contract:1}')).toContain('is not JSON');
  });
});

describe("the installation's own compose files", () => {
  let dir = '';
  let deployDir = '';
  const write = (config: unknown) =>
    writeFileSync(join(deployDir, DEPLOY_FILE), JSON.stringify(config), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'melete-compose-files-'));
    deployDir = join(dir, 'deploy');
    mkdirSync(deployDir);
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'private', 'compose.extra.yml'), 'services: {}\n');
    writeFileSync(join(deployDir, 'docker-compose.brand.yml'), 'services: {}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('they default to none, so an existing contract reads the same files as before', () => {
    expect(defaultDeployConfig().compose_files).toEqual([]);
    expect(composeFiles('/srv/melete/deploy', defaultDeployConfig())).toHaveLength(1);
  });

  test('each is read after every built-in file, in the order listed', () => {
    write({
      contract: 1,
      overlays: ['browser'],
      database: { external: true },
      blobs: { store: 's3', bucket: 'b' },
      compose_files: ['../private/compose.extra.yml', 'docker-compose.brand.yml'],
    });
    const loaded = loadDeployConfig(deployDir);
    if (loaded.kind !== 'found') throw new Error(JSON.stringify(loaded));
    const names = composeFiles(deployDir, loaded.config).map((file) =>
      relative(dir, file).split(sep).join('/'),
    );
    expect(names).toEqual([
      'deploy/docker-compose.yml',
      'deploy/docker-compose.browser.yml',
      'deploy/docker-compose.external-db.yml',
      'deploy/docker-compose.blobs-s3.yml',
      'private/compose.extra.yml',
      'deploy/docker-compose.brand.yml',
    ]);
    const command = composeCommand(deployDir, { ...loaded.config, profiles: ['sandbox'] });
    expect(command.slice(-4)).toEqual([
      '-f',
      join(deployDir, 'docker-compose.brand.yml'),
      '--profile',
      'sandbox',
    ]);
    expect(ownComposeFiles(deployDir, loaded.config)).toEqual(
      names.slice(-2).map((name) => join(dir, name)),
    );
  });

  test('a file that is not there makes the contract invalid, naming it', () => {
    write({ contract: 1, compose_files: ['docker-compose.brand.yml', '../private/missing.yml'] });
    const loaded = loadDeployConfig(deployDir);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' ? loaded.issues : []).toEqual([
      'compose_files.1: deploy/../private/missing.yml does not exist',
    ]);
    // A folder is not a Compose file either.
    mkdirSync(join(dir, 'private', 'folder.yml'));
    write({ contract: 1, compose_files: ['../private/folder.yml'] });
    expect(loadDeployConfig(deployDir).kind).toBe('invalid');
  });

  test('a path must be relative to deploy/, a YAML file, listed once and not a built-in', () => {
    for (const file of [
      '/etc/compose.yml',
      'C:/compose.yml',
      '..\\private\\compose.yml',
      'compose.json',
      'docker-compose.yml',
      'docker-compose.browser.yml',
      'docker-compose.blobs-s3.yml',
      '',
    ])
      expect(issues(JSON.stringify({ contract: 1, compose_files: [file] })), file).toContain(
        'compose_files',
      );
    expect(
      issues(
        '{"contract":1,"compose_files":["docker-compose.brand.yml","docker-compose.brand.yml"]}',
      ),
    ).toContain('each file once');
  });

  test('a path is written one way, so a built-in or a listed file cannot be named twice', () => {
    for (const file of [
      './docker-compose.yml',
      './docker-compose.brand.yml',
      'brand//compose.yml',
      'brand/./compose.yml',
      'brand/../docker-compose.yml',
      '../private/../deploy/docker-compose.brand.yml',
    ])
      expect(issues(JSON.stringify({ contract: 1, compose_files: [file] })), file).toContain(
        'compose_files',
      );
    // Normalised, and still the base file or one already listed: judged by where it lands.
    write({ contract: 1, compose_files: ['../deploy/docker-compose.yml'] });
    const base = loadDeployConfig(deployDir);
    expect(base.kind === 'invalid' ? base.issues.join() : base.kind).toContain(
      'is a file the stack already reads',
    );
    write({
      contract: 1,
      compose_files: ['docker-compose.brand.yml', '../deploy/docker-compose.brand.yml'],
    });
    const twice = loadDeployConfig(deployDir);
    expect(twice.kind === 'invalid' ? twice.issues : []).toEqual([
      'compose_files.1: deploy/../deploy/docker-compose.brand.yml is a file the stack already reads',
    ]);
    for (const file of ['./docker-compose.brand.yml', 'brand/../x.yml'])
      expect(
        () => parseArguments(['v1.2.3', '--compose-file', file], new Date(0), '/h', '/r'),
        file,
      ).toThrow();
  });

  test('status, doctor and check name them in the contract line', () => {
    write({ contract: 1, compose_files: ['../private/compose.extra.yml'] });
    const result = judgeContract(readInstallation(deployDir));
    expect(result.level).toBe('ok');
    expect(result.detail).toBe(
      'melete.deploy.json, contract 1; also reads deploy/../private/compose.extra.yml',
    );
    write({ contract: 1, compose_files: ['../private/gone.yml'] });
    const missing = judgeContract(readInstallation(deployDir));
    expect(missing.level).toBe('fail');
    expect(missing.detail).toContain('deploy/../private/gone.yml does not exist');
  });

  test('an upgrade names them to the upgrade script, which reads them in the same place', () => {
    const config = valid('{"contract":1,"compose_files":["../private/compose.extra.yml"]}');
    const args = upgradeOverlayArguments(config);
    expect(args).toEqual(['--compose-file', '../private/compose.extra.yml']);
    const parsed = parseArguments(['v1.2.3', ...args], new Date(0), '/home/op', '/srv/melete');
    expect(composeArguments(parsed).slice(-2)).toEqual(['-f', 'private/compose.extra.yml']);
    expect(() =>
      parseArguments(['v1.2.3', '--compose-file', '/etc/x.yml'], new Date(0), '/h', '/r'),
    ).toThrow();
  });
});
