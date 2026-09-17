import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOutput } from '../../apps/melete/src/runtime/docker-engine.ts';
import {
  type CommandRunner,
  judgePreflight,
  type PreflightFacts,
  parseArguments,
  renderCommand,
  rollbackSteps,
  runUpgrade,
  spawnRunner,
  type UpgradeContext,
  upgradePlan,
} from './upgrade.ts';

const GIB = 1024 ** 3;
const context: UpgradeContext = {
  tag: 'v0.2.0',
  backupDir: '/srv/backups/melete-upgrade-v0.2.0',
  repositoryRoot: '/srv/melete',
  browser: false,
  waitTimeoutSeconds: 300,
  project: 'melete',
  fromCommit: 'a'.repeat(40),
  fromBranch: 'main',
  fromVersion: 'v0.1.0',
};
const lines = (steps: ReturnType<typeof upgradePlan>) => steps.map((step) => renderCommand(step));
const indexOf = (rendered: string[], fragment: string) => {
  const index = rendered.findIndex((line) => line.includes(fragment));
  if (index < 0) throw new Error(`no step contains: ${fragment}`);
  return index;
};

describe('the upgrade plan', () => {
  const plan = upgradePlan(context);
  const rendered = lines(plan);

  test('stops the writers, then backs everything up, before the tree changes', () => {
    const stop = indexOf(rendered, 'stop melete runtime web');
    const dump = indexOf(rendered, 'pg_dump');
    const verifyDump = indexOf(rendered, 'pg_restore --list');
    const env = indexOf(rendered, 'cp -p deploy/.env');
    const data = indexOf(rendered, 'cp -a melete:/data -');
    const work = indexOf(rendered, 'cp -a melete:/work -');
    const journal = indexOf(rendered, 'cp -a melete:/data/restrictions -');
    const checkout = indexOf(rendered, 'checkout --detach refs/tags/v0.2.0');
    expect(stop).toBeLessThan(dump);
    expect(dump).toBeLessThan(verifyDump);
    for (const backup of [dump, verifyDump, env, data, work, journal])
      expect(backup).toBeLessThan(checkout);
    expect(plan.filter((step) => step.phase === 'backup').length).toBeGreaterThanOrEqual(8);
  });

  test('dumps in custom format into a private directory and keeps the journal apart', () => {
    expect(rendered[0]).toBe('mkdir -m 700 /srv/backups/melete-upgrade-v0.2.0');
    const dump = plan[indexOf(rendered, 'pg_dump')];
    expect(dump?.command.join(' ')).toContain('--format=custom');
    expect(dump?.stdoutFile).toBe('/srv/backups/melete-upgrade-v0.2.0/database.dump');
    const journal = plan[indexOf(rendered, 'melete:/data/restrictions -')];
    expect(journal?.stdoutFile).toBe('/srv/backups/melete-upgrade-v0.2.0/restrictions.tar');
    expect(rendered).toContain(
      'docker compose -f deploy/docker-compose.yml cp -a melete:/data - > /srv/backups/melete-upgrade-v0.2.0/data.tar',
    );
    expect(indexOf(rendered, 'chmod 600')).toBeLessThan(indexOf(rendered, 'checkout --detach'));
    expect(indexOf(rendered, 'sha256sum')).toBeLessThan(indexOf(rendered, 'checkout --detach'));
  });

  test('keeps the running images, then builds and tags the release as well as :local', () => {
    const keep = indexOf(rendered, 'docker tag melete-service:local melete-service:v0.1.0');
    const checkout = indexOf(rendered, 'checkout --detach');
    const install = indexOf(rendered, 'bun install --frozen-lockfile');
    const check = indexOf(rendered, 'bun run compose:check');
    const build = indexOf(rendered, 'docker compose -f deploy/docker-compose.yml build');
    const up = indexOf(rendered, 'up -d --wait --wait-timeout 300');
    expect(keep).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(install);
    expect(install).toBeLessThan(check);
    expect(check).toBeLessThan(build);
    for (const image of ['melete-service', 'melete-web', 'melete-runtime']) {
      const tag = indexOf(rendered, `docker tag ${image}:local ${image}:v0.2.0`);
      expect(tag).toBeGreaterThan(build);
      expect(tag).toBeLessThan(up);
      expect(rendered).toContain(`docker tag ${image}:local ${image}:v0.1.0`);
    }
  });

  test('waits for health and then for every migration in the new journal', () => {
    const up = indexOf(rendered, 'up -d --wait --wait-timeout 300');
    const migrations = plan.findIndex((step) => step.until === 'journal-recorded');
    expect(migrations).toBeGreaterThan(up);
    expect(rendered[migrations]).toContain('select count(*) from drizzle.__drizzle_migrations');
    expect(migrations).toBe(plan.length - 1);
  });

  test('never removes a volume, prunes, or restores over a live schema', () => {
    const everything = rendered.join('\n');
    expect(everything).not.toMatch(/--volumes|down -v|prune|volume rm|--clean|--remove-orphans/);
    expect(everything).not.toMatch(/push|login/);
  });

  test('a custom project and the browser override reach every Compose command', () => {
    const custom = lines(upgradePlan({ ...context, project: 'assistant', browser: true }));
    const compose = custom.filter((line) => line.startsWith('docker compose '));
    expect(compose.length).toBeGreaterThan(5);
    for (const line of compose)
      expect(line).toContain('-f deploy/docker-compose.yml -f deploy/docker-compose.browser.yml');
    expect(indexOf(custom, 'stop melete runtime web browser')).toBeGreaterThan(0);
  });
});

