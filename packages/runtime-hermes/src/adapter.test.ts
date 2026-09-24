import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeEvent } from '@melete/contracts';
import { brokerParkedActions, type FetchLike, HermesRuntimeAdapter } from './adapter.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const ATTEMPT = `att_${SUFFIX}`;
const JOB = `job_${SUFFIX}`;
const ACTION = `act_${SUFFIX}`;

const bundle: AttemptBundle = {
  attempt: { id: ATTEMPT, job_id: JOB, epoch: 1, revision: 0, token: 'capability.jwt' },
  job: {
    title: 'Chase the lease renewal',
    objective: 'Get a signed renewal before the end of the month.',
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
  budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120_000, max_actions: 3 },
  model: { provider: 'custom', model: 'fake-scripted-v1', fallback: null },
};

const RECORDED = readFileSync(join(import.meta.dir, 'fixtures', 'run-events.sse'), 'utf8');

const capabilitiesBody = (durable = true) => ({
  object: 'hermes.api_server.capabilities',
  platform: 'hermes-agent',
  model: 'fake-scripted-v1',
  features: {
    run_submission: true,
    run_events_sse: true,
    run_stop: true,
    run_approval_response: true,
    runs_idempotency: { supported: true, durable, retention_seconds: 86_400 },
  },
});

class Collector {
  readonly events: RuntimeEvent[] = [];
  async emit(event: RuntimeEvent) {
    this.events.push(event);
  }
}

/** Serves the recorded stream in several chunks, so the parser is exercised. */
function streamOf(text: string, chunks = 5): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const size = Math.ceil(text.length / chunks);
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces.shift();
      if (piece === undefined) controller.close();
      else controller.enqueue(encoder.encode(piece));
    },
  });
}

type Call = { url: string; init?: RequestInit };

function harness(
  options: { sse?: string; durable?: boolean; startStatus?: number; eventsStatus?: number } = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/v1/capabilities') {
      return Response.json(capabilitiesBody(options.durable ?? true));
    }
    if (path === '/v1/runs' && init?.method === 'POST') {
      if (options.startStatus && options.startStatus >= 400) {
        return new Response('no', { status: options.startStatus });
      }
      return Response.json(
        { run_id: 'run_fixture_1', status: 'started', replayed: false },
        { status: 202 },
      );
    }
    if (path.endsWith('/events')) {
      if (options.eventsStatus && options.eventsStatus >= 400) {
        return new Response('gone', { status: options.eventsStatus });
      }
      return new Response(streamOf(options.sse ?? RECORDED), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({ ok: true });
  };
  return { calls, fetch };
}

const adapterWith = (fetch: FetchLike, parked: string[] | Error = []): HermesRuntimeAdapter =>
  new HermesRuntimeAdapter({
    baseUrl: 'http://runtime:8790',
    parkedActions: async () => {
      if (parked instanceof Error) throw parked;
      return parked;
    },
    fetch,
    streamIdleMs: 2_000,
  });

describe('capabilities', () => {
  test('reports what the engine says it supports', async () => {
    const { fetch } = harness();
    const capabilities = await adapterWith(fetch).capabilities();
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.interrupt).toBe(true);
    expect(capabilities.version).toContain('hermes@v2026.9.7');
  });

  test('refuses an engine whose run idempotency is not durable', async () => {
    const { fetch } = harness({ durable: false });
    // Without it a restart between the start request and its answer turns a
    // retry into a second run, which is a second set of effects.
    expect(adapterWith(fetch).capabilities()).rejects.toThrow(/durable run idempotency/);
  });
});

