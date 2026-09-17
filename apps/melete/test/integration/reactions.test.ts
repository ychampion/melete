import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  AttemptBundle,
  CommittedOutcome,
  EventSink,
  QuestioningRuntimeAdapter,
} from '@melete/contracts';
import { dedupKey, reaction as reactionContract, THUMBS_DOWN, THUMBS_UP } from '@melete/contracts';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { event, job, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { EventStream } from '../../src/events/stream.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { AttentionService } from '../../src/jobs/attention.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { ReactionService } from '../../src/jobs/reactions.ts';
import { ReplyService } from '../../src/jobs/replies.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { defaultBudget, rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'reaction-attention-signing-key-32bytes';
let spaceId = '';
const streams = new Set<EventStream>();

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

/**
 * A monitor that keeps monitoring: every wake says something different and then
 * goes back to waiting, so each pass is a genuinely new result and the job is
 * still alive for the next one.
 */
function reporting(): QuestioningRuntimeAdapter {
  const counts = new Map<string, number>();
  return {
    capabilities: () => new StubRuntimeAdapter().capabilities(),
    start: async (bundle: AttemptBundle, sink: EventSink): Promise<CommittedOutcome> => {
      const seen = (counts.get(bundle.attempt.job_id) ?? 0) + 1;
      counts.set(bundle.attempt.job_id, seen);
      await sink.emit({
        type: 'text_delta',
        text: `Checked the tracker; the queue is ${seen} long today.`,
        attempt_id: bundle.attempt.id,
        local_seq: 0,
        dedup_key: dedupKey(bundle.attempt.id, 0),
        at: new Date().toISOString(),
      });
      return {
        kind: 'waiting_for_event_or_time',
        wait: { kind: 'timer', wake_at: new Date(Date.now() + 3_600_000).toISOString() },
      };
    },
  };
}

withDb('reactions', () => {
  let runner: AttemptRunner;
  let submissions: SubmissionService;
  let replies: ReplyService;
  let attention: AttentionService;
  let reactions: ReactionService;

  const wire = () => {
    const { jobs } = fixture();
    runner = new AttemptRunner(jobs, reporting(), { key });
    submissions = new SubmissionService(jobs);
    replies = new ReplyService(jobs, submissions, runner);
    attention = new AttentionService(jobs, runner);
    reactions = new ReactionService(jobs, attention);
  };

  const app = () => {
    const { handle, jobs } = fixture();
    const events = new EventStream(handle);
    streams.add(events);
    return createApp({
      env: loadEnv({}),
      db: handle.db,
      jobs,
      submissions,
      replies,
      attention,
      reactions,
      events,
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

  /** The seq of the newest thing an attempt said on this job. */
  const lastAssistantMessage = async (jobId: string): Promise<string> => {
    const { handle } = fixture();
    const [row] = await handle.db
      .select({ seq: event.seq })
      .from(event)
      .where(and(eq(event.jobId, jobId), isNotNull(event.attemptId)))
      .orderBy(desc(event.seq))
      .limit(1);
    if (!row) throw new Error('the attempt said nothing');
    return String(row.seq);
  };

  const scope = () => ({ spaceId });

  const monitor = async (title: string) => {
    const { jobs } = fixture();
    return jobs.create({
      space_id: spaceId,
      title,
      objective: `Watch ${title} and report what changed.`,
      scheduling_class: 'background',
      importance: 'routine',
      unread_threshold: 3,
    });
  };

  beforeEach(async () => {
    const { handle, queue } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "principal", "owner", "space", event_retention cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    wire();
  });

  afterAll(async () => {
    for (const events of streams) await events.close();
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('two thumbs-down trip the frequency reduction one cycle earlier than unread alone', async () => {
    const silent = await monitor('Tracker, left alone');
    const disliked = await monitor('Tracker, reacted to');

    // Cycle one. Both report; neither has crossed the threshold of three.
    let silentRow = await wake(silent);
    let dislikedRow = await wake(disliked);
    expect(silentRow.unreadResults).toBe(1);
    expect(dislikedRow.unreadResults).toBe(1);
    expect(silentRow.attentionStatus).toBe('normal');
    expect(dislikedRow.attentionStatus).toBe('normal');

    await reactions.add(scope(), await lastAssistantMessage(disliked.id), {
      emoji: THUMBS_DOWN,
      by: 'person',
    });
    dislikedRow = await fixture().jobs.get(disliked.id);
    // The result it landed on now counts as two, which is what a read-and-wrong
    // result is worth beside an unread one.
    expect(dislikedRow.unreadResults).toBe(2);
    expect(dislikedRow.attentionStatus).toBe('normal');

    // Cycle two. The reacted-to monitor crosses; the silent one does not.
    silentRow = await wake(silent);
    dislikedRow = await wake(disliked);
    expect(silentRow.unreadResults).toBe(2);
    expect(silentRow.attentionStatus).toBe('normal');
    expect(silentRow.cadenceMultiplier).toBe(1);
    expect(dislikedRow.unreadResults).toBe(3);
    expect(dislikedRow.attentionStatus).toBe('frequency_reduced');
    expect(dislikedRow.cadenceMultiplier).toBeGreaterThan(1);

    await reactions.add(scope(), await lastAssistantMessage(disliked.id), {
      emoji: THUMBS_DOWN,
      by: 'person',
    });

    // Cycle three is where unread alone finally gets there, a cycle later.
    silentRow = await wake(silent);
    expect(silentRow.unreadResults).toBe(3);
    expect(silentRow.attentionStatus).toBe('frequency_reduced');
  }, 60_000);

  test('a thumbs-up clears the unread streak', async () => {
    const row = await monitor('Tracker, approved of');
    let current = await wake(row);
    current = await wake(current);
    expect(current.unreadResults).toBe(2);

    await reactions.add(scope(), await lastAssistantMessage(row.id), {
      emoji: THUMBS_UP,
      by: 'person',
    });
    current = await fixture().jobs.get(row.id);
    expect(current.unreadResults).toBe(0);
    expect(current.attentionStatus).toBe('normal');
    expect(current.cadenceMultiplier).toBe(1);
  }, 60_000);

  test('reacting twice with the same emoji records one reaction and counts once', async () => {
    const row = await monitor('Tracker, double-tapped');
    await wake(row);
    const message = await lastAssistantMessage(row.id);

    const first = await reactions.add(scope(), message, { emoji: THUMBS_DOWN, by: 'person' });
    const second = await reactions.add(scope(), message, { emoji: THUMBS_DOWN, by: 'person' });
    expect(second.seq).toBe(first.seq);
    expect(await reactions.list(scope(), message)).toHaveLength(1);
    expect((await fixture().jobs.get(row.id)).unreadResults).toBe(2);
  }, 60_000);

  test('a reaction is an ordinary event: persisted, replayed and readable over HTTP', async () => {
    const row = await monitor('Tracker, over HTTP');
    await wake(row);
    const message = await lastAssistantMessage(row.id);

    const service = app();
    const cookie = await signIn(service);
    const posted = await service.request(`/messages/${message}/reactions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: THUMBS_UP }),
    });
    expect(posted.status).toBe(201);
    const body = (await posted.json()) as { reaction: unknown };
    const parsed = reactionContract.parse(body.reaction);
    expect(parsed.message_id).toBe(message);
    expect(parsed.emoji).toBe(THUMBS_UP);
    expect(parsed.by).toBe('person');
    expect(parsed.job_id).toBe(row.id);

    const listed = await service.request(`/messages/${message}/reactions`, { headers: { cookie } });
    expect(((await listed.json()) as { reactions: unknown[] }).reactions).toHaveLength(1);

    const perJob = await service.request(`/jobs/${row.id}/reactions`, { headers: { cookie } });
    expect(((await perJob.json()) as { reactions: unknown[] }).reactions).toHaveLength(1);

    // It replays over SSE from the event table, like everything else the
    // transcript shows: a client that reconnects gets the reaction back.
    const stream = await service.request(`/jobs/${row.id}/events?after=${Number(message) - 1}`, {
      headers: { cookie },
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('the event stream has no body');
    const decoder = new TextDecoder();
    let frames = '';
    while (!frames.includes('event: reaction')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      frames += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    expect(frames).toContain('event: reaction');
    expect(frames).toContain(THUMBS_UP);
  }, 60_000);

  test('a reaction on a message that does not exist is a 404, not a silent no-op', async () => {
    const service = app();
    const cookie = await signIn(service);
    const response = await service.request('/messages/999999/reactions', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: THUMBS_UP }),
    });
    expect(response.status).toBe(404);
  }, 30_000);

  test('a word is not a reaction', async () => {
    const row = await monitor('Tracker, mistyped');
    await wake(row);
    const message = await lastAssistantMessage(row.id);
    const service = app();
    const cookie = await signIn(service);
    const response = await service.request(`/messages/${message}/reactions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: 'thumbsup' }),
    });
    expect(response.status).toBe(400);
  }, 60_000);
  test('a session cannot reach a message in another space, and learns nothing by trying', async () => {
    const { handle, jobs } = fixture();
    // A second space with a job of its own. The session belongs to the first.
    const elsewhere = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: elsewhere, name: 'Elsewhere', gitPath: `/spaces/${elsewhere}` });
    const theirs = await jobs.create({
      space_id: elsewhere,
      title: 'Not yours',
      objective: 'A responsibility in another space.',
      scheduling_class: 'background',
    });
    await wake(theirs);
    const theirMessage = await lastAssistantMessage(theirs.id);

    const service = app();
    const cookie = await signIn(service);
    const posted = await service.request(`/messages/${theirMessage}/reactions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: THUMBS_DOWN }),
    });
    // 404, never 403: refusing by name would confirm the message is there.
    expect(posted.status).toBe(404);
    expect(((await posted.json()) as { error: { code: string } }).error.code).toBe('not_found');

    // Nothing was written and no counter moved.
    expect(
      await handle.sql`select seq from event where type = 'reaction' and job_id = ${theirs.id}`,
    ).toHaveLength(0);
    expect((await jobs.get(theirs.id)).unreadResults).toBe(1);

    // Reading is scoped the same way, by message and by job.
    const listed = await service.request(`/messages/${theirMessage}/reactions`, {
      headers: { cookie },
    });
    expect(listed.status).toBe(404);
    const perJob = await service.request(`/jobs/${theirs.id}/reactions`, { headers: { cookie } });
    expect(perJob.status).toBe(404);
  }, 90_000);
  test('a client cannot sign a reaction as the assistant', async () => {
    const row = await monitor('Tracker, impersonated');
    await wake(row);
    const message = await lastAssistantMessage(row.id);
    const service = app();
    const cookie = await signIn(service);

    // `by` is not a field a caller may send; the schema refuses the whole body
    // rather than ignoring the part it does not like.
    const spoofed = await service.request(`/messages/${message}/reactions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: THUMBS_DOWN, by: 'assistant' }),
    });
    expect(spoofed.status).toBe(400);
    expect(
      await fixture().handle
        .sql`select seq from event where type = 'reaction' and job_id = ${row.id}`,
    ).toHaveLength(0);

    // The same glyph without the claim is recorded as the person, and the
    // attention counters move the way a person's reaction moves them.
    const honest = await service.request(`/messages/${message}/reactions`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: THUMBS_DOWN }),
    });
    expect(honest.status).toBe(201);
    const parsed = reactionContract.parse(
      ((await honest.json()) as { reaction: unknown }).reaction,
    );
    expect(parsed.by).toBe('person');
    expect((await fixture().jobs.get(row.id)).unreadResults).toBe(2);
  }, 90_000);

  test("a reaction the assistant leaves belongs to the job's principal alone", async () => {
    const { handle } = fixture();
    const mine = newId('own');
    const theirs = newId('own');
    await handle.sql`insert into principal (id, email) values
      (${mine}, 'mine@example.test'), (${theirs}, 'theirs@example.test')`;
    await handle.sql`update space set owner_principal_id = ${mine} where id = ${spaceId}`;
    const jobId = newId('job');
    const attemptId = newId('att');
    await handle.sql`insert into job
      (id, space_id, principal_id, title, objective, state, lease_epoch, budget, constraints)
      values (${jobId}, ${spaceId}, ${mine}, 'Invoice', 'Watch the invoice thread.', 'running', 1,
        ${JSON.stringify(defaultBudget)}::jsonb,
        ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb)`;
    await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
    const [said] = await handle.sql`insert into event (job_id, type, payload, dedup_key)
      values (${jobId}, 'notice',
        ${JSON.stringify({ kind: 'user_message', text: 'that one, please' })}::jsonb,
        ${`said:${jobId}`}) returning seq`;
    const message = String(said?.seq);

    // The glyph alone, the way an attempt sends it: the broker finds the target.
    const broker = new BrokerService({ sql: handle.sql, connectors: { get: () => undefined } });
    const answered = await broker.react(
      {
        job_id: jobId,
        attempt_id: attemptId,
        space_id: spaceId,
        principal_id: mine,
        epoch: 1,
        revision: 0,
        scopes: [],
        budget: { max_actions: 20, max_output_tokens: 10_000, max_usd_est: 2 },
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      { emoji: THUMBS_UP },
    );
    expect(answered).toEqual({ message_id: message, emoji: THUMBS_UP });

    // It is written on the job, so the job's owner reads it and nobody else does.
    expect(await reactions.list({ spaceId, principalId: mine }, message)).toMatchObject([
      { message_id: message, emoji: THUMBS_UP, by: 'assistant', job_id: jobId },
    ]);
    expect(await reactions.listForJob({ spaceId, principalId: mine }, jobId)).toHaveLength(1);
    // Another account holding the same space id still reads absence, not a refusal.
    const byMessage = await rejectionOf(reactions.list({ spaceId, principalId: theirs }, message));
    expect(byMessage).toMatchObject({ code: 'not_found', status: 404 });
    const byJob = await rejectionOf(reactions.listForJob({ spaceId, principalId: theirs }, jobId));
    expect(byJob).toMatchObject({ code: 'not_found', status: 404 });
  }, 60_000);
});
