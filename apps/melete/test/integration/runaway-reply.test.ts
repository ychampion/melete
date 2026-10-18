/**
 * A reply that falls into writing the same letter again and again is stopped
 * after its first copy and ends with a plain line saying why, as a finished
 * answer. A reply that repeats a chorus, as a song does, is left whole.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  type AttemptOutcome,
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { experienceTurn, job, space } from '../../src/db/schema.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { RUNAWAY_NOTE } from '../../src/jobs/runaway.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'runaway-reply-signing-key-32-bytes-long';
const runners: AttemptRunner[] = [];

const LETTER = [
  'Dear Hiring Manager,',
  "I'm excited to apply for the Operations Coordinator position at Greenleaf Grocers. For the past three years, I've worked at a logistics startup, where I ran vendor scheduling and helped cut late deliveries by a third.",
  'In my role, I coordinated with vendors to keep deliveries on schedule, and I learned how much a store depends on the right products arriving in the right place at the right time.',
  'Grocery operations move quickly, and a small delay can ripple across a whole day. I enjoy that pace, and I am comfortable juggling many moving parts and spotting problems early.',
  'Thank you for your time and consideration. I would welcome the chance to discuss how my background in vendor scheduling can support your operations.',
  'Sincerely,\nRiya Sharma',
].join('\n\n');
const FIRST = `Here's your cover letter:\n\n${LETTER}\n\nIt's 217 words.`;
const looping = [
  FIRST,
  ...Array.from({ length: 9 }, () => `Here's the finished letter:\n\n${LETTER}`),
].join('\n\n');
const CHORUS =
  'Oh the river runs so wide tonight, and the lights are burning low,\nwe will carry every song we know, wherever the long roads go.';
const song = [1, 2, 3, 4]
  .flatMap((n) => [
    `Verse ${n}: the morning came on silver wings and found us by the shore, with stories ${n} times retold and wanting something more.`,
    CHORUS,
  ])
  .join('\n\n');

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/** An engine that streams `text` in small pieces and stops when told to. */
function streaming(text: string) {
  const seen = { sent: 0, stopped: false };
  const runtime: RuntimeAdapter = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: true, version: 'test' }),
    async start(
      bundle: AttemptBundle,
      sink: EventSink,
      signal?: AbortSignal,
    ): Promise<AttemptOutcome> {
      let seq = 0;
      for (let at = 0; at < text.length; at += 40) {
        if (signal?.aborted) {
          seen.stopped = true;
          throw signal.reason;
        }
        await sink.emit({
          type: 'text_delta',
          text: text.slice(at, at + 40),
          attempt_id: bundle.attempt.id,
          local_seq: seq,
          dedup_key: dedupKey(bundle.attempt.id, seq++),
          at: new Date().toISOString(),
        } as never);
        seen.sent = Math.min(text.length, at + 40);
      }
      return { kind: 'completed', summary: text, evidence: [] };
    },
  };
  return { runtime, seen };
}

async function conversation(runtime: RuntimeAdapter) {
  const { handle, jobs } = fixture();
  const spaceId = newId('sp');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  const submissions = new SubmissionService(jobs);
  const melete = await new ExperienceService(handle.db, jobs, submissions).defaultAgent(spaceId);
  const chat = await jobs.transaction((tx) =>
    jobs.createInTransaction(
      tx,
      { space_id: spaceId, title: 'Letter', objective: 'Talk' },
      { kind: 'chat' },
    ),
  );
  await handle.db.update(job).set({ agentId: melete.id }).where(eq(job.id, chat.id));
  const sent = await submissions.input(chat.id, {
    text: 'Write a cover letter. Sign it Riya Sharma.',
  });
  if (!sent.job) throw new Error('message refused');
  const worker = new AttemptRunner(jobs, runtime, { key, scopes: [] });
  runners.push(worker);
  await worker.handleWake({
    job_id: sent.job.id,
    expected_epoch: sent.job.leaseEpoch,
    expected_version: sent.job.stateVersion,
    reason: 'created',
  });
  const [turn] = await handle.db
    .select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, chat.id));
  const attempts = await handle.sql`select outcome from attempt where job_id = ${chat.id}`;
  return { turn, state: (await jobs.get(chat.id)).state, attempts };
}

withDb('a reply that keeps repeating itself', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await resetTestRows(handle.sql);
  });

  afterEach(async () => {
    for (const worker of runners.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('is stopped after its first copy, ending on a plain line, and not run again', async () => {
    const { runtime, seen } = streaming(looping);
    const { turn, state, attempts } = await conversation(runtime);
    // The engine was told to stop well before the tenth copy.
    expect(seen.stopped).toBe(true);
    expect(seen.sent).toBeLessThan(looping.length / 2);
    expect(turn?.status).toBe('done');
    expect(turn?.answer).toBe(`${FIRST}\n\n${RUNAWAY_NOTE}`);
    expect(turn?.answer.split('Dear Hiring Manager').length).toBe(2);
    expect(state).toBe('waiting_for_input');
    expect(attempts.map((row) => row.outcome)).toEqual(['completed']);
  });

  test('a song with its chorus repeated is left whole', async () => {
    const { runtime, seen } = streaming(song);
    const { turn, state } = await conversation(runtime);
    expect(seen.stopped).toBe(false);
    expect(turn?.status).toBe('done');
    expect(turn?.answer).toBe(song);
    expect(state).toBe('waiting_for_input');
  });
});