describe('lifecycle hook bridge', () => {
  const hook = (name: string, capture = 0, event = 'hook.event') => ({
    event,
    attempt_id: ATTEMPT,
    capture_id: `${ATTEMPT}:hook:${capture}`,
    name,
    tool_name: 'test.read',
    timing: { captured_at: '2026-09-12T00:00:00.000Z', duration_ms: 12 },
    outcome: event === 'hook.error' ? 'failed' : 'observed',
    redacted_args_digest: 'a'.repeat(64),
    ...(event === 'hook.error' ? { error_code: 'observer_failed' } : {}),
  });
  const frames = (...events: object[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

  test('ordered observations share the event sequencer and replayed captures consume no new id', async () => {
    const first = hook('on_session_start');
    const { fetch } = harness({
      sse: frames(
        first,
        first,
        hook('pre_tool_call', 1),
        hook('post_tool_call', 2),
        hook('on_compaction', 3),
        hook('on_session_end', 4),
        { event: 'run.completed', output: 'Done' },
      ),
    });
    const sink = new Collector();
    const outcome = await adapterWith(fetch).start(bundle, sink, new AbortController().signal);
    expect(outcome.kind).toBe('completed');
    expect(
      sink.events.filter((event) => event.type === 'hook_event').map((event) => event.name),
    ).toEqual([
      'on_session_start',
      'pre_tool_call',
      'post_tool_call',
      'on_compaction',
      'on_session_end',
    ]);
    expect(sink.events.map((event) => event.dedup_key)).toEqual(
      sink.events.map((_, seq) => `${ATTEMPT}:${seq}`),
    );
  });

  test('a throwing observer is a durable hook_error and the run still completes', async () => {
    const { fetch } = harness({
      sse: frames(hook('pre_tool_call', 0, 'hook.error'), {
        event: 'run.completed',
        output: 'Done',
      }),
    });
    const sink = new Collector();
    expect((await adapterWith(fetch).start(bundle, sink, new AbortController().signal)).kind).toBe(
      'completed',
    );
    expect(sink.events[1]?.type).toBe('hook_error');
    expect(sink.events[1]).toHaveProperty('error_code', 'observer_failed');
  });

  test('mismatched identity and changed replay bytes are gaps, never accepted observations', async () => {
    for (const sse of [
      frames({ ...hook('pre_tool_call'), attempt_id: 'att_someone_else' }),
      frames(hook('pre_tool_call'), { ...hook('pre_tool_call'), outcome: 'failed' }),
    ]) {
      const { fetch } = harness({ sse });
      const outcome = await adapterWith(fetch).start(
        bundle,
        new Collector(),
        new AbortController().signal,
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') expect(outcome.reason).toContain('transcript is incomplete');
    }
  });

  test("a compaction's allow-listed scalars reach the ledger and nothing beside them does", async () => {
    const { fetch } = harness({
      sse: frames(
        {
          ...hook('on_compaction'),
          outcome: 'succeeded',
          detail: { compression_count: 2, in_place: true },
        },
        { event: 'run.completed', output: 'Done' },
      ),
    });
    const sink = new Collector();
    expect((await adapterWith(fetch).start(bundle, sink, new AbortController().signal)).kind).toBe(
      'completed',
    );
    expect(sink.events.find((value) => value.type === 'hook_event')).toMatchObject({
      name: 'on_compaction',
      detail: { compression_count: 2, in_place: true },
    });
    // A detail field nobody declared is a gap, not a record with an extra key.
    const rejected = harness({
      sse: frames({
        ...hook('on_compaction'),
        detail: { compression_count: 2, session_id: 'ses_private' },
      }),
    });
    const outcome = await adapterWith(rejected.fetch).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('failed');
  });

  test('unrecognized fields never leave the adapter in a hook record', async () => {
    const { fetch } = harness({
      sse: frames(
        { ...hook('pre_tool_call'), args: { token: 'secret' }, error_message: 'private' },
        { event: 'run.completed', output: 'Done' },
      ),
    });
    const sink = new Collector();
    await adapterWith(fetch).start(bundle, sink, new AbortController().signal);
    expect(JSON.stringify(sink.events)).not.toContain('secret');
    expect(JSON.stringify(sink.events)).not.toContain('private');
  });
});

describe('a recorded run', () => {
  test("the owner's new message reaches the model once, and earlier context once", async () => {
    const { calls, fetch } = harness();
    const asked = {
      role: 'user' as const,
      content: 'Book the dentist for Tuesday.',
      at: '2026-09-23T09:00:00Z',
    };
    const earlier = {
      role: 'user' as const,
      content: 'I prefer mornings.',
      at: '2026-09-22T09:00:00Z',
    };
    const reply = {
      role: 'assistant' as const,
      content: 'Noted, mornings.',
      at: '2026-09-22T09:00:05Z',
    };
    await adapterWith(fetch).start(
      {
        ...bundle,
        transcript: [earlier, reply, asked],
        inputs: { ...bundle.inputs, new_user_messages: [asked] },
      },
      new Collector(),
      new AbortController().signal,
    );
    const started = calls.find(
      (call) => new URL(call.url).pathname === '/v1/runs' && call.init?.method === 'POST',
    );
    const input = String(JSON.parse(String(started?.init?.body)).input);
    const count = (text: string) => input.split(text).length - 1;
    expect(count(asked.content)).toBe(1);
    expect(count(earlier.content)).toBe(1);
    expect(count(reply.content)).toBe(1);
  });

  test('maps the stream to contract events in order', async () => {
    const { fetch } = harness();
    const sink = new Collector();
    const outcome = await adapterWith(fetch).start(bundle, sink, new AbortController().signal);

    expect(outcome).toEqual({
      kind: 'completed',
      summary: 'Asked the landlord for a signed date and parked the send for approval.',
      evidence: [],
    });
    expect(sink.events.map((e) => e.type)).toEqual([
      'turn_started',
      'tool_call_proposed',
      'tool_result',
      'text_delta',
      'text_delta',
      'tool_call_proposed',
      'tool_result',
      'attempt_outcome',
    ]);
  });

  test('every event carries the one dedup key format', async () => {
    const { fetch } = harness();
    const sink = new Collector();
    await adapterWith(fetch).start(bundle, sink, new AbortController().signal);

    sink.events.forEach((event, index) => {
      expect(event.attempt_id).toBe(ATTEMPT);
      expect(event.local_seq).toBe(index);
      expect(event.dedup_key).toBe(`${ATTEMPT}:${index}`);
    });
  });

  test('a tool result is paired with the call that opened it', async () => {
    const { fetch } = harness();
    const sink = new Collector();
    await adapterWith(fetch).start(bundle, sink, new AbortController().signal);

    const proposed = sink.events.filter((e) => e.type === 'tool_call_proposed');
    const results = sink.events.filter((e) => e.type === 'tool_result');
    expect(proposed.map((e) => (e as { call_id: string }).call_id)).toEqual(
      results.map((e) => (e as { call_id: string }).call_id),
    );
    expect(results.every((e) => (e as { ok: boolean }).ok)).toBe(true);
  });

  test('the start carries the attempt id as its idempotency key', async () => {
    const { calls, fetch } = harness();
    await adapterWith(fetch).start(bundle, new Collector(), new AbortController().signal);

    const start = calls.find((c) => c.init?.method === 'POST');
    const headers = start?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(ATTEMPT);
    expect(headers['X-Hermes-Session-Key']).toBe(JOB);
  });

  test('keepalive and close comments produce no events', async () => {
    const { fetch } = harness({ sse: ': keepalive\n\n: stream closed\n\n' });
    const sink = new Collector();
    await adapterWith(fetch).start(bundle, sink, new AbortController().signal);
    expect(
      sink.events.filter((e) => e.type !== 'turn_started' && e.type !== 'attempt_outcome'),
    ).toEqual([]);
  });
});

describe('the ledger has the last word', () => {
  test('a parked action turns a completion into waiting_for_approval', async () => {
    const { fetch } = harness();
    const sink = new Collector();
    const outcome = await adapterWith(fetch, [ACTION]).start(
      bundle,
      sink,
      new AbortController().signal,
    );

    expect(outcome).toEqual({ kind: 'waiting_for_approval', action_ids: [ACTION] });
    const requested = sink.events.find((e) => e.type === 'action_requested');
    expect(requested).toMatchObject({ action_id: ACTION, kind: 'approval' });
    // The recorded outcome is the settled one, not what the engine said.
    const last = sink.events.at(-1) as { type: string; outcome: { kind: string } };
    expect(last.outcome.kind).toBe('waiting_for_approval');
  });

  test('an unreadable ledger reports an unknown check without inventing failure', async () => {
    const { fetch } = harness();
    const outcome = await adapterWith(fetch, new Error('ledger down')).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: 'unknown_check',
      check: 'parked_actions',
      reason: 'unavailable',
    });
    expect((outcome as { message: string }).message).toContain('ledger down');
  });
});

describe('a go-ahead with nothing proposed', () => {
  const CONNECTION = `conn_${SUFFIX}`;
  const tools: AttemptBundle['tools'] = [
    {
      name: 'email.draft',
      description: 'Save a draft',
      input_schema: { type: 'object' },
      effect_class: 'write_reversible',
      connection_id: CONNECTION,
    },
    {
      name: 'email.send',
      description: 'Send a message',
      input_schema: { type: 'object' },
      effect_class: 'write_external',
      connection_id: CONNECTION,
    },
  ];
  const withTools = { ...bundle, tools };
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const run = (output: string, called: string[] = []) =>
    called
      .flatMap((tool) => [
        frame({ event: 'tool.started', tool, preview: '' }),
        frame({ event: 'tool.completed', tool, duration: 0.1, error: false }),
      ])
      .join('') + frame({ event: 'run.completed', output });

  /** One stream per run, and the parked ledger as it stands after each run. */
  function script(runs: string[], parkedAfter: string[][] = []) {
    const inputs: string[] = [];
    let started = 0;
    const fetch: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/runs' && init?.method === 'POST') {
        inputs.push((JSON.parse(String(init.body)) as { input: string }).input);
        started++;
        return Response.json({ run_id: `run_${started}`, status: 'started' }, { status: 202 });
      }
      if (path.endsWith('/events')) {
        const index = Number(path.split('/')[3]?.replace('run_', '')) - 1;
        return new Response(streamOf(runs[index] ?? ''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({ ok: true });
    };
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://runtime:8790',
      parkedActions: async () => parkedAfter[started - 1] ?? [],
      fetch,
      streamIdleMs: 2_000,
    });
    return { adapter, inputs };
  }

  test('a drafted reply that asks to send gets one continuation, and its proposal parks', async () => {
    const { adapter, inputs } = script(
      [
        run('I drafted the reply. Shall I send it?', ['email.draft']),
        run('The send is waiting for your approval.', ['email.send']),
      ],
      [[], [ACTION]],
    );
    const outcome = await adapter.start(withTools, new Collector(), new AbortController().signal);
    expect(outcome).toEqual({ kind: 'waiting_for_approval', action_ids: [ACTION] });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('proposed nothing');
    expect(inputs[1]).toContain('the broker will ask the owner');
  });

  test('an ask that still proposes nothing settles waiting for input, never completed', async () => {
    const { adapter, inputs } = script([
      run('Would you like me to send the confirmation now?'),
      run('Let me know if I should send it.'),
      run('unreachable'),
    ]);
    const outcome = await adapter.start(withTools, new Collector(), new AbortController().signal);
    expect(outcome).toEqual({
      kind: 'waiting_for_input',
      question: 'Let me know if I should send it.',
    });
    // Exactly one continuation: the third scripted run is never started.
    expect(inputs).toHaveLength(2);
  });

  test('an effect the owner refused in this wake is not asked for again', async () => {
    const refused: AttemptBundle = {
      ...withTools,
      inputs: {
        ...withTools.inputs,
        approval_results: [{ action_id: ACTION, decision: 'denied', note: null }],
      },
    };
    const reply = "I won't send it. Let me know if you'd like me to send a shorter version.";
    const { adapter, inputs } = script([run(reply), run('unreachable')]);
    const outcome = await adapter.start(refused, new Collector(), new AbortController().signal);
    // The reply is still a question, so the job asks it. What must not happen is
    // answering a refusal with "call the tool now" and proposing again on our word.
    expect(outcome).toEqual({ kind: 'waiting_for_input', question: reply });
    expect(inputs).toHaveLength(1);
  });

  test('a finished send, a closing offer or a plain question completes in one run', async () => {
    for (const [output, called] of [
      ['I sent the reply.', ['email.send']],
      ['Done. Let me know if you need anything else.', []],
      ['Which address should I use, work or personal?', []],
      ["I can't send mail from here, so nothing was sent.", []],
    ] as const) {
      const { adapter, inputs } = script([run(output, [...called])]);
      const outcome = await adapter.start(withTools, new Collector(), new AbortController().signal);
      expect(outcome).toEqual({ kind: 'completed', summary: output, evidence: [] });
      expect(inputs).toHaveLength(1);
    }
  });
});

