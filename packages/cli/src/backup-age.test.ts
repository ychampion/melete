import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupNameTime,
  judgeBackupAge,
  MAX_BACKUP_AGE_HOURS,
  newestBackup,
  recordBackup,
} from './backup-age.ts';
import { runCheck } from './commands/check.ts';
import { runStatus } from './commands/status.ts';
import { DEPLOY_FILE, type DeployConfig, deployConfigSchema } from './deploy-config.ts';
import { reportSchema } from './schema.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-02T10:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function install(backup: object, hosted?: boolean) {
  const deployDir = temporaryDeployDir();
  const backups = mkdtempSync(join(tmpdir(), 'melete-backups-'));
  const config: DeployConfig = deployConfigSchema.parse({
    contract: 1,
    backup: { dir: backups, ...backup },
    ...(hosted === undefined ? {} : { hosted }),
  });
  return { deployDir, backups, config };
}

const age = (rig: ReturnType<typeof install>) =>
  judgeBackupAge(rig.deployDir, rig.config, NOW, '/nowhere');

describe('how old the newest backup is', () => {
  test('a self-hosted installation with no schedule is not judged', () => {
    expect(age(install({}))).toEqual([]);
    expect(age(install({}, false))).toEqual([]);
    expect(age(install({ scheduled: false }))).toEqual([]);
  });

  test('a hosted installation, or one with a schedule, fails with no backup at all', () => {
    for (const rig of [install({}, true), install({ scheduled: true })]) {
      const [result] = age(rig);
      expect(result).toMatchObject({ id: 'backup.age', level: 'fail' });
      expect(result?.fix).toContain('bun run melete backup');
    }
  });

  test('a backup up to 26 hours old passes, and one a minute older fails', () => {
    expect(MAX_BACKUP_AGE_HOURS).toBe(26);
    for (const [hours, level] of [
      [0, 'ok'],
      [1, 'ok'],
      [25.9, 'ok'],
      [26, 'ok'],
      [26 + 1 / 60, 'fail'],
      [72, 'fail'],
    ] as const) {
      const rig = install({ scheduled: true });
      recordBackup(rig.deployDir, ago(hours), 'ssh://vault:/srv/melete/x');
      expect([hours, age(rig)[0]?.level]).toEqual([hours, level]);
    }
  });

  test('a backup in the folder counts by the time in its name', () => {
    const rig = install({}, true);
    mkdirSync(join(rig.backups, 'melete-20261001T120000Z')); // 22 hours before NOW
    mkdirSync(join(rig.backups, 'melete-20260901T120000Z'));
    mkdirSync(join(rig.backups, 'melete-final'));
    writeFileSync(join(rig.backups, 'melete-20261002T090000Z'), 'not a backup directory');
    const [result] = age(rig);
    expect(result).toMatchObject({ level: 'ok' });
    expect(result?.detail).toContain('22 hours ago');
    expect(result?.detail).toContain('melete-20261001T120000Z');
  });

  test('only the newest time counts, so pruning older backups changes nothing', () => {
    const rig = install({ scheduled: true });
    mkdirSync(join(rig.backups, 'melete-20260920T000000Z'));
    recordBackup(rig.deployDir, ago(2), 'ssh://vault:/srv/melete/melete-20261002T080000Z');
    expect(newestBackup(rig.deployDir, rig.config, '/nowhere')?.location).toBe(
      'ssh://vault:/srv/melete/melete-20261002T080000Z',
    );
    // A newer one in the folder wins over an older note.
    mkdirSync(join(rig.backups, 'melete-20261002T093000Z'));
    expect(newestBackup(rig.deployDir, rig.config, '/nowhere')?.location).toBe(
      join(rig.backups, 'melete-20261002T093000Z'),
    );
  });

  test('a damaged note is ignored rather than trusted', () => {
    const rig = install({ scheduled: true });
    recordBackup(rig.deployDir, ago(1), 'x');
    writeFileSync(join(rig.deployDir, '.melete', 'last-backup.json'), '{"at":"yesterday"');
    expect(age(rig)[0]?.level).toBe('fail');
  });

  test('backup names read as the times they were stamped with', () => {
    expect(backupNameTime('melete-20261002T101500Z')?.toISOString()).toBe(
      '2026-10-02T10:15:00.000Z',
    );
    expect(backupNameTime('melete-final')).toBeNull();
    expect(backupNameTime('melete-20261302T101500Z')).toBeNull();
  });
});

describe('check and status report it', () => {
  const scheduledInstall = (fresh: boolean) => {
    const deployDir = temporaryDeployDir();
    const backups = mkdtempSync(join(tmpdir(), 'melete-backups-'));
    writeEnv(deployDir);
    writeFileSync(
      join(deployDir, DEPLOY_FILE),
      JSON.stringify({ contract: 1, backup: { dir: backups, keep: 3, scheduled: true } }),
    );
    if (fresh) mkdirSync(join(backups, 'melete-20261002T040000Z'));
    else mkdirSync(join(backups, 'melete-20260930T040000Z'));
    return deployDir;
  };
  const levelIn = (printed: string) =>
    reportSchema.parse(JSON.parse(printed)).results.find((result) => result.id === 'backup.age')
      ?.level;

  test('check fails on a stale backup and passes on a fresh one', () => {
    const stale = testContext(scheduledInstall(false));
    runCheck(stale, true);
    expect(levelIn(stale.printed())).toBe('fail');
    const fresh = testContext(scheduledInstall(true));
    runCheck(fresh, true);
    expect(levelIn(fresh.printed())).toBe('ok');
  });

  test('check says nothing about backups on a self-hosted installation with no schedule', () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir);
    writeFileSync(join(deployDir, DEPLOY_FILE), JSON.stringify({ contract: 1 }));
    const context = testContext(deployDir);
    runCheck(context, true);
    expect(levelIn(context.printed())).toBeUndefined();
  });

  test('status fails on a stale backup', async () => {
    const context = testContext(scheduledInstall(false));
    expect(await runStatus(context, true)).toBe(1);
    expect(levelIn(context.printed())).toBe('fail');
  });
});
