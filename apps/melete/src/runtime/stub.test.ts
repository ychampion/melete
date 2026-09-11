import { describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  type AttemptOutcome,
  type RuntimeEvent,
  runtimeEvent,
} from '@melete/contracts';
import { StubRuntimeAdapter, StubRuntimeCrash, type StubScript } from './stub.ts';

const at = '2026-09-11T08:00:00.000Z';
const completed: AttemptOutcome = { kind: 'completed', summary: 'Finished.', evidence: [] };

function makeBundle(script: StubScript = { script: [] }, epoch = 1): AttemptBundle {
  return {
    attempt: {
      id: 'att_01J00000000000000000000000',
      job_id: 'job_01J00000000000000000000000',
      epoch,
      revision: 0,
      token: 'test-token',
    },
    job: {
      title: 'Stub job',
      objective: 'Exercise a disposable attempt.',
      constraints: { notes: JSON.stringify(script) },
      progress_summary: '',
      unresolved_questions: [],
      deliverable: { kind: 'none' },
    },
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [] },
    transcript: [],
    tools: [],
    skills: [],
    knowledge: [],
    workspace: { mount: '/work', files: [] },
    budget: { max_turns: 5, max_output_tokens: 1000, max_wall_ms: 1000, max_actions: 3 },
    model: { provider: 'scripted', model: 'stub', fallback: null },
  };
}

function recordEvents(): { events: RuntimeEvent[]; emit: (event: RuntimeEvent) => Promise<void> } {
  const events: RuntimeEvent[] = [];
  return {
    events,
    emit: async (event) => {
      events.push(runtimeEvent.parse(event));
    },
  };
}

