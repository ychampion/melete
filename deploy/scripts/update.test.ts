/**
 * deploy/scripts/update.sh against stand-ins for docker and git that record
 * each call: the order a host relies on (space, checkout, every pull, start,
 * restart, prune last), and the refusals that leave a running stack untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const script = resolve(import.meta.dir, 'update.sh');
// Windows resolves `bash` to WSL's launcher; there the test needs Git Bash named.
const bash = process.platform === 'win32' ? process.env.MELETE_TEST_BASH : Bun.which('bash');

const PUBLISHED = [
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
  'ghcr.io/ychampion/melete-service:main',
  'ghcr.io/ychampion/melete-runtime:main',
  'ghcr.io/ychampion/melete-runtime:main',
  'ghcr.io/ychampion/melete-web:main',
];

const STUB_DOCKER = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "info --format {{.DockerRootDir}}") printf '%s\\n' "$STUB_ROOT" ;;
  *" config --images") printf '%s\\n' $STUB_IMAGES ;;
  *" pull"*) exit "\${STUB_PULL_EXIT:-0}" ;;
  "image inspect melete-sandbox:local") exit "\${STUB_LOCAL_SANDBOX:-1}" ;;
esac
exit 0
`;
const STUB_GIT = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$STUB_LOG"
exit "\${STUB_GIT_EXIT:-0}"
`;
// `bun run melete quiet`: with --time-only it checks the service and waits for
// --at; otherwise it waits for a quiet moment and drains, or cancels the drain.
const STUB_BUN = `#!/usr/bin/env bash
printf 'bun %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"quiet --cancel") exit 0 ;;
  *" --time-only") exit "\${STUB_TIME_EXIT:-0}" ;;
  *" quiet"*) exit "\${STUB_QUIET_EXIT:-0}" ;;
esac
exit 0
`;
/**
 * Runs the script with the stand-ins first on PATH. Git for Windows' bash puts
 * its own directories (and its git) ahead of the PATH it is given, so the
 * stand-ins are put first again inside bash, which then runs the script.
 */
const FIRST_ON_PATH = [
  'stubs="$STUB_DIR"',
  'if command -v cygpath >/dev/null 2>&1; then stubs="$(cygpath -u "$stubs")"; fi',
  'PATH="$stubs:$PATH"',
  'exec "$BASH" "$0" "$@"',
].join('\n');

let directory = '';
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = '';
});

function run(env: Record<string, string>, args: string[] = []) {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = mkdtempSync(join(tmpdir(), 'melete-update-'));
  const log = join(directory, 'calls.log');
  writeFileSync(log, '');
  for (const [name, body] of [
    ['docker', STUB_DOCKER],
    ['git', STUB_GIT],
    ['bun', STUB_BUN],
  ] as const) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), 0o755);
  }
  const result = Bun.spawnSync([bash ?? 'bash', '-c', FIRST_ON_PATH, script, ...args], {
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      STUB_DIR: directory,
      // Were a real git ever reached, it would find no repository to change.
      GIT_DIR: join(directory, 'no-repository'),
      STUB_LOG: log,
      STUB_ROOT: directory,
      STUB_IMAGES: PUBLISHED.join(' '),
      MELETE_UPDATE_MIN_FREE_GB: '0',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^docker compose -f deploy\/docker-compose\.yml /, 'compose '));
  return { code: result.exitCode, stderr: result.stderr.toString(), calls };
}

const changes = (calls: string[]) =>
  calls.filter((line) => /^compose .*\b(pull|up|restart)\b|^docker (image prune|tag)/.test(line));

