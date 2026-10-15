/**
 * Disconnecting one app fences the work that used it, and only that work. A
 * job that never touched the app keeps running and keeps acting; a job whose
 * use of it cannot be told is fenced; work linked to a job that used it is
 * fenced with it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type CapabilityClaims, type DispatchResult, jobBudget } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import {
  action,
  approval,
  attempt,
  connection,
  event,
  job,
  runState,
  space,
  trigger,
} from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { withCapability } from '../../src/jobs/fence.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
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

  test('work with no attempt left to wake into does not stop a revocation', async () => {
    const { jobs, handle } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const mail = await addConnection('imap', 'Work mail');
    const account = await addConnection('command_line', 'GitHub');
    // One job asked to send from the mailbox and waits for the answer; another
    // waits for the mailbox's next message. Neither has an attempt left.
    const asking = await runningJob(runner, 'Asks to send from work mail');
    const listening = await runningJob(runner, 'Waits for work mail');
    const send = newId('act');
    await handle.db.insert(action).values({
      id: send,
      jobId: asking.id,
      attemptId: asking.claims.attempt_id,
      connectionId: mail,
      kind: 'email.send',
      effectClass: 'write_external',
      canonicalPayload: { to: ['someone@example.test'] },
      payloadHash: 'd'.repeat(64),
      idempotencyKey: send,
      status: 'needs_approval',
    });
    const asked = newId('apr');
    await handle.db.insert(approval).values({
      id: asked,
      actionId: send,
      jobRevision: (await jobs.get(asking.id)).revision,
      payloadHash: 'd'.repeat(64),
    });
    const listener = newId('trg');
    await handle.db.insert(trigger).values({
      id: listener,
      jobId: listening.id,
      kind: 'event',
      spec: { kind: 'event', connection_id: mail, event_name: 'mail.received' },
    });
    const waits = [
      [asking, 'waiting_for_approval', { kind: 'approval', action_ids: [send] }],
      [
        listening,
        'waiting_for_event_or_time',
        { kind: 'event', trigger_id: listener, deadline_at: null },
      ],
    ] as const;
    for (const [work, state, wait] of waits) {
      await handle.db
        .update(attempt)
        .set({
          endedAt: new Date(),
          outcome: 'completed',
          leaseExpiresAt: null,
          leaseStatus: 'ended',
        })
        .where(eq(attempt.id, work.claims.attempt_id));
      const row = await jobs.get(work.id);
      await handle.db
        .update(job)
        .set({ state, wait, budget: { ...jobBudget.parse(row.budget), max_attempts: 1 } })
        .where(eq(job.id, work.id));
    }
    const policy = new PolicyService(jobs, runner);
    expect(
      await policy.changeConnection(mail, { kind: 'revoke', expected_generation: 0 }),
    ).toMatchObject({ status: 'revoked' });
    // What it asked is refused, and nothing it held can run.
    const [effect] = await handle.db.select().from(action).where(eq(action.id, send));
    expect(effect?.status).toBe('failed');
    const [decision] = await handle.db.select().from(approval).where(eq(approval.id, asked));
    expect(decision?.decision).toBe('denied');
    for (const work of [asking, listening]) {
      expect(await fenceEvents(work.id)).toHaveLength(1);
      expect(['queued', 'running']).not.toContain((await jobs.get(work.id)).state);
    }
    // Revoking an account whose use cannot be told reaches them again, and completes too.
    expect(
      await policy.changeConnection(account, { kind: 'revoke', expected_generation: 0 }),
    ).toMatchObject({ status: 'revoked' });
    await runner.stop();
  });

  test('work carried past a revocation still cannot reach the revoked mailbox', async () => {
    const { jobs, handle, queue } = fixture();
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key,
      scopes: ['mail.read'],
    });
    const reads: string[] = [];
    const mailbox = (): Connector => ({
      manifest: {
        name: 'mailbox',
        version: '0.1.0',
        provider: 'imap',
        description: 'A mailbox that answers every read.',
        credentials: [],
        health: true,
        tools: [
          {
            name: 'mail.read',
            description: 'Read the inbox.',
            input_schema: { type: 'object' },
            effect_class: 'read',
            required_scopes: ['mail.read'],
            verify: false,
            requires_approval: false,
            record_schema: null,
          },
        ],
      },
      async execute(proposed): Promise<DispatchResult> {
        reads.push(proposed.connection_id);
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: proposed.id,
            connection_id: proposed.connection_id,
            external_ref: proposed.id,
            late: false,
            received_at: new Date().toISOString(),
            detail: {},
          },
        };
      },
      async verify() {
        return { decision: 'unsupported', reason: 'fixture' };
      },
      async health() {
        return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
      },
    });
    const work = newId('conn');
    const home = newId('conn');
    for (const id of [work, home])
      await handle.db
        .insert(connection)
        .values({ id, spaceId, provider: 'imap', label: id, scopes: ['mail.read'] });
    const registry = new ConnectorRegistry().register(work, mailbox()).register(home, mailbox());
    const broker = new BrokerService({ sql: handle.sql, connectors: registry, boss: queue.boss });
    // Started while both mailboxes were connected, and never used the work one.
    const carried = await runningJob(runner, 'Reads home mail later');
    expect((await attemptRow(carried.claims.attempt_id))?.connectionGenerations).toEqual({
      [work]: 0,
      [home]: 0,
    });
    await new PolicyService(jobs, runner).changeConnection(work, {
      kind: 'revoke',
      expected_generation: 0,
    });
    // Its lease is current again, but the revoked mailbox is not part of it.
    expect(await fenceEvents(carried.id)).toHaveLength(0);
    expect(
      await rejectionOf(
        broker.propose(carried.claims, { connection_id: work, kind: 'mail.read', payload: {} }),
      ),
    ).toMatchObject({ code: 'unknown_connection' });
    const kept = await broker.propose(carried.claims, {
      connection_id: home,
      kind: 'mail.read',
      payload: {},
    });
    const [recorded] = await handle.db.select().from(action).where(eq(action.id, kept.action_id));
    expect(recorded?.connectionId).toBe(home);
    expect(reads).not.toContain(work);
    await registry.close();
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
