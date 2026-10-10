import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import { parseSshTarget, runBackup } from './commands/backup.ts';
import { runDeploy } from './commands/deploy.ts';
import { runRestore } from './commands/restore.ts';
import type { Source } from './context.ts';
import { DEPLOY_FILE } from './deploy-config.ts';
import { parseContents } from './files.ts';
import { appendHistory } from './history.ts';
import { masterKeyFingerprint } from './master-key.ts';
import { temporaryDeployDir, testContext, writeEnv } from './testing.ts';
import { deployRig, NEW, OLD } from './testing-engine.ts';

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
    if (text.includes(' --entrypoint du ')) return ok('100000\t/m/0\n200000\t/m/1\n');
    if (text.startsWith('ssh ') && text.includes('df -Pk'))
      return ok(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1 1 ${(options.free ?? 10_000 * MB) / 1024} 1% /\n`,
      );
    if (text.startsWith('ssh ')) return ok();
    if (text.startsWith('docker volume inspect --format {{.Name}} '))
      return ok(`${command.at(-1)}\n`);
    if (text.startsWith('docker volume inspect')) return ok('[]');
    if (text.startsWith('docker volume ls ')) return ok('');
    if (text.startsWith('sh -c docker ps ')) return ok();
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
      'artifacts.tar',
      'config.tar',
      'contents.json',
      'database.dump',
      'deploy.env',
      'master-key.fingerprint',
      DEPLOY_FILE,
      'restrictions-20261002T100000Z.tar',
      'spaces.tar',
      'work.tar',
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
        (sink) => 'command' in sink && sink.command.join(' ').includes('pg_restore --list'),
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

  test('--offline (or --with-volumes) stops the writers for the files, and starts them again', async () => {
    for (const flag of ['--offline', '--with-volumes']) {
      const rig = backupRig();
      expect(await runBackup(rig.context, [flag], false)).toBe(0);
      const set = join(rig.backups, 'melete-20261002T100000Z');
      expect(readdirSync(set)).toEqual(
        expect.arrayContaining(['spaces.tar', 'artifacts.tar', 'work.tar', 'contents.json']),
      );
      expect(JSON.parse(readFileSync(join(set, 'contents.json'), 'utf8')).taken).toBe('offline');
      // melete-cells too, and the attempt containers it started: they write into /work.
      const stop = rig.calls.findIndex((call) =>
        / stop melete runtime web melete-cells$/.test(call),
      );
      const cells = rig.calls.findIndex(
        (call) =>
          call.includes('--filter label=com.melete.attempt-supervisor=v1') &&
          call.includes("'label=com.melete.project=melete'") &&
          call.endsWith('| xargs -r docker stop'),
      );
      const start = rig.calls.findIndex((call) =>
        call.endsWith(
          ' up -d --no-build --pull never --wait --wait-timeout 300 melete runtime web melete-cells',
        ),
      );
      expect(stop).toBeGreaterThan(-1);
      expect(cells).toBeGreaterThan(stop);
      expect(start).toBeGreaterThan(cells);
      // Taken with nothing writing, a file that changes under tar is an error, not a warning.
      const spaces = rig.context.streams.find(
        (call) =>
          'command' in call.source && call.source.command.join(' ').includes('src=melete_spaces'),
      );
      expect(spaces && 'command' in spaces.source ? spaces.source.command.at(-1) : '').toBe(
        'exec tar -C /v --numeric-owner -cf - .',
      );
    }
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
    expect(printed).toMatch(/ok\s+restore\.checksums\s+10 file\(s\) match/);
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
    expect(printed.lastIndexOf('up -d --no-build --wait ')).toBeGreaterThan(journal);
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

/** Two computers of this installation, one running; a third volume belongs to another installation. */
const COMPUTERS = ['melete-sbx-proj-sbx_a', 'melete-sbx-proj-sbx_b'];
const labelsOf = (computer: string) => ({
  'com.melete.sandbox': 'v1',
  'com.melete.sandbox.name': computer,
  'melete.owner': 'v1',
  'melete.project': 'proj',
  'melete.session': computer.slice('melete-sbx-proj-'.length),
});

/**
 * A rig whose engine also has agents' computers, and which logs every command
 * and every streamed part in one order: `run <command>` and `stream <source> -> <sinks>`.
 */
function filesRig(
  options: {
    env?: Record<string, string>;
    contract?: object;
    listFails?: boolean;
    pauseState?: () => string;
  } = {},
) {
  const deployDir = temporaryDeployDir();
  const backups = join(deployDir, '..', 'backups');
  writeEnv(deployDir, { MELETE_SANDBOX_PROJECT: 'proj', ...options.env });
  writeFileSync(
    join(deployDir, DEPLOY_FILE),
    JSON.stringify({ contract: 1, backup: { dir: backups, keep: 3 }, ...options.contract }),
  );
  const events: string[] = [];
  /** Volumes on the engine; a restore on a new machine starts without the computers'. */
  const volumes = new Set([
    'melete_spaces',
    'melete_artifacts',
    'melete_work',
    'melete_pgdata',
    'melete_restrictions',
    ...COMPUTERS.flatMap((computer) => [`${computer}-work`, `${computer}-home`]),
  ]);
  /** Containers on the engine, running or not. */
  const containers = new Set(COMPUTERS);
  const running = new Set([COMPUTERS[0] ?? '']);
  const paused = new Set<string>();
  /** Labels a volume has on the engine when they are not its computer's own. */
  const owners = new Map<string, Record<string, string>>();
  /** The running containers that use a volume. */
  const users = new Map<string, string[]>();
  /** Commands that fail. */
  const fails: ((text: string) => boolean)[] = [];
  const run = (command: readonly string[]): CommandOutput => {
    const text = command.join(' ');
    events.push(`run ${text}`);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const no = (stderr = 'no such object') => ({ code: 1, stdout: '', stderr });
    if (fails.some((fail) => fail(text))) return no('failed in this test');
    if (text.includes('pg_database_size')) return ok(`${40 * MB}\n`);
    if (text.includes('du -sk /data/restrictions')) return ok('12\t/data/restrictions\n');
    if (text.includes(' --entrypoint du ')) return ok('1000\t/m/0\n');
    if (text.startsWith('docker volume ls ')) {
      if (options.listFails) return no('Cannot connect to the Docker daemon');
      // The engine filters by label; another installation's computer never matches it.
      return text.includes('label=melete.project=proj')
        ? ok(
            `${[...volumes].filter((volume) => volume.startsWith('melete-sbx-proj-')).join('\n')}\n`,
          )
        : ok('');
    }
    if (text.startsWith('docker volume inspect --format {{.Name}} {{json .Labels}} '))
      return ok(
        command
          .slice(5)
          .map(
            (volume) =>
              `${volume} ${JSON.stringify(labelsOf(volume.replace(/-(work|home)$/, '')))}`,
          )
          .join('\n'),
      );
    if (text.startsWith('docker volume inspect --format {{json .Labels}} ')) {
      const volume = command.at(-1) ?? '';
      if (!volumes.has(volume)) return no();
      return ok(
        `${JSON.stringify(owners.get(volume) ?? labelsOf(volume.replace(/-(work|home)$/, '')))}\n`,
      );
    }
    if (text.startsWith('docker volume inspect'))
      return volumes.has(command.at(-1) ?? '') ? ok(`${command.at(-1)}\n`) : no();
    if (text.startsWith('docker volume rm ')) {
      volumes.delete(command.at(-1) ?? '');
      return ok();
    }
    if (text.startsWith('docker volume create ')) {
      volumes.add(command.at(-1) ?? '');
      return ok();
    }
    if (
      text.startsWith('docker container inspect --format {{.State.Running}} {{.State.Paused}} ')
    ) {
      const name = command.at(-1) ?? '';
      return running.has(name) ? ok(`true ${paused.has(name)}\n`) : no();
    }
    if (text.startsWith('docker container inspect --format {{.Id}} '))
      return containers.has(command.at(-1) ?? '') ? ok('0123abcd\n') : no();
    if (text.startsWith('docker container inspect --format {{.State.Paused}} '))
      return ok(options.pauseState?.() ?? `${paused.has(command.at(-1) ?? '')}\n`);
    if (text.startsWith('docker pause ')) {
      paused.add(command.at(-1) ?? '');
      return ok();
    }
    if (text.startsWith('docker unpause ')) {
      paused.delete(command.at(-1) ?? '');
      return ok();
    }
    if (text.startsWith('docker stop ')) {
      for (const name of command.slice(2)) running.delete(name);
      return ok();
    }
    if (text.startsWith('docker ps --filter volume=')) {
      const volume = (command[3] ?? '').slice('volume='.length);
      return ok((users.get(volume) ?? []).map((name) => `${name}\n`).join(''));
    }
    if (text.startsWith('sh -c docker ps ')) return ok();
    if (text.startsWith('docker compose')) return ok();
    if (text.endsWith('--version')) return ok('v1');
    return no('no such command in this test');
  };
  const context = testContext(deployDir, [], { run });
  const stream = context.stream;
  context.stream = async (source, sinks) => {
    const describe = (endpoint: Source) =>
      'command' in endpoint
        ? endpoint.command.join(' ')
        : 'file' in endpoint
          ? endpoint.file
          : 'bytes';
    events.push(`stream ${describe(source)} -> ${sinks.map(describe).join(', ')}`);
    return await stream(source, sinks);
  };
  const set = join(backups, 'melete-20261002T100000Z');
  return {
    deployDir,
    backups,
    set,
    context,
    events,
    volumes,
    containers,
    running,
    paused,
    owners,
    users,
    fails,
  };
}

const indexOf = (events: readonly string[], part: string) =>
  events.findIndex((event) => event.includes(part));

/** Replaces a file of a backup set, and its line in SHA256SUMS. */
function replaceInSet(set: string, file: string, text: string) {
  writeFileSync(join(set, file), text);
  const sum = createHash('sha256').update(text).digest('hex');
  const sums = readFileSync(join(set, 'SHA256SUMS'), 'utf8');
  writeFileSync(
    join(set, 'SHA256SUMS'),
    sums
      .split('\n')
      .map((line) => (line.endsWith(`  ${file}`) ? `${sum}  ${file}` : line))
      .join('\n'),
  );
}

/** The restore's last step: the whole stack started, after the database alone was. */
const startsStack = (event: string) =>
  event.includes(' up -d --no-build --wait ') && !event.endsWith(' --wait postgres');

/** The logged steps that change the engine: a stop, a removal, a load or an unpack. */
const changes = (events: readonly string[]) =>
  events.filter(
    (event) =>
      /^run docker (pause|unpause|stop|volume rm|volume create) /.test(event) ||
      /^run docker compose .* (stop|down|up|create)( |$)/.test(event) ||
      /-xpf -|pg_restore -U|cp -a - melete|xargs -r docker stop/.test(event),
  );

describe('the people files and the agents computers in a backup', () => {
  test('the default backup holds the files and each computer, taken after the database', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const files = readdirSync(rig.set);
    for (const file of [
      'spaces.tar',
      'artifacts.tar',
      'work.tar',
      'contents.json',
      ...COMPUTERS.flatMap((computer) => [
        `computer-${computer}-work.tar`,
        `computer-${computer}-home.tar`,
      ]),
    ])
      expect(files).toContain(file);
    const contents = JSON.parse(readFileSync(join(rig.set, 'contents.json'), 'utf8'));
    expect(contents).toMatchObject({ format: 1, taken: 'online', blobs: 'local' });
    expect(contents.parts.map((part: { part: string }) => part.part)).toEqual([
      'spaces',
      'artifacts',
      'work',
    ]);
    // Each computer's volume keeps the labels its adapter gave it, so a restore can make it again.
    expect(contents.computers[0]).toMatchObject({
      volume: `${COMPUTERS[0]}-home`,
      computer: COMPUTERS[0],
      labels: labelsOf(COMPUTERS[0] ?? ''),
    });
    // Every part is in the checksum list.
    const sums = readFileSync(join(rig.set, 'SHA256SUMS'), 'utf8');
    for (const file of files.filter((name) => name !== 'SHA256SUMS'))
      expect(sums).toContain(`  ${file}\n`);
    // Files after the database: everything the dump names is in the backup.
    expect(indexOf(rig.events, 'pg_dump')).toBeLessThan(indexOf(rig.events, 'src=melete_spaces'));
    // Each volume is read through a read-only mount of the service's image, with no network.
    const spaces = rig.events.find((event) => event.includes('src=melete_spaces')) ?? '';
    expect(spaces).toContain(
      'docker run --rm --network none --user 0:0 --mount type=volume,src=melete_spaces,dst=/v,readonly --entrypoint sh ghcr.io/ychampion/melete-service:main',
    );
    expect(rig.context.printed()).toMatch(
      /ok\s+backup\.files\s+Holds the spaces' files, the files kept by their content, the agents' shared \/work and 2 agent computer\(s\), taken with the stack running/,
    );
    // Nothing of the stack was stopped.
    expect(rig.events.some((event) => / stop /.test(event))).toBe(false);
  });

  test('a running computer is paused only while its own volumes are copied', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    const [first, second] = COMPUTERS;
    const pause = indexOf(rig.events, `run docker pause ${first}`);
    const unpause = indexOf(rig.events, `run docker unpause ${first}`);
    expect(pause).toBeGreaterThan(-1);
    expect(indexOf(rig.events, `src=${first}-home`)).toBeGreaterThan(pause);
    expect(indexOf(rig.events, `src=${first}-work`)).toBeGreaterThan(pause);
    expect(unpause).toBeGreaterThan(indexOf(rig.events, `src=${first}-work`));
    expect(unpause).toBeLessThan(indexOf(rig.events, `src=${second}-home`));
    // A stopped computer is copied as it is.
    expect(indexOf(rig.events, `docker pause ${second}`)).toBe(-1);
    expect(rig.paused.size).toBe(0);
  });

  test('a computer the service resumed during its copy is reported, not hidden', async () => {
    const rig = filesRig({ pauseState: () => 'false\n' });
    expect(await runBackup(rig.context, [], false)).toBe(0);
    expect(rig.context.printed()).toMatch(
      new RegExp(
        `warn\\s+backup\\.computer_in_use\\s+${COMPUTERS[0]} was used while its files were copied`,
      ),
    );
  });

  test('a copy that fails leaves no computer paused and no partial backup', async () => {
    const rig = filesRig();
    rig.context.streamFails.push(`src=${COMPUTERS[0]}-work`);
    expect(await runBackup(rig.context, [], false)).toBe(1);
    expect(indexOf(rig.events, `docker unpause ${COMPUTERS[0]}`)).toBeGreaterThan(-1);
    expect(rig.paused.size).toBe(0);
    expect(readdirSync(rig.backups)).toEqual([]);
    expect(rig.context.printed()).toContain('No backup was kept');
  });

  test('computers that cannot be listed fail the backup rather than being left out', async () => {
    const rig = filesRig({ listFails: true });
    expect(await runBackup(rig.context, [], false)).toBe(1);
    expect(rig.context.printed()).toMatch(
      /fail\s+backup\.computers\s+The agents' computers' volumes could not be listed: Cannot connect/,
    );
    expect(readdirSync(rig.backups)).toEqual([]);
  });

  test("only this installation's computers are listed, and none without a sandbox project", async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    expect(rig.events.find((event) => event.startsWith('run docker volume ls'))).toBe(
      'run docker volume ls --quiet --filter label=com.melete.sandbox=v1 --filter label=melete.project=proj',
    );
    const none = filesRig({ env: { MELETE_SANDBOX_PROJECT: '' } });
    expect(await runBackup(none.context, [], false)).toBe(0);
    expect(indexOf(none.events, 'docker volume ls')).toBe(-1);
    expect(readdirSync(none.set).some((file) => file.startsWith('computer-'))).toBe(false);
  });

  test('--database-only leaves the files out and says so', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, ['--database-only'], false)).toBe(0);
    expect(readdirSync(rig.set).sort()).toEqual([
      'SHA256SUMS',
      'database.dump',
      'deploy.env',
      'master-key.fingerprint',
      DEPLOY_FILE,
      'restrictions-20261002T100000Z.tar',
    ]);
    expect(rig.context.printed()).toMatch(/warn\s+backup\.files_left_out\s+--database-only/);
    expect(await runBackup(rig.context, ['--database-only', '--offline'], false)).toBe(2);
  });

  test('with blobs in an S3 bucket, the backup says the bucket is not in it', async () => {
    const rig = filesRig({
      env: {
        MELETE_BLOB_STORE: 's3',
        MELETE_BLOB_S3_BUCKET: 'melete-blobs',
        MELETE_BLOB_S3_ENDPOINT: 'https://s3.example.net',
        MELETE_BLOB_S3_ACCESS_KEY_ID: 'access-id',
        MELETE_BLOB_S3_SECRET_ACCESS_KEY: 's3-secret-value',
      },
      contract: {
        blobs: { store: 's3', bucket: 'melete-blobs', endpoint: 'https://s3.example.net' },
      },
    });
    expect(await runBackup(rig.context, [], false)).toBe(0);
    expect(rig.context.printed()).toMatch(
      /warn\s+backup\.blobs_bucket\s+Files kept by their content \(uploads, Files\) are in the bucket melete-blobs/,
    );
    expect(JSON.parse(readFileSync(join(rig.set, 'contents.json'), 'utf8')).blobs).toBe('s3');
  });

  test('--estimate counts the files and the computers', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, ['--estimate'], false)).toBe(0);
    expect(rig.context.printed()).toMatch(
      /ok\s+backup\.files_mb\s+The files and the agents' computers hold 1 MB/,
    );
    const measure = rig.events.find((event) => event.includes('--entrypoint du')) ?? '';
    for (const volume of ['melete_spaces', `${COMPUTERS[1]}-work`])
      expect(measure).toContain(`src=${volume},dst=`);
  });
});

describe('restoring the files', () => {
  async function backedUp() {
    const rig = filesRig();
    expect(await runBackup(rig.context, [], false)).toBe(0);
    rig.events.length = 0;
    return rig;
  }

  test('--verify reads every archive through and changes nothing', async () => {
    const rig = await backedUp();
    expect(await runRestore(rig.context, [rig.set, '--verify'], false)).toBe(0);
    expect(rig.context.printed()).toMatch(
      /ok\s+restore\.archives\s+Every part reads through: 8 archive\(s\) unpack from start to end\. Nothing was changed\./,
    );
    expect(changes(rig.events)).toEqual([]);
    expect(rig.events.filter((event) => event.endsWith('-> tar -tf -'))).toHaveLength(8);
  });

  test('a computer whose container is gone is still put back, and the restore says what that keeps', async () => {
    const rig = await backedUp();
    rig.containers.delete(COMPUTERS[1] ?? '');
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toMatch(
      /warn\s+restore\.computers_without_container\s+1 of the 2 agent computer\(s\) have no container on this machine/,
    );
    expect(printed).toContain('an empty home folder');
    expect(printed).toContain(`src=${COMPUTERS[1]}-home,dst=/v`);
    expect(changes(rig.events)).toEqual([]);

    // With every container here, there is nothing to warn about.
    const kept = await backedUp();
    expect(await runRestore(kept.context, [kept.set], false)).toBe(0);
    expect(kept.context.printed()).not.toContain('restore.computers_without_container');
  });

  test('--verify fails loudly on an archive that does not unpack, or one the backup lacks', async () => {
    const damaged = await backedUp();
    damaged.context.streamFails.push('tar -tf -');
    expect(await runRestore(damaged.context, [damaged.set, '--dry-run'], false)).toBe(1);
    expect(damaged.context.printed()).toMatch(
      /fail\s+restore\.archives\s+\S+\.tar could not be read through/,
    );

    const missing = await backedUp();
    rmSync(join(missing.set, 'artifacts.tar'));
    const sums = readFileSync(join(missing.set, 'SHA256SUMS'), 'utf8');
    writeFileSync(
      join(missing.set, 'SHA256SUMS'),
      sums
        .split('\n')
        .filter((line) => !line.endsWith('  artifacts.tar'))
        .join('\n'),
    );
    expect(await runRestore(missing.context, [missing.set, '--verify'], false)).toBe(1);
    expect(missing.context.printed()).toContain(
      'artifacts.tar is missing: contents.json says the backup holds it',
    );
  });

  test('without --yes, restore prints every step and changes nothing', async () => {
    const rig = await backedUp();
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toContain(
      "find /v -mindepth 1 -delete && exec tar -C /v --numeric-owner -xpf -' < ",
    );
    expect(printed).toContain(`${rig.set}/spaces.tar`);
    expect(printed).toContain(`${rig.set}/computer-${COMPUTERS[0]}-home.tar`);
    expect(printed).toContain(`--yes runs these steps.`);
    expect(changes(rig.events)).toEqual([]);
  });

  test('--yes stops the stack, puts back the database, then the files and computers, and only then starts it', async () => {
    const rig = await backedUp();
    // A new machine for the computers: their volumes are not here yet.
    for (const computer of COMPUTERS) {
      rig.volumes.delete(`${computer}-work`);
      rig.volumes.delete(`${computer}-home`);
    }
    rig.running.clear();
    rig.running.add(COMPUTERS[1] ?? '');
    expect(await runRestore(rig.context, [rig.set, '--yes'], false)).toBe(0);
    const order = [
      ' stop melete runtime web melete-cells',
      'xargs -r docker stop',
      `run docker stop ${COMPUTERS.join(' ')}`,
      ' down',
      'run docker volume rm melete_pgdata',
      ' up -d --no-build --wait postgres',
      'pg_restore -U',
      ' create melete',
      'src=melete_spaces,dst=/v ',
      'src=melete_artifacts,dst=/v ',
      'src=melete_work,dst=/v ',
      `run docker volume create --label com.melete.sandbox=v1 --label com.melete.sandbox.name=${COMPUTERS[0]}`,
      `src=${COMPUTERS[0]}-home,dst=/v `,
      `src=${COMPUTERS[1]}-work,dst=/v `,
    ].map((part) => indexOf(rig.events, part));
    for (const [index, position] of order.entries()) {
      expect([index, position]).not.toEqual([index, -1]);
      if (index > 0)
        expect([index, position]).toEqual([index, Math.max(position, order[index - 1] ?? 0)]);
    }
    // The start is the last thing, after every part is back.
    const start =
      rig.events.flatMap((event, index) => (startsStack(event) ? [index] : [])).at(-1) ?? -1;
    expect(start).toBeGreaterThan(order.at(-1) ?? 0);
    // It waits for the services that keep running; the one-shot image holders are left out.
    const started = rig.events[start] ?? '';
    for (const service of ['postgres', 'melete', 'runtime', 'web'])
      expect(started.split(' ')).toContain(service);
    expect(started).not.toContain('-image');
    expect(started).not.toContain('database-roles');
    expect(
      rig.events.slice(start + 1).filter((event) => event.startsWith('run docker compose')),
    ).toEqual([]);
    // Before a volume is emptied, the engine is asked that nothing uses it.
    expect(indexOf(rig.events, 'run docker ps --filter volume=melete_work ')).toBeGreaterThan(-1);
    expect(indexOf(rig.events, 'run docker ps --filter volume=melete_work ')).toBeLessThan(
      indexOf(rig.events, 'src=melete_work,dst=/v '),
    );
    // The archives were read through before anything changed.
    expect(indexOf(rig.events, '-> tar -tf -')).toBeLessThan(
      indexOf(rig.events, ' stop melete runtime web'),
    );
    // Each computer volume comes back with its labels, so its computer is made again on it.
    for (const computer of COMPUTERS)
      for (const volume of [`${computer}-work`, `${computer}-home`])
        expect(rig.volumes.has(volume)).toBe(true);
    expect(rig.context.printed()).toMatch(/ok\s+restore\.done\s+Restored from/);
  });

  test('a step that fails stops the restore there and never starts the stack', async () => {
    const rig = await backedUp();
    rig.context.streamFails.push('src=melete_artifacts,dst=/v ');
    expect(await runRestore(rig.context, [rig.set, '--yes'], false)).toBe(3);
    expect(indexOf(rig.events, 'src=melete_work,dst=/v ')).toBe(-1);
    expect(rig.events.some(startsStack)).toBe(false);
    expect(rig.context.printed()).toMatch(
      /fail\s+restore\.step\s+docker run --rm -i --network none/,
    );
    expect(rig.context.printed()).toContain(
      'the stack was not started on a half-restored installation',
    );
  });

  test('--yes refuses before changing anything when an archive does not read through', async () => {
    const rig = await backedUp();
    rig.context.streamFails.push('tar -tf -');
    expect(await runRestore(rig.context, [rig.set, '--yes'], false)).toBe(2);
    expect(changes(rig.events)).toEqual([]);
    expect(rig.context.printed()).toMatch(/fail\s+restore\.archives\s+.*Nothing was changed\./);
  });

  test('--yes and --verify cannot be given together', async () => {
    const rig = await backedUp();
    expect(await runRestore(rig.context, [rig.set, '--yes', '--verify'], false)).toBe(2);
    expect(changes(rig.events)).toEqual([]);
  });

  test('--keep-database keeps an external database, and is refused for the bundled one', async () => {
    // The bundled database comes back with the files, so the two agree.
    const bundled = await backedUp();
    expect(await runRestore(bundled.context, [bundled.set, '--keep-database'], false)).toBe(1);
    expect(bundled.context.printed()).toMatch(
      /fail\s+restore\.keep_database\s+--keep-database is for an external database/,
    );
    expect(
      await runRestore(bundled.context, [bundled.set, '--keep-database', '--yes'], false),
    ).toBe(2);
    expect(changes(bundled.events)).toEqual([]);

    const external = filesRig({ contract: { database: { external: true } } });
    expect(await runBackup(external.context, [], false)).toBe(0);
    expect(await runRestore(external.context, [external.set, '--keep-database'], false)).toBe(0);
    expect(external.context.printed()).toContain('The database stays as it is');
    expect(external.context.printed()).not.toContain('pg_restore');
  });

  test('every computer whose container is here is stopped first, running or not', async () => {
    const rig = await backedUp();
    // The second is stopped now, but the service may start it before the restore runs.
    expect(rig.running.has(COMPUTERS[1] ?? '')).toBe(false);
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    expect(rig.context.printed()).toContain(`docker stop ${COMPUTERS.join(' ')}\n`);
  });

  test("the runtime's attempt containers are stopped first, and a volume still in use is never emptied", async () => {
    const plan = await backedUp();
    expect(await runRestore(plan.context, [plan.set], false)).toBe(0);
    expect(plan.context.printed()).toContain('label=com.melete.attempt-supervisor=v1');
    expect(plan.context.printed()).toContain('| xargs -r docker stop');

    const busy = await backedUp();
    busy.users.set('melete_work', ['melete-att-1']);
    expect(await runRestore(busy.context, [busy.set, '--yes'], false)).toBe(3);
    expect(indexOf(busy.events, 'src=melete_work,dst=/v ')).toBe(-1);
    expect(busy.events.some(startsStack)).toBe(false);
    expect(busy.context.printed()).toContain(
      'melete_work is still in use by melete-att-1; stop it first',
    );
  });

  test('a start that fails after every part is back says the restore need not run again', async () => {
    const rig = await backedUp();
    rig.fails.push(startsStack);
    expect(await runRestore(rig.context, [rig.set, '--yes'], false)).toBe(3);
    expect(indexOf(rig.events, `src=${COMPUTERS[1]}-work,dst=/v `)).toBeGreaterThan(-1);
    const printed = rig.context.printed();
    expect(printed).toContain('Every part is back; only the start failed.');
    expect(printed).toContain('The restore need not run again.');
    expect(printed).toMatch(
      /fail\s+restore\.done\s+Every part is back, but the stack did not start healthy\./,
    );
  });

  test('a first step that fails says nothing was replaced, and how to start the stack as it was', async () => {
    const rig = await backedUp();
    rig.fails.push((text) => text.includes(' stop melete runtime web'));
    expect(await runRestore(rig.context, [rig.set, '--yes'], false)).toBe(3);
    // Only the stop that failed was tried.
    expect(changes(rig.events)).toHaveLength(1);
    const printed = rig.context.printed();
    expect(printed).toContain('Nothing was replaced yet, but services may be stopped.');
    expect(printed).toMatch(
      /start the stack as it was with docker compose .* up -d --no-build --wait /,
    );
    expect(printed).toMatch(
      /fail\s+restore\.done\s+The restore stopped before it replaced anything/,
    );
  });

  test('a computer of another installation is left out, and nothing of its is touched', async () => {
    const rig = await backedUp();
    const contents = JSON.parse(readFileSync(join(rig.set, 'contents.json'), 'utf8'));
    for (const computer of contents.computers)
      if (computer.computer === COMPUTERS[1]) computer.labels['melete.project'] = 'other';
    replaceInSet(rig.set, 'contents.json', JSON.stringify(contents));
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toMatch(
      /warn\s+restore\.computers_left_out\s+1 agent computer\(s\) in this backup are not this installation's \(MELETE_SANDBOX_PROJECT=proj\)/,
    );
    expect(printed).toContain(`src=${COMPUTERS[0]}-home,dst=/v`);
    expect(printed).not.toContain(`src=${COMPUTERS[1]}-home,dst=/v`);
    expect(printed).not.toContain(`src=${COMPUTERS[1]}-work,dst=/v`);
    expect(printed).toContain(`docker stop ${COMPUTERS[0]}\n`);

    // A volume of the same name here that is labelled for something else is never emptied.
    const taken = await backedUp();
    taken.owners.set(`${COMPUTERS[0]}-home`, {
      ...labelsOf(COMPUTERS[0] ?? ''),
      'melete.project': 'other',
    });
    expect(await runRestore(taken.context, [taken.set], false)).toBe(0);
    expect(taken.context.printed()).toMatch(
      /warn\s+restore\.computers_left_out\s+1 agent computer/,
    );
    expect(taken.context.printed()).not.toContain(`src=${COMPUTERS[0]}-work,dst=/v`);
    expect(taken.context.printed()).not.toContain(`src=${COMPUTERS[0]}-home,dst=/v`);
    expect(taken.context.printed()).toContain(`src=${COMPUTERS[1]}-work,dst=/v`);
  });

  test('a backup an earlier --with-volumes made puts back its spaces, files and /work, never its journal', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, ['--database-only'], false)).toBe(0);
    for (const file of ['data.tar', 'work.tar']) writeFileSync(join(rig.set, file), `old ${file}`);
    const sums = readFileSync(join(rig.set, 'SHA256SUMS'), 'utf8');
    writeFileSync(
      join(rig.set, 'SHA256SUMS'),
      `${sums}${['data.tar', 'work.tar']
        .map((file) => `${createHash('sha256').update(`old ${file}`).digest('hex')}  ${file}`)
        .join('\n')}\n`,
    );
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toContain(
      'find /r/data/spaces -mindepth 1 -delete && find /r/data/artifacts -mindepth 1 -delete && exec tar -C /r --numeric-owner -xpf - data/spaces data/artifacts',
    );
    expect(printed).toContain('exec tar -C /r --numeric-owner -xpf - work');
    expect(printed).not.toContain('data/restrictions');
    // Each archive is checked to hold what is put back from it, before its volumes are emptied.
    expect(await runRestore(rig.context, [rig.set, '--verify'], false)).toBe(0);
    expect(rig.context.streams.map((call) => call.sinks)).toContainEqual([
      { command: ['tar', '-tf', '-', 'data/spaces', 'data/artifacts'] },
    ]);
    expect(rig.context.streams.map((call) => call.sinks)).toContainEqual([
      { command: ['tar', '-tf', '-', 'work'] },
    ]);
    rig.context.streamFails.push('tar -tf - data/spaces data/artifacts');
    expect(await runRestore(rig.context, [rig.set, '--verify'], false)).toBe(1);
  });

  test('a backup made with --database-only restores the database and leaves the files here alone', async () => {
    const rig = filesRig();
    expect(await runBackup(rig.context, ['--database-only'], false)).toBe(0);
    expect(await runRestore(rig.context, [rig.set], false)).toBe(0);
    const printed = rig.context.printed();
    expect(printed).toMatch(/warn\s+restore\.files\s+This backup holds no files/);
    expect(printed).not.toContain('find /v');
  });

  test('a list of parts naming a volume or label a shell could misread is refused', () => {
    const good = {
      format: 1,
      taken: 'online',
      parts: [
        { part: 'spaces', file: 'spaces.tar' },
        { part: 'artifacts', file: 'artifacts.tar' },
        { part: 'work', file: 'work.tar' },
      ],
      computers: [
        {
          volume: `${COMPUTERS[0]}-work`,
          computer: COMPUTERS[0],
          labels: labelsOf(COMPUTERS[0] ?? ''),
          file: `computer-${COMPUTERS[0]}-work.tar`,
        },
      ],
      blobs: 'local',
    };
    expect(typeof parseContents(JSON.stringify(good))).toBe('object');
    const bad = (change: (value: typeof good) => void) => {
      const value = structuredClone(good);
      change(value);
      return parseContents(JSON.stringify(value));
    };
    for (const result of [
      bad((value) => {
        Object.assign((value.computers[0] as { labels: Record<string, string> }).labels, {
          x: '$(id)',
        });
      }),
      bad((value) => {
        (value.computers[0] as { volume: string }).volume = 'melete_pgdata';
      }),
      bad((value) => {
        (value.parts[0] as { file: string }).file = '../spaces.tar';
      }),
      // A list without every part, or without how it was taken, is refused too.
      bad((value) => {
        value.parts.pop();
      }),
      bad((value) => {
        (value as { taken: string }).taken = 'sometime';
      }),
      parseContents('{"format":2}'),
    ])
      expect(typeof result).toBe('string');
  });
});

describe('deploy backs up the files with the database', () => {
  test('the backup before migrations holds the files, and is sized with them', async () => {
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
    const [set] = readdirSync(backups);
    expect(readdirSync(join(backups, set ?? ''))).toEqual(
      expect.arrayContaining(['database.dump', 'spaces.tar', 'artifacts.tar', 'work.tar']),
    );
    expect(rig.context.printed()).toMatch(
      /ok\s+backup\.database\s+.*the database \(about 40 MB\) and the files \(about 10 MB\) are backed up/,
    );

    // Files that would not fit beside the pulls refuse the deploy before anything changes.
    const big = temporaryDeployDir();
    const tight = deployRig(
      big,
      {
        commits: new Map([
          [OLD, 68],
          [NEW, 69],
        ]),
        filesBytes: 5000 * MB,
      },
      { backup: { dir: join(big, '..', 'backups'), keep: 3 } },
    );
    expect(await runDeploy(tight.context, ['--checkout'], false, tight.dependencies)).toBe(2);
    expect(tight.context.printed()).toMatch(/fail\s+disk\.pull_estimate/);
    expect(tight.state.pulls).toEqual([]);
  });
});
