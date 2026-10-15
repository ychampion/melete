/**
 * A schedule the person asked for runs every time it is due, read or not.
 *
 * Before, three changed results nobody marked read put any background job on
 * a quarter of its schedule: a morning brief ran three days, then skipped
 * three, while its card still said "Every day". Work the agent chose to
 * schedule for itself is still slowed down when nobody reads what it finds.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  automationResponse,
  experienceOperations,
  runResponse,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { job, owner, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { AttentionService, REDUCED_CADENCE_MULTIPLIER } from '../../src/jobs/attention.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { stand } from '../../src/runs/standing.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'routine-cadence-signing-key-32-bytes!',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : undefined;
const runs = jobs ? new RunService(jobs) : null;
if (runner && runs) attachRuns(runner, runs);
if (runs && triggers) runs.triggers = triggers;
// Wired to every attempt's end, as the service wires it.
const attention = jobs && runner ? new AttentionService(jobs, runner) : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      triggers,
      runs: runs ?? undefined,
      attention: attention ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'cadence@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Records `count` new results nobody read, each different from the last. */
async function unreadResults(row: JobRow, count: number) {
  for (let index = 0; index < count; index++) {
    const attemptId = newId('att');
    await required(jobs).transaction(async (tx) => {
      const current = required(await required(jobs).lock(tx, row.id));
      await required(attention).record(
        tx,
        current,
        { kind: 'completed', summary: `Result ${index}`, evidence: [] },
        attemptId,
        { text: `Result ${index}`, hash: `hash-${index}`, baseline: false, changed: true },
      );
    });
  }
  return required(jobs).get(row.id);
}

withDb('a schedule the person set', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a daily routine with a new result every run runs every time, unread or not', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations/morning-brief', 'POST', { agent_id: persona.id, at: '07:00' })
      ).json(),
    ).automation;
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const jobId = required(registration).jobId;
    for (let day = 1; day <= 5; day++) {
      expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
      const row = await required(jobs).get(jobId);
      // Due now: the occurrence was not swallowed as a deferred check.
      expect(row.state).toBe('queued');
      const claimed = required(
        await required(runner).claim({
          job_id: row.id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'event',
        }),
      );
      await required(runner).commitOutcome(claimed.claims, {
        kind: 'completed',
        summary: `Day ${day}: ${day + 1} meetings, and the weather turns on day ${day + 2}.`,
        evidence: [],
      });
    }
    const list = experienceOperations['GET /automations'].response.parse(
      await (await request('/automations')).json(),
    );
    const shown = required(list.automations.find((entry) => entry.id === routine.id));
    expect(shown.runs.filter((run) => run.status === 'done')).toHaveLength(5);
    const after = await required(jobs).get(jobId);
    expect(after.unreadResults).toBeGreaterThanOrEqual(after.unreadThreshold);
    expect(after.cadenceMultiplier).toBe(1);
    expect(after.scheduleSkipRemaining).toBe(0);
    expect(after.attentionStatus).toBe('normal');
  });

  test('repeating work the person started keeps its schedule, from the runs page or a conversation', async () => {
    const typed = runResponse.parse(
      await (
        await request('/runs', 'POST', {
          goal: 'Check the rent listings near the park',
          repeat: { cron: '0 8 * * *', timezone: 'UTC' },
        })
      ).json(),
    ).run;
    const asked = await required(jobs).transaction((tx) =>
      required(runs).create(
        tx,
        spaceId,
        { goal: 'Send me the top three headlines', repeat: { cron: '0 7 * * *', timezone: 'UTC' } },
        { principalId: ownerId },
      ),
    );
    for (const id of [typed.id, asked.id]) {
      const after = await unreadResults(await required(jobs).get(id), 5);
      expect(after.cadenceMultiplier).toBe(1);
      expect(after.scheduleSkipRemaining).toBe(0);
      expect(after.attentionStatus).toBe('normal');
    }
  });

  test('a schedule the work chose for itself still slows down when nobody reads it', async () => {
    const work = await required(jobs).transaction((tx) =>
      required(runs).create(
        tx,
        spaceId,
        { goal: 'Watch the build until it is fixed' },
        {
          principalId: ownerId,
        },
      ),
    );
    await required(jobs).transaction(async (tx) => {
      const current = required(await required(jobs).lock(tx, work.id));
      await stand(tx, required(jobs), current, { kind: 'schedule', cron: '0 * * * *' }, 'work');
    });
    const after = await unreadResults(await required(jobs).get(work.id), 3);
    expect(after.cadenceMultiplier).toBe(REDUCED_CADENCE_MULTIPLIER);
    expect(after.attentionStatus).toBe('frequency_reduced');
    // A timer it rests on is stretched as before.
    const wakeAt = new Date(Date.now() + 60 * 60_000);
    const resting = await required(jobs).transaction(async (tx) => {
      const current = required(await required(jobs).lock(tx, work.id));
      await tx.update(job).set({ state: 'running' }).where(eq(job.id, work.id));
      return required(jobs).move(
        tx,
        { ...current, state: 'running' },
        { kind: 'attempt_waiting_for_event_or_time' },
        { wait: { kind: 'timer', wake_at: wakeAt.toISOString() } },
      );
    });
    expect(required(resting.nextWakeAt).getTime()).toBeGreaterThan(wakeAt.getTime() + 60 * 60_000);
  });

  test('a routine left slowed down by an earlier version runs when due and waits on its timer as set', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations/morning-brief', 'POST', { agent_id: persona.id, at: '06:00' })
      ).json(),
    ).automation;
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const jobId = required(registration).jobId;
    await required(handle)
      .db.update(job)
      .set({
        cadenceMultiplier: REDUCED_CADENCE_MULTIPLIER,
        attentionStatus: 'frequency_reduced',
        scheduleSkipRemaining: REDUCED_CADENCE_MULTIPLIER - 1,
      })
      .where(eq(job.id, jobId));
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    expect((await required(jobs).get(jobId)).state).toBe('queued');
    const wakeAt = new Date(Date.now() + 60 * 60_000);
    const resting = await required(jobs).transaction(async (tx) => {
      const current = required(await required(jobs).lock(tx, jobId));
      await tx.update(job).set({ state: 'running' }).where(eq(job.id, jobId));
      return required(jobs).move(
        tx,
        { ...current, state: 'running' },
        { kind: 'attempt_waiting_for_event_or_time' },
        { wait: { kind: 'timer', wake_at: wakeAt.toISOString() } },
      );
    });
    expect(required(resting.nextWakeAt).getTime()).toBe(wakeAt.getTime());
  });
});
