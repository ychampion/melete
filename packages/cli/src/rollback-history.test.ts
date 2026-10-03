import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy } from './commands/deploy.ts';
import { runRollback } from './commands/rollback.ts';
import { historyPath, readHistory } from './history.ts';
import { temporaryDeployDir } from './testing.ts';
import {
  type DeployRig,
  deployRig,
  NEW,
  OLD,
  REGISTRY,
  RELEASES,
  release,
  whens,
} from './testing-engine.ts';

const short = (commit: string) => commit.slice(0, 7);
const env = (deployDir: string) => readFileSync(join(deployDir, '.env'), 'utf8');
const THIRD = 'c'.repeat(40);

/** A third release, published as main, whose journal adds one migration. */
function publishThird(rig: DeployRig) {
  rig.state.commits.set(THIRD, 69);
  for (const name of RELEASES) {
    rig.state.registry.set(`${REGISTRY}/${name}:${short(THIRD)}`, release(name, THIRD));
    rig.state.registry.set(`${REGISTRY}/${name}:main`, release(name, THIRD));
  }
}

const unhealthy = async () => Response.json({ status: 'error', database: 'error' });

describe('rollback after a run that did not finish', () => {
  test('after a first deploy that failed past the switch, it returns to where that deploy started', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir, { failUp: true });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(3);
    expect(readHistory(deployDir).map((entry) => entry.result)).toEqual(['switched', 'failed']);
    rig.state.failUp = false;
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(0);
    expect(env(deployDir)).toContain(`\nMELETE_IMAGE_TAG=${short(OLD)}\n`);
    expect(rig.state.head).toBe(OLD);
    expect(rig.state.branch).toBe('main');
  });

  test('after a failed deploy that ran a migration, it prints the restore and goes back one release, not two', async () => {
    const deployDir = temporaryDeployDir();
    const backups = join(deployDir, '..', 'backups');
    const rig = deployRig(deployDir, {}, { backup: { dir: backups, keep: 3 } });
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    publishThird(rig);
    rig.context.fetch = unhealthy;
    // The service starts, runs migration 69, and never reports healthy.
    expect(
      await runDeploy(rig.context, ['--tag', 'main', '--checkout'], false, rig.dependencies),
    ).toBe(3);
    const failed = readHistory(deployDir).at(-1);
    expect(failed?.result).toBe('failed');
    expect(failed?.migrations.ran).toEqual(whens(69).slice(-1));
    const before = env(deployDir);
    const mark = rig.context.printed().length;

    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(3);
    const printed = rig.context.printed().slice(mark);
    expect(printed).toContain(
      '1 migration(s), run since bbbbbbb was running, that bbbbbbb does not know',
    );
    expect(printed).toContain(`bun run melete set MELETE_IMAGE_TAG=${short(NEW)}`);
    expect(printed).not.toContain(short(OLD));
    expect(printed).toContain('Nothing was changed.');
    expect(env(deployDir)).toBe(before);
  });

  test('a migration run after the recorded deploy by something else also means a restore', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    // A migration no release in the history knows, recorded since.
    rig.state.recorded = [...whens(68), (whens(68).at(-1) ?? 0) + 10];
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(3);
    expect(rig.context.printed()).toContain('going back means restoring the database');
  });

  test('a run cut short after the switch is still the one rollback undoes', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    // Keep only the `switched` line, as if the command had been killed after it.
    const lines = readFileSync(historyPath(deployDir), 'utf8').trim().split('\n');
    writeFileSync(historyPath(deployDir), `${lines.slice(0, -1).join('\n')}\n`);
    expect(readHistory(deployDir).at(-1)?.result).toBe('switched');
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(0);
    expect(env(deployDir)).toContain(`\nMELETE_IMAGE_TAG=${short(OLD)}\n`);
  });

  test('when something moved the stack since the recorded run, rollback refuses', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const envPath = join(deployDir, '.env');
    writeFileSync(
      envPath,
      readFileSync(envPath, 'utf8').replace(/MELETE_IMAGE_TAG=.*/, 'MELETE_IMAGE_TAG=main'),
    );
    const calls = rig.state.calls.length;
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(2);
    expect(rig.context.errors()).toContain(
      'deploy/.env runs main, but the last recorded run switched the stack to bbbbbbb',
    );
    expect(rig.state.calls).toHaveLength(calls);
  });

  test('a shell value that differs from deploy/.env refuses the rollback', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    rig.context.environment = { COMPOSE_PROJECT_NAME: 'other' };
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(2);
    expect(rig.context.errors()).toContain('This shell sets COMPOSE_PROJECT_NAME');
  });

  test('a recorded backup that is gone is named as unusable, not offered', async () => {
    const deployDir = temporaryDeployDir();
    const backups = join(deployDir, '..', 'backups');
    const rig = deployRig(
      deployDir,
      {
        commits: new Map([
          [OLD, 68],
          [NEW, 69],
        ]),
      },
      { backup: { dir: backups, keep: 3 } },
    );
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const backup = readHistory(deployDir).at(-1)?.backup ?? '';
    rmSync(backup, { recursive: true });
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(3);
    expect(rig.context.printed()).toContain(
      `The backup recorded with that run, ${backup}, cannot be used: it is not there.`,
    );
  });
});