describe.skipIf(!bash)('update.sh', () => {
  test('pulls everything first, restarts the service, and prunes last', () => {
    const { code, calls } = run({}, ['--profile', 'sandbox']);
    expect(code).toBe(0);
    expect(calls.indexOf('git pull --ff-only')).toBeGreaterThan(
      calls.indexOf('docker info --format {{.DockerRootDir}}'),
    );
    expect(changes(calls)).toEqual([
      'compose --profile sandbox pull',
      'compose --profile sandbox up -d --no-build --wait --wait-timeout 600',
      'compose --profile sandbox restart melete',
      'compose --profile sandbox up -d --no-build --wait --wait-timeout 600',
      'docker image prune -f',
    ]);
    expect(calls.some((line) => /\bbuild\b/.test(line.replace('--no-build', '')))).toBe(false);
  });

  test('a failed pull stops before anything running is touched', () => {
    const { code, stderr, calls } = run({ STUB_PULL_EXIT: '1' });
    expect(code).not.toBe(0);
    expect(stderr).toContain('the running containers were not touched');
    expect(changes(calls)).toEqual(['compose pull']);
  });

  test('refuses to pull with too little space, before the checkout moves', () => {
    const { code, stderr, calls } = run({ MELETE_UPDATE_MIN_FREE_GB: '100000000' });
    expect(code).not.toBe(0);
    expect(stderr).toContain('Nothing was changed');
    expect(calls.some((line) => line.startsWith('git '))).toBe(false);
    expect(changes(calls)).toEqual([]);
  });

  test('refuses an installation that builds from source', () => {
    const { code, stderr, calls } = run({
      STUB_IMAGES: 'melete-service:local melete-runtime:local melete-web:local',
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain('MELETE_IMAGE_TAG is not set');
    expect(changes(calls)).toEqual([]);
  });

  test('a checkout that cannot fast-forward stops the update', () => {
    const { code, calls } = run({ STUB_GIT_EXIT: '1' });
    expect(code).not.toBe(0);
    expect(changes(calls)).toEqual([]);
  });

  test('runs the stand-ins, never a real git, whatever bash puts first on PATH', () => {
    const { code, calls } = run({});
    expect(code).toBe(0);
    expect(calls).toContain('git pull --ff-only');
  });

  test('--when-quiet waits for --at, pulls, then waits for quiet and drains before the restart', () => {
    const { code, calls } = run({}, [
      '--when-quiet',
      '--at',
      '03:00',
      '--max-wait',
      '90',
      '--profile',
      'sandbox',
    ]);
    expect(code).toBe(0);
    const timed = calls.indexOf('bun run melete quiet --at 03:00 --time-only');
    const drained = calls.indexOf('bun run melete quiet --max-wait 90');
    expect(timed).toBeGreaterThan(calls.indexOf('docker info --format {{.DockerRootDir}}'));
    expect(timed).toBeLessThan(calls.indexOf('git pull --ff-only'));
    // The code and the images download before the drain, so no new work waits on them.
    expect(drained).toBeGreaterThan(calls.indexOf('git pull --ff-only'));
    expect(drained).toBeGreaterThan(calls.indexOf('compose --profile sandbox pull'));
    expect(drained).toBeLessThan(
      calls.indexOf('compose --profile sandbox up -d --no-build --wait --wait-timeout 600'),
    );
    expect(calls.at(-1)).toBe('bun run melete quiet --cancel');
    // The timing options are not Compose's.
    expect(changes(calls)[0]).toBe('compose --profile sandbox pull');
  });

  test('--when-quiet with no quiet moment pulls, but stops and restarts nothing', () => {
    const { code, stderr, calls } = run({ STUB_QUIET_EXIT: '1' }, ['--when-quiet']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('no quiet moment came in time');
    expect(stderr).toContain('nothing running was stopped or restarted');
    expect(calls).toContain('git pull --ff-only');
    expect(changes(calls)).toEqual(['compose pull']);
    // The drain it may have left on is cancelled on the way out.
    expect(calls.at(-1)).toBe('bun run melete quiet --cancel');
  });

  test('--when-quiet with a service that cannot answer changes nothing', () => {
    const { code, stderr, calls } = run({ STUB_TIME_EXIT: '2' }, ['--when-quiet']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('nothing was changed');
    expect(calls.some((line) => line.startsWith('git '))).toBe(false);
    expect(changes(calls)).toEqual([]);
    expect(calls.filter((line) => line.startsWith('bun '))).toEqual([
      'bun run melete quiet --time-only',
    ]);
  });

  test('--at without --when-quiet is refused', () => {
    const { code, calls } = run({}, ['--at', '03:00']);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('keeps computers made before the switch on the published image', () => {
    const images = [...PUBLISHED, 'ghcr.io/ychampion/melete-sandbox:main'].join(' ');
    const { code, calls } = run({ STUB_IMAGES: images, STUB_LOCAL_SANDBOX: '0' });
    expect(code).toBe(0);
    const tag = 'docker tag ghcr.io/ychampion/melete-sandbox:main melete-sandbox:local';
    expect(calls.indexOf(tag)).toBeGreaterThan(calls.indexOf('compose pull'));
    expect(calls.indexOf(tag)).toBeLessThan(calls.indexOf('docker image prune -f'));
    // Without an old local image there is nothing to keep pointing.
    const fresh = run({ STUB_IMAGES: images });
    expect(fresh.calls.some((line) => line.startsWith('docker tag'))).toBe(false);
  });
});
