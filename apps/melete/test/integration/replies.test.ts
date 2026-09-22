import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CreateJobRequest } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../src/api/errors.ts';
import { session } from '../../src/db/auth-schema.ts';
import { attempt, notification, owner, replyObligation, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { ReplyService } from '../../src/jobs/replies.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';
import { processFault } from '../helpers/process-fault.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'reply-integration-signing-key-32-bytes';
const token = 'r'.repeat(43);
const cookie = `melete_session=${token}`;
let spaceId = '';
let submissions: SubmissionService;
let replies: ReplyService;
let runner: AttemptRunner;
function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}
function input(script: StubStep[] = [], extra: Partial<CreateJobRequest> = {}) {
  return {
    space_id: spaceId,
    title: 'Reply responsibility',
    objective: 'Return a response',
    ...extra,
    constraints: { ...extra.constraints, notes: JSON.stringify({ script }) },
  };
}
async function run(row: JobRow) {
  await runner.handleWake({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  });
}
async function direct(script: StubStep[] = [], extra: Partial<CreateJobRequest> = {}) {
  const result = await submissions.create(input(script, extra));
  if (!result.job) throw new Error('Direct request was not accepted');
  return result.job;
}
async function rejects(operation: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe(code);
}
const answer: StubStep = {
  type: 'outcome',
  outcome: { kind: 'completed', summary: 'A durable answer', evidence: [] },
};

