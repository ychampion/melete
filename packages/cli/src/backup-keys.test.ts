// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell lines, not templates.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandOutput } from '../../../apps/melete/src/runtime/docker-engine.ts';
import {
  backupOptions,
  encryptingSink,
  runBackup,
  takeBackup,
  withEncryption,
} from './commands/backup.ts';
import { gatherDoctor } from './commands/doctor.ts';
import { runRestore } from './commands/restore.ts';
import type { Endpoint, Source, StreamResult } from './context.ts';
import { composeCommand, deployConfigSchema } from './deploy-config.ts';
import { inspectLocal, inspectRemote } from './images.ts';
import { readInstallation } from './installation.ts';
import { masterKeyFingerprint } from './master-key.ts';
import { databaseSecrets, redact } from './redact.ts';
import { ok, temporaryDeployDir, testContext, writeEnv } from './testing.ts';

const PASSWORD = 's3cr%zzPass';
const RECIPIENT = `age1${'q'.repeat(58)}`;

/** A deployment with a backup directory, and a fake engine that answers what a backup asks. */
function rig(env: Record<string, string> = {}) {
  const deployDir = temporaryDeployDir();
  const backups = join(deployDir, '..', 'backups');
  const envText = writeEnv(deployDir, env);
  writeFileSync(
    join(deployDir, 'melete.deploy.json'),
    JSON.stringify({ contract: 1, backup: { dir: backups, keep: 3 } }),
  );
  const tools = new Set(['age', 'gpg']);
  const run = (command: readonly string[]): CommandOutput => {
    const text = command.join(' ');
    if ((text === 'age --version' || text === 'gpg --version') && !tools.has(command[0] ?? ''))
      return { code: 127, stdout: '', stderr: 'not found' };
    if (text.endsWith('--version')) return { code: 0, stdout: 'v1', stderr: '' };
    if (text.startsWith('docker volume inspect')) return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const context = testContext(deployDir, [], { run });
  return { deployDir, backups, envText, context, tools };
}

const masterKeyOf = (envText: string) => /MELETE_MASTER_KEY=(.+)/.exec(envText)?.[1] ?? '';

async function backupSet(r: ReturnType<typeof rig>) {
  expect(await runBackup(r.context, [], false)).toBe(0);
  const [set] = readdirSync(r.backups);
  return join(r.backups, set ?? '');
}

describe('the master key is kept apart from backups', () => {
  test('a restore without the key, or with another key, is refused with no steps', async () => {
    const r = rig();
    const set = await backupSet(r);
    // A new machine: its own deploy/.env with another key, and none in the terminal.
    writeEnv(r.deployDir, { MELETE_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
    const without = testContext(r.deployDir, [], { run: r.context.run });
    expect(await runRestore(without, [set, '--plan'], false)).toBe(2);
    expect(without.printed()).toMatch(/fail\s+restore\.master_key/);
    expect(without.printed()).not.toContain('To restore');

    const wrong = testContext(r.deployDir, [], {
      run: r.context.run,
      environment: { MELETE_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') },
    });
    expect(await runRestore(wrong, [set, '--plan'], false)).toBe(2);
    expect(wrong.printed()).toContain('is not the key this backup was made with');
  });

  test('the key supplied in the terminal is checked by its fingerprint and put back by the steps', async () => {
    const r = rig();
    const set = await backupSet(r);
    const key = masterKeyOf(r.envText);
    writeEnv(r.deployDir, { MELETE_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });
    const right = testContext(r.deployDir, [], {
      run: r.context.run,
      environment: { MELETE_MASTER_KEY: key },
    });
    expect(await runRestore(right, [set, '--plan'], true)).toBe(0);
    const plan = JSON.parse(right.printed()) as { steps: string[] };
    expect(plan.steps).toContain('bun run melete set --from-env MELETE_MASTER_KEY');
    // The plan names the key, never shows it.
    expect(right.printed()).not.toContain(key);
    expect(readFileSync(join(set, 'master-key.fingerprint'), 'utf8').trim()).toBe(
      masterKeyFingerprint(key),
    );
  });
});

describe('encrypted backups', () => {
  test('options take --encrypt and an age recipient, and refuse anything else as a recipient', () => {
    expect(backupOptions(['--encrypt']).encrypt).toBe('passphrase');
    expect(backupOptions(['--encrypt-to', RECIPIENT]).encrypt).toEqual({ recipient: RECIPIENT });
    expect(() => backupOptions(['--encrypt-to', 'rm -rf /'])).toThrow('not an age recipient');
  });

  test('each part is encrypted on its way to a new private file, or into the command that writes it elsewhere', () => {
    expect(
      encryptingSink({ kind: 'age', recipient: RECIPIENT }, { file: '/b/database.dump.age' }),
    ).toEqual({
      command: [
        'bash',
        '-c',
        'set -o pipefail -o noclobber; umask 077; age -r "$1" > "$2"',
        'bash',
        RECIPIENT,
        '/b/database.dump.age',
      ],
    });
    const remote = encryptingSink(
      { kind: 'gpg', passphraseFile: '/tmp/p/passphrase' },
      { command: ['ssh', '-o', 'BatchMode=yes', 'vault', 'umask 077 && cat > /srv/x'] },
    );
    expect(remote).toEqual({
      command: [
        'bash',
        '-c',
        'set -o pipefail; gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$1" --symmetric --cipher-algo AES256 | "${@:2}"',
        'bash',
        '/tmp/p/passphrase',
        'ssh',
        '-o',
        'BatchMode=yes',
        'vault',
        'umask 077 && cat > /srv/x',
      ],
    });
  });

  test('an encrypted set lists what was stored, and restore decrypts each part into its command', async () => {
    const r = rig();
    // A stream that plays the encrypting sink: it writes "encrypted" bytes to the file it names.
    const calls: { source: Source; sinks: readonly Endpoint[] }[] = [];
    r.context.stream = async (source, sinks): Promise<StreamResult> => {
      calls.push({ source, sinks });
      const bytes = Buffer.from(
        `cipher of ${'command' in source ? source.command.join(' ') : 'file' in source ? source.file : 'bytes'}`,
      );
      for (const sink of sinks) {
        if ('file' in sink)
          writeFileSync(sink.file, 'bytes' in source ? Buffer.from(source.bytes) : bytes, {
            flag: 'wx',
            mode: 0o600,
          });
        else if (sink.command[0] === 'bash')
          writeFileSync(sink.command.at(-1) ?? '', bytes, { flag: 'wx', mode: 0o600 });
      }
      const read =
        'bytes' in source
          ? Buffer.from(source.bytes)
          : 'file' in source && existsSync(source.file)
            ? readFileSync(source.file)
            : bytes;
      return {
        ok: true,
        bytes: read.length,
        sha256: createHash('sha256').update(read).digest('hex'),
        detail: '',
      };
    };
    expect(await runBackup(r.context, ['--encrypt-to', RECIPIENT], false)).toBe(0);
    const [name] = readdirSync(r.backups);
    const set = join(r.backups, name ?? '');
    const files = readdirSync(set).sort();
    expect(files).toEqual([
      'SHA256SUMS',
      'database.dump.age',
      'deploy.env.age',
      'master-key.fingerprint',
      'melete.deploy.json.age',
      `restrictions-${(name ?? '').slice('melete-'.length)}.tar.age`,
    ]);
    // The sums are of the stored, encrypted files, so the set is checked without its key.
    const sums = readFileSync(join(set, 'SHA256SUMS'), 'utf8');
    for (const file of files.filter((f) => f !== 'SHA256SUMS'))
      expect(sums).toContain(
        `${createHash('sha256')
          .update(readFileSync(join(set, file)))
          .digest('hex')}  ${file}`,
      );
    expect(r.context.printed()).toContain('backup.encrypted');
    expect(r.context.printed()).not.toContain('backup.plaintext');

    const restore = testContext(r.deployDir, [], { run: r.context.run });
    expect(await runRestore(restore, [set, '--plan'], true)).toBe(0);
    const steps = (JSON.parse(restore.printed()) as { steps: string[] }).steps.join('\n');
    expect(steps).toContain(`age -d -i "$MELETE_BACKUP_IDENTITY" '${set}/database.dump.age' | `);
    expect(steps).not.toContain("database.dump.age' <");
    expect(steps).not.toMatch(/< \S*database\.dump/);
  });

  test('an unencrypted backup says plainly what it holds', async () => {
    const r = rig();
    await backupSet(r);
    expect(r.context.printed()).toMatch(/warn\s+backup\.plaintext/);
    expect(r.context.printed()).toMatch(/warn\s+backup\.master_key_apart/);
  });

  test('without the tool, or a passphrase, nothing is written; the passphrase file is removed after', async () => {
    const r = rig();
    r.tools.delete('age');
    expect(await runBackup(r.context, ['--encrypt-to', RECIPIENT], false)).toBe(2);
    expect(r.context.errors()).toContain('age is not installed here');
    expect(existsSync(r.backups)).toBe(false);
    expect(await runBackup(r.context, ['--encrypt'], false)).toBe(2);
    expect(r.context.errors()).toContain('MELETE_BACKUP_PASSPHRASE');

    let seen = '';
    await withEncryption(
      { ...r.context, environment: { MELETE_BACKUP_PASSPHRASE: 'a long enough passphrase' } },
      'passphrase',
      async (encryption) => {
        seen = encryption?.kind === 'gpg' ? encryption.passphraseFile : '';
        expect(readFileSync(seen, 'utf8')).toBe('a long enough passphrase');
      },
    );
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });
});

describe('database errors never print the URL or its password', () => {
  const env = {
    DATABASE_URL: `postgres://melete:${PASSWORD}@db.example.net:5432/melete?sslmode=verify-full`,
    POSTGRES_PASSWORD: 'bundled-password-value',
  };

  test('libpq repeating a malformed password, or the URL, is hidden', () => {
    const secrets = databaseSecrets(env);
    const said = `psql: error: invalid percent-encoded token: "${PASSWORD}"; connection to "${env.DATABASE_URL}" failed; password=${env.POSTGRES_PASSWORD}`;
    const shown = redact(said, secrets);
    expect(shown).not.toContain(PASSWORD);
    expect(shown).not.toContain('bundled-password-value');
    expect(shown).toContain('invalid percent-encoded token: "***"');
    // A token libpq echoes from a URL that is not in deploy/.env is hidden too.
    expect(redact('invalid percent-encoded token: "pa%zzss"', [])).toBe(
      'invalid percent-encoded token: "***"',
    );
    // A URL not in deploy/.env still loses its password.
    expect(redact('postgres://u:other-pass@h/d', [])).toBe('postgres://u:***@h/d');
  });

  test('doctor reports the database error without the password', async () => {
    const deployDir = temporaryDeployDir();
    writeEnv(deployDir, { DATABASE_URL: env.DATABASE_URL });
    writeFileSync(
      join(deployDir, 'melete.deploy.json'),
      JSON.stringify({ contract: 1, database: { external: true } }),
    );
    const installation = readInstallation(deployDir, 'linux');
    const compose = composeCommand(deployDir, installation.config).join(' ');
    const image =
      'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
    const context = testContext(deployDir, [
      [`${compose} config --images`, ok(`${image}\n`)],
      ['docker image inspect', ok('sha256:1')],
      [`${compose} ps`, ok('')],
      [
        `${compose} run --rm --no-deps -T database-client`,
        {
          code: 2,
          stdout: '',
          stderr: `psql: error: invalid percent-encoded token: "${PASSWORD}"`,
        },
      ],
    ]);
    const facts = await gatherDoctor(context, installation, false);
    expect(JSON.stringify(facts.database)).not.toContain(PASSWORD);
    expect(JSON.stringify(facts.database)).toContain('***');
  });

  test('a failed backup part reports its error without the password', async () => {
    const r = rig({ DATABASE_URL: env.DATABASE_URL });
    r.context.stream = async () => ({
      ok: false,
      bytes: 0,
      sha256: '',
      detail: `pg_dump exited 1: invalid percent-encoded token: "${PASSWORD}"`,
    });
    const config = deployConfigSchema.parse({ contract: 1 });
    const outcome = await takeBackup(r.context, config, { kind: 'dir', dir: r.backups }, false);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome.results)).not.toContain(PASSWORD);
  });
});

describe('the commit an image names', () => {
  test('only a full commit hash is used; anything else is refused or left unknown', () => {
    const label =
      (revision: string) =>
      (command: readonly string[]): CommandOutput => {
        const text = command.join(' ');
        if (text.includes('--format {{json .Manifest}}'))
          return {
            code: 0,
            stdout: JSON.stringify({ digest: 'sha256:d', layers: [{ size: 1 }] }),
            stderr: '',
          };
        if (text.includes('--format {{json .Image}}'))
          return {
            code: 0,
            stdout: JSON.stringify({
              rootfs: { diff_ids: ['sha256:a'] },
              config: { Labels: { 'org.opencontainers.image.revision': revision } },
            }),
            stderr: '',
          };
        if (text.startsWith('docker image inspect'))
          return {
            code: 0,
            stdout: JSON.stringify({
              Id: 'sha256:i',
              Config: { Labels: { 'org.opencontainers.image.revision': revision } },
            }),
            stderr: '',
          };
        return { code: 1, stdout: '', stderr: '' };
      };
    for (const bad of ['--upload-pack=touch /tmp/x', 'main', 'abc1234', `${'a'.repeat(40)}\n`]) {
      expect(inspectRemote(label(bad), 'ghcr.io/o/melete-web:main', 'amd64')).toMatchObject({
        error: expect.stringContaining('not a 40-character commit hash'),
      });
      expect(inspectLocal(label(bad), ['x']).get('x')?.revision).toBeNull();
    }
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(inspectRemote(label(commit), 'ghcr.io/o/melete-web:main', 'amd64')).toMatchObject({
      revision: commit,
    });
    expect(inspectLocal(label(commit), ['x']).get('x')?.revision).toBe(commit);
  });
});
