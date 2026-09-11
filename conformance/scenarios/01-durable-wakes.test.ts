import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { QUEUES, RECOVERY_SCAN_SECONDS } from '../../apps/melete/src/jobs/queue.ts';
import type { JobRow } from '../../apps/melete/src/jobs/service.ts';
import { conformanceFixture, eventually, killAtFault, wake } from '../helpers/fixture.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(1);

const fixture = await conformanceFixture();
const withDb = fixture ? describe : describe.skip;

withDb(`conformance 1: ${s.title}`, () => {
  let waiting: JobRow;
  let afterFault: JobRow;
  let readyWakeCount = 0;
  let recoveryMs = 0;
  let boundary = 0;
  beforeAll(async () => {
    if (!fixture) return;
    const row = await fixture.create([
      {
        type: 'outcome',
        epoch: 1,
        outcome: {
          kind: 'waiting_for_event_or_time',
          wait: { kind: 'timer', wake_at: new Date(Date.now() - 1000).toISOString() },
        },
      },
      {
        type: 'outcome',
        epoch: 2,
        outcome: { kind: 'completed', summary: 'Recovered timer', evidence: [] },
      },
    ]);
    await fixture.runner.handleWake(wake(row));
    waiting = await fixture.jobs.get(row.id);
    const [latest] = await fixture.handle
      .sql`select max(seq)::bigint as seq from event where job_id = ${row.id}`;
    boundary = Number(latest?.seq);
    await fixture.queue.boss.deleteAllJobs(QUEUES.attempt);
    expect(await killAtFault(fixture, row.id, 'transition')).toEqual({
      code: 77,
      marker: 'FAULT:transition',
    });
    afterFault = await fixture.jobs.get(row.id);
    expect(afterFault.stateVersion).toBe(waiting.stateVersion);
    expect(
      await fixture.handle
        .sql`select seq from event where job_id = ${row.id} and seq > ${boundary}`,
    ).toHaveLength(0);
    const start = Date.now();
    await fixture.runner.recover();
    recoveryMs = Date.now() - start;
    const ready = await fixture.handle
      .sql`select id from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id} and (data->>'expected_version')::int = ${waiting.stateVersion}`;
    readyWakeCount = ready.length;
    await fixture.queue.boss.send(QUEUES.attempt, wake(waiting));
    await fixture.queue.boss.send(QUEUES.attempt, wake(waiting));
    await fixture.runner.start();
    await eventually(async () => (await fixture.jobs.get(row.id)).state === 'completed');
  }, 20_000);
  afterAll(async () => {
    await fixture?.close();
  });
  test(s.assertions[0] ?? '', async () => {
    if (!fixture) return;
    expect(
      await fixture.handle.sql`select id from attempt where job_id = ${waiting.id} and epoch > 1`,
    ).toHaveLength(1);
    expect((await fixture.jobs.get(waiting.id)).leaseEpoch).toBe(2);
  });
  test(s.assertions[1] ?? '', async () => {
    expect(readyWakeCount).toBe(1);
    expect(recoveryMs).toBeLessThan(60_000);
    expect(RECOVERY_SCAN_SECONDS).toBe(60);
    const schedules = await fixture?.queue.boss.getSchedules(QUEUES.recoveryScan);
    expect(schedules?.some((item) => item.cron === '* * * * *')).toBe(true);
  });
  test(s.assertions[2] ?? '', () => {
    expect(afterFault.state).toBe('waiting_for_event_or_time');
    expect(afterFault.wait).toEqual(waiting.wait);
    expect(afterFault.nextWakeAt?.getTime()).toBe(waiting.nextWakeAt?.getTime());
    expect(afterFault.nextWakeAt?.getTime()).toBeLessThan(Date.now());
  });
  test(s.assertions[3] ?? '', async () => {
    if (!fixture) return;
    expect(
      await fixture.handle
        .sql`select seq from event where job_id = ${waiting.id} and seq > ${boundary} and type = 'attempt_started'`,
    ).toHaveLength(1);
    expect(
      await fixture.handle
        .sql`select seq from event where job_id = ${waiting.id} and seq > ${boundary} and payload->>'input' = 'timer_fired'`,
    ).toHaveLength(1);
  });
});
