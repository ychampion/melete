import { expect, test } from 'bun:test';
import {
  gatherFacts,
  missingPrerequisites,
  type PreflightFacts,
  preflightReport,
} from './preflight.ts';

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
  expect(gatherFacts({}, [], old).docker).toBeUndefined();
  expect(asked).toEqual([]);

  const requested = gatherFacts({ MELETE_CONFORMANCE_COMPOSE: '1' }, [], old);
  expect(asked.map((command) => command.slice(0, 2).join(' '))).toEqual([
    'docker version',
    'docker compose',
  ]);
  expect(requested.docker).toHaveLength(2);
  expect(gatherFacts({}, ['--docker'], old).docker).toHaveLength(2);

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
  const supported = gatherFacts({}, ['--docker'], current);
  expect(missingPrerequisites({ ...supported, ...host })).toEqual([]);
  expect(preflightReport({ ...supported, ...host })).toStartWith('doctor: every');
  const unsupported = gatherFacts({}, ['--docker'], old);
  expect(missingPrerequisites({ ...unsupported, ...host })).toHaveLength(2);
  // The deployment scenarios run the suite, so they still judge both.
  const scenarios = gatherFacts({ MELETE_CONFORMANCE_COMPOSE: '1' }, ['--docker'], current);
  expect(missingPrerequisites({ ...scenarios, ...host }).map((line) => line.split(' ')[0])).toEqual(
    ['DATABASE_URL', 'uv'],
  );
});