describe('nothing becomes a completion that was not one', () => {
  test('an interrupted run fails retryably and says history is missing', async () => {
    const sse =
      'data: {"event":"message.delta","delta":"half a "}\n\n' +
      'data: {"event":"run.interrupted","run_id":"run_fixture_1"}\n\n';
    const { fetch } = harness({ sse });
    const sink = new Collector();
    const outcome = await adapterWith(fetch).start(bundle, sink, new AbortController().signal);

    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    expect((outcome as { reason: string }).reason).toContain('interrupted');
    expect((outcome as { reason: string }).reason).toContain('transcript is incomplete');
  });

  test('a stream that stops without a terminal frame is a gap, not a success', async () => {
    const { fetch } = harness({ sse: 'data: {"event":"message.delta","delta":"only this"}\n\n' });
    const outcome = await adapterWith(fetch).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    expect((outcome as { reason: string }).reason).toContain('before the run reported an outcome');
  });

  test('a failed run keeps the engine reason', async () => {
    const { fetch } = harness({
      sse: 'data: {"event":"run.failed","error":"provider refused the request"}\n\n',
    });
    const outcome = await adapterWith(fetch).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'provider refused the request',
      retryable: true,
    });
  });

  test('a start the engine refused never opens a stream', async () => {
    const { calls, fetch } = harness({ startStatus: 503 });
    const outcome = await adapterWith(fetch).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    expect(calls.some((c) => c.url.endsWith('/events'))).toBe(false);
  });

  test('an events route that refuses is a gap', async () => {
    const { fetch } = harness({ eventsStatus: 404 });
    const outcome = await adapterWith(fetch).start(
      bundle,
      new Collector(),
      new AbortController().signal,
    );
    expect((outcome as { reason: string }).reason).toContain('answered 404');
  });
});

