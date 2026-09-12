import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  AttemptBundle,
  CommittedOutcome,
  QuestioningRuntimeAdapter,
  QuestionSpecInput,
  RuntimeAdapter,
} from '@melete/contracts';
import { notification as notificationContract, ownerQuestion } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../src/api/errors.ts';
import { job, notification, question, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { AttentionService } from '../../src/jobs/attention.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { QuestionService } from '../../src/jobs/questions.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { notificationView, ReplyService } from '../../src/jobs/replies.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'attention-contract-signing-key-32bytes';
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** A runtime that answers from a per-title plan, so several jobs share one adapter. */
function planned(
  plans: Map<string, (bundle: AttemptBundle) => CommittedOutcome>,
): QuestioningRuntimeAdapter {
  return {
    capabilities: () => new StubRuntimeAdapter().capabilities(),
    start: async (bundle) => {
      const plan = plans.get(bundle.job.title);
      if (!plan) throw new Error(`no plan for ${bundle.job.title}`);
      return plan(bundle);
    },
  };
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

withDb('attention as a contract', () => {
  let submissions: SubmissionService;
  let replies: ReplyService;
  let questions: QuestionService;
  let runner: AttemptRunner;

  const wire = (runtime: RuntimeAdapter | QuestioningRuntimeAdapter) => {
    const { jobs } = fixture();
    runner = new AttemptRunner(jobs, runtime, { key });
    submissions = new SubmissionService(jobs);
    replies = new ReplyService(jobs, submissions, runner);
    questions = new QuestionService(jobs, submissions);
    new AttentionService(jobs, runner);
    return runner;
  };

  const app = () => {
    const { handle, jobs } = fixture();
    return createApp({
      env: loadEnv({}),
      db: handle.db,
      jobs,
      submissions,
      replies,
      questions,
      checkDatabase: async () => 'ok',
    });
  };

  const signIn = async (service: ReturnType<typeof createApp>) => {
    const setup = await service.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'owner-password' }),
    });
    expect(setup.status).toBe(201);
    return setup.headers.get('set-cookie')?.split(';')[0] ?? '';
  };

  const wake = async (row: JobRow) => {
    const { handle, jobs } = fixture();
    await handle.db.update(job).set({ nextWakeAt: new Date() }).where(eq(job.id, row.id));
    const current = await jobs.get(row.id);
    await runner.handleWake({
      job_id: current.id,
      expected_epoch: current.leaseEpoch,
      expected_version: current.stateVersion,
      reason: 'timer',
    });
    return jobs.get(row.id);
  };

  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "principal", "owner", "space", event_retention cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  }, 15_000);

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('three questions in the same minute make one queue entry per job, and answering the middle one wakes only that job', async () => {
    const { handle, jobs, queue } = fixture();
    const asked: Record<string, QuestionSpecInput> = {
      'Roof quote': {
        text: 'The roofer wants to start Monday. Do I confirm?',
        because: [],
        if_ignored: 'The slot is released and the roofer moves to another job.',
        blocks_external_effect: true,
      },
      'Passport renewal': {
        text: 'Which address should the new passport be sent to?',
        because: [],
        if_ignored: 'The application misses its window on 2026-10-01 and has to start again.',
        deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      'Book club': {
        text: 'Which of the three books should I suggest?',
        because: [],
        if_ignored: 'Nobody suggests a book and the meeting has nothing to read.',
      },
    };
    const plans = new Map<string, (bundle: AttemptBundle) => CommittedOutcome>();
    for (const [title, spec] of Object.entries(asked))
      plans.set(title, (bundle) => ({
        outcome: { kind: 'waiting_for_input', question: spec.text },
        questions: [{ ...spec, because: [`job:${bundle.attempt.job_id}`] }],
      }));
    wire(planned(plans));

    // Created oldest first, so the queue order cannot come from creation order.
    const created: JobRow[] = [];
    for (const title of ['Book club', 'Passport renewal', 'Roof quote']) {
      const row = await jobs.create({ space_id: spaceId, title, objective: `Handle ${title}` });
      created.push(await wake(row));
    }
    for (const row of created) expect(row.state).toBe('waiting_for_input');

    const service = app();
    const cookie = await signIn(service);
    const response = await service.request('/questions', { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { questions: unknown[] };
    const queued = body.questions.map((entry) => ownerQuestion.parse(entry));
    expect(queued.map((entry) => entry.job_title)).toEqual([
      'Roof quote',
      'Passport renewal',
      'Book club',
    ]);
    // One entry per job: a job with a question contributes exactly one.
    expect(new Set(queued.map((entry) => entry.job_id)).size).toBe(3);
    for (const entry of queued) {
      expect(entry.because.length).toBeGreaterThan(0);
      expect(entry.if_ignored.length).toBeGreaterThan(0);
      expect(entry.state).toBe('open');
    }
    expect(queued[1]?.if_ignored).toContain('2026-10-01');

    const middle = queued[1];
    if (!middle) throw new Error('The queue is missing its middle entry');
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    const answered = await service.request(`/questions/${middle.id}/answer`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Send it to the flat, not the office.' }),
    });
    expect(answered.status).toBe(200);
    const result = (await answered.json()) as {
      question: { state: string; answer: string };
      job: { id: string; state: string };
      receipt: { state: string };
    };
    expect(result.receipt.state).toBe('accepted');
    expect(result.question.state).toBe('answered');
    expect(result.question.answer).toBe('Send it to the flat, not the office.');

    const states = new Map<string, string>();
    for (const row of created) states.set(row.title, (await jobs.get(row.id)).state);
    expect(states.get('Passport renewal')).toBe('queued');
    expect(states.get('Roof quote')).toBe('waiting_for_input');
    expect(states.get('Book club')).toBe('waiting_for_input');

    const hints = await handle.sql`select data->>'job_id' as job_id from pgboss.job`;
    expect(hints.map((hint) => hint.job_id)).toEqual([middle.job_id]);
    expect((await questions.list()).map((entry) => entry.job_title)).toEqual([
      'Roof quote',
      'Book club',
    ]);
    // A resent answer replays its receipt rather than waking the job a second time.
    const resent = await service.request(`/questions/${middle.id}/answer`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Send it to the flat, not the office.' }),
    });
    expect(resent.status).toBe(200);
    const [remaining] = await handle.sql`select count(*)::int as n from pgboss.job`;
    expect(remaining?.n).toBe(1);
    await runner.stop();
  }, 30_000);

  test('an attempt that emits two questions asks one and asks the other on the next wake', async () => {
    const { jobs } = fixture();
    const blocking = 'Which of the two invoices should I pay first?';
    const secondary = "Should I archive last year's receipts?";
    const later = 'Anything else before I close this?';
    const plans = new Map<string, (bundle: AttemptBundle) => CommittedOutcome>();
    plans.set('Household admin', (bundle) =>
      bundle.attempt.epoch === 1
        ? {
            outcome: { kind: 'waiting_for_input', question: blocking },
            questions: [
              {
                text: blocking,
                because: [`job:${bundle.attempt.job_id}`],
                if_ignored: 'The later invoice accrues a late fee on 2026-09-30.',
                blocks_external_effect: true,
              },
              {
                text: secondary,
                because: [`job:${bundle.attempt.job_id}`],
                if_ignored: 'The receipts stay where they are and nothing is lost.',
              },
            ],
          }
        : { kind: 'waiting_for_input', question: later },
    );
    wire(planned(plans));
    const created = await jobs.create({
      space_id: spaceId,
      title: 'Household admin',
      objective: 'Pay what is due',
      budget: { max_attempts: 20 },
    });
    const first = await wake(created);

    expect(first.state).toBe('waiting_for_input');
    expect((first.wait as { question: string }).question).toBe(blocking);
    const open = await questions.list();
    expect(open.map((entry) => entry.text)).toEqual([blocking]);
    expect(open[0]?.blocks_external_effect).toBe(true);
    expect(first.deferredQuestions.map((item) => item.text)).toEqual([secondary]);

    const bundle = await jobs.transaction((tx) =>
      buildBundle(
        tx,
        first,
        { id: newId('att'), epoch: 99, revision: first.revision, token: 'inspection' },
        { provider: 'stub', model: 'script', fallback: null },
        0,
      ),
    );
    expect(bundle.attention.questions_allowed).toBe(0);
    expect(bundle.attention.guidance).toContain('one question');
    expect(bundle.attention.open_question?.text).toBe(blocking);
    expect(bundle.attention.deferred_questions.map((item) => item.text)).toEqual([secondary]);

    const answerable = open[0];
    if (!answerable) throw new Error('No question was asked');
    // Distinct milliseconds, so "oldest" is decided by age rather than a tie-break.
    await Bun.sleep(10);
    await questions.answer(answerable.id, { text: 'Pay the council tax one first.' });
    expect((await jobs.get(created.id)).state).toBe('queued');

    const second = await wake(created);
    expect(second.state).toBe('waiting_for_input');
    // The deferred question is asked on the next wake; the new one waits its turn.
    expect((second.wait as { question: string }).question).toBe(secondary);
    expect((await questions.list()).map((entry) => entry.text)).toEqual([secondary]);
    expect(second.deferredQuestions.map((item) => item.text)).toEqual([later]);
    const all = await fixture()
      .handle.db.select()
      .from(question)
      .where(eq(question.jobId, created.id));
    expect(all.map((row) => row.state).sort()).toEqual(['answered', 'open']);
    await runner.stop();
  }, 30_000);

  test('a quiet monitor with no delta writes no outbox row, and one with a delta writes one that cites its reason', async () => {
    const { handle, jobs } = fixture();
    const unchanged = 'The boiler is still unrepaired and no engineer is booked.';
    const changed = 'The engineer is booked for Friday the 18th.';
    wire(new StubRuntimeAdapter());
    const accepted = await submissions.create({
      space_id: spaceId,
      title: 'Boiler watch',
      objective: 'Tell me when the repair is booked',
      scheduling_class: 'quiet',
      budget: { max_attempts: 20 },
      constraints: {
        notes: JSON.stringify({
          script: [
            { type: 'text_delta', text: unchanged, epoch: [1, 2, 3, 4] },
            { type: 'text_delta', text: changed, epoch: 5 },
            {
              type: 'outcome',
              outcome: {
                kind: 'waiting_for_event_or_time',
                wait: { kind: 'timer', wake_at: new Date(Date.now() + 60_000).toISOString() },
              },
            },
          ],
        }),
      },
    });
    const created = accepted.job;
    if (!created) throw new Error('The quiet monitor was not accepted');
    expect(accepted.receipt.state).toBe('accepted');
    // Creating a quiet monitor owes no reply: the owner asked to be left alone.
    expect(await replies.list()).toHaveLength(0);

    for (let index = 0; index < 4; index++) await wake(created);
    const quiet = await jobs.get(created.id);
    expect(quiet.state).toBe('waiting_for_event_or_time');
    expect(quiet.lastResultHash).not.toBeNull();
    expect(quiet.unreadResults).toBe(0);
    expect(quiet.attentionStatus).toBe('normal');
    expect(await replies.outbox()).toHaveLength(0);
    expect(await handle.db.select().from(notification)).toHaveLength(0);

    await wake(created);
    const outbox = await replies.outbox();
    expect(outbox).toHaveLength(1);
    const row = outbox[0];
    if (!row) throw new Error('The outbox is empty');
    const sent = notificationContract.parse(notificationView(row));
    expect(sent.content?.text).toBe(changed);
    expect(sent.because).toHaveLength(1);
    expect(sent.because[0]).toMatch(/^event:\d+$/);
    expect(sent.if_ignored).toContain('Nothing happens until');
    expect((await jobs.get(created.id)).unreadResults).toBe(1);
    await runner.stop();
  }, 30_000);

  test('the outbox refuses a notification that cites nothing', async () => {
    const { handle, jobs } = fixture();
    wire(new StubRuntimeAdapter());
    const created = await jobs.create({
      space_id: spaceId,
      title: 'Cited or not sent',
      objective: 'Prove the outbox refuses unexplained mail',
    });
    const draft = {
      jobId: created.id,
      coalesceKey: created.id,
      deliveryKey: 'delivery-without-a-reason',
      obligationIds: [],
      content: {
        job_id: created.id,
        attempt_id: newId('att'),
        kind: 'status' as const,
        text: 'Something happened.',
      },
      contentHash: 'a'.repeat(64),
      ifIgnored: 'Nothing happens.',
      deliveryAttempt: 1,
    };
    await rejects(
      () => jobs.transaction((tx) => replies.enqueue(tx, { ...draft, because: [] })),
      'notification_without_because',
    );
    await rejects(
      () => jobs.transaction((tx) => replies.enqueue(tx, { ...draft, because: ['just because'] })),
      'notification_without_because',
    );
    await rejects(
      () =>
        jobs.transaction((tx) =>
          replies.enqueue(tx, { ...draft, because: [`job:${created.id}`], ifIgnored: '  ' }),
        ),
      'notification_without_consequence',
    );
    expect(await handle.db.select().from(notification)).toHaveLength(0);
    // The database refuses it too, so nothing that bypasses the service can land it.
    let refused: unknown;
    try {
      await handle.sql`insert into "notification" (id, job_id, coalesce_key, delivery_key, obligation_ids, content_hash, because, if_ignored, delivery_attempt) values (${newId('ntf')}, ${created.id}, ${created.id}, 'raw', '[]'::jsonb, ${'b'.repeat(64)}, '[]'::jsonb, 'Nothing happens.', 1)`;
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('notification_because_not_empty');
    const accepted = await jobs.transaction((tx) =>
      replies.enqueue(tx, { ...draft, because: [`job:${created.id}`] }),
    );
    expect(accepted.because).toEqual([`job:${created.id}`]);
    await runner.stop();
  }, 30_000);
});
