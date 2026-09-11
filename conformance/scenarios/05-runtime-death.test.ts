import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventStream } from '../../apps/melete/src/events/stream.ts';
import { AttemptRunner } from '../../apps/melete/src/jobs/runner.ts';
import type { StubStep } from '../../apps/melete/src/runtime/stub.ts';
import { StubRuntimeAdapter } from '../../apps/melete/src/runtime/stub.ts';
import { fakeTool } from '../helpers/fake-effects.ts';
import { CONFORMANCE_KEY, conformanceFixture, killAtFault, wake } from '../helpers/fixture.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(5);

const fixture = await conformanceFixture();
const withDb = fixture ? describe : describe.skip;

withDb(`conformance 5: ${s.title}`, () => {
  const jobs: Array<{ id: string; mode: string; firstAttempt: string; gapSeq: number }> = [];
  beforeAll(async () => {
    if (!fixture) return;
    for (const mode of ['mid-stream', 'after-tool'] as const) {
      const script: StubStep[] = [{ type: 'text_delta', text: 'Durable prefix', epoch: 1 }];
      if (mode === 'after-tool')
        script.push({
          type: 'tool',
          tool: 'test.send',
          call_id: 'stable-call',
          arguments: { message: 'one effect' },
        });
      script.push(
        { type: 'stall', key: mode, epoch: 1 },
        { type: 'text_delta', text: 'Recovered suffix', epoch: 2 },
        {
          type: 'outcome',
          outcome: { kind: 'completed', summary: 'Recovered from stored state', evidence: [] },
        },
      );
      const row = await fixture.create(script);
      expect(await killAtFault(fixture, row.id, mode)).toEqual({
        code: 77,
        marker: `FAULT:${mode}`,
      });
      const [first] = await fixture.handle
        .sql`select id, ended_at from attempt where job_id = ${row.id}`;
      if (!first) throw new Error('The killed attempt was not persisted');
      expect(first.ended_at).toBeNull();
      await fixture.handle
        .sql`update attempt set lease_expires_at = now() - interval '1 second' where id = ${first.id}`;
      const replacement = new AttemptRunner(
        fixture.jobs,
        new StubRuntimeAdapter({
          onTool: fakeTool(fixture.jobs, CONFORMANCE_KEY, fixture.connectionId),
        }),
        { key: CONFORMANCE_KEY },
      );
      await replacement.recover();
      await replacement.handleWake(wake(await fixture.jobs.get(row.id)));
      const [gap] = await fixture.handle
        .sql`select seq from event where attempt_id = ${first.id} and payload->>'kind' = 'gap'`;
      jobs.push({ id: row.id, mode, firstAttempt: first.id, gapSeq: Number(gap?.seq) });
    }
  }, 25_000);
  afterAll(async () => {
    await fixture?.close();
  });

  test(s.assertions[0] ?? '', async () => {
    if (!fixture) return;
    expect(jobs).toHaveLength(2);
    for (const row of jobs) {
      const current = await fixture.jobs.get(row.id);
      expect(current.state).toBe('completed');
      expect(current.leaseEpoch).toBe(2);
      expect(current.stateVersion).toBe(4);
      expect(
        await fixture.handle.sql`select id from attempt where job_id = ${row.id}`,
      ).toHaveLength(2);
    }
  });
  test(s.assertions[1] ?? '', async () => {
    if (!fixture) return;
    const completedTool = jobs.find((row) => row.mode === 'after-tool');
    if (!completedTool) throw new Error('Missing after-tool proof');
    const [count] = await fixture.handle
      .sql`select calls from fake_effect_counter where job_id = ${completedTool.id}`;
    expect(count?.calls).toBe(1);
    expect(
      await fixture.handle.sql`select id from action where job_id = ${completedTool.id}`,
    ).toHaveLength(1);
    expect(
      await fixture.handle
        .sql`select seq from event where job_id = ${completedTool.id} and type = 'tool_result'`,
    ).toHaveLength(1);
  });
  test(s.assertions[2] ?? '', async () => {
    if (!fixture) return;
    for (const row of jobs) {
      const [lost] = await fixture.handle
        .sql`select outcome, lease_status, ended_at from attempt where id = ${row.firstAttempt}`;
      expect(lost?.outcome).toBe('fenced');
      expect(lost?.lease_status).toBe('lost');
      expect(lost?.ended_at).not.toBeNull();
      expect(
        await fixture.handle
          .sql`select seq from event where job_id = ${row.id} and type = 'attempt_started'`,
      ).toHaveLength(2);
      expect(
        await fixture.handle
          .sql`select seq from event where attempt_id = ${row.firstAttempt} and type = 'attempt_ended'`,
      ).toHaveLength(1);
    }
  });
  test(s.assertions[3] ?? '', async () => {
    if (!fixture) return;
    const stream = new EventStream(fixture.handle);
    try {
      for (const row of jobs) {
        const deltas = await fixture.handle
          .sql`select payload->>'text' as text from event where job_id = ${row.id} and type = 'text_delta' order by seq`;
        expect(deltas.map((value) => value.text)).toEqual(['Durable prefix', 'Recovered suffix']);
        expect(row.gapSeq).toBeGreaterThan(0);
        // The reader already knows the replacement epoch; replay checks the original durable gap.
        const current = await fixture.jobs.get(row.id);
        const response = await stream.response({
          jobId: row.id,
          after: row.gapSeq - 1,
          epoch: current.leaseEpoch,
        });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('SSE body missing');
        try {
          const chunk = new TextDecoder().decode((await reader.read()).value);
          expect(chunk).toContain(`id: ${row.gapSeq}\n`);
          expect(chunk).toContain('event: gap\n');
          expect(chunk).toContain('runtime_interrupted');
        } finally {
          await reader.cancel();
        }
      }
    } finally {
      await stream.close();
    }
  });
});
