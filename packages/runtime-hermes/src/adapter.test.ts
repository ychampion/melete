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

describe('a recorded run', () => {
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
              receipt_ref: 'receipt-marker-w9-delta@example.test',
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
    expect(requests[0]?.input).toContain('receipt receipt-marker-w9-delta@example.test');
    expect(requests[0]?.input).toContain('question asked: Which recording should I use?');
  } finally {
    await server.stop(true);
  }
});
