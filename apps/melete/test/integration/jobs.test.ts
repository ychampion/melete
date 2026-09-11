import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  JOB_STATES,
  type JobState,
  jobResponse,
  LEGAL_EDGES,
  type TransitionInput,
  transition,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { job, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

async function create(state: JobState = 'queued') {
  const { jobs, handle } = fixture();
  const row = await jobs.create({
    space_id: spaceId,
    title: 'Test',
    objective: 'Test the durable service',
  });
  // Test fixtures deliberately seed each source state; production only uses contracts.transition.
  const [seeded] = await handle.db.update(job).set({ state }).where(eq(job.id, row.id)).returning();
  if (!seeded) throw new Error('missing seeded job');
  return seeded;
}

const INPUTS: TransitionInput[] = [
  { kind: 'attempt_started' },
  {
    kind: 'attempt_completed',
    all_actions_terminal: true,
    has_unknown_action: false,
    deliverable_declared: false,
    deliverable_satisfied: true,
  },
  { kind: 'attempt_waiting_for_input' },
  { kind: 'attempt_waiting_for_approval' },
  { kind: 'attempt_waiting_for_event_or_time' },
  { kind: 'attempt_failed', retryable: false, attempts_remaining: 0 },
  { kind: 'attempt_budget_exhausted' },
  { kind: 'action_unknown' },
  { kind: 'user_input_received' },
  { kind: 'approval_decided', decision: 'approved' },
  { kind: 'event_fired' },
  { kind: 'timer_fired' },
  { kind: 'reconciled' },
  { kind: 'cancelled' },
];

withDb('durable jobs and contract transitions', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await handle.sql`truncate "owner", "space" cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  });

  test('every legal edge persists its transition event and next wake in one transaction', async () => {
    const { jobs, handle } = fixture();
    for (const edge of LEGAL_EDGES) {
      const row = await create(edge.from);
      const input = INPUTS.find((input) => input.kind === edge.input);
      if (!input) throw new Error(`missing input ${edge.input}`);
      const updated = await jobs.transaction((tx) => jobs.move(tx, row, input));
      expect(updated.state).toBe(edge.to);
      expect(updated.stateVersion).toBe(1);
      const events =
        await handle.sql`select payload from event where job_id = ${row.id} and type = 'job_state_changed'`;
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.to).toBe(edge.to);
      const wakes =
        await handle.sql`select data from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id} and (data->>'expected_version')::int = 1`;
      expect(wakes.length).toBe(edge.to === 'queued' ? 1 : 0);
    }
  });

  test.each([...JOB_STATES])(
    'illegal inputs from %s preserve state, events and queue',
    async (state) => {
      const { jobs, handle } = fixture();
      const row = await create(state);
      for (const input of INPUTS) {
        if (transition(state, input).ok) continue;
        // Native await keeps the driver's transaction lifecycle out of Bun's rejection matcher.
        let rejection: unknown;
        try {
          await jobs.transaction((tx) => jobs.move(tx, row, input));
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(Error);
      }
      expect((await jobs.get(row.id)).stateVersion).toBe(0);
      const events = await handle.sql`select seq from event where job_id = ${row.id}`;
      expect(events).toHaveLength(1);
      const wakes =
        await handle.sql`select id from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id}`;
      expect(wakes).toHaveLength(1);
    },
  );

  test('fault between transition and enqueue rolls back state, event and wake together', async () => {
    const { handle, queue, jobs } = fixture();
    const row = await create('waiting_for_input');
    const broken = new JobService(handle.db, queue.boss, {
      afterTransitionBeforeEnqueue: async () => {
        throw new Error('injected process death');
      },
    });
    await expect(broken.input(row.id, 'resume')).rejects.toThrow('injected process death');
    expect((await jobs.get(row.id)).state).toBe('waiting_for_input');
    expect(await handle.sql`select seq from event where job_id = ${row.id}`).toHaveLength(1);
    expect(
      await handle.sql`select id from pgboss.job where data->>'job_id' = ${row.id}`,
    ).toHaveLength(1);
  });

  test('objective and constraint changes bump revision, repeated values do not', async () => {
    const { jobs } = fixture();
    const row = await create();
    expect((await jobs.revise(row.id, { objective: 'Changed objective' })).revision).toBe(1);
    expect((await jobs.revise(row.id, { objective: 'Changed objective' })).revision).toBe(1);
    const revised = await jobs.revise(row.id, {
      constraints: {
        deliverable: { kind: 'answer' },
        allowed_domains: [],
        public_compartment: false,
      },
    });
    expect(revised.revision).toBe(2);
    expect(revised.leaseEpoch).toBe(0);
  });

  test('completion guards, retry and denial outcomes use frozen transition policy', async () => {
    const { jobs } = fixture();
    const variants: Array<[TransitionInput, string | null]> = [
      [
        {
          kind: 'attempt_completed',
          all_actions_terminal: false,
          has_unknown_action: true,
          deliverable_declared: true,
          deliverable_satisfied: false,
        },
        'needs_reconciliation',
      ],
      [
        {
          kind: 'attempt_completed',
          all_actions_terminal: false,
          has_unknown_action: false,
          deliverable_declared: false,
          deliverable_satisfied: true,
        },
        null,
      ],
      [
        {
          kind: 'attempt_completed',
          all_actions_terminal: true,
          has_unknown_action: false,
          deliverable_declared: true,
          deliverable_satisfied: false,
        },
        'waiting_for_input',
      ],
      [{ kind: 'attempt_failed', retryable: true, attempts_remaining: 1 }, 'queued'],
      [{ kind: 'attempt_failed', retryable: true, attempts_remaining: 0 }, 'failed'],
    ];
    for (const [input, expected] of variants) {
      const row = await create('running');
      const result = jobs.transaction((tx) => jobs.move(tx, row, input));
      if (expected) expect((await result).state).toBe(expected);
      else await expect(result).rejects.toThrow();
    }
    const approval = await create('waiting_for_approval');
    expect(
      (
        await jobs.transaction((tx) =>
          jobs.move(tx, approval, { kind: 'approval_decided', decision: 'denied' }),
        )
      ).state,
    ).toBe('queued');
  });

  test('authenticated HTTP creates, lists, reads, inputs and cancels jobs with contract responses', async () => {
    const { jobs, handle } = fixture();
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: handle.db,
      jobs,
      checkDatabase: async () => 'ok',
    });
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'test-password' }),
    });
    const cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
    const headers = { cookie, 'content-type': 'application/json' };
    const response = await app.request('/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ space_id: spaceId, title: 'API', objective: 'Answer me' }),
    });
    expect(response.status).toBe(201);
    const created = jobResponse.parse(await response.json()).job;
    expect((await app.request(`/jobs/${created.id}`, { headers })).status).toBe(200);
    expect((await app.request('/jobs?state=queued', { headers })).status).toBe(200);
    expect((await app.request('/jobs?state=bogus', { headers })).status).toBe(400);
    expect(
      (
        await app.request(`/jobs/${created.id}/input`, {
          method: 'POST',
          headers,
          body: '{"text":"hello"}',
        })
      ).status,
    ).toBe(409);
    const row = await create('waiting_for_input');
    const input = await app.request(`/jobs/${row.id}/input`, {
      method: 'POST',
      headers,
      body: '{"text":"answer"}',
    });
    expect(jobResponse.parse(await input.json()).job.state).toBe('queued');
    const cancelled = await app.request(`/jobs/${created.id}/cancel`, { method: 'POST', headers });
    expect(jobResponse.parse(await cancelled.json()).job.lease_epoch).toBe(1);
    expect(
      (await app.request(`/jobs/${created.id}/cancel`, { method: 'POST', headers })).status,
    ).toBe(409);
    expect((await app.request('/jobs', { method: 'POST', headers, body: '{}' })).status).toBe(400);
  });
});
