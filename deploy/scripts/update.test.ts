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
  ] as const) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), 0o755);
  }
  const result = Bun.spawnSync([bash ?? 'bash', script, ...args], {
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
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
