import { afterAll, describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import { HermesRuntimeAdapter } from '../../../../packages/runtime-hermes/src/adapter.ts';
import { event, space } from '../../src/db/schema.ts';
import { EventStream } from '../../src/events/stream.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;

withDb('durable lifecycle observations', () => {
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('adapter capture persists in order, deduplicates delivery and replays from the stored cursor', async () => {
    if (!handle || !jobs) throw new Error('Postgres unavailable');
    const spaceId = newId('sp');
    await handle.db.insert(space).values({ id: spaceId, name: 'Hooks', gitPath: '/spaces/hooks' });
    const row = await jobs.create({
      space_id: spaceId,
      title: 'Observe a turn',
      objective: 'Read and finish.',
    });
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'hook-test-capability-key-at-least-32-bytes',
    });
    const claimed = await runner.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    });
    if (!claimed) throw new Error('Expected an admitted attempt');
    const names = [
      'on_session_start',
      'pre_tool_call',
      'post_tool_call',
      'on_compaction',
      'api_request_error',
      'on_session_end',
    ];
    const frames = names.map((name, index) => ({
      event: index === 1 ? 'hook.error' : 'hook.event',
      attempt_id: claimed.claims.attempt_id,
      capture_id: `${claimed.claims.attempt_id}:hook:${index}`,
      name,
      tool_name: 'test.read',
      timing: { captured_at: new Date().toISOString(), duration_ms: 1 },
      outcome: index === 1 || index === 4 ? 'failed' : 'observed',
      redacted_args_digest: 'a'.repeat(64),
      ...(index === 1 ? { error_code: 'observer_failed' } : {}),
    }));
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://recorded-hermes',
      parkedActions: async () => [],
      fetch: async (url) =>
        url.endsWith('/events')
          ? new Response(
              [
                ...frames,
                frames[0],
                { event: 'run.completed', output: 'Finished despite observer failure.' },
              ]
                .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
                .join(''),
            )
          : Response.json({ run_id: 'recorded-hooks', status: 'started' }),
    });
    const delivered: RuntimeEvent[] = [];
    const stream = new EventStream(handle, { keepaliveMs: 25, pollIntervalMs: 25 });
    const abort = new AbortController();
    try {
      const outcome = await adapter.start(
        claimed.bundle,
        {
          emit: async (value) => {
            await runner.emit(claimed.claims, value);
            delivered.push(value);
          },
        },
        abort.signal,
      );
      expect(outcome.kind).toBe('completed');
      for (const value of delivered) await runner.emit(claimed.claims, value);
      const saved = await handle.db
        .select()
        .from(event)
        .where(eq(event.attemptId, claimed.claims.attempt_id))
        .orderBy(asc(event.seq));
      const observations = saved.filter(
        (value) => value.type === 'hook_event' || value.type === 'hook_error',
      );
      expect(observations.map((value) => (value.payload as { name: string }).name)).toEqual(names);
      expect(observations).toHaveLength(6);
      expect(observations[1]?.type).toBe('hook_error');
      expect(new Set(observations.map((value) => value.dedupKey)).size).toBe(6);

      const first = observations[0];
      if (!first) throw new Error('Expected persisted observation');
      const response = await stream.response({
        after: first.seq,
        jobId: row.id,
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected replay stream');
      const replayed: string[] = [];
      try {
        while (replayed.length < 5) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Replay ended early');
          const text = new TextDecoder().decode(value);
          const data = text.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const parsed = JSON.parse(data.slice(6)) as {
            type: string;
            payload: { name?: string };
            seq: number;
          };
          expect(parsed.seq).toBeGreaterThan(first.seq);
          if (parsed.type === 'hook_event' || parsed.type === 'hook_error')
            replayed.push(parsed.payload.name ?? '');
        }
        expect(replayed).toEqual(names.slice(1));
      } finally {
        abort.abort();
        await reader.cancel();
      }
    } finally {
      abort.abort();
      await stream.close();
      await runner.stop();
    }
  }, 15_000);
});