describe('the rollback steps', () => {
  const steps = rollbackSteps({ ...context, project: 'assistant' });
  const text = steps.join('\n');
  // The comments warn against the flags the commands must never carry.
  const commands = steps.filter((line) => !line.startsWith('#')).join('\n');

  test('restore the dump into an empty database volume and keep the newer journal', () => {
    const down = steps.findIndex((line) => line.endsWith('docker-compose.yml down'));
    const checkout = steps.findIndex((line) => line.includes('git checkout main'));
    const remove = steps.indexOf('docker volume rm assistant_pgdata');
    const postgres = steps.findIndex((line) => line.endsWith('up -d --wait postgres'));
    const restore = steps.findIndex((line) => line.includes('pg_restore'));
    const up = steps.findIndex((line) => line.endsWith('up -d --wait --wait-timeout 300'));
    expect(down).toBeGreaterThanOrEqual(0);
    expect(down).toBeLessThan(checkout);
    expect(checkout).toBeLessThan(remove);
    expect(remove).toBeLessThan(postgres);
    expect(postgres).toBeLessThan(restore);
    expect(restore).toBeLessThan(up);
    expect(steps[restore]).toContain('--no-owner --no-privileges --exit-on-error');
    expect(steps[restore]).toContain('< /srv/backups/melete-upgrade-v0.2.0/database.dump');
    expect(steps[restore]).not.toContain('--clean');
    expect(commands).not.toMatch(/--volumes|down -v|prune/);
    // Exactly one volume is ever removed, and it is not the journal.
    expect(commands.match(/volume rm/g)).toHaveLength(1);
    expect(commands).not.toMatch(/volume rm .*restrictions/);
    expect(text).toContain('assistant_restrictions');
  });

  test('reuse the preserved images instead of rebuilding the old release', () => {
    for (const image of ['melete-service', 'melete-web', 'melete-runtime'])
      expect(steps).toContain(`docker tag ${image}:v0.1.0 ${image}:local`);
  });

  test('a detached start returns to the commit, not to a branch', () => {
    const detached = rollbackSteps({ ...context, fromBranch: null });
    expect(detached).toContain(`git checkout --detach ${'a'.repeat(40)}`);
  });
});

describe('arguments', () => {
  const now = new Date('2030-01-02T03:04:05Z');
  test('a tag, a default private backup directory and the dry-run flag', () => {
    expect(parseArguments(['v0.2.0', '--dry-run'], now, '/home/owner', '/srv/melete')).toEqual({
      tag: 'v0.2.0',
      dryRun: true,
      browser: false,
      waitTimeoutSeconds: 300,
      repositoryRoot: '/srv/melete',
      backupDir: '/home/owner/melete-backups/upgrade-v0.2.0-20300102T030405Z',
    });
    expect(
      parseArguments(
        ['--backup-dir', '/mnt/b', 'v1.2.3-rc.1', '--browser', '--wait-timeout', '600'],
        now,
        '/home/owner',
        '/srv/melete',
      ),
    ).toMatchObject({
      tag: 'v1.2.3-rc.1',
      dryRun: false,
      browser: true,
      waitTimeoutSeconds: 600,
      backupDir: '/mnt/b/upgrade-v1.2.3-rc.1-20300102T030405Z',
    });
  });

  test.each([
    [[]],
    [['main']],
    [['--upload-pack=x']],
    [['v0.2.0; rm -rf /']],
    [['v0.2.0', 'v0.3.0']],
    [['v0.2.0', '--backup-dir']],
    [['v0.2.0', '--backup-dir', 'relative/path']],
    [['v0.2.0', '--wait-timeout', 'soon']],
    [['v0.2.0', '--force']],
  ])('refuses %j', (argv) => {
    expect(() => parseArguments(argv, now, '/home/owner', '/srv/melete')).toThrow('Usage:');
  });
});

