/**
 * A scan runs inside the service process. When the process stops part way
 * through one, the scan row is left saying it is running, and a scan that
 * says it is running is what every later request to scan is handed back.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-scan-restart-'));
const withDb = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

withDb('a scan cut off by a restart is closed, so the person can scan again', async () => {
  if (!fixture) return;
  const spaceId = newId('sp');
  const ownerId = newId('own');
  await fixture.db.insert(owner).values({ id: ownerId, email: 'restart@example.test' });
  await fixture.sql`insert into principal (id, email, password_hash)
    select id, email, password_hash from owner where id = ${ownerId}`;
  await fixture.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  const scanOwner = { spaceId, principalId: ownerId };
  const store = new PostgresCompanyStore(fixture.db);
  const cut = await store.openScan(scanOwner);
  expect((await store.runningScan(scanOwner))?.id).toBe(cut.id);

  const service = await bootstrap({
    workers: false,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: fixture.url,
      MELETE_CAPABILITY_KEY: 'scan-restart-fixture-key'.repeat(2),
      MELETE_RUNTIME_ADAPTER: 'stub',
      MELETE_SPACES_DIR: root,
      MELETE_WORK_DIR: root,
    }),
  });
  await service.close();

  expect(await store.runningScan(scanOwner)).toBe(null);
  const closed = await store.scan(scanOwner, cut.id);
  expect(closed?.status).toBe('failed');
  expect(closed?.error).toBeTruthy();
});