describe('control', () => {
  test('an abort stops the run on the engine', async () => {
    const controller = new AbortController();
    const { calls, fetch } = harness({
      sse: 'data: {"event":"run.completed","output":"done"}\n\n',
    });
    const adapter = adapterWith(fetch);
    const started = adapter.start(bundle, new Collector(), controller.signal);
    controller.abort();
    await started;
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(true);
  });

  test('a shell-command approval is denied, never allowed for the session', async () => {
    const { calls, fetch } = harness({
      sse:
        'data: {"event":"approval.request","request_id":"req_9","command":"rm -rf /work","allow_session":true}\n\n' +
        'data: {"event":"run.completed","output":"stopped"}\n\n',
    });
    await adapterWith(fetch).start(bundle, new Collector(), new AbortController().signal);

    const approval = calls.find((c) => c.url.endsWith('/approval'));
    expect(approval).toBeDefined();
    expect(JSON.parse(String(approval?.init?.body))).toEqual({
      request_id: 'req_9',
      choice: 'deny',
    });
  });
});

describe('the default ledger lookup', () => {
  test('asks for this job and keeps only this attempt', async () => {
    const calls: string[] = [];
    const lookup = brokerParkedActions({
      brokerUrl: 'http://melete:3112/',
      serviceKey: 'service-key',
      spaceId: `spc_${SUFFIX}`,
      fetch: async (url) => {
        calls.push(url);
        return Response.json({
          actions: [
            { id: ACTION, attempt_id: ATTEMPT },
            { id: 'act_from_an_older_attempt', attempt_id: 'att_older' },
          ],
        });
      },
    });

    expect(await lookup(bundle)).toEqual([ACTION]);
    expect(calls[0]).toContain(`job_id=${JOB}`);
    expect(calls[0]).toContain('status=needs_approval');
  });

  test('a refusal raises rather than reporting nothing parked', async () => {
    const lookup = brokerParkedActions({
      brokerUrl: 'http://melete:3112',
      serviceKey: 'service-key',
      spaceId: `spc_${SUFFIX}`,
      fetch: async () => new Response('no', { status: 401 }),
    });
    expect(lookup(bundle)).rejects.toThrow(/answered 401/);
  });
});

