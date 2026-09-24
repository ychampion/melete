import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import type { MemorySql } from '../memory/db.ts';
import { SupervisedHermesRuntime } from './hermes.ts';

test('an oversized assembled prompt is refused before launching an engine', async () => {
  let launched = false;
  const runtime = new SupervisedHermesRuntime(
    {
      kind: 'process',
      launch: async () => {
        launched = true;
        throw new Error('must not launch');
      },
      close: async () => {},
    },
    (() => {
      throw new Error('must not query');
    }) as unknown as MemorySql,
  );
  const bundle = {
    job: {
      title: 'Too large',
      objective: 'x'.repeat(128000),
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
    },
    since_last: EMPTY_SINCE_LAST,
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
    transcript: [],
    skills: [],
    knowledge: [],
    tools: [],
    workspace: { mount: '/work' },
    model: { model: 'scripted' },
    budget: { max_output_tokens: 8000, max_turns: 8, max_actions: 3 },
  } as unknown as AttemptBundle;
  const outcome = await runtime.start(
    bundle,
    { emit: async () => {} },
    new AbortController().signal,
  );
  expect(outcome).toMatchObject({
    kind: 'budget_exhausted',
    summary: expect.stringContaining('input_context_exceeded'),
  });
  expect(launched).toBe(false);
});

test('an engine that fails to stop after completing keeps the completed outcome', async () => {
  // A minimal engine: durable capabilities, one run, a stream that completes.
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Response.json({
          object: 'hermes.api_server.capabilities',
          platform: 'hermes-agent',
          model: 'fake-scripted-v1',
          features: {
            run_submission: true,
            run_events_sse: true,
            run_stop: true,
            run_approval_response: true,
            runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
          },
        });
      if (path === '/v1/runs' && request.method === 'POST')
        return Response.json(
          { run_id: 'run_fixture_1', status: 'started', replayed: false },
          { status: 202 },
        );
      if (path.endsWith('/events'))
        return new Response(
          `data: ${JSON.stringify({ event: 'run.completed', output: 'Done' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return Response.json({ ok: true });
    },
  });
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const runtime = new SupervisedHermesRuntime(
      {
        kind: 'process',
        launch: async () => ({
          baseUrl: `http://127.0.0.1:${server.port}`,
          token: 'engine-key',
          coldStartMs: 1,
          workspace: '/work',
          stop: async () => {
            throw new Error('Runtime process tree did not stop');
          },
        }),
        close: async () => {},
      },
      (async () => []) as unknown as MemorySql,
    );
    const outcome = await runtime.start(
      {
        attempt: {
          id: 'att_01J8ZP3QWABCDEFGHJKMNPQRST',
          job_id: 'job_01J8ZP3QWABCDEFGHJKMNPQRST',
          epoch: 1,
          revision: 0,
          token: 'capability.jwt',
        },
        job: {
          title: 'Small',
          objective: 'Finish',
          constraints: {},
          progress_summary: '',
          unresolved_questions: [],
          deliverable: {},
        },
        inputs: {
          new_user_messages: [],
          approval_results: [],
          trigger_events: [],
          repair_briefs: [],
        },
        since_last: EMPTY_SINCE_LAST,
        transcript: [],
        tools: [],
        skills: [],
        knowledge: [],
        workspace: { mount: '/work', files: [] },
        budget: { max_turns: 2, max_output_tokens: 4000, max_wall_ms: 10_000, max_actions: 0 },
        model: { provider: 'custom', model: 'fake-scripted-v1', fallback: null },
      } as unknown as AttemptBundle,
      { emit: async () => {} },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('completed');
    // The failure to stop is recorded, not dropped.
    expect(errors.join('')).toContain('Runtime process tree did not stop');
  } finally {
    process.stderr.write = write;
    server.stop(true);
  }
});

test("a job's output budget above the window does not stop an ordinary prompt from launching", async () => {
  // The whole budget is spent across the job's requests; none of them sets it
  // aside from the window, so a short prompt reaches the engine.
  const runtime = new SupervisedHermesRuntime(
    {
      kind: 'process',
      launch: async () => {
        throw new Error('launched');
      },
      close: async () => {},
    },
    (() => {
      throw new Error('must not query');
    }) as unknown as MemorySql,
  );
  const bundle = {
    job: {
      title: 'Long job',
      objective: 'Write the report.',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
    },
    since_last: EMPTY_SINCE_LAST,
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
    transcript: [],
    skills: [],
    knowledge: [],
    tools: [],
    workspace: { mount: '/work' },
    model: { model: 'scripted' },
    budget: { max_output_tokens: 250_000, max_turns: 8, max_actions: 3 },
  } as unknown as AttemptBundle;
  let failure: unknown;
  try {
    await runtime.start(bundle, { emit: async () => {} }, new AbortController().signal);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('launched');
});
