/**
 * The lifecycle wait names a trigger. The attempt reads each trigger's event
 * name in its input, so the broker resolves that name to the one enabled
 * trigger of this job that carries it; an id still works exactly as before.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AttemptBundle, CapabilityClaims } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { pendingRuntimeWait, requestRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const dbTest = db ? test : test.skip;
afterAll(async () => {
  await db?.close();
});

const sql = () => {
  if (!db) throw new Error('Postgres unavailable');
  return db.sql;
};
const bundleOf = (claims: CapabilityClaims) =>
  ({
    attempt: {
      id: claims.attempt_id,
      job_id: claims.job_id,
      epoch: claims.epoch,
      revision: claims.revision,
    },
  }) as AttemptBundle;

async function withTrigger(eventName: string, options: { enabled?: boolean; jobId?: string } = {}) {
  const seeded = options.jobId ? null : await seedJob(sql(), { scopes: ['test.read', 'job.wait'] });
  const jobId = options.jobId ?? seeded?.claims.job_id;
  const [row] = await sql()`select space_id from job where id = ${jobId ?? ''}`;
  const [source] = await sql()`select id from connection where space_id = ${row?.space_id}`;
  const id = recordId('trg');
  await sql()`insert into trigger (id, job_id, kind, spec, enabled) values (${id}, ${jobId ?? ''}, 'event',
    ${JSON.stringify({ kind: 'event', connection_id: source?.id, event_name: eventName, poll_seconds: 300 })}::jsonb,
    ${options.enabled ?? true})`;
  return { id, claims: seeded?.claims };
}

describe('an event wait by name', () => {
  dbTest('resolves the event name to the enabled trigger of this job, broker-side', async () => {
    const { id, claims } = await withTrigger('mail.new');
    if (!claims) throw new Error('fixture claims absent');
    const result = await requestRuntimeWait(sql(), claims, {
      kind: 'event',
      event_name: 'mail.new',
    });
    // An omitted deadline is no deadline, and the stored wait carries the id.
    expect(result.wait).toEqual({ kind: 'event', trigger_id: id, deadline_at: null });
    expect(await pendingRuntimeWait(sql(), bundleOf(claims))).toEqual(result.wait);
  });

  dbTest('an event name typed where the trigger id goes resolves the same way', async () => {
    const { id, claims } = await withTrigger('calendar.changed');
    if (!claims) throw new Error('fixture claims absent');
    const result = await requestRuntimeWait(sql(), claims, {
      kind: 'event',
      trigger_id: 'calendar.changed',
      deadline_at: null,
    });
    expect(result.wait).toEqual({ kind: 'event', trigger_id: id, deadline_at: null });
  });

  dbTest('an unknown, disabled or ambiguous name is refused, and nothing is recorded', async () => {
    const { claims } = await withTrigger('mail.new');
    if (!claims) throw new Error('fixture claims absent');
    expect(
      await rejectionOf(requestRuntimeWait(sql(), claims, { kind: 'event', event_name: 'nope' })),
    ).toMatchObject({ code: 'scope_denied' });
    await withTrigger('mail.archived', { enabled: false, jobId: claims.job_id });
    expect(
      await rejectionOf(
        requestRuntimeWait(sql(), claims, { kind: 'event', event_name: 'mail.archived' }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    await withTrigger('mail.new', { jobId: claims.job_id });
    const ambiguous = await rejectionOf(
      requestRuntimeWait(sql(), claims, { kind: 'event', event_name: 'mail.new' }),
    );
    expect(ambiguous).toMatchObject({ code: 'payload_invalid' });
    expect((ambiguous as Error).message).toContain('trigger_id');
    // Another job's trigger with the same name is not this job's to wait on.
    const other = await withTrigger('server.down');
    expect(other.claims).toBeDefined();
    expect(
      await rejectionOf(
        requestRuntimeWait(sql(), claims, { kind: 'event', event_name: 'server.down' }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(await pendingRuntimeWait(sql(), bundleOf(claims))).toBeNull();
  });
});
