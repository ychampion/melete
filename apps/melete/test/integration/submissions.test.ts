import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { jobSubmissionResponse, submissionResponse, ULID_PATTERN } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { acceptanceJournal, job, owner, space, submission } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService, submissionDigest } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';
import { processFault } from '../helpers/process-fault.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const submissions = jobs ? new SubmissionService(jobs) : null;
const withDb = submissions ? describe : describe.skip;
const token = 's'.repeat(43);
const cookie = `melete_session=${token}`;
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs || !submissions) throw new Error('Postgres unavailable');
  return { handle, queue, jobs, submissions };
}
function app() {
  return createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    db: fixture().handle.db,
    jobs: fixture().jobs,
    submissions: fixture().submissions,
    checkDatabase: async () => 'ok',
  });
}
function payload() {
  return {
    space_id: spaceId,
    title: 'One responsibility',
    objective: 'Return one accepted receipt',
  };
}
function request(body: unknown, id?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      ...(id ? { 'Idempotency-Key': id } : {}),
    },
    body: JSON.stringify(body),
  };
}

withDb('durable submission receipts', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
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
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('the response contains an already persisted acceptance receipt and a server ULID', async () => {
    const { handle, submissions } = fixture();
    const response = await app().request('/jobs', request(payload()));
    expect(response.status).toBe(201);
    const body = jobSubmissionResponse.parse(await response.json());
    expect(body.receipt.state).toBe('accepted');
    expect(ULID_PATTERN.test(body.receipt.submission_id)).toBe(true);
    expect(body.receipt.job_id).toBe(body.job?.id ?? null);
    expect(body.receipt.job_revision).toBe(0);
    expect(body.receipt.input_digest).toBe(submissionDigest('create', payload()));
    expect(await submissions.get(body.receipt.submission_id)).toEqual(body.receipt);
    const [marker] =
      await handle.sql`select payload from event where seq = ${body.receipt.event_cursor}`;
    expect(marker?.payload).toMatchObject({
      kind: 'submission_accepted',
      submission_id: body.receipt.submission_id,
    });
    expect((await handle.sql`show fsync`)[0]?.fsync).toBe('on');
    expect((await handle.sql`show synchronous_commit`)[0]?.synchronous_commit).toBe('on');
  });

  test('racing repeats with canonical key order admit one job and return the same receipt', async () => {
    const { handle } = fixture();
    const input = payload();
    const reordered = { objective: input.objective, title: input.title, space_id: spaceId };
    const api = app();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        api.request('/jobs', request(index % 2 ? input : reordered, 'same-request')),
      ),
    );
    const receipts = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(201);
        return jobSubmissionResponse.parse(await response.json()).receipt;
      }),
    );
    const first = receipts[0];
    if (!first) throw new Error('No receipt returned');
    for (const receipt of receipts) expect(receipt).toEqual(first);
    expect(await handle.db.select().from(job)).toHaveLength(1);
    expect(await handle.db.select().from(submission)).toHaveLength(1);
    expect(await handle.db.select().from(acceptanceJournal)).toHaveLength(1);
  });

  test('a changed payload is rejected without replacing the original acceptance', async () => {
    const { submissions, handle } = fixture();
    const accepted = await submissions.create(payload(), 'same-request');
    const changed = await app().request(
      '/jobs',
      request({ ...payload(), objective: `${payload().objective} ` }, 'same-request'),
    );
    expect(changed.status).toBe(409);
    const body = jobSubmissionResponse.parse(await changed.json());
    expect(body.receipt.state).toBe('rejected');
    expect(body.error?.code).toBe('submission_conflict');
    expect(await submissions.get('same-request')).toEqual(accepted.receipt);
    expect(await handle.db.select().from(job)).toHaveLength(1);
    expect(await handle.db.select().from(submission)).toHaveLength(1);
  });

  test('an input retry writes one user message and one queued transition', async () => {
    const { submissions, jobs, handle } = fixture();
    const accepted = await submissions.create(payload(), 'create');
    if (!accepted.job) throw new Error('Accepted job missing');
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'submission-test-capability-key-32-bytes',
    });
    const claimed = await runner.claim({
      job_id: accepted.job.id,
      expected_epoch: 0,
      expected_version: 0,
      reason: 'created',
    });
    if (!claimed) throw new Error('Attempt not admitted');
    await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_input',
      question: 'Which input?',
    });
    const api = app();
    const first = await api.request(
      `/jobs/${accepted.job.id}/input`,
      request({ text: 'This input' }, 'input-once'),
    );
    const repeated = await api.request(
      `/jobs/${accepted.job.id}/input`,
      request({ text: 'This input' }, 'input-once'),
    );
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    const receipt = jobSubmissionResponse.parse(await first.json()).receipt;
    expect(jobSubmissionResponse.parse(await repeated.json()).receipt).toEqual(receipt);
    expect((await jobs.get(accepted.job.id)).stateVersion).toBe(3);
    expect(
      await handle.sql`select seq from event where job_id = ${accepted.job.id} and payload->>'kind' = 'user_message'`,
    ).toHaveLength(1);
  });

  test('death after durable admission but before response is recovered by receipt lookup and retry', async () => {
    const { handle } = fixture();
    const id = 'lost-response';
    const marker = await processFault(
      fileURLToPath(new URL('../helpers/submission-child.ts', import.meta.url)),
      { url: handle.url, id, payload: payload(), cookie },
      88,
    );
    expect(marker).toBe(`ADMITTED:${id}`);
    const reconnected = app();
    const lookup = await reconnected.request(`/submissions/${id}`, { headers: { Cookie: cookie } });
    expect(lookup.status).toBe(200);
    const existing = submissionResponse.parse(await lookup.json()).receipt;
    const retry = await reconnected.request('/jobs', request(payload(), id));
    expect(retry.status).toBe(201);
    expect(jobSubmissionResponse.parse(await retry.json()).receipt).toEqual(existing);
    expect(await handle.db.select().from(job)).toHaveLength(1);
    expect(await handle.db.select().from(submission)).toHaveLength(1);
    expect(await handle.db.select().from(acceptanceJournal)).toHaveLength(1);
  }, 20_000);

  test.each(['receipt_missing', 'history_missing', 'history_corrupt', 'marker_only'] as const)(
    '%s yields unknown durability and never admits another job',
    async (fault) => {
      const { handle, submissions } = fixture();
      await submissions.create(payload(), 'damaged-history');
      if (fault === 'receipt_missing' || fault === 'marker_only')
        await handle.db.delete(submission).where(eq(submission.submissionId, 'damaged-history'));
      if (fault === 'history_missing' || fault === 'marker_only')
        await handle.db
          .delete(acceptanceJournal)
          .where(eq(acceptanceJournal.submissionId, 'damaged-history'));
      if (fault === 'history_corrupt')
        await handle.db
          .update(acceptanceJournal)
          .set({ receiptHash: 'corrupt' })
          .where(eq(acceptanceJournal.submissionId, 'damaged-history'));
      expect((await submissions.get('damaged-history')).state).toBe('unknown_durability');
      const retry = await app().request('/jobs', request(payload(), 'damaged-history'));
      expect(retry.status).toBe(503);
      expect(jobSubmissionResponse.parse(await retry.json()).receipt.state).toBe(
        'unknown_durability',
      );
      expect(
        (
          await handle.db
            .select()
            .from(submission)
            .where(eq(submission.submissionId, 'damaged-history'))
        )[0]?.state,
      ).toBe('unknown_durability');
      expect(await handle.db.select().from(job)).toHaveLength(1);
    },
  );

  test('invalid submissions retain their rejection and cannot be changed under the same ID', async () => {
    const { submissions, handle } = fixture();
    const rejected = await submissions.create({}, 'invalid-once');
    expect(rejected.status).toBe(400);
    expect(rejected.receipt.state).toBe('rejected');
    expect((await submissions.create({}, 'invalid-once')).receipt).toEqual(rejected.receipt);
    expect((await submissions.create(payload(), 'invalid-once')).status).toBe(409);
    expect(await handle.db.select().from(job)).toHaveLength(0);
  });

  test('an unknown lookup reports uncertainty and all receipt routes require the session', async () => {
    const { submissions, handle } = fixture();
    expect((await submissions.get('never-observed')).state).toBe('unknown_durability');
    expect((await app().request('/submissions/never-observed')).status).toBe(401);
    expect(await handle.db.select().from(submission)).toHaveLength(0);
  });
});
