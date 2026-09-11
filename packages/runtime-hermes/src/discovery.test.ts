import { describe, expect, test } from 'bun:test';
import type { AttemptBundle, RuntimeEvent, ToolSpec } from '@melete/contracts';
import {
  brokerCatalogState,
  brokerParkedActions,
  type FetchLike,
  HermesRuntimeAdapter,
} from './adapter.ts';

const suffix = '01J8ZP3QWABCDEFGHJKMNPQRST';
const load: ToolSpec = {
  name: 'load_tool',
  description: 'Load a tool',
  input_schema: { type: 'object' },
  effect_class: 'read',
  connection_id: null,
};
const target: ToolSpec = { ...load, name: 'test.read', connection_id: `conn_${suffix}` };
const bundle: AttemptBundle = {
  attempt: {
    id: `att_${suffix}`,
    job_id: `job_${suffix}`,
    epoch: 1,
    revision: 0,
    token: 'one-attempt-token',
  },
  job: {
    title: 'Discover',
    objective: 'Read the missing tool',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  transcript: [{ role: 'user', content: 'Earlier context', at: new Date(0).toISOString() }],
  tools: [load],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 10, max_output_tokens: 1000, max_wall_ms: 2000, max_actions: 5 },
  model: { provider: 'fake', model: 'scripted', fallback: null },
};

function discoveryHarness(
  options: { terminal?: string; loaded?: boolean; parked?: boolean; output?: number } = {},
) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const events: RuntimeEvent[] = [];
  let runs = 0;
  let reads = 0;
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path === '/v1/runs') return Response.json({ run_id: `run_${++runs}`, status: 'started' });
    if (path.endsWith('/events')) {
      const first = path.includes('run_1/');
      const frames = first
        ? [
            { event: 'tool.started', tool: 'load_tool', preview: 'test.read' },
            { event: 'tool.completed', tool: 'load_tool' },
            ...(options.terminal === 'missing'
              ? []
              : [
                  {
                    event: options.terminal ?? 'run.cancelled',
                    output: 'tools_loaded',
                    usage: { output_tokens: options.output ?? 20 },
                  },
                ]),
          ]
        : [
            { event: 'tool.started', tool: 'test.read' },
            { event: 'tool.completed', tool: 'test.read' },
            {
              event: 'run.completed',
              output: 'Read verified.',
              usage: { output_tokens: options.output ?? 20 },
            },
          ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    }
    return Response.json({ ok: true });
  };
  const adapter = new HermesRuntimeAdapter({
    baseUrl: 'http://hermes',
    fetch,
    parkedActions: async () => (options.parked ? [`act_${suffix}`] : []),
    catalogState: async () => (reads++ > 0 && options.loaded !== false ? [load, target] : [load]),
  });
  return {
    calls,
    events,
    run: (attempt = bundle) =>
      adapter.start(
        attempt,
        {
          emit: async (event) => {
            events.push(event);
          },
        },
        new AbortController().signal,
      ),
  };
}

