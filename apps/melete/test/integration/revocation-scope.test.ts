/**
 * Disconnecting one app fences the work that used it, and only that work. A
 * job that never touched the app keeps running and keeps acting; a job whose
 * use of it cannot be told is fenced; work linked to a job that used it is
 * fenced with it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CapabilityClaims } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { action, attempt, connection, event, job, runState, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { withCapability } from '../../src/jobs/fence.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'revocation-scope-signing-key-32bytes';
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

async function addConnection(provider: string, label: string) {
  const id = newId('conn');
  await fixture().handle.db.insert(connection).values({ id, spaceId, provider, label });
  return id;
}

/** A job with a running attempt, as the runner claims it. */
async function runningJob(
  runner: AttemptRunner,
  title: string,
  links: { experienceParentId?: string } = {},
) {
  const { jobs, handle } = fixture();
  const row = await jobs.create({ space_id: spaceId, title, objective: title });
  if (links.experienceParentId)
    await handle.db
      .update(job)
      .set({ experienceParentId: links.experienceParentId })
      .where(eq(job.id, row.id));
  const claimed = await runner.claim({
    job_id: row.id,
    expected_epoch: 0,
    expected_version: 0,
    reason: 'created',
  });
  if (!claimed) throw new Error(`${title} did not start`);
  return { id: row.id, claims: claimed.claims, token: claimed.bundle.attempt.token };
}

/** What a read through the broker leaves: an action on that connection. */
async function used(work: { id: string; claims: CapabilityClaims }, connectionId: string) {
  const id = newId('act');
  await fixture()
    .handle.db.insert(action)
    .values({
      id,
      jobId: work.id,
      attemptId: work.claims.attempt_id,
      connectionId,
      kind: 'email.search',
      effectClass: 'read',
      canonicalPayload: {},
      payloadHash: 'b'.repeat(64),
      idempotencyKey: id,
      status: 'succeeded',
    });
}

async function attemptRow(id: string) {
  const [row] = await fixture().handle.db.select().from(attempt).where(eq(attempt.id, id));
  return row;
}

async function fenceEvents(jobId: string) {
  return fixture()
    .handle.db.select()
    .from(event)
    .where(and(eq(event.jobId, jobId), eq(event.type, 'context_invalidated')));
}

/** The attempt still holds its lease and may still act through the broker's fence. */
async function stillActs(runner: AttemptRunner, work: { claims: CapabilityClaims; token: string }) {
  expect(await runner.heartbeat(work.claims)).toBe(true);
  expect(await withCapability(fixture().jobs, work.token, key, async () => 'acted')).toBe('acted');
  expect((await attemptRow(work.claims.attempt_id))?.endedAt).toBeNull();
}

/** The attempt was fenced and can no longer act. */
async function fenced(work: { id: string; claims: CapabilityClaims; token: string }) {
  const ended = await attemptRow(work.claims.attempt_id);
  expect(ended?.outcome).toBe('fenced');
  expect(ended?.leaseStatus).toBe('context_invalidated');
  let refused: unknown;
  await withCapability(fixture().jobs, work.token, key, async () => 'acted').catch((error) => {
    refused = error;
  });
  expect(refused).toMatchObject({ code: 'stale_epoch' });
  expect(await fenceEvents(work.id)).toHaveLength(1);
}

