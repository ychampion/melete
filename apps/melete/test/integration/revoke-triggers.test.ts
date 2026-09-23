/**
 * Revoking a connection stops everything listening on it: an event trigger
 * and a watch trigger alike. A chase's reply trigger is a watch.
 */
import { afterAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { connection, owner, space, trigger } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'revoke-triggers-signing-key-32-bytes',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const withDb = triggers ? test : test.skip;

afterAll(async () => {
  await triggers?.stop();
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
}, 30_000);

withDb(
  'revoking a connection disables its watch triggers as well as its event triggers',
  async () => {
    if (!handle || !jobs || !runner || !triggers) return;
    const spaceId = newId('sp');
    const ownerId = newId('own');
    const connectionId = newId('conn');
    await handle.db.insert(owner).values({ id: ownerId, email: 'revoke@example.test' });
    await handle.sql`insert into principal (id, email, password_hash)
    select id, email, password_hash from owner where id = ${ownerId}`;
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Mailbox' });
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Chase',
      objective: 'Wait for Acme',
    });
    await triggers.create(row.id, {
      kind: 'event',
      connection_id: connectionId,
      event_name: 'mail.new',
      poll_seconds: 300,
    });
    await triggers.create(row.id, {
      kind: 'watch',
      connection_id: connectionId,
      event_name: 'mail.new',
      predicate: { all: [{ field: 'from', op: 'matches', value: '@acme\\.test>?$' }] },
      poll_seconds: 300,
    });

    await new PolicyService(jobs, runner).changeConnection(connectionId, {
      kind: 'revoke',
      expected_generation: 0,
    });

    const rows = await handle.db.select().from(trigger).where(eq(trigger.jobId, row.id));
    expect(rows.map((entry) => [entry.kind, entry.enabled]).sort()).toEqual([
      ['event', false],
      ['watch', false],
    ]);
  },
);
