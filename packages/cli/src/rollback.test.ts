import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy } from './commands/deploy.ts';
import { runRollback } from './commands/rollback.ts';
import { readHistory } from './history.ts';
import { temporaryDeployDir } from './testing.ts';
import { deployRig, NEW, OLD } from './testing-engine.ts';

const short = (commit: string) => commit.slice(0, 7);
const env = (deployDir: string) => readFileSync(join(deployDir, '.env'), 'utf8');

describe('melete rollback', () => {
  test('the previous release is deployed again when the last deploy ran no migrations', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    expect(rig.state.head).toBe(NEW);
    const ups = rig.state.ups;

    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(0);
    // The stack ran `main` before; the commit that tag named is what comes back.
    expect(env(deployDir)).toContain(`\nMELETE_IMAGE_TAG=${short(OLD)}\n`);
    expect(rig.state.head).toBe(OLD);
    expect(rig.state.branch).toBe('main');
    expect(rig.state.ups).toBe(ups + 2);
    const last = readHistory(deployDir).at(-1);
    expect(last).toMatchObject({
      command: 'rollback',
      from: { tag: short(NEW) },
      to: { tag: short(OLD) },
      result: 'deployed',
    });
  });

  test('a dry run prints the previous release and changes nothing', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runDeploy(rig.context, ['--checkout'], false, rig.dependencies)).toBe(0);
    const before = env(deployDir);
    const entries = readHistory(deployDir).length;
    expect(await runRollback(rig.context, ['--dry-run'], false, rig.dependencies)).toBe(0);
    expect(rig.context.printed()).toContain(`deploy.target  ${short(OLD)}, built from ${OLD}`);
    expect(rig.context.printed()).toContain('rollback: planned; nothing was changed');
    expect(env(deployDir)).toBe(before);
    expect(rig.state.head).toBe(NEW);
    expect(readHistory(deployDir)).toHaveLength(entries);
  });

  test('after a deploy that ran migrations it prints the database restore and exits 3', async () => {
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
    const backup = readHistory(deployDir)[0]?.backup ?? '';
    expect(backup).toContain(backups);
    const before = env(deployDir);
    const calls = rig.state.calls.length;

    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(3);
    const printed = rig.context.printed();
    expect(printed).toContain('The database holds 69 migrations and aaaaaaa knows 68');
    expect(printed).toContain('Nothing was changed.');
    expect(printed).toContain(`${backup}/database.dump`);
    expect(printed).toContain('docker volume rm melete_pgdata');
    expect(printed).not.toMatch(/volume rm \S*restrictions/);
    expect(printed).toContain(`git -c advice.detachedHead=false checkout --detach ${OLD}`);
    expect(printed).toContain(`bun run melete set MELETE_IMAGE_TAG=${short(OLD)}`);
    // Only reads: the migration count and the journal.
    expect(
      rig.state.calls
        .slice(calls)
        .every((call) => !/ up | restart|pull|docker tag|checkout/.test(call)),
    ).toBe(true);
    expect(env(deployDir)).toBe(before);
  });

  test('with no deploy recorded there is nothing to go back to', async () => {
    const deployDir = temporaryDeployDir();
    const rig = deployRig(deployDir);
    expect(await runRollback(rig.context, [], false, rig.dependencies)).toBe(2);
    expect(rig.context.errors()).toContain('No deploy is recorded');
  });
});
