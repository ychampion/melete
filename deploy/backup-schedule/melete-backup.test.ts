/**
 * The scheduled backup's check-in: a finished backup calls the address as it
 * is, and a failed one calls an address the monitor reads as a failure, even
 * when the address carries a query string.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Windows resolves `bash` to WSL's launcher; there the test needs Git Bash named.
const bash = process.platform === 'win32' ? process.env.MELETE_TEST_BASH : Bun.which('bash');
const script = join(import.meta.dir, 'melete-backup.sh');

const STUB_BUN = `#!/usr/bin/env bash
exit "\${STUB_BUN_EXIT:-0}"
`;
const STUB_CURL = `#!/usr/bin/env bash
for last; do :; done
printf '%s\\n' "$last" >> "$STUB_LOG"
`;

let directory = '';
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** Runs the script with a backup that finishes or fails; answers the addresses it called. */
function run(pingUrl: string, backupFails: boolean) {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), 'melete-backup-'));
  const log = join(directory, 'pings.log');
  writeFileSync(log, '');
  for (const [name, body] of [
    ['bun', STUB_BUN],
    ['curl', STUB_CURL],
  ] as const) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), 0o755);
  }
  // The stubs go first on PATH inside the shell itself: Git Bash's launcher
  // puts its own directories ahead of an inherited PATH, which would run the
  // real curl.
  const stubsFirst =
    'PATH="$(cygpath -u "$STUB_DIR" 2>/dev/null || printf %s "$STUB_DIR"):$PATH" exec "$BASH" "$1"';
  const result = Bun.spawnSync([bash ?? 'bash', '-c', stubsFirst, 'melete-backup-test', script], {
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      STUB_DIR: directory,
      STUB_LOG: log,
      STUB_BUN_EXIT: backupFails ? '3' : '0',
      MELETE_BACKUP_TO: 'ssh://backup.example:/srv/melete',
      MELETE_BACKUP_RECIPIENT: 'age1example',
      MELETE_BACKUP_PING_URL: pingUrl,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pings = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { exit: result.exitCode, pings };
}

describe.skipIf(!bash)('the backup check-in', () => {
  test('a finished backup calls the address as it is', () => {
    const url = 'https://hc-ping.com/abc?rid=1';
    expect(run(url, false)).toEqual({ exit: 0, pings: [url] });
  });

  test('a failure adds /fail to the path, before any query', () => {
    expect(run('https://hc-ping.com/abc', true)).toEqual({
      exit: 3,
      pings: ['https://hc-ping.com/abc/fail'],
    });
    expect(run('https://hc-ping.com/abc/', true).pings).toEqual(['https://hc-ping.com/abc/fail']);
    expect(run('https://hc-ping.com/abc?rid=1', true).pings).toEqual([
      'https://hc-ping.com/abc/fail?rid=1',
    ]);
  });

  test('an Uptime Kuma push address reports a failure as status=down', () => {
    expect(run('https://kuma.example/api/push/T0k3n?status=up&msg=OK&ping=', true).pings).toEqual([
      'https://kuma.example/api/push/T0k3n?ping=&status=down&msg=backup%20failed',
    ]);
    expect(run('https://kuma.example/api/push/T0k3n', true).pings).toEqual([
      'https://kuma.example/api/push/T0k3n?status=down&msg=backup%20failed',
    ]);
    // A finished backup leaves Uptime Kuma's address as it is.
    const up = 'https://kuma.example/api/push/T0k3n?status=up&msg=OK&ping=';
    expect(run(up, false).pings).toEqual([up]);
  });
});
