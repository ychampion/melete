import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import { parseSshTarget, runBackup } from './commands/backup.ts';
import { runRestore } from './commands/restore.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { appendHistory } from './history.ts';
import { masterKeyFingerprint } from './master-key.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const MB = 1024 ** 2;
const posix = process.platform !== 'win32';

function backupRig(options: { free?: number; contract?: object; volumes?: boolean } = {}) {
  const deployDir = temporaryDeployDir();
  const backups = join(deployDir, '..', 'backups');
  const envText = writeEnv(deployDir);
  mkdirSync(join(deployDir, 'config'));
  writeFileSync(join(deployDir, 'config', 'providers.json'), '{}');
  writeFileSync(
    join(deployDir, DEPLOY_FILE),
    JSON.stringify({ contract: 1, backup: { dir: backups, keep: 2 }, ...options.contract }),
  );
  const calls: string[] = [];
  const run = (command: readonly string[]): CommandOutput => {
    const text = command.join(' ');
    calls.push(text);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (text.includes('pg_database_size')) return ok(`${40 * MB}\n`);
    if (text.includes('du -sk /data/restrictions')) return ok('12\t/data/restrictions\n');
    if (text.includes('du -sk /data /work')) return ok('100000\t/data\n200000\t/work\n');
    if (text.startsWith('ssh ') && text.includes('df -Pk'))
      return ok(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1 1 ${(options.free ?? 10_000 * MB) / 1024} 1% /\n`,
      );
    if (text.startsWith('ssh ')) return ok();
    if (text.startsWith('docker volume inspect')) return ok('[]');
    if (text.startsWith('docker compose')) return ok();
    return { code: 1, stdout: '', stderr: 'no such command in this test' };
  };
  const context = testContext(deployDir, [], {
    run,
    freeAt: () => options.free ?? 10_000 * MB,
  });
  return { deployDir, backups, envText, context, calls };
}

const masterKey = (envText: string) => /MELETE_MASTER_KEY=(.+)/.exec(envText)?.[1] ?? '';

describe('melete backup', () => {
  test('backup files are private and the key never reaches output', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const [set] = readdirSync(rig.backups);
    expect(set).toBe('melete-20261002T100000Z');
    const dir = join(rig.backups, set ?? '');
    expect(readdirSync(dir).sort()).toEqual([
      'SHA256SUMS',
      'config.tar',
      'database.dump',
      'deploy.env',
      'master-key.fingerprint',
      DEPLOY_FILE,
      'restrictions-20261002T100000Z.tar',
    ]);
    // deploy.env is kept without the master key; the set holds only its fingerprint.
    const kept = masterKey(rig.envText);
    expect(readFileSync(join(dir, 'deploy.env'), 'utf8')).toBe(
      rig.envText.replace(`MELETE_MASTER_KEY=${kept}`, 'MELETE_MASTER_KEY='),
    );
    for (const file of readdirSync(dir))
      expect([file, readFileSync(join(dir, file), 'latin1').includes(kept)]).toEqual([file, false]);
    expect(readFileSync(join(dir, 'master-key.fingerprint'), 'utf8').trim()).toBe(
      masterKeyFingerprint(kept),
    );
    if (posix) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const file of readdirSync(dir))
        expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
    const key = masterKey(rig.envText);
    expect(key.length).toBeGreaterThan(20);
    expect(rig.context.printed()).not.toContain(key);
    expect(rig.context.errors()).not.toContain(key);
    expect(rig.calls.join('\n')).not.toContain(key);
    // The dump is listed by pg_restore as it is written.
    const dump = rig.context.streams.find(
      (call) => 'command' in call.source && call.source.command.join(' ').includes('pg_dump'),
    );
    expect(
      dump?.sinks.some(
        (sink) => 'command' in sink && sink.command.join(' ').endsWith('pg_restore --list'),
      ),
    ).toBe(true);
    // Every file is in the checksum list.
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
    for (const file of readdirSync(dir).filter((name) => name !== 'SHA256SUMS'))
      expect(sums).toContain(`  ${file}\n`);
  });

  test('backup --to ssh:// streams with no local file', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, ['--to', 'ssh://vault:/srv/melete'], false)).toBe(0);
    expect(existsSync(rig.backups)).toBe(false);
    expect(
      readdirSync(join(rig.deployDir, '..')).filter((entry) => entry.startsWith('melete-')),
    ).toEqual([]);
    for (const call of rig.context.streams)
      for (const sink of call.sinks) {
        expect('command' in sink).toBe(true);
        if ('command' in sink && sink.command[0] === 'ssh')
          expect(sink.command.at(-1)).toMatch(
            /^umask 077 && cat > \/srv\/melete\/melete-20261002T100000Z\/[\w.-]+$/,
          );
      }
    expect(rig.calls).toContain(
      'ssh -o BatchMode=yes vault umask 077 && mkdir -p /srv/melete && mkdir -m 700 /srv/melete/melete-20261002T100000Z',
    );
    expect(rig.context.printed()).toContain('ssh://vault:/srv/melete/melete-20261002T100000Z');
  });

  test('a part that fails removes the partial backup', async () => {
    const rig = backupRig();
    rig.context.streamFails.push('/data/restrictions');
    expect(await runBackup(rig.context, [], false)).toBe(1);
    expect(readdirSync(rig.backups)).toEqual([]);
    expect(rig.context.printed()).toContain('No backup was kept');
  });

  test('keep removes the oldest backups only, and nothing else in the directory', async () => {
    const rig = backupRig();
    mkdirSync(rig.backups, { recursive: true });
    for (const name of [
      'melete-20260901T000000Z',
      'melete-20260915T000000Z',
      'notes',
      'melete-final',
    ])
      mkdirSync(join(rig.backups, name));
    expect(await runBackup(rig.context, [], false)).toBe(0);
    expect(readdirSync(rig.backups).sort()).toEqual([
      'melete-20260915T000000Z',
      'melete-20261002T100000Z',
      'melete-final',
      'notes',
    ]);
  });

  test('--with-volumes stops the writers, archives /data and /work, and starts them again', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, ['--with-volumes'], false)).toBe(0);
    const set = join(rig.backups, 'melete-20261002T100000Z');
    expect(readdirSync(set)).toEqual(expect.arrayContaining(['data.tar', 'work.tar']));
    const stop = rig.calls.findIndex((call) => / stop melete runtime web$/.test(call));
    const start = rig.calls.findIndex((call) =>
      call.includes(' up -d --no-build --pull never --wait'),
    );
    expect(stop).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(stop);
  });

  test('--estimate compares the sizes with the free space and changes nothing', async () => {
    const fits = backupRig();
    expect(await runBackup(fits.context, ['--estimate'], false)).toBe(0);
    expect(fits.context.printed()).toMatch(/ok\s+backup\.database_mb\s+The database is 40 MB/);
    expect(existsSync(fits.backups)).toBe(false);

    const short = backupRig({ free: 80 * MB });
    expect(await runBackup(short.context, ['--estimate', '--with-volumes'], false)).toBe(1);
    expect(short.context.printed()).toMatch(/fail\s+backup\.target_free_mb\s+80 MB free/);
    expect(short.calls.some((call) => / stop /.test(call))).toBe(false);
  });

  test('a destination a remote shell could misread is refused', () => {
    for (const value of [
      'ssh://vault:/srv/melete;rm -rf /',
      'ssh://vault:/srv/$(id)',
      'ssh://vault:/srv/../etc',
      'ssh://vault:relative/path',
      'ssh://-oProxyCommand=x:/srv',
      'ssh://-oVerbose:/srv',
    ])
      expect(() => parseSshTarget(value)).toThrow(/is not a backup destination/);
    expect(parseSshTarget('ssh://me@vault.lan:~/melete-backups/')).toEqual({
      host: 'me@vault.lan',
      path: '~/melete-backups',
    });
  });
});

describe('melete restore', () => {
  test('a sound backup is checked and its restore keeps the journal volume on this machine', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const set = join(rig.backups, 'melete-20261002T100000Z');
    const context = testContext(rig.deployDir, [], {
      run: (command) => ({ code: command[1] === 'volume' ? 0 : 1, stdout: '', stderr: '' }),
    });
    expect(await runRestore(context, [set, '--plan'], false)).toBe(0);
    const printed = context.printed();
    expect(printed).toMatch(/ok\s+restore\.checksums\s+6 file\(s\) match/);
    expect(printed).toContain('melete_restrictions stays as it is');
    expect(printed).toContain('docker volume rm melete_pgdata');
    expect(printed).toContain('melete-20261002T100000Z/database.dump');
    expect(printed).not.toMatch(/volume rm \S*restrictions/);
    expect(printed).not.toContain('melete:/data <');
  });

  test('on a new machine the newest journal archive goes back before the service starts', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const set = join(rig.backups, 'melete-20261002T100000Z');
    const context = testContext(rig.deployDir, [], {
      run: () => ({ code: 1, stdout: '', stderr: 'no such volume' }),
    });
    expect(await runRestore(context, [set], false)).toBe(0);
    const printed = context.printed();
    const restore = printed.indexOf('pg_restore');
    // -a keeps the archive's file ownership, so the service can still append to the journal.
    const journal = printed.indexOf('cp -a - melete:/data <');
    expect(journal).toBeGreaterThan(restore);
    expect(printed.indexOf('up -d --no-build --wait\n')).toBeGreaterThan(journal);
  });

  test('a damaged backup fails its check', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const set = join(rig.backups, 'melete-20261002T100000Z');
    writeFileSync(join(set, 'database.dump'), 'damaged');
    const context = testContext(rig.deployDir, [], {
      run: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await runRestore(context, [set], false)).toBe(1);
    expect(context.printed()).toMatch(
      /fail\s+restore\.checksums\s+database\.dump does not match SHA256SUMS/,
    );
  });

  test('a backup whose SHA256SUMS leaves out a file, the dump above all, fails its check', async () => {
    const rig = backupRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const set = join(rig.backups, 'melete-20261002T100000Z');
    const sums = readFileSync(join(set, 'SHA256SUMS'), 'utf8');
    writeFileSync(
      join(set, 'SHA256SUMS'),
      sums
        .split('\n')
        .filter((line) => !line.endsWith('  database.dump'))
        .join('\n'),
    );
    writeFileSync(join(set, 'extra.tar'), 'unlisted');
    const context = testContext(rig.deployDir, [], {
      run: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(await runRestore(context, [set], false)).toBe(1);
    expect(context.printed()).toContain('SHA256SUMS does not list database.dump');
    expect(context.printed()).toContain('SHA256SUMS does not list extra.tar');
  });
});

describe('what backup and restore keep, and refuse', () => {
  test('keep never removes the backup the last deploy took', async () => {
    const rig = backupRig();
    mkdirSync(rig.backups, { recursive: true });
    for (const name of ['melete-20260901T000000Z', 'melete-20260915T000000Z'])
      mkdirSync(join(rig.backups, name));
    const named = join(rig.backups, 'melete-20260901T000000Z');
    appendHistory(rig.deployDir, {
      at: '2026-09-01T00:00:01.000Z',
      command: 'deploy',
      from: { tag: 'aaaaaaa', revision: null },
      to: { tag: 'bbbbbbb', revision: null },
      checkout: null,
      migrations: { from: 68, to: 69 },
      backup: named,
      result: 'deployed',
      detail: '',
    });
    expect(await runBackup(rig.context, [], false)).toBe(0);
    // keep is 2: the two newest stay, and so does the one the deploy named, though it is older.
    expect(readdirSync(rig.backups).sort()).toEqual([
      'melete-20260901T000000Z',
      'melete-20260915T000000Z',
      'melete-20261002T100000Z',
    ]);
  });

  test('a shell value that differs from deploy/.env refuses backup and restore', async () => {
    const rig = backupRig();
    rig.context.environment = { COMPOSE_PROJECT_NAME: 'other' };
    expect(await runBackup(rig.context, [], false)).toBe(2);
    expect(rig.context.errors()).toContain('This shell sets COMPOSE_PROJECT_NAME');
    expect(existsSync(rig.backups)).toBe(false);

    const sound = backupRig();
    expect(await runBackup(sound.context, [], false)).toBe(0);
    const context = testContext(sound.deployDir, [], {
      run: () => ({ code: 0, stdout: '', stderr: '' }),
      environment: { MELETE_IMAGE_REGISTRY: 'registry.example.com/team' },
    });
    expect(await runRestore(context, [join(sound.backups, 'melete-20261002T100000Z')], false)).toBe(
      2,
    );
    expect(context.errors()).toContain('This shell sets MELETE_IMAGE_REGISTRY');
    expect(context.errors()).not.toContain('registry.example.com');
  });
});