test('the actual Hermes run request carries the since-last receipt and pending question', async () => {
  const requests: Array<{ input: string; instructions: string }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 3190,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/runs' && request.method === 'POST') {
        requests.push((await request.json()) as { input: string; instructions: string });
        return Response.json({ run_id: 'run_delta', status: 'started' }, { status: 202 });
      }
      if (path === '/v1/runs/run_delta/events') {
        return new Response(RECORDED, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  try {
    const adapter = new HermesRuntimeAdapter({
      baseUrl: server.url.toString(),
      parkedActions: async () => [],
    });
    const outcome = await adapter.start(
      {
        ...bundle,
        since_last: {
          ...EMPTY_SINCE_LAST,
          attempt_id: ATTEMPT,
          actions: [
            {
              action_id: ACTION,
              kind: 'email.send',
              status: 'succeeded',
              receipt_ref: 'receipt-marker-delta@example.test',
              at: '2026-09-11T10:00:00Z',
            },
          ],
          pending_questions: [
            { id: 'qst_delta', text: 'Which recording should I use?', state: 'asked' },
          ],
        },
      },
      new Collector(),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toContain('receipt receipt-marker-delta@example.test');
    expect(requests[0]?.input).toContain('question asked: Which recording should I use?');
  } finally {
    await server.stop(true);
  }
});