describe('broker-verified tool continuation', () => {
  test('loads, stops, waits for termination and resumes with one public outcome', async () => {
    const h = discoveryHarness();
    expect(await h.run()).toMatchObject({ kind: 'completed', summary: 'Read verified.' });
    const starts = h.calls.filter((call) => call.path === '/v1/runs');
    expect(starts).toHaveLength(2);
    const firstStart = starts[0];
    const secondStart = starts[1];
    if (!firstStart || !secondStart) throw new Error('missing continuation');
    expect(new Headers(firstStart.init?.headers).get('Idempotency-Key')).toBe(bundle.attempt.id);
    expect(new Headers(secondStart.init?.headers).get('Idempotency-Key')).toBe(
      `${bundle.attempt.id}:tools:1`,
    );
    expect(h.calls.findIndex((call) => call.path === '/v1/runs/run_1/stop')).toBeLessThan(
      h.calls.indexOf(secondStart),
    );
    const first = JSON.parse(String(starts[0]?.init?.body));
    const second = JSON.parse(String(starts[1]?.init?.body));
    expect(first.input).toContain('Earlier context');
    expect(second.conversation_history).toBeUndefined();
    expect(second.input).toContain('test.read');
    expect(second.session_id).toBe(first.session_id);
    expect(h.events.filter((event) => event.type === 'attempt_outcome')).toHaveLength(1);
    expect(h.events.map((event) => event.local_seq)).toEqual(h.events.map((_, index) => index));
    expect(h.events.every((event) => event.attempt_id === bundle.attempt.id)).toBe(true);
  });

  test('model text cannot claim a load that the broker has not recorded', async () => {
    const h = discoveryHarness({ loaded: false, terminal: 'run.completed' });
    await h.run();
    expect(h.calls.filter((call) => call.path === '/v1/runs')).toHaveLength(1);
    expect(h.calls.some((call) => call.path.endsWith('/stop'))).toBe(false);
  });

  test('a lost terminal frame never starts concurrent continuation work', async () => {
    const h = discoveryHarness({ terminal: 'missing' });
    expect(await h.run()).toMatchObject({ kind: 'failed' });
    expect(h.calls.filter((call) => call.path === '/v1/runs')).toHaveLength(1);
  });

  test('approval parking takes precedence over a successful load', async () => {
    const h = discoveryHarness({ parked: true });
    expect(await h.run()).toMatchObject({ kind: 'waiting_for_approval' });
    expect(h.calls.filter((call) => call.path === '/v1/runs')).toHaveLength(1);
  });

  test('continuations share the output allowance', async () => {
    const h = discoveryHarness({ output: 60 });
    expect(
      await h.run({ ...bundle, budget: { ...bundle.budget, max_output_tokens: 100 } }),
    ).toMatchObject({ kind: 'budget_exhausted' });
  });

  test('continuations share the turn allowance', async () => {
    const h = discoveryHarness();
    expect(await h.run({ ...bundle, budget: { ...bundle.budget, max_turns: 1 } })).toMatchObject({
      kind: 'budget_exhausted',
    });
    expect(h.calls.filter((call) => call.path === '/v1/runs')).toHaveLength(1);
  });

  test('the wall deadline bounds a silent stream', async () => {
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://hermes',
      parkedActions: async () => [],
      fetch: async (url) =>
        url.endsWith('/events')
          ? new Response(new ReadableStream())
          : Response.json({ run_id: 'silent', status: 'started' }),
    });
    const started = Date.now();
    const outcome = await adapter.start(
      { ...bundle, budget: { ...bundle.budget, max_wall_ms: 25 } },
      { emit: async () => {} },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('budget_exhausted');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('the wall deadline also bounds a stalled broker callback', async () => {
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://hermes',
      parkedActions: async () => [],
      catalogState: () => new Promise(() => {}),
      fetch: async () => {
        throw new Error('no run may start before its catalog arrives');
      },
    });
    const started = Date.now();
    const outcome = await adapter.start(
      { ...bundle, budget: { ...bundle.budget, max_wall_ms: 25 } },
      { emit: async () => {} },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('budget_exhausted');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('wall exhaustion still observes a pending approval through a real asynchronous ledger read', async () => {
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://hermes',
      parkedActions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [`act_${suffix}`];
      },
      fetch: async (url) =>
        url.endsWith('/events')
          ? new Response(new ReadableStream())
          : Response.json({ run_id: 'wall-limit', status: 'started' }),
    });
    const outcome = await adapter.start(
      { ...bundle, budget: { ...bundle.budget, max_wall_ms: 25 } },
      { emit: async () => {} },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: 'waiting_for_approval', action_ids: [`act_${suffix}`] });
  });

  test('final ledger bookkeeping is bounded and aborts its request', async () => {
    let ledgerSignal: AbortSignal | undefined;
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://hermes',
      parkedActions: brokerParkedActions({
        brokerUrl: 'http://broker',
        serviceKey: 'service',
        spaceId: 'sp_test',
        timeoutMs: 40,
        fetch: async (_url, init) => {
          ledgerSignal = init?.signal ?? undefined;
          return new Promise(() => {});
        },
      }),
      fetch: async (url) =>
        url.endsWith('/events')
          ? new Response('data: {"event":"run.completed","output":"Finished"}\n\n')
          : Response.json({ run_id: 'ledger-timeout', status: 'started' }),
    });
    const outcome = await adapter.start(
      bundle,
      { emit: async () => {} },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: 'unknown_check',
      check: 'parked_actions',
      reason: 'timed_out',
    });
    expect(ledgerSignal?.aborted).toBe(true);
  }, 3_000);
});

test('the default catalog lookup uses only the attempt capability and validates schemas', async () => {
  let authorization = '';
  const lookup = brokerCatalogState({
    brokerUrl: 'http://broker/',
    fetch: async (_, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ tools: [load] });
    },
  });
  expect(await lookup(bundle)).toEqual([load]);
  expect(authorization).toBe(`Bearer ${bundle.attempt.token}`);
});

test('closing ledger check honors a broker timeout longer than one second', async () => {
  const adapter = new HermesRuntimeAdapter({
    baseUrl: 'http://hermes',
    parkedActions: brokerParkedActions({
      brokerUrl: 'http://broker',
      serviceKey: 'service',
      spaceId: 'sp_test',
      timeoutMs: 1800,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return Response.json({ actions: [{ id: `act_${suffix}`, attempt_id: bundle.attempt.id }] });
      },
    }),
    fetch: async (url) =>
      url.endsWith('/events')
        ? new Response('data: {"event":"run.completed","output":"Finished"}\n\n')
        : Response.json({ run_id: 'slow-ledger', status: 'started' }),
  });
  const outcome = await adapter.start(
    bundle,
    { emit: async () => {} },
    new AbortController().signal,
  );
  expect(outcome).toEqual({ kind: 'waiting_for_approval', action_ids: [`act_${suffix}`] });
});