function gate(): { pending: Promise<void>; release: () => void } {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

describe('scripted stub runtime', () => {
  const outcomes: AttemptOutcome[] = [
    completed,
    { kind: 'waiting_for_input', question: 'Which file?', draft: 'A draft.' },
    { kind: 'waiting_for_approval', action_ids: ['act_01J00000000000000000000000'] },
    { kind: 'waiting_for_event_or_time', wait: { kind: 'timer', wake_at: at } },
    { kind: 'failed', reason: 'Scripted failure.', retryable: true },
    { kind: 'budget_exhausted', summary: 'The budget is used.' },
  ];

  test.each(outcomes)('returns and emits frozen outcome %j', async (outcome) => {
    const sink = recordEvents();
    const actual = await new StubRuntimeAdapter().start(
      makeBundle({ script: [{ type: 'outcome', outcome }] }),
      sink,
      new AbortController().signal,
    );
    expect(actual).toEqual(outcome);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ type: 'attempt_outcome', outcome });
  });

  test('supports direct internal scripts and does not treat ordinary notes as a script', async () => {
    const bundle = makeBundle();
    bundle.job.constraints = { script: [{ type: 'outcome', outcome: completed }] };
    const runtime = new StubRuntimeAdapter();
    expect(await runtime.start(bundle, recordEvents(), new AbortController().signal)).toEqual(
      completed,
    );
    bundle.job.constraints = { notes: 'Keep the answer brief.' };
    expect((await runtime.start(bundle, recordEvents(), new AbortController().signal)).kind).toBe(
      'completed',
    );
    expect(await runtime.capabilities()).toEqual({
      streaming: true,
      tools: true,
      interrupt: true,
      version: 'stub/1',
    });
  });

  test('streams schema-valid text and tool events with monotonically increasing dedup keys', async () => {
    const sink = recordEvents();
    const effects: string[] = [];
    const bundle = makeBundle({
      script: [
        { type: 'turn_started', turn: 0 },
        { type: 'text_delta', text: 'Checking.' },
        { type: 'tool', tool: 'test.echo', call_id: 'call-1', arguments: { value: 'hello' } },
        {
          type: 'action_requested',
          action_id: 'act_01J00000000000000000000000',
          kind: 'test.echo',
        },
        { type: 'outcome', outcome: completed },
      ],
    });
    const runtime = new StubRuntimeAdapter({
      onTool: (callId, args) => {
        effects.push(callId);
        return { echoed: args.value ?? null };
      },
    });
    await runtime.start(bundle, sink, new AbortController().signal);
    expect(effects).toEqual(['call-1']);
    expect(sink.events.map((event) => event.type)).toEqual([
      'turn_started',
      'text_delta',
      'tool_call_proposed',
      'tool_result',
      'action_requested',
      'attempt_outcome',
    ]);
    expect(sink.events[3]).toMatchObject({ result: { echoed: 'hello' }, ok: true });
    for (const [index, event] of sink.events.entries()) {
      expect(event.local_seq).toBe(index);
      expect(event.dedup_key).toBe(`${bundle.attempt.id}:${index}`);
    }
  });

  test('waits for the sink to persist a proposal before running a fake effect', async () => {
    const persisted = gate();
    const proposed = gate();
    let effects = 0;
    const runtime = new StubRuntimeAdapter({
      onTool: () => {
        effects++;
        return {};
      },
    });
    const pending = runtime.start(
      makeBundle({ script: [{ type: 'tool', tool: 'test.echo', call_id: 'call-1' }] }),
      {
        emit: async (event) => {
          if (event.type === 'tool_call_proposed') {
            proposed.release();
            await persisted.pending;
          }
        },
      },
      new AbortController().signal,
    );
    await proposed.pending;
    expect(effects).toBe(0);
    persisted.release();
    await pending;
    expect(effects).toBe(1);
  });

  test('crashes mid-stream without fabricating an outcome, then skips the first-epoch crash', async () => {
    const script: StubScript = {
      script: [
        { type: 'text_delta', text: 'Partial.', epoch: 1 },
        { type: 'crash', message: 'process killed', epoch: 1 },
        { type: 'outcome', outcome: completed, epoch: [2, 3] },
      ],
    };
    const sink = recordEvents();
    await expect(
      new StubRuntimeAdapter().start(makeBundle(script), sink, new AbortController().signal),
    ).rejects.toBeInstanceOf(StubRuntimeCrash);
    expect(sink.events.map((event) => event.type)).toEqual(['text_delta']);
    expect(
      await new StubRuntimeAdapter().start(
        makeBundle(script, 2),
        recordEvents(),
        new AbortController().signal,
      ),
    ).toEqual(completed);
  });

  test('resumes from durable tool transcript after a crash without repeating a completed effect', async () => {
    const script: StubScript = {
      script: [
        { type: 'tool', tool: 'test.write', call_id: 'stable-call', result: { saved: true } },
        { type: 'crash', epoch: 1 },
        { type: 'outcome', outcome: completed },
      ],
    };
    let effects = 0;
    const onTool = () => {
      effects++;
      return { saved: true };
    };
    const before = recordEvents();
    await expect(
      new StubRuntimeAdapter({ onTool }).start(
        makeBundle(script),
        before,
        new AbortController().signal,
      ),
    ).rejects.toThrow(StubRuntimeCrash);
    const result = before.events.find((event) => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    const resumed = makeBundle(script, 2);
    resumed.transcript = [
      { role: 'tool', tool_call_id: 'stable-call', content: '{"saved":true}', at },
    ];
    const after = recordEvents();
    await new StubRuntimeAdapter({ onTool }).start(resumed, after, new AbortController().signal);
    expect(effects).toBe(1);
    expect(after.events.map((event) => event.type)).toEqual(['attempt_outcome']);
  });

  test('a proposed call without a durable result is not mistaken for completed work', async () => {
    const bundle = makeBundle({ script: [{ type: 'tool', tool: 'test.read', call_id: 'call-1' }] });
    bundle.transcript = [{ role: 'assistant', tool_call_id: 'call-1', content: 'Read it.', at }];
    let effects = 0;
    await new StubRuntimeAdapter({
      onTool: () => {
        effects++;
        return {};
      },
    }).start(bundle, recordEvents(), new AbortController().signal);
    expect(effects).toBe(1);
  });

  test('a slow attempt is interrupted promptly by cancellation', async () => {
    const controller = new AbortController();
    const pending = new StubRuntimeAdapter().start(
      makeBundle({ script: [{ type: 'sleep', ms: 60_000 }] }),
      recordEvents(),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a named stall can ignore cancellation and resume for stale-outcome verification', async () => {
    const held = gate();
    const started = gate();
    const controller = new AbortController();
    const runtime = new StubRuntimeAdapter({
      onStall: async (key, bundle) => {
        expect(key).toBe('A');
        expect(bundle.attempt.epoch).toBe(1);
        started.release();
        await held.pending;
      },
    });
    const sink = recordEvents();
    const pending = runtime.start(
      makeBundle({
        ignore_abort: true,
        script: [
          { type: 'stall', key: 'A' },
          { type: 'tool', tool: 'test.late', call_id: 'late-call', result: { late: true } },
          { type: 'outcome', outcome: completed },
        ],
      }),
      sink,
      controller.signal,
    );
    await started.pending;
    controller.abort();
    expect(sink.events).toHaveLength(0);
    held.release();
    expect(await pending).toEqual(completed);
    expect(sink.events.find((event) => event.type === 'tool_result')).toMatchObject({
      result: { late: true },
    });
  });

  test('records a completed fake effect even when cancellation arrives during it', async () => {
    const controller = new AbortController();
    const sink = recordEvents();
    const runtime = new StubRuntimeAdapter({
      onTool: () => {
        controller.abort();
        return { saved: true };
      },
    });
    await expect(
      runtime.start(
        makeBundle({ script: [{ type: 'tool', tool: 'test.write', call_id: 'call-1' }] }),
        sink,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.events.map((event) => event.type)).toEqual(['tool_call_proposed', 'tool_result']);
  });

  test('fails on invalid scripts before producing events', async () => {
    const bundle = makeBundle();
    bundle.job.constraints = { notes: '{"script":[{"type":"unknown"}]}' };
    const sink = recordEvents();
    await expect(
      new StubRuntimeAdapter().start(bundle, sink, new AbortController().signal),
    ).rejects.toThrow();
    expect(sink.events).toHaveLength(0);
  });
});
