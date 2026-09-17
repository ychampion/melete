import { expect, test } from 'bun:test';
import { gatherFacts, missingPrerequisites, type PreflightFacts } from './preflight.ts';

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