const ready: PreflightFacts = {
  tag: 'v0.2.0',
  status: '',
  tagCommit: 'b'.repeat(40),
  headCommit: 'a'.repeat(40),
  targetContainsHead: true,
  configChangedInTarget: false,
  envFile: true,
  docker: {
    engine: { code: 0, stdout: '1.48 28.0.0', stderr: '' },
    compose: { code: 0, stdout: '2.33.1', stderr: '' },
  },
  postgresRunning: true,
  serviceContainer: true,
  dockerRootFreeBytes: 20 * GIB,
  backupFreeBytes: 20 * GIB,
  backupEstimateBytes: 1 * GIB,
};

describe('the preflight', () => {
  test('a clean tree, a known tag, a supported engine and enough disk pass', () => {
    expect(judgePreflight(ready)).toEqual([]);
  });

  test('a modified or untracked file outside the operator configuration refuses', () => {
    const problems = judgePreflight({
      ...ready,
      status: ' M apps/melete/src/index.ts\n?? notes.txt\n M deploy/config/connections.json\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('apps/melete/src/index.ts');
    expect(problems[0]).toContain('notes.txt');
    expect(problems[0]).not.toContain('connections.json');
  });

  test('edited operator configuration passes unless the release also changed it', () => {
    const edited = { ...ready, status: ' M deploy/config/connections.json\n' };
    expect(judgePreflight(edited)).toEqual([]);
    const problems = judgePreflight({ ...edited, configChangedInTarget: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('deploy/config');
  });

  test('a missing tag, the current release and an older release are refused', () => {
    expect(judgePreflight({ ...ready, tagCommit: null })[0]).toContain('git fetch --tags');
    expect(judgePreflight({ ...ready, tagCommit: ready.headCommit })[0]).toContain(
      'already at v0.2.0',
    );
    expect(judgePreflight({ ...ready, targetContainsHead: false })[0]).toContain(
      'does not contain the running commit',
    );
  });

  test('an old engine, an old Compose and a stopped database are named', () => {
    const problems = judgePreflight({
      ...ready,
      docker: {
        engine: { code: 0, stdout: '1.47 27.5.1', stderr: '' },
        compose: { code: 0, stdout: '2.30.0', stderr: '' },
      },
      postgresRunning: false,
      serviceContainer: false,
      envFile: false,
    });
    expect(problems.some((line) => line.includes('Docker Engine 27.5.1'))).toBe(true);
    expect(problems.some((line) => line.includes('Docker Compose 2.30.0'))).toBe(true);
    expect(problems.some((line) => line.includes('postgres service is not running'))).toBe(true);
    expect(problems.some((line) => line.includes('melete service has no container'))).toBe(true);
    expect(problems.some((line) => line.includes('deploy/.env'))).toBe(true);
  });

  test('too little disk for the rebuild or for the backup is refused with numbers', () => {
    const docker = judgePreflight({ ...ready, dockerRootFreeBytes: 7 * GIB });
    expect(docker).toHaveLength(1);
    expect(docker[0]).toContain('7.0 GiB free');
    expect(docker[0]).toContain('8.0 GiB');
    // 10 GiB of data needs 12 GiB and a margin; 11 GiB is not enough.
    const backup = judgePreflight({
      ...ready,
      backupEstimateBytes: 10 * GIB,
      backupFreeBytes: 11 * GIB,
    });
    expect(backup).toHaveLength(1);
    expect(backup[0]).toContain('backup');
    expect(
      judgePreflight({ ...ready, backupEstimateBytes: 10 * GIB, backupFreeBytes: 13 * GIB }),
    ).toEqual([]);
    expect(judgePreflight({ ...ready, dockerRootFreeBytes: null })[0]).toContain(
      'could not be measured',
    );
    expect(judgePreflight({ ...ready, backupFreeBytes: null })[0]).toContain(
      'could not be measured',
    );
  });

  test('a backup whose size could not be measured is refused, not sized at the floor', () => {
    // Plenty of free space proves nothing when the data it must hold is unknown.
    const problems = judgePreflight({
      ...ready,
      backupEstimateBytes: null,
      backupFreeBytes: 500 * GIB,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('size of the backup could not be measured');
  });
});

/** Answers the read-only queries of a healthy installation; records every command. */
function host(overrides: Record<string, Partial<CommandOutput>> = {}) {
  const commands: string[] = [];
  let migrationQueries = 0;
  const answers: Record<string, string> = {
    'git status --porcelain': '',
    'git rev-parse --verify --quiet refs/tags/v0.2.0^{commit}': 'b'.repeat(40),
    'git rev-parse HEAD': 'a'.repeat(40),
    'git symbolic-ref -q --short HEAD': 'main',
    'git describe --tags --always': 'v0.1.0',
    'docker version': '1.48 28.0.0',
    'docker compose version --short': '2.33.1',
    'docker info': '/var/lib/docker',
    'df -Pk':
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 1 41943040 1% /',
    ' ps -q postgres': 'c'.repeat(64),
    ' ps -a -q melete': 'd'.repeat(64),
    'du -sk /data /work': '2048\t/data\n1024\t/work',
    pg_database_size: '10485760',
  };
  const run: CommandRunner = async (command, options) => {
    const line = renderCommand({ command, ...options });
    commands.push(line);
    for (const [fragment, override] of Object.entries(overrides))
      if (line.includes(fragment)) return { code: 0, stdout: '', stderr: '', ...override };
    if (line.includes('__drizzle_migrations')) {
      migrationQueries += 1;
      // The service is still migrating on the first look.
      return { code: 0, stdout: migrationQueries === 1 ? '35\n' : '37\n', stderr: '' };
    }
    const answer = Object.entries(answers).find(([fragment]) => line.includes(fragment));
    return { code: 0, stdout: answer?.[1] ?? '', stderr: '' };
  };
  return { run, commands };
}

const options = {
  tag: 'v0.2.0',
  backupDir: '/srv/backups/upgrade-v0.2.0',
  repositoryRoot: '/srv/melete',
  browser: false,
  waitTimeoutSeconds: 300,
};
const dependencies = (run: CommandRunner, output: string[]) => ({
  run,
  log: (line: string) => {
    output.push(line);
  },
  sleep: async () => {},
  journalEntries: async () => 37,
  environment: async () => ({ COMPOSE_PROJECT_NAME: 'melete' }),
});
const mutating = /\b(stop|checkout|build|tag|up -d|mkdir|chmod|cp -|install|pg_dump|down)\b/;

describe('running the upgrade with an injected command runner', () => {
  test('a dry run prints the plan and the rollback and changes nothing', async () => {
    const { run, commands } = host();
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: true }, dependencies(run, output));
    expect(result.status).toBe('planned');
    expect(commands.filter((line) => mutating.test(line))).toEqual([]);
    const text = output.join('\n');
    expect(text).toContain('Dry run: nothing below was executed.');
    expect(text).toContain('git -c advice.detachedHead=false checkout --detach refs/tags/v0.2.0');
    expect(text).toContain('docker tag melete-service:local melete-service:v0.2.0');
    expect(text).toContain('docker volume rm melete_pgdata');
    expect(text).toContain('Preflight passed');
  });

  test('a dry run still prints the plan when the preflight finds problems', async () => {
    const { run, commands } = host({ 'git status --porcelain': { stdout: ' M README.md\n' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: true }, dependencies(run, output));
    expect(result.status).toBe('refused');
    expect(commands.filter((line) => mutating.test(line))).toEqual([]);
    expect(output.join('\n')).toContain('README.md');
    expect(output.join('\n')).toContain('checkout --detach refs/tags/v0.2.0');
  });

  test('volumes that cannot be measured stop the upgrade before the backup', async () => {
    const { run, commands } = host({
      'du -sk /data /work': { code: 1, stderr: 'du: cannot read directory: Permission denied' },
    });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('refused');
    expect(commands.filter((line) => mutating.test(line))).toEqual([]);
    expect(output.join('\n')).toContain('size of the backup could not be measured');
  });

  test('a failed preflight stops before anything is touched', async () => {
    const { run, commands } = host({ 'docker version': { stdout: '1.47 27.5.1' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('refused');
    expect(commands.filter((line) => mutating.test(line))).toEqual([]);
    expect(output.join('\n')).toContain('Docker Engine 27.5.1 (API 1.47) is too old');
  });

  test('a full run executes the plan in order and waits for the migrations', async () => {
    const { run, commands } = host();
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('upgraded');
    const planned = lines(upgradePlan({ ...context, backupDir: options.backupDir }));
    const executed = commands.slice(commands.indexOf(planned[0] ?? ''));
    // The migration query repeats until the journal is recorded; nothing else differs.
    expect(executed.filter((line, index) => line !== executed[index - 1])).toEqual(planned);
    expect(executed.filter((line) => line.includes('__drizzle_migrations'))).toHaveLength(2);
    expect(output.join('\n')).toContain('37 of 37 migrations recorded');
    expect(output.join('\n')).toContain('docker volume rm melete_pgdata');
  });

  test('a failed backup restarts the stopped services and never switches the tree', async () => {
    const { run, commands } = host({ pg_dump: { code: 1, stderr: 'pg_dump: connection lost' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('failed-before-switch');
    expect(commands.some((line) => line.includes('checkout'))).toBe(false);
    expect(commands.some((line) => line.includes(' build'))).toBe(false);
    expect(commands.at(-1)).toBe(
      'docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 300',
    );
    expect(output.join('\n')).toContain('The previous release was started again');
  });

  test('a failure after the switch leaves the stack alone and prints the rollback', async () => {
    const { run, commands } = host({ ' build': { code: 1, stderr: 'build failed' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('failed-after-switch');
    expect(commands.some((line) => line.includes('up -d'))).toBe(false);
    const text = output.join('\n');
    expect(text).toContain('build failed');
    // The operator may fix the cause and finish by hand: the rest is spelled out.
    const rest = text.slice(text.indexOf('Commands that were not completed:'));
    expect(rest).toContain('docker compose -f deploy/docker-compose.yml build');
    expect(rest).toContain('docker tag melete-web:local melete-web:v0.2.0');
    expect(rest).toContain('up -d --wait --wait-timeout 300');
    expect(rest).not.toContain('pg_dump');
    expect(text).toContain('To return to v0.1.0');
    expect(text).toContain('docker volume rm melete_pgdata');
    expect(text).toContain('/srv/backups/upgrade-v0.2.0/database.dump');
  });

  test('a checkout that fails has switched nothing, so the previous release restarts', async () => {
    const { run, commands } = host({ 'checkout --detach': { code: 1, stderr: 'would overwrite' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('failed-before-switch');
    expect(commands.some((line) => line.includes('bun install'))).toBe(false);
    expect(commands.at(-1)).toContain('up -d --wait --wait-timeout 300');
  });

  test('migrations that never finish fail the upgrade rather than report success', async () => {
    const { run } = host({ __drizzle_migrations: { stdout: '35\n' } });
    const output: string[] = [];
    const result = await runUpgrade({ ...options, dryRun: false }, dependencies(run, output));
    expect(result.status).toBe('failed-after-switch');
    expect(output.join('\n')).toContain('35 of 37 migrations');
  });

  test('a secret in a failing command is not echoed', async () => {
    const { run } = host({ pg_dump: { code: 1, stderr: 'password hunter2-secret rejected' } });
    const output: string[] = [];
    await runUpgrade(
      { ...options, dryRun: false },
      {
        ...dependencies(run, output),
        environment: async () => ({
          COMPOSE_PROJECT_NAME: 'melete',
          POSTGRES_PASSWORD: 'hunter2-secret',
        }),
      },
    );
    expect(output.join('\n')).not.toContain('hunter2-secret');
    expect(output.join('\n')).toContain('[redacted]');
  });
});

describe('the real command runner', () => {
  test('streams bytes to a private file, feeds a file to stdin, and never overwrites', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'melete-upgrade-runner-'));
    try {
      const run = spawnRunner(directory);
      const dump = join(directory, 'database.dump');
      // Bytes that are not valid text: a dump must not pass through a string.
      const emit = 'process.stdout.write(new Uint8Array([80,71,68,77,80,0,255,254,10]))';
      expect(await run([process.execPath, '-e', emit], { stdoutFile: dump })).toEqual({
        code: 0,
        stdout: '',
        stderr: '',
      });
      expect([...(await readFile(dump))]).toEqual([80, 71, 68, 77, 80, 0, 255, 254, 10]);

      const again = await run([process.execPath, '-e', emit], { stdoutFile: dump });
      expect(again.code).toBe(127);
      expect(again.stderr).toContain('EEXIST');

      const count =
        'let n=0;process.stdin.on("data",(c)=>{n+=c.length}).on("end",()=>console.log(n))';
      const piped = await run([process.execPath, '-e', count], { stdinFile: dump });
      expect(piped.stdout.trim()).toBe('9');

      const failed = await run([process.execPath, '-e', 'console.error("no");process.exit(3)']);
      expect(failed).toMatchObject({ code: 3, stderr: 'no\n' });
      expect((await run(['melete-no-such-command'])).code).toBe(127);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
