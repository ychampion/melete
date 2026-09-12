import { expect, test } from 'bun:test';
import { missingPrerequisites, type PreflightFacts } from './preflight.ts';

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
