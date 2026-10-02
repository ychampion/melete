import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeEvent } from '@melete/contracts';
import type { CellHandle, CellHost, CellSpec } from './cell-host.ts';
import { DockerHermesRuntimeAdapter } from './docker.ts';

const attempt = 'att_01J00000000000000000000000';
const job = 'job_01J00000000000000000000000';

function bundle(): AttemptBundle {
  return {
    attempt: { id: attempt, job_id: job, epoch: 1, revision: 0, token: 'only-this-attempt' },
    job: {
      title: 'Send once',
      objective: 'Send the scripted message',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    since_last: EMPTY_SINCE_LAST,
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
    transcript: [],
    tools: [],
    skills: [],
    knowledge: [],
    workspace: { mount: '/work', files: [] },
    budget: { max_turns: 4, max_output_tokens: 1000, max_wall_ms: 10000, max_actions: 2 },
    model: { provider: 'fake', model: 'scripted', fallback: null },
  };
}

/** A host that records what the supervisor asks of it. */
class RecordingHost implements CellHost {
  readonly id = 'remote:test';
  steps: string[] = [];
  specs: CellSpec[] = [];
  failStart = false;

  async verify() {
    this.steps.push('verify');
    return { engine: 'test', imageId: `sha256:${'a'.repeat(64)}` };
  }

  async reconcile(scope: 'start' | 'stopped') {
    this.steps.push(`reconcile ${scope}`);
  }

  cell(spec: CellSpec): CellHandle {
    this.specs.push(spec);
    const name = 'attempt' in spec.cell ? spec.cell.attempt : spec.cell.spare;
    this.steps.push(`cell ${name}`);
    return {
      brokerPeer: 'gateway',
      start: async () => {
        this.steps.push('start');
        if (this.failStart) throw new Error('the engine refused the cell');
        return 'http://cell.test:8790';
      },
      state: async () => ({ status: 'running' }),
      adopt: async () => {},
      rename: async () => {},
      release: async () => {
        this.steps.push('release');
      },
    };
  }
}

function runtimeOn(host: CellHost, urls: string[]) {
  return new DockerHermesRuntimeAdapter({
    project: 'test-melete',
    image: 'melete-runtime:local',
    socket: '/unused.sock',
    workRoot: '/unused-work',
    workVolume: 'test-melete_work',
    probeUrl: 'http://probe:8790',
    probeKey: 'x'.repeat(64),
    startTimeoutMs: 2000,
    parkedActions: async () => [],
    host,
    fetch: async (url) => {
      urls.push(url);
      if (url.endsWith('/v1/capabilities'))
        return Response.json({
          features: { runs_idempotency: { supported: true, durable: true } },
        });
      if (url.endsWith('/v1/runs')) return Response.json({ run_id: 'run-1', status: 'queued' });
      if (url.endsWith('/events'))
        return new Response(
          'event: run.completed\ndata: {"event":"run.completed","output":"Done"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return Response.json({});
    },
  });
}

const sink = (events: RuntimeEvent[]) => ({
  emit: async (event: RuntimeEvent) => {
    events.push(event);
  },
});

test('an attempt runs on the cell host it is given, and its cell is released when it ends', async () => {
  const host = new RecordingHost();
  const urls: string[] = [];
  const runtime = runtimeOn(host, urls);
  const outcome = await runtime.start(bundle(), sink([]), new AbortController().signal);
  await runtime.close();
  expect(outcome.kind).toBe('completed');
  expect(host.steps).toEqual(['verify', 'reconcile start', `cell ${attempt}`, 'start', 'release']);
  expect(host.specs[0]?.cell).toEqual({ attempt, job });
  expect(host.specs[0]?.environment).toContain(`MELETE_ATTEMPT_ID=${attempt}`);
  expect(host.specs[0]?.environment).toContain(`MELETE_JOB_ID=${job}`);
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((url) => url.startsWith('http://cell.test:8790/'))).toBe(true);
});

test('a cell that fails to start is released, and the attempt fails', async () => {
  const host = new RecordingHost();
  host.failStart = true;
  const runtime = runtimeOn(host, []);
  await expect(runtime.start(bundle(), sink([]), new AbortController().signal)).rejects.toThrow(
    'the engine refused the cell',
  );
  await runtime.close();
  expect(host.steps).toEqual(['verify', 'reconcile start', `cell ${attempt}`, 'start', 'release']);
});

test('removing stopped instances reconciles the cell host', async () => {
  const host = new RecordingHost();
  const runtime = runtimeOn(host, []);
  await runtime.removeStopped();
  await runtime.close();
  expect(host.steps).toEqual(['verify', 'reconcile start', 'reconcile stopped']);
});