withDb('reply obligations and notification outbox', () => {
  beforeEach(async () => {
    const { handle, jobs, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await resetTestRows(handle.sql);
    const ownerId = newId('own');
    spaceId = newId('sp');
    await handle.db
      .insert(owner)
      .values({ id: ownerId, email: 'owner@example.test', passwordHash: 'fixture' });
    await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner`;
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    submissions = new SubmissionService(jobs);
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    replies = new ReplyService(jobs, submissions, runner);
  });
  afterEach(async () => {
    await runner.stop();
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('an unknown ledger check produces an explicit paused reply without failure', async () => {
    const message = 'The parked-action check timed out; approval state is unknown.';
    const row = await direct([
      {
        type: 'outcome',
        outcome: { kind: 'unknown_check', check: 'parked_actions', reason: 'timed_out', message },
      },
    ]);
    await run(row);
    const updated = await fixture().jobs.get(row.id);
    expect(updated.state).toBe('waiting_for_input');
    const [pending] = await replies.outbox();
    expect(pending?.content).toMatchObject({ kind: 'status', text: message });
    expect(pending?.ifIgnored).toContain('waiting');
  });

  test('a direct request creates one obligation and assistant text never marks it delivered', async () => {
    const row = await direct([
      { type: 'text_delta', text: 'Visible text alone is not an acknowledgement' },
      answer,
    ]);
    const [owed] = await replies.list();
    expect(owed?.state).toBe('owed');
    await run(row);
    const [pending] = await replies.outbox();
    expect(pending?.state).toBe('pending');
    expect(pending?.deliveredAt).toBeNull();
    expect((await replies.list())[0]?.state).toBe('owed');
    if (!owed) throw new Error('Reply obligation missing');
    expect((await replies.acknowledge(owed.id)).state).toBe('acknowledged');
    expect((await replies.outbox())[0]?.deliveredAt).toBeNull();
  });

  test('an interrupted direct admission recovers its obligation and reports unavailable content', async () => {
    const { handle, jobs } = fixture();
    expect(
      await processFault(
        fileURLToPath(new URL('../helpers/submission-child.ts', import.meta.url)),
        { url: handle.url, id: 'direct-interrupted', payload: input([answer]), cookie },
        88,
      ),
    ).toBe('ADMITTED:direct-interrupted');
    const [before] = await replies.list();
    expect(before?.state).toBe('owed');
    await replies.recover();
    const [recovered] = await replies.list();
    expect(recovered?.id).toBe(before?.id);
    expect(recovered?.state).toBe('needs_retransmission');
    expect(recovered?.message).toContain('needs retransmission');
    if (!recovered?.jobId) throw new Error('Recovered job missing');
    await run(await jobs.get(recovered.jobId));
    expect((await replies.list())[0]?.state).toBe('owed');
    expect(await replies.outbox()).toHaveLength(1);
  }, 20_000);

  test('an interrupted quiet unchanged check remains quiet after lease recovery', async () => {
    const { jobs, handle } = fixture();
    const row = await jobs.create(
      input([
        { type: 'text_delta', text: 'No change', epoch: 1 },
        { type: 'stall', key: 'quiet-check', epoch: 1 },
        {
          type: 'outcome',
          outcome: {
            kind: 'waiting_for_event_or_time',
            wait: { kind: 'timer', wake_at: new Date(Date.now() + 60_000).toISOString() },
          },
        },
      ]),
    );
    expect(
      await processFault(
        fileURLToPath(new URL('../helpers/quiet-child.ts', import.meta.url)),
        { url: handle.url, jobId: row.id, key },
        89,
      ),
    ).toBe('QUIET_CHECK_INTERRUPTED');
    await handle.sql`update attempt set lease_expires_at = now() - interval '1 second' where job_id = ${row.id}`;
    await runner.recover();
    await run(await jobs.get(row.id));
    await replies.recover();
    expect((await jobs.get(row.id)).state).toBe('waiting_for_event_or_time');
    expect(await replies.list()).toHaveLength(0);
    expect(await replies.outbox()).toHaveLength(0);
  }, 20_000);

  test('delivery attempts recover separately and a late acknowledgement fulfills only its exact content', async () => {
    const { handle } = fixture();
    await run(await direct([answer]));
    const [first] = await replies.outbox();
    if (!first) throw new Error('Outbox empty');
    await replies.beginDelivery(first.id);
    await replies.recover();
    const [retry] = await replies.outbox();
    expect(retry?.id).not.toBe(first.id);
    expect(retry?.deliveryAttempt).toBe(2);
    expect(retry?.deliveryKey).toBe(first.deliveryKey);
    await replies.recover();
    expect(await replies.outbox()).toHaveLength(1);
    expect(await handle.db.select().from(notification)).toHaveLength(2);
    await rejects(() => replies.delivered(first.id, '0'.repeat(64)), 'notification_hash_mismatch');
    expect(await replies.list()).toHaveLength(1);
    const delivered = await replies.delivered(first.id, first.contentHash);
    expect(delivered.deliveredAt).toBeInstanceOf(Date);
    expect(await replies.delivered(first.id, first.contentHash)).toEqual(delivered);
    expect(await replies.list()).toHaveLength(0);
    expect(await replies.outbox()).toHaveLength(0);
  });

  test('the periodic recovery scan never offers a delivery in flight again', async () => {
    const { handle } = fixture();
    // Startup recovery may retransmit what an earlier process attempted.
    await runner.recover();
    await run(await direct([answer]));
    const [first] = await replies.outbox();
    if (!first) throw new Error('Outbox empty');
    await replies.beginDelivery(first.id);
    // A later scan runs while this process may still be delivering it.
    await runner.recover();
    expect((await replies.outbox()).map((item) => item.id)).toEqual([first.id]);
    expect(await handle.db.select().from(notification)).toHaveLength(1);
    await replies.delivered(first.id, first.contentHash);
    expect(await replies.list()).toHaveLength(0);
  });

  // Ends an attempt with reply content but without the finish hooks, as the
  // broker's releaseAttempt does on a destination's rate-limit wait.
  const waiting: StubStep = {
    type: 'outcome',
    outcome: {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'timer', wake_at: '2099-01-01T09:00:00.000Z' },
    },
  };
  async function runWithoutHooks(row: JobRow) {
    const saved = runner.onFinished.splice(0);
    try {
      await run(row);
    } finally {
      runner.onFinished.push(...saved);
    }
  }

  test('every scan repairs a reply flagged for retransmission once its content exists', async () => {
    const { jobs } = fixture();
    await runner.recover();
    const row = await direct([waiting]);
    // Mid-attempt the obligation has no content yet, so a scan flags it.
    await runner.recover();
    expect((await replies.list())[0]?.state).toBe('needs_retransmission');
    await runWithoutHooks(row);
    expect((await jobs.get(row.id)).state).toBe('waiting_for_event_or_time');
    await runner.recover();
    expect(await replies.outbox()).toHaveLength(1);
    expect((await replies.list())[0]?.state).toBe('owed');
  });

  test('a reply service keeps the acceptance hook it was handed', async () => {
    const { jobs } = fixture();
    const own = new SubmissionService(jobs);
    const seen: string[] = [];
    own.onAccepted = async (_tx, receipt) => {
      seen.push(receipt.submission_id);
    };
    const chained = new ReplyService(jobs, own);
    await own.create(input([answer]), 'chained-hook');
    expect(seen).toEqual(['chained-hook']);
    expect((await chained.list()).map((item) => item.submissionId)).toEqual(['chained-hook']);
  });

  test('coalescing replaces pending content while retaining every direct obligation', async () => {
    const { jobs, handle } = fixture();
    const row = await direct([
      {
        type: 'outcome',
        epoch: 1,
        outcome: { kind: 'waiting_for_input', question: 'Which date?' },
      },
      { ...answer, epoch: 2 },
    ]);
    await run(row);
    expect(await replies.outbox()).toHaveLength(1);
    const inputReceipt = await submissions.input(row.id, { text: 'Tomorrow' }, 'follow-up');
    expect(inputReceipt.receipt.state).toBe('accepted');
    await run(await jobs.get(row.id));
    expect(await replies.list()).toHaveLength(2);
    const [latest] = await replies.outbox();
    if (!latest) throw new Error('Outbox empty');
    expect(latest.obligationIds).toHaveLength(2);
    expect(await handle.db.select().from(notification)).toHaveLength(2);
    await replies.delivered(latest.id, latest.contentHash);
    expect(await replies.list()).toHaveLength(0);
  });

  test('recovery distinguishes reconstructable content from a missing response', async () => {
    const { handle } = fixture();
    await run(await direct([answer]));
    const [pending] = await replies.outbox();
    if (!pending) throw new Error('Outbox empty');
    await handle.db
      .update(notification)
      .set({ content: null })
      .where(eq(notification.id, pending.id));
    await replies.recover();
    expect((await replies.outbox())[0]?.content).toMatchObject({ text: 'A durable answer' });
    await handle.db.delete(notification);
    await handle.db.update(replyObligation).set({ content: null });
    await handle.db.update(attempt).set({ outcomeDetail: null });
    await replies.recover();
    expect((await replies.list())[0]?.state).toBe('needs_retransmission');
    expect(await replies.outbox()).toHaveLength(0);
  });

  test('a spent attempt budget rejects another input without accepting an unfulfillable obligation', async () => {
    const row = await direct([answer], {
      budget: { max_attempts: 1 },
      constraints: { deliverable: { kind: 'artifact', path_glob: '*.md' } },
    });
    await run(row);
    const rejected = await submissions.input(row.id, { text: 'Try again' }, 'over-budget');
    expect(rejected.receipt.state).toBe('rejected');
    expect(rejected.error?.code).toBe('budget_exhausted');
    expect(await replies.list()).toHaveLength(1);
  });

  test('the outbox API requires authentication and an exact content hash to acknowledge delivery', async () => {
    const { jobs, handle } = fixture();
    await run(await direct([answer]));
    const [pending] = await replies.outbox();
    const [owed] = await replies.list();
    if (!pending || !owed) throw new Error('Reply records missing');
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: handle.db,
      jobs,
      submissions,
      replies,
      checkDatabase: async () => 'ok',
    });
    expect((await app.request('/reply-obligations')).status).toBe(401);
    expect((await app.request('/notifications')).status).toBe(401);
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    expect(
      (await app.request(`/reply-obligations/${owed.id}/acknowledge`, { method: 'POST', headers }))
        .status,
    ).toBe(200);
    expect(
      (await app.request(`/notifications/${pending.id}/attempt`, { method: 'POST', headers }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(`/notifications/${pending.id}/delivered`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content_hash: '0'.repeat(64) }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/notifications/${pending.id}/delivered`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content_hash: pending.contentHash }),
        })
      ).status,
    ).toBe(200);
    expect(await replies.list()).toHaveLength(0);
  });
});