withDb('disconnecting an app fences only the work that could use it', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql, { retention: true });
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  }, 15_000);
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('revoking one mailbox leaves running work on another mailbox running', async () => {
    const { jobs } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    const other = await addConnection('imap', 'Home mail');
    const unrelated = await runningJob(runner, 'Long fix that reads home mail');
    await used(unrelated, other);
    const idle = await runningJob(runner, 'Work that reads nothing');
    const response = await new PolicyService(jobs, runner).changeConnection(mail, {
      kind: 'revoke',
      expected_generation: 0,
    });
    expect(response).toMatchObject({ status: 'revoked', policy_generation: 1 });
    for (const work of [unrelated, idle]) {
      await stillActs(runner, work);
      expect(await fenceEvents(work.id)).toHaveLength(0);
      expect((await jobs.get(work.id)).state).toBe('running');
      // Carried onto the new generations, without the revoked mailbox.
      const row = await attemptRow(work.claims.attempt_id);
      expect(row?.policyGeneration).toBe(1);
      expect(row?.connectionGenerations).toEqual({ [other]: 0 });
    }
    await runner.stop();
  });

  test('the work that used the revoked mailbox is fenced', async () => {
    const { jobs } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    const other = await addConnection('imap', 'Home mail');
    const reader = await runningJob(runner, 'Reads work mail');
    await used(reader, mail);
    const bystander = await runningJob(runner, 'Reads home mail');
    await used(bystander, other);
    await new PolicyService(jobs, runner).changeConnection(mail, {
      kind: 'revoke',
      expected_generation: 0,
    });
    await fenced(reader);
    const [control] = await fenceEvents(reader.id);
    expect(control?.payload).toMatchObject({
      reason: 'connection_revoked',
      connection_id: mail,
      attempt_id: reader.claims.attempt_id,
    });
    await stillActs(runner, bystander);
    await runner.stop();
  });

  test('a job that only listened on the mailbox, or was told about it, is fenced too', async () => {
    const { jobs, handle } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    const told = await runningJob(runner, 'Woken by a message');
    await handle.db.insert(event).values({
      jobId: told.id,
      type: 'notice',
      payload: {
        kind: 'trigger_event',
        trigger_id: null,
        event: { kind: 'connector_event', connection_id: mail, event_name: 'mail.received' },
      },
      dedupKey: `evt-${newId('act')}`,
    });
    const shared = await runningJob(runner, 'Shares a file from the mailbox');
    const id = newId('act');
    await handle.db.insert(action).values({
      id,
      jobId: shared.id,
      attemptId: shared.claims.attempt_id,
      connectionId: await addConnection('files', 'Files'),
      kind: 'artifacts.share',
      effectClass: 'write_external',
      canonicalPayload: { mailbox_connection_id: mail },
      payloadHash: 'c'.repeat(64),
      idempotencyKey: id,
      status: 'dispatched',
      dispatchedAt: new Date(),
    });
    await new PolicyService(jobs, runner).changeConnection(mail, {
      kind: 'revoke',
      expected_generation: 0,
    });
    await fenced(told);
    await fenced(shared);
    // The send in flight through that mailbox is no longer counted as done.
    const [effect] = await handle.db.select().from(action).where(eq(action.id, id));
    expect(effect?.status).toBe('unknown');
    await runner.stop();
  });

  test('a connection whose use cannot be told job by job fences every job', async () => {
    const { jobs } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const account = await addConnection('command_line', 'GitHub');
    const other = await addConnection('imap', 'Home mail');
    const unrecorded = await runningJob(runner, 'Never recorded using it');
    await used(unrecorded, other);
    const idle = await runningJob(runner, 'Reads nothing');
    await new PolicyService(jobs, runner).changeConnection(account, {
      kind: 'revoke',
      expected_generation: 0,
    });
    await fenced(unrecorded);
    await fenced(idle);
    await runner.stop();
  });

  test('work linked to a job that used the mailbox is fenced with it', async () => {
    const { jobs, handle } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    // A conversation whose child job read the mailbox; another child of it did not.
    const conversation = await runningJob(runner, 'Conversation');
    const child = await runningJob(runner, 'Child that read mail', {
      experienceParentId: conversation.id,
    });
    await used(child, mail);
    const sibling = await runningJob(runner, 'Child that read nothing', {
      experienceParentId: conversation.id,
    });
    // A run whose helper step read it.
    const run = await runningJob(runner, 'Long run');
    const helper = await runningJob(runner, 'Helper step');
    await handle.db.insert(runState).values([
      { jobId: run.id, spaceId, goal: 'Finish' },
      { jobId: helper.id, spaceId, goal: 'Step', parentRunId: run.id },
    ]);
    await used(helper, mail);
    // A conversation that read it, with a child that did not.
    const reader = await runningJob(runner, 'Conversation that read mail');
    await used(reader, mail);
    const started = await runningJob(runner, 'Started from it', {
      experienceParentId: reader.id,
    });
    const elsewhere = await runningJob(runner, 'Unlinked work');
    await new PolicyService(jobs, runner).changeConnection(mail, {
      kind: 'revoke',
      expected_generation: 0,
    });
    for (const work of [conversation, child, sibling, run, helper, reader, started])
      await fenced(work);
    await stillActs(runner, elsewhere);
    await runner.stop();
  });

  test('switching a mailbox to another key fences its users and carries the rest forward', async () => {
    const { jobs, handle } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    const credential = newId('sec');
    await handle.sql`insert into secret (id, space_id, ciphertext)
      values (${credential}, ${spaceId}, 'sealed-fixture')`;
    const reader = await runningJob(runner, 'Reads work mail');
    await used(reader, mail);
    const elsewhere = await runningJob(runner, 'Reads nothing');
    await new PolicyService(jobs, runner).changeConnection(mail, {
      kind: 'switch',
      expected_generation: 0,
      secret_ref: credential,
    });
    await fenced(reader);
    await stillActs(runner, elsewhere);
    expect((await attemptRow(elsewhere.claims.attempt_id))?.connectionGenerations).toEqual({
      [mail]: 1,
    });
    await runner.stop();
  });
});
