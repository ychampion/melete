import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy } from './commands/deploy.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { readHistory } from './history.ts';
import { temporaryDeployDir } from './testing.ts';
import { deployRig, NEW, OLD, REGISTRY, release, whens } from './testing-engine.ts';

const MB = 1024 ** 2;
const short = (commit: string) => commit.slice(0, 7);
const env = (deployDir: string) => readFileSync(join(deployDir, '.env'), 'utf8');
const ref = (name: string, tag: string) => `${REGISTRY}/${name}:${tag}`;

describe('melete deploy', () => {
  test('a moving tag is pinned to its commit tag, checked out, pulled, started, verified and recorded', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    const code = await runDeploy(
      rig.context,
      ['--tag', 'main', '--checkout'],
      false,
      rig.dependencies,
    );
    expect(rig.context.errors()).toBe('');
    expect(code).toBe(0);
    expect(rig.state.pulls).toEqual([
      ref('melete-service', short(NEW)),
      ref('melete-runtime', short(NEW)),
      ref('melete-web', short(NEW)),
    ]);
    expect(env(deployDir)).toContain(`\nMELETE_IMAGE_TAG=${short(NEW)}\n`);
    expect(JSON.parse(readFileSync(join(deployDir, DEPLOY_FILE), 'utf8')).images.tag).toBe(
      short(NEW),
    );
    expect(rig.state.head).toBe(NEW);
    expect(rig.state.restarts).toBe(1);
    // `up`, then `up` again after the service's restart; never a build, never a pull during `up`.
    const ups = rig.state.calls.filter((call) => call.includes(' up -d '));
    expect(ups).toHaveLength(2);
    for (const up of ups) expect(up).toContain('--no-build --pull never --wait');
    const [entry] = readHistory(deployDir);
    expect(entry).toMatchObject({
      command: 'deploy',
      from: { tag: 'main', revision: OLD },
      to: { tag: short(NEW), revision: NEW },
      checkout: { from: OLD, branch: 'main', to: NEW },
      result: 'deployed',
    });
    expect(rig.context.printed()).toContain('deploy: done.');
  });

  test('deploy pulls one image at a time and re-measures disk after each', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const order = rig.state.calls.filter(
      (call) => call.startsWith('docker pull ') || call.includes('/docker-root:ro'),
    );
    const pulls = order.flatMap((call, index) => (call.startsWith('docker pull ') ? [index] : []));
    expect(pulls).toHaveLength(3);
    for (const index of pulls) expect(order[index + 1]).toContain('/docker-root:ro');
  });

  test('deploy refuses with nothing changed when a pull fails, and no container is recreated', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, { failPulls: [`${REGISTRY}/melete-runtime`] });
    const code = await runDeploy(rig.context, ['--checkout'], false, rig.dependencies);
    expect(code).toBe(2);
    expect(rig.state.pulls).toEqual([
      ref('melete-service', short(NEW)),
      ref('melete-runtime', short(NEW)),
    ]);
    expect(env(deployDir)).toBe(rig.envBefore);
    expect(rig.state.head).toBe(OLD);
    expect(rig.state.ups).toBe(0);
    expect(rig.state.restarts).toBe(0);
    expect(rig.state.tagged).toEqual([]);
    expect(rig.context.printed()).toContain('Nothing was changed.');
    expect(rig.context.printed()).toContain(
      `unused until a deploy succeeds: ${ref('melete-service', short(NEW))}`,
    );
    expect(readHistory(deployDir).at(-1)?.result).toBe('refused');
  });

  test('deploy refuses before any pull when the update would leave less than the floor', async () => {
    const deployDir = temporaryDeployDir();
    // Three new 100 MB layers: 300 x 2.2 + 200 MB margin = 860 MB; 1200 - 860 is below 600.
    const rig = deployRig(deployDir, { freeBytes: 1200 * MB });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.state.pulls).toEqual([]);
    expect(env(deployDir)).toBe(rig.envBefore);
    expect(rig.context.printed()).toMatch(
      /fail\s+disk\.pull_estimate\s+1200 MB free; the update needs about 860 MB/,
    );
  });

  test('reaching the floor while pulling stops before the switch', async () => {
    const deployDir = temporaryDeployDir();
    // Each pull really takes six times its download: 1400, 800, then 200 MB free.
    const rig = deployRig(deployDir, { pullCost: 6 });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.state.pulls).toHaveLength(3);
    expect(env(deployDir)).toBe(rig.envBefore);
    expect(rig.state.ups).toBe(0);
    expect(rig.context.printed()).toContain('below the floor of 600 MB');
  });

  test('images from another commit are refused unless the checkout moves or the gap is accepted', async () => {
    const refused = temporaryDeployDir();
    const rig = deployRig(refused);
    expect(await runDeploy(rig.context, [], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toMatch(/fail\s+images\.revision_matches_checkout/);
    expect(rig.state.pulls).toEqual([]);

    const accepted = temporaryDeployDir();
    const other = deployRig(accepted);
    expect(
      await runDeploy(other.context, ['--allow-compose-mismatch'], false, other.dependencies),
    ).toBe(0);
    expect(other.state.head).toBe(OLD);
    expect(other.context.printed()).toMatch(/warn\s+images\.revision_matches_checkout/);
  });

  test('a moving tag whose commit tag is missing is refused', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    rig.state.registry.delete(ref('melete-service', short(NEW)));
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toContain(`main names commit ${short(NEW)}`);
  });

  test('a changed checkout refuses --checkout', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, {
      dirty: ['deploy/docker-compose.yml', 'deploy/config/x.json'],
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toMatch(
      /fail\s+checkout\.clean\s+.*deploy\/docker-compose\.yml$/m,
    );
    expect(rig.context.printed()).not.toContain('deploy/config/x.json');
  });

  test('a dry run of the running release downloads nothing and changes nothing', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    const code = await runDeploy(
      rig.context,
      ['--tag', short(OLD), '--dry-run'],
      true,
      rig.dependencies,
    );
    expect(code).toBe(0);
    const value = JSON.parse(rig.context.printed());
    expect(value.outcome).toBe('planned');
    expect(value.pulls.map((pull: { bytes: number }) => pull.bytes)).toEqual([0, 0, 0]);
    expect(rig.state.pulls).toEqual([]);
    expect(env(deployDir)).toBe(rig.envBefore);
    expect(readHistory(deployDir)).toEqual([]);
    expect(existsSync(join(deployDir, '.melete', 'lock'))).toBe(false);
  });

  test('a second deploy of the same release finds nothing to do', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const pulls = rig.state.pulls.length;
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.state.pulls).toHaveLength(pulls);
    expect(rig.context.printed()).toContain('deploy: the stack already runs this; nothing to do.');
  });

  test('the database is backed up before any pull when the release adds migrations', async () => {
    const deployDir = temporaryDeployDir();
    const backups = join(deployDir, '..', 'backups');
    const rig = deployRig(
      deployDir,
      {
        commits: new Map([
          [OLD, 68],
          [NEW, 69],
        ]),
        failPulls: [`${REGISTRY}/melete-service`],
      },
      { backup: { dir: backups, keep: 3 } },
    );
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    // The pull failed, and the backup taken before it is there and whole.
    const [set] = readdirSync(backups);
    expect(set).toMatch(/^melete-\d{8}T\d{6}Z$/);
    expect(readdirSync(join(backups, set ?? ''))).toContain('database.dump');
    expect(rig.context.printed()).toMatch(/ok\s+backup\.database\s+.*runs 1 new migration/);
  });

  test('migrations are verified against the journal after the switch', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(
      deployDir,
      {
        commits: new Map([
          [OLD, 68],
          [NEW, 69],
        ]),
      },
      { backup: { dir: join(deployDir, '..', 'backups'), keep: 3 } },
    );
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.context.printed()).toMatch(
      /ok\s+verify\.migrations\s+Every one of the 69 migrations in the journal is recorded/,
    );
    expect(readHistory(deployDir)[0]?.backup).toMatch(/melete-\d{8}T\d{6}Z$/);
  });

  test('a release whose migrations are not all recorded after it starts fails the deploy', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(
      deployDir,
      {
        commits: new Map([
          [OLD, 68],
          [NEW, 69],
        ]),
        migrateOnUp: false,
      },
      { backup: { dir: join(deployDir, '..', 'backups'), keep: 3 } },
    );
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(3);
    expect(rig.context.printed()).toMatch(
      /fail\s+verify\.migrations\s+The database has not recorded 1 of the 69 migrations/,
    );
    expect(rig.context.printed()).toContain('it prints the database restore');
    expect(rig.state.removed).toEqual([]);
  });

  test('a migration recorded by another build is reported, and the release runs beside it', async () => {
    const deployDir = temporaryDeployDir();
    // The database already ran the release's newest migration and one more from elsewhere.
    const rig = deployRig(deployDir, {
      commits: new Map([
        [OLD, 68],
        [NEW, 69],
      ]),
      recorded: [...whens(69), whens(70).at(-1) ?? 0],
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toMatch(/warn\s+migrations\.unknown\s+The database records 1 migration/);
    // Nothing is pending, so nothing is backed up first.
    expect(printed).toMatch(/ok\s+backup\.database\s+bbbbbbb adds no migrations/);
    expect(printed).toMatch(/ok\s+verify\.migrations\s+Every one of the 69 migrations/);
  });

  test('a release migration older than the newest recorded one is refused, since it would never run', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, {
      commits: new Map([
        [OLD, 68],
        [NEW, 70],
      ]),
      // 0068 and a later one from elsewhere are recorded; the release's 0069 is not.
      recorded: [...whens(68), (whens(70).at(-1) ?? 0) + 5],
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toMatch(
      /fail\s+migrations\.would_skip\s+2 of bbbbbbb's migrations/,
    );
    expect(rig.state.pulls).toEqual([]);
  });

  test('a release that knows fewer migrations than the database is refused', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, {
      commits: new Map([
        [OLD, 68],
        [NEW, 60],
      ]),
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.printed()).toMatch(/fail\s+migrations\.forward_only/);
    expect(rig.state.pulls).toEqual([]);
  });

  test('a failure after the switch exits 3 and names the rollback', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, { failUp: true });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(3);
    expect(rig.context.printed()).toContain('To go back: bun run melete rollback');
    expect(readHistory(deployDir).at(-1)?.result).toBe('failed');
    // Nothing was removed while the stack was unhealthy.
    expect(rig.state.removed).toEqual([]);
  });

  test('a status check that fails only after the deploy fails it; one that failed before does not', async () => {
    const worse = temporaryDeployDir();
    const rig = deployRig(worse);
    rig.statusAfter = [{ level: 'fail', name: 'API', detail: 'Nothing answered.' }];
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(3);
    expect(rig.context.printed()).toContain('Status got worse: API: Nothing answered.');

    const same = temporaryDeployDir();
    const steady = deployRig(same);
    steady.statusBefore = [{ level: 'fail', name: 'Computer', detail: 'image missing' }];
    steady.statusAfter = [{ level: 'fail', name: 'Computer', detail: 'image missing' }];
    expect(await runDeploy(steady.context, ['--checkout'], false, steady.dependencies)).toBe(0);
    expect(steady.context.printed()).toMatch(
      /warn\s+verify\.status\s+.*failed before the deploy too: Computer/,
    );
  });

  test('deploy prunes only dangling images and nothing labelled for another project', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    const ours = release('melete-web', OLD);
    rig.state.dangling = [
      {
        id: ours.digest,
        repoDigests: [`${REGISTRY}/melete-web@${ours.digest}`],
        layers: [],
        revision: OLD,
      },
      {
        id: 'sha256:redis',
        repoDigests: ['docker.io/library/redis@sha256:redis'],
        layers: [],
        revision: null,
      },
      { id: 'sha256:built-elsewhere', repoDigests: [], layers: [], revision: null },
      {
        id: 'sha256:mixed',
        repoDigests: [`${REGISTRY}/melete-web@sha256:mixed`, 'example.com/other/app@sha256:mixed'],
        layers: [],
        revision: null,
      },
    ];
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.state.removed).toEqual([ours.digest]);
    const removals = rig.state.calls.filter((call) =>
      /prune|docker rmi|image rm|builder/.test(call),
    );
    expect(removals).toEqual([`docker image rm ${ours.digest}`]);
    // The prune comes after the service's restart.
    const restart = rig.state.calls.findIndex((call) =>
      call.startsWith('docker compose restart melete'),
    );
    expect(rig.state.calls.findIndex((call) => call.startsWith('docker image rm'))).toBeGreaterThan(
      restart,
    );
  });

  test('a held lock refuses a deploy with nothing changed', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    const { acquireLock } = await import('./lock.ts');
    const release = acquireLock(deployDir, 'backup', {
      pid: 1,
      host: 'elsewhere',
      now: () => new Date(),
      alive: () => true,
    });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(2);
    expect(rig.context.errors()).toContain('Another melete command holds');
    expect(rig.state.calls).toEqual([]);
    release();
  });
});
