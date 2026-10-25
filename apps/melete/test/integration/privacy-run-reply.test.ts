/**
 * Long work held back by the privacy question can be answered from where it
 * waits: the Work page's reply box takes a reply that names an answer as that
 * answer, Home's queue lists the answers to press, and turning the topic off
 * in Settings lets the next shift go.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import type { AttemptBundle, AttemptOutcome, RuntimeAdapter } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { event, job, owner, question, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { withPrivacyGate } from '../../src/privacy/gate.ts';
import { KEEP_PRIVATE, PrivacyRouter, SEND_REDACTED } from '../../src/privacy/router.ts';
import { PostgresPrivacyStore } from '../../src/privacy/store.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = randomBytes(32).toString('hex');
const GOAL = 'Go through my bank statements from this year and list every subscription I pay for.';

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 15_000);

describe.if(jobs !== null)('answering the privacy question long work waits on', () => {
  if (!handle || !queue || !jobs) return;
  const started: AttemptBundle[] = [];
  const engine: RuntimeAdapter = {
    capabilities: () => new StubRuntimeAdapter().capabilities(),
    start: async (bundle): Promise<AttemptOutcome> => {
      started.push(bundle);
      return { kind: 'completed', summary: 'Shift over.', evidence: [] };
    },
  };
  const store = new PostgresPrivacyStore(handle.sql, () => KEY);
  const router = new PrivacyRouter({ store, resolve: async () => [{ address: '93.184.216.34' }] });
  const runner = new AttemptRunner(
    jobs,
    withPrivacyGate(engine, { router: () => router, engineProtocol: 'chat/completions' }),
    { key: 'privacy-run-reply-signing-key-32bytes!' },
  );
  const runs = new RunService(jobs);
  attachRuns(runner, runs);
  const app = createApp({
    db: handle.db,
    env: loadEnv({ NODE_ENV: 'test' }),
    jobs,
    runner,
    runs,
    sql: handle.sql,
    checkDatabase: async () => 'ok',
  });
  let spaceId = '';
  let ownerId = '';
  let token = '';

  const request = async (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        Cookie: `melete_session=${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const wake = async (row: Pick<JobRow, 'id'>) => {
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

  const openQuestion = async (jobId: string) => {
    const [open] = await handle.db
      .select()
      .from(question)
      .where(and(eq(question.jobId, jobId), eq(question.state, 'open')));
    return open ?? null;
  };

  const messages = async (jobId: string) =>
    (
      await handle.db
        .select({ payload: event.payload })
        .from(event)
        .where(and(eq(event.jobId, jobId), eq(event.type, 'notice')))
    )
      .map((row) => row.payload as { kind?: string; text?: string })
      .filter((payload) => payload.kind === 'user_message')
      .map((payload) => payload.text);

  /** Long work on the person's finances, held at its first shift: no local model is set up. */
  const heldRun = async () => {
    const row = await jobs.transaction((tx) =>
      runs.create(tx, spaceId, { goal: GOAL }, { principalId: ownerId, typed: true }),
    );
    const asked = await wake(row);
    expect(asked.state).toBe('waiting_for_input');
    expect(started).toHaveLength(0);
    const open = await openQuestion(row.id);
    if (!open) throw new Error('the privacy question was not asked');
    expect(open.text).toContain('personal finances');
    return { row, open };
  };

  const reply = async (runId: string, text: string) => {
    const response = await request(`/runs/${runId}/message`, 'POST', { text });
    expect(response.status).toBe(200);
  };

  beforeEach(async () => {
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await resetTestRows(handle.sql, { retention: true });
    started.length = 0;
    spaceId = newId('sp');
    ownerId = newId('own');
    token = randomBytes(32).toString('base64url');
    await handle.db.insert(owner).values({ id: ownerId, email: `${ownerId}@example.test` });
    await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
    await handle.db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId,
      spaceId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    // Every topic on, as a new install has it, and no local model.
    await store.saveSettings(spaceId, {}, null);
    router.invalidate(spaceId);
  }, 15_000);

  test('Home lists the question with the two answers to press', async () => {
    const { row, open } = await heldRun();
    const response = await request('/quick-answers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      questions: { id: string; conversation_id: string; options: unknown[]; free_text: boolean }[];
    };
    expect(body.questions.find((item) => item.id === open.id)).toMatchObject({
      conversation_id: row.id,
      options: [
        { id: 'send_redacted', label: SEND_REDACTED },
        { id: 'keep_private', label: KEEP_PRIVATE },
      ],
      free_text: false,
    });
  });

  test('pressing an answer on the work page records it and the held shift goes on', async () => {
    const { row, open } = await heldRun();
    const response = await request(`/quick-answers/${open.id}`, 'POST', {
      option_id: 'send_redacted',
    });
    expect(response.status).toBe(200);
    expect((await openQuestion(row.id)) ?? null).toBeNull();
    await wake(row);
    expect(started).toHaveLength(1);
  });

  test('a reply in the reply box that names an answer is that answer, not a new message', async () => {
    const { row, open } = await heldRun();
    await reply(row.id, '  send a redacted version.  ');
    const [answered] = await handle.db.select().from(question).where(eq(question.id, open.id));
    expect(answered).toMatchObject({ state: 'answered', answer: SEND_REDACTED });
    // The words are recorded as the choice, never as something the person wrote.
    expect(await messages(row.id)).toEqual([]);
    await wake(row);
    expect(started).toHaveLength(1);
    expect(started[0]?.inputs.new_user_messages.map((entry) => entry.content)).toEqual([]);
    expect(started[0]?.job.objective).toStartWith(GOAL);
  });

  test('a reply that chooses neither answer sends nothing and is asked again, saying so', async () => {
    const { row } = await heldRun();
    await reply(row.id, 'Yes, that’s fine, send the redacted version. It’s just a car question.');
    const after = await wake(row);
    expect(after.state).toBe('waiting_for_input');
    expect(started).toHaveLength(0);
    const again = await openQuestion(row.id);
    expect(again?.text).toStartWith(
      `Your last reply did not choose “${SEND_REDACTED}” or “${KEEP_PRIVATE}”.`,
    );
    expect(again?.options.map((option) => option.label)).toEqual([SEND_REDACTED, KEEP_PRIVATE]);
    // The question is answerable from the reply box on the next try.
    await reply(row.id, 'Keep it private');
    expect((await openQuestion(row.id)) ?? null).toBeNull();
    await wake(row);
    expect(started).toHaveLength(0);
  });

  test('turning the topic off in Settings lets the next shift go', async () => {
    const { row } = await heldRun();
    const saved = await request('/privacy/settings', 'PUT', {
      sensitive_topics: ['health', 'therapy'],
    });
    expect(saved.status).toBe(200);
    // The settings route clears its own router's cache; this one reads the change now too.
    router.invalidate(spaceId);
    await reply(row.id, 'Please carry on and finish the brief.');
    await wake(row);
    expect(started).toHaveLength(1);
  });
});
