import { expect, test } from 'bun:test';
import type { CommandOutput } from '../../src/runtime/docker-engine.ts';
import type { MachineAccess } from '../../src/runtime/docker-host.ts';
import {
  gatherFacts,
  missingPrerequisites,
  type PreflightFacts,
  preflightReport,
} from './preflight.ts';

const linux: MachineAccess = {
  platform: 'linux',
  env: {},
  exists: () => false,
  installed: () => [],
};

const complete: PreflightFacts = {
  platform: 'linux',
  uid: 1000,
  databaseUrl: 'postgres://melete_test:test@127.0.0.1:5432/postgres',
  tmpdirWritable: true,
  libpq: true,
  uv: true,
};

test('a Linux host with a real Postgres and uv has nothing missing', () => {
  expect(missingPrerequisites(complete)).toEqual([]);
});

test('each missing prerequisite is named once, by name', () => {
  const lines = missingPrerequisites({
    ...complete,
    uid: 0,
    databaseUrl: undefined,
    tmpdirWritable: false,
    libpq: false,
    uv: false,
  });
  expect(lines).toHaveLength(5);
  expect(lines.map((line) => line.split(/[ ;(]/)[0])).toEqual([
    'TMPDIR',
    'tests',
    'DATABASE_URL',
    'libpq5',
    'uv',
  ]);
  expect(lines.some((line) => line.includes('root'))).toBe(true);
});

test('Windows and macOS run embedded Postgres without libpq or a DATABASE_URL', () => {
  expect(missingPrerequisites({ ...complete, platform: 'win32', databaseUrl: undefined })).toEqual(
    [],
  );
  expect(missingPrerequisites({ ...complete, platform: 'darwin', databaseUrl: undefined })).toEqual(
    [],
  );
});

test('the Docker host is judged only when the deployment scenarios are requested', () => {
  const asked: string[][] = [];
  const old = (command: readonly string[]) => {
    asked.push([...command]);
    return { code: 0, stdout: command.includes('compose') ? '2.30.0' : '1.47 27.5.1', stderr: '' };
  };
  expect(gatherFacts({}, [], old, linux).docker).toBeUndefined();
  expect(asked).toEqual([]);

  const requested = gatherFacts({ MELETE_CONFORMANCE_COMPOSE: '1' }, [], old, linux);
  expect(asked.map((command) => command.slice(0, 2).join(' '))).toEqual([
    'docker version',
    'docker compose',
    'docker info',
    'docker context',
  ]);
  expect(requested.docker).toHaveLength(2);
  expect(gatherFacts({}, ['--docker'], old, linux).docker).toHaveLength(2);

  const lines = missingPrerequisites({ ...complete, docker: requested.docker });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('Docker Engine 27.5.1 (API 1.47) is too old');
  expect(lines[1]).toContain('Docker Compose 2.30.0 is too old');
  expect(missingPrerequisites({ ...complete, docker: [] })).toEqual([]);
});

test('--docker alone judges only what a host running the stack needs', () => {
  const current = (command: readonly string[]) => ({
    code: 0,
    stdout: command.includes('compose') ? '2.40.3' : '1.51 28.5.1',
    stderr: '',
  });
  const old = (command: readonly string[]) => ({
    code: 0,
    stdout: command.includes('compose') ? '2.30.0' : '1.47 27.5.1',
    stderr: '',
  });
  // A deploy-only host: no DATABASE_URL on Linux, no uv. Neither concerns the stack.
  const host = { databaseUrl: undefined, platform: 'linux' as const, uv: false };
  const supported = gatherFacts({}, ['--docker'], current, linux);
  expect(missingPrerequisites({ ...supported, ...host })).toEqual([]);
  expect(preflightReport({ ...supported, ...host })).toStartWith('doctor: every');
  const unsupported = gatherFacts({}, ['--docker'], old, linux);
  expect(missingPrerequisites({ ...unsupported, ...host })).toHaveLength(2);
  // The deployment scenarios run the suite, so they still judge both.
  const scenarios = gatherFacts({ MELETE_CONFORMANCE_COMPOSE: '1' }, ['--docker'], current, linux);
  expect(missingPrerequisites({ ...scenarios, ...host }).map((line) => line.split(' ')[0])).toEqual(
    ['DATABASE_URL', 'uv'],
  );
});

test('on Windows, --docker judges Docker Desktop: its pipe, its mode, its memory and the paths', () => {
  const GIB = 1024 ** 3;
  const windows = (pipe: boolean): MachineAccess => ({
    platform: 'win32',
    env: {},
    exists: () => pipe,
    installed: () => ['.bun/short.js'],
  });
  const desktop =
    (fields: Record<string, unknown>) =>
    (command: readonly string[]): CommandOutput => {
      const line = command.join(' ');
      const stdout = line.startsWith('docker version')
        ? '1.51 28.5.1'
        : line.startsWith('docker compose')
          ? 'v2.40.3-desktop.1'
          : line.startsWith('docker info')
            ? JSON.stringify({
                OSType: 'linux',
                OperatingSystem: 'Docker Desktop',
                KernelVersion: '6.6.87.2-microsoft-standard-WSL2',
                MemTotal: 8 * GIB,
                ...fields,
              })
            : line.startsWith('docker context')
              ? 'npipe:////./pipe/dockerDesktopLinuxEngine'
              : line.startsWith('reg query')
                ? 'LongPathsEnabled    REG_DWORD    0x0'
                : line.endsWith('ls-files')
                  ? 'README.md'
                  : '';
      return { code: 0, stdout, stderr: '' };
    };
  const judged = (fields: Record<string, unknown>, pipe = true) =>
    preflightReport(gatherFacts({}, ['--docker'], desktop(fields), windows(pipe)));
  expect(judged({})).toBe('doctor: every Docker Engine and Compose requirement is met.\n');
  expect(judged({ OSType: 'windows' })).toContain('Switch to Linux containers');
  expect(judged({ MemTotal: 2 * GIB })).toContain('.wslconfig');
  const stopped = (command: readonly string[]): CommandOutput =>
    command[1] === 'compose'
      ? { code: 0, stdout: 'v2.40.3-desktop.1', stderr: '' }
      : { code: 1, stdout: '', stderr: 'error during connect' };
  const report = preflightReport(gatherFacts({}, ['--docker'], stopped, windows(false)));
  expect(report).toContain('doctor: 1 missing prerequisite(s)');
  expect(report).toContain('Docker Desktop is not running');
});

test('--docker names an engine on another machine and accepts it', () => {
  const remote = (command: readonly string[]): CommandOutput => {
    const line = command.join(' ');
    const stdout = line.startsWith('docker version')
      ? '1.51 28.5.1'
      : line.startsWith('docker compose')
        ? '2.40.3'
        : line.startsWith('docker info')
          ? JSON.stringify({ OSType: 'linux', OperatingSystem: 'Ubuntu 24.04.3 LTS', MemTotal: 1 })
          : line.startsWith('docker context')
            ? 'ssh://deploy@droplet.example.net'
            : '';
    return { code: 0, stdout, stderr: '' };
  };
  const report = preflightReport(gatherFacts({}, ['--docker'], remote, linux));
  expect(report).toStartWith('doctor: every Docker Engine and Compose requirement is met.\n');
  expect(report).toContain('doctor: The Docker engine is on droplet.example.net');
});
