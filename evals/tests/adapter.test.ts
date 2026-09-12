import { describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  EMPTY_SINCE_LAST,
  type RuntimeEvent,
  type WaitSpec,
} from '@melete/contracts';
import { type FetchLike, HermesRuntimeAdapter } from '../../packages/runtime-hermes/src/adapter.ts';

const suffix = '01J8ZP3QWABCDEFGHJKMNPQRST';
const actionId = `act_${suffix}`;
const bundle: AttemptBundle = {
  attempt: {
    id: `att_${suffix}`,
    job_id: `job_${suffix}`,
    epoch: 1,
    revision: 0,
    token: 'test-capability',
  },
  job: {
    title: 'Wait fixture',
    objective: 'Wait for the event.',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  since_last: EMPTY_SINCE_LAST,
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 6, max_output_tokens: 4000, max_wall_ms: 60000, max_actions: 3 },
  model: { provider: 'scripted', model: 'scripted', fallback: null },
};
function transport(completed = true): FetchLike {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/capabilities')
      return Response.json({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
        },
      });
    if (path === '/v1/runs' && init?.method === 'POST')
      return Response.json(
        { run_id: 'wait-fixture', status: 'started', replayed: false },
        { status: 202 },
      );
    if (path.endsWith('/events'))
      return new Response(
        `data: ${JSON.stringify(completed ? { event: 'run.completed', output: 'Waiting for the event.' } : { event: 'run.failed', error: 'fixture interruption' })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    throw new Error('Unexpected engine request');
  };
}
async function run(
  pendingWait: () => Promise<WaitSpec | null>,
  parked: string[] = [],
  completed = true,
) {
  const events: RuntimeEvent[] = [];
  const adapter = new HermesRuntimeAdapter({
    baseUrl: 'http://fixture.invalid',
    fetch: transport(completed),
    parkedActions: async () => parked,
    pendingWait,
  });
  const result = await adapter.start(
    bundle,
    {
      emit: async (event) => {
        events.push(event);
      },
    },
    new AbortController().signal,
  );
  return { result, events };
}

describe('the broker ledger, not prose, determines the runtime wait', () => {
  test('a typed timer replaces an apparent completion and is persisted in the outcome', async () => {
    const wait: WaitSpec = { kind: 'timer', wake_at: '2030-01-01T00:00:00Z' };
    const { result, events } = await run(async () => wait);
    expect(result).toEqual({ kind: 'waiting_for_event_or_time', wait });
    expect(events.at(-1)).toMatchObject({ type: 'attempt_outcome', outcome: result });
  });
  test('an event wait retains its registered trigger', async () => {
    const wait: WaitSpec = { kind: 'event', trigger_id: `trg_${suffix}`, deadline_at: null };
    expect((await run(async () => wait)).result).toEqual({
      kind: 'waiting_for_event_or_time',
      wait,
    });
  });
  test('the model saying waiting does not create a wait without a ledger record', async () => {
    expect((await run(async () => null)).result.kind).toBe('completed');
  });
  test('a pending approval takes priority and the wait resolver is not called', async () => {
    let called = false;
    const { result } = await run(async () => {
      called = true;
      return null;
    }, [actionId]);
    expect(result).toEqual({ kind: 'waiting_for_approval', action_ids: [actionId] });
    expect(called).toBe(false);
  });
  test('a ledger read failure cannot fabricate a completion', async () => {
    const { result } = await run(async () => {
      throw new Error('ledger unavailable');
    });
    expect(result).toMatchObject({
      kind: 'unknown_check',
      check: 'parked_actions',
      reason: 'unavailable',
    });
  });
  test('a lifecycle resolver cannot grant an approval or ask an invented question', async () => {
    const { result } = await run(async () => ({
      kind: 'user_input',
      question: 'Approve everything?',
    }));
    expect(result).toMatchObject({
      kind: 'unknown_check',
      check: 'parked_actions',
      reason: 'unavailable',
    });
  });
  test('a failed engine run is not promoted to a successful wait', async () => {
    const { result } = await run(
      async () => ({ kind: 'timer', wake_at: '2030-01-01T00:00:00Z' }),
      [],
      false,
    );
    expect(result.kind).toBe('failed');
  });
});
