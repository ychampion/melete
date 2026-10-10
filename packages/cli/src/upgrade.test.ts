import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  composeArguments,
  parseArguments,
  UPGRADE_CLIENT_TLS,
  upgradePlan,
} from '../../../deploy/scripts/upgrade.ts';
import { runUpgrade, upgradeOverlayArguments } from './commands/upgrade.ts';
import { CLIENT_TLS } from './database.ts';
import { composeCommand, type DeployConfig, deployConfigSchema } from './deploy-config.ts';
import { ok, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const config = (value: object): DeployConfig =>
  deployConfigSchema.parse({
    contract: 1,
    images: { registry: null, tag: 'local', channel: 'local' },
    ...value,
  });

/** Every overlay, profile, database and blob store the contract can name. */
const EVERYTHING = {
  overlays: ['browser', 'tailscale', 'tailscale-kernel'],
  profiles: ['sandbox'],
  database: { external: true },
  blobs: { store: 's3', bucket: 'melete-blobs' },
};

describe('the upgrade reads the same Compose files and profiles as a deploy', () => {
  test.each([
    ['nothing extra', {}],
    ['the sandbox profile', { profiles: ['sandbox'] }],
    ['an external database', { database: { external: true } }],
    ['an S3 blob store', { blobs: { store: 's3', bucket: 'melete-blobs' } }],
    ['the tailnet with the kernel file', { overlays: ['tailscale', 'tailscale-kernel'] }],
    ['everything at once', EVERYTHING],
  ])('%s', (_name, value) => {
    const installation = config(value);
    const deployDir = '/srv/melete/deploy';
    const options = parseArguments(
      ['v1.0.0', ...upgradeOverlayArguments(installation)],
      new Date(),
      '/home/owner',
      '/srv/melete',
    );
    const relativeToRoot = composeCommand(deployDir, installation).map((part) =>
      part.startsWith('/srv/') ? relative('/srv/melete', part).replaceAll('\\', '/') : part,
    );
    expect(composeArguments(options)).toEqual(relativeToRoot);
  });

  test('the sandbox profile reaches the build, and its computer image is kept for a rollback', () => {
    const options = parseArguments(
      ['v1.0.0', '--profile', 'sandbox'],
      new Date(),
      '/home/owner',
      '/srv/melete',
    );
    const plan = upgradePlan({
      ...options,
      project: 'melete',
      fromCommit: 'a'.repeat(40),
      fromBranch: 'main',
      fromVersion: 'v0.9.0',
    });
    const build = plan.find((step) => step.command.includes('build'));
    expect(build?.command.join(' ')).toContain('--profile sandbox build');
    expect(plan.map((step) => step.command.join(' '))).toContain(
      'docker tag melete-sandbox:local melete-sandbox:v0.9.0',
    );
  });

  test('with an external database, the dump and the migration count use the database client', () => {
    const options = parseArguments(['v1.0.0', '--external-db'], new Date(), '/h', '/srv/melete');
    const lines = upgradePlan({
      ...options,
      project: 'melete',
      fromCommit: 'a'.repeat(40),
      fromBranch: 'main',
      fromVersion: 'v0.9.0',
    }).map((step) => step.command.join(' '));
    const dump = lines.find((line) => line.includes('pg_dump')) ?? '';
    expect(dump).toContain('run --rm --no-deps -T database-client sh -c');
    expect(dump).toContain('--dbname="$DATABASE_URL"');
    expect(lines.some((line) => line.includes('exec -T postgres'))).toBe(false);
  });

  test("the upgrade script's TLS line is the melete command's", () => {
    expect(UPGRADE_CLIENT_TLS).toBe(CLIENT_TLS);
  });
});

describe('melete upgrade', () => {
  const rig = (value: object, rules: Parameters<typeof testContext>[1] = []) => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { MELETE_IMAGE_TAG: 'local' });
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      JSON.stringify({
        contract: 1,
        images: { registry: null, tag: 'local', channel: 'local' },
        ...value,
      }),
    );
    let releaseDir = '';
    const context = testContext(deployDir, rules, {
      attach: async (command) => {
        context.attached.push([...command]);
        releaseDir = resolve(command[1] ?? '', '../../..');
        return 0;
      },
    });
    return { context, deployDir, release: () => releaseDir };
  };

  test("runs the target release's own script, taken from the tag, with every overlay and profile", async () => {
    const { context, deployDir, release } = rig(EVERYTHING, [
      ['git -C', ok('')],
      ['tar -x', ok('')],
    ]);
    expect(await runUpgrade(context, ['v1.0.0', '--dry-run'])).toBe(0);
    const command = context.attached[0] ?? [];
    expect(command[1]).toStartWith(resolve(tmpdir()));
    expect(command[1]).not.toStartWith(deployDir);
    expect(command[1]?.replaceAll('\\', '/')).toEndWith('deploy/scripts/upgrade.ts');
    expect(command.slice(2)).toEqual([
      'v1.0.0',
      '--dry-run',
      '--repository',
      context.root,
      '--browser',
      '--tailscale',
      '--tailscale-kernel',
      '--external-db',
      '--blobs-s3',
      '--profile',
      'sandbox',
    ]);
    const archive = context.docker.calls.find((call) => call.includes('archive'));
    expect(archive).toContain('refs/tags/v1.0.0');
    // The copy is removed once the upgrade has run.
    expect(existsSync(release())).toBe(false);
  });

  test('a tag this clone lacks is fetched, and one that still is not there is refused', async () => {
    const { context } = rig({}, [['git -C', { code: 1 }]]);
    expect(await runUpgrade(context, ['v9.9.9'])).toBe(2);
    expect(context.docker.calls.some((call) => call.includes('fetch'))).toBe(true);
    expect(context.attached).toEqual([]);
    expect(context.errors()).toContain('The tag v9.9.9 is not in this checkout');
  });

  test('overlay options given by hand are refused: the contract decides them', async () => {
    const { context } = rig({});
    for (const option of ['--profile', '--external-db', '--blobs-s3', '--browser'])
      expect(await runUpgrade(context, ['v1.0.0', option])).toBe(2);
    expect(context.attached).toEqual([]);
  });
});
