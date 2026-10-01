import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { AttemptBundle, AttemptOutcome, RuntimeAdapter } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { event, job, question, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { newId } from '../../src/ids.ts';
import { QuestionService } from '../../src/jobs/questions.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { withPrivacyGate } from '../../src/privacy/gate.ts';
import { PrivacyRouter, SEND_REDACTED } from '../../src/privacy/router.ts';
import { PostgresPrivacyStore } from '../../src/privacy/store.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = randomBytes(32).toString('hex');
const MESSAGE = 'Please research heat pump adoption in Europe.';

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 15_000);

describe.if(jobs !== null)('answering the privacy question', () => {
  if (!handle || !queue || !jobs) return;
  let spaceId = '';
  const started: AttemptBundle[] = [];
  const engine: RuntimeAdapter = {
    capabilities: () => new StubRuntimeAdapter().capabilities(),
    start: async (bundle): Promise<AttemptOutcome> => {
      started.push(bundle);
      return { kind: 'completed', summary: 'Here is the research.', evidence: [] };
    },
  };
  const store = new PostgresPrivacyStore(handle.sql, () => KEY);
  const router = new PrivacyRouter({ store, resolve: async () => [{ address: '93.184.216.34' }] });
  const runner = new AttemptRunner(
    jobs,
    withPrivacyGate(engine, { router: () => router, engineProtocol: 'chat/completions' }),
    { key: 'privacy-decision-signing-key-32bytes!' },
  );
  const submissions = new SubmissionService(jobs);
  const questions = new QuestionService(jobs, submissions);

  const wake = async (row: JobRow) => {
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
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql, { retention: true });
    started.length = 0;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
    // A private space with no local model: the first attempt asks before sending anything.
    await store.saveSettings(spaceId, { private_space: true }, null);
  }, 15_000);

  test('records the decision without a message from the person and resumes the held request', async () => {
    const created = await jobs.create({
      space_id: spaceId,
      title: 'Research',
      objective: 'Help with what the person asks',
    });
    await jobs.transaction((tx) =>
      appendEvent(tx, {
        jobId: created.id,
        type: 'notice',
        payload: { kind: 'user_message', text: MESSAGE },
        dedupKey: `${created.id}:test-message`,
      }),
    );
    const asked = await wake(created);
    expect(asked.state).toBe('waiting_for_input');
    expect(started).toHaveLength(0);
    const [open] = await handle.db
      .select()
      .from(question)
      .where(and(eq(question.jobId, created.id), eq(question.state, 'open')));
    if (!open) throw new Error('the privacy question was not asked');

    const answered = await questions.answer(open.id, { text: SEND_REDACTED });
    expect(answered.status).toBe(200);
    expect(answered.question.state).toBe('answered');
    expect(answered.job?.state).toBe('queued');
    // A resent answer changes nothing.
    expect((await questions.answer(open.id, { text: SEND_REDACTED })).status).toBe(200);

    const notices = await handle.db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.jobId, created.id), eq(event.type, 'notice')));
    const kinds = notices.map((row) => (row.payload as { kind?: string; text?: string }) ?? {});
    // The only message is the one the person wrote; the option label is not one.
    expect(
      kinds.filter((entry) => entry.kind === 'user_message').map((entry) => entry.text),
    ).toEqual([MESSAGE]);
    expect(kinds.filter((entry) => entry.kind === 'privacy_decision')).toHaveLength(1);

    await wake(await jobs.get(created.id));
    expect(started).toHaveLength(1);
    // The engine is handed the person's own request, and no message with the option's words.
    expect(started[0]?.inputs.new_user_messages.map((entry) => entry.content)).toEqual([MESSAGE]);
    expect(started[0]?.transcript.map((entry) => entry.content)).not.toContain(SEND_REDACTED);
  });

  test('an answer that is not one of the offered options is refused', async () => {
    const created = await jobs.create({
      space_id: spaceId,
      title: 'Research',
      objective: 'Help with what the person asks',
    });
    await wake(created);
    const [open] = await handle.db
      .select()
      .from(question)
      .where(and(eq(question.jobId, created.id), eq(question.state, 'open')));
    if (!open) throw new Error('the privacy question was not asked');
    let code = '';
    try {
      await questions.answer(open.id, { text: 'Sure, whatever' });
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('invalid_choice');
  });
});
