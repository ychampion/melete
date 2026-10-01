import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import {
  CONTAINER_ATTEMPT_KEYS,
  type DockerApi,
  DockerError,
  DockerHermesRuntimeAdapter,
  SPARE_HANDOFF_PATH,
} from './docker.ts';

const imageId = `sha256:${'a'.repeat(64)}`;
const identity = (prefix: string, index = 0) => `${prefix}_01J0000000000000000000000${index}`;

function bundle(index = 0, model = 'scripted'): AttemptBundle {
  return {
    attempt: {
      id: identity('att', index),
      job_id: identity('job', index),
      epoch: 1,
      revision: 0,
      token: `capability-of-attempt-${index}`,
    },
    job: {
      title: 'Answer',
      objective: 'Answer the message',
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
    model: { provider: 'fake', model, fallback: null },
    time_zone: 'Europe/Paris',
  };
}

type Config = {
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    NetworkMode: string;
    Mounts: Array<{ Target: string; VolumeOptions?: { Subpath: string } }>;
  };
};
type Container = {
  id: string;
  name: string;
  config: Config;
  address: string;
  startedAt?: number;
  handedAt?: number;
  handoff?: { cwd: string; env: Record<string, string> };
  removed?: boolean;
  exitCode?: number;
};

/**
 * Docker and the engines it runs. An engine takes `bootMs` from its start to
 * load, and `serveMs` more to serve once it has its attempt: a spare loads on
 * its own and answers its handoff path once loaded; any other engine serves
 * after both.
 */
class Engines implements DockerApi {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  containers: Container[] = [];
  runsAt: number[] = [];
  stale: Array<{ Id: string; Names: string[]; Labels: Record<string, string> }> = [];
  /** A spare that exits with this status instead of loading. */
  spareExit?: number;
  constructor(
    readonly bootMs: number,
    readonly serveMs: number,
  ) {}

  private find(id: string) {
    const container = this.containers.find((entry) => entry.id === id);
    if (!container) throw new DockerError(404, 'GET', `/containers/${id}`);
    return container;
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    this.calls.push({ method, path, body });
    if (path === '/containers/self/json')
      return {
        Id: 'self',
        Config: {
          Labels: {
            'com.docker.compose.project': 'test-melete',
            'com.docker.compose.service': 'melete',
          },
        },
      };
    if (path.startsWith('/images/'))
      return {
        Id: imageId,
        Config: {
          Labels: {
            'com.melete.hermes.commit': HERMES_PINNED_COMMIT,
            'com.melete.plugin.sha256': 'b'.repeat(64),
          },
        },
      };
    if (path.startsWith('/containers/json?')) return this.stale;
    if (path.startsWith('/networks?')) return [];
    if (path.startsWith('/volumes?')) return { Volumes: [] };
    if (path === '/networks/create') return { Id: (body as { Name: string }).Name };
    if (path === '/volumes/create') return body;
    if (path.startsWith('/containers/create?')) {
      const config = body as Config;
      const container: Container = {
        id: `cell-${this.containers.length}`,
        name: decodeURIComponent(path.split('name=')[1] ?? ''),
        config,
        address: `172.30.0.${this.containers.length + 2}`,
      };
      this.containers.push(container);
      return { Id: container.id };
    }
    const [, kind, id, action] = path.split('?')[0]?.split('/') ?? [];
    if (kind === 'containers' && id && action === 'start') {
      const container = this.find(id);
      container.startedAt = Date.now();
      if (this.spareExit !== undefined && container.config.Env.includes('MELETE_RUNTIME_SPARE=1'))
        container.exitCode = this.spareExit;
      return null;
    }
    if (kind === 'containers' && id && action === 'json') {
      const container = this.find(id);
      return {
        Id: container.id,
        Config: { Labels: container.config.Labels },
        NetworkSettings: {
          Networks: { [container.config.HostConfig.NetworkMode]: { IPAddress: container.address } },
        },
        State:
          container.exitCode === undefined
            ? { Status: 'running' }
            : { Status: 'exited', ExitCode: container.exitCode },
      };
    }
    if (kind === 'containers' && id && method === 'DELETE') {
      const container = this.containers.find((entry) => entry.id === id);
      if (container) container.removed = true;
      return null;
    }
    if (method !== 'GET') return null;
    throw new Error(`Unexpected daemon call ${method} ${path}`);
  }

  /** The engines' own HTTP, by the address each container was given. */
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const container = this.containers.find((entry) => entry.address === target.hostname);
    if (!container?.startedAt || container.removed || container.exitCode !== undefined)
      throw new Error('connection refused');
    const now = Date.now();
    const spare = container.config.Env.includes('MELETE_RUNTIME_SPARE=1');
    const loaded = now >= container.startedAt + this.bootMs;
    const key = container.config.Env.find((entry) => entry.startsWith('API_SERVER_KEY='))?.slice(
      'API_SERVER_KEY='.length,
    );
    const authorised =
      new Headers(init?.headers).get('authorization') === `Bearer ${key ?? 'missing'}`;
    if (spare && container.handedAt === undefined) {
      if (!loaded) throw new Error('connection refused');
      if (target.pathname !== SPARE_HANDOFF_PATH) return new Response(null, { status: 404 });
      if (!authorised) return new Response(null, { status: 401 });
      if (init?.method === 'POST') {
        container.handoff = JSON.parse(String(init.body));
        container.handedAt = now;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 200 });
    }
    const serving = spare
      ? now >= (container.handedAt ?? Number.POSITIVE_INFINITY) + this.serveMs
      : loaded && now >= container.startedAt + this.bootMs + this.serveMs;
    if (!serving) throw new Error('connection refused');
    if (target.pathname === '/v1/capabilities')
      return Response.json({ features: { runs_idempotency: { supported: true, durable: true } } });
    if (target.pathname === '/v1/runs') {
      this.runsAt.push(now);
      return Response.json({ run_id: 'run-1', status: 'queued' });
    }
    if (target.pathname.endsWith('/events'))
      return new Response(
        'event: run.completed\ndata: {"event":"run.completed","output":"Done"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    return Response.json({});
  };

  spares() {
    return this.containers.filter((entry) => entry.config.Env.includes('MELETE_RUNTIME_SPARE=1'));
  }
}

const fixtures: Array<{ root: string; runtime: DockerHermesRuntimeAdapter }> = [];
async function setup(options: { spares?: number; bootMs?: number; serveMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'melete-spare-test-'));
  const engines = new Engines(options.bootMs ?? 300, options.serveMs ?? 20);
  const runtime = new DockerHermesRuntimeAdapter({
    project: 'test-melete',
    image: 'melete-runtime:local',
    socket: '/unused.sock',
    workRoot: root,
    workVolume: 'test-melete_work',
    probeUrl: 'http://probe:8790',
    probeKey: 'x'.repeat(64),
    selfId: 'self',
    docker: engines,
    startTimeoutMs: 5000,
    spares: options.spares ?? 1,
    parkedActions: async () => [],
    fetch: (input, init) => engines.fetch(String(input), init),
  });
  fixtures.push({ root, runtime });
  return { root, engines, runtime, sink: { emit: async () => {} } };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not reached');
    await Bun.sleep(5);
  }
}

/** Time from an attempt's start to the engine's first run, which is when the model is first called. */
async function timeToFirstRun(
  f: Awaited<ReturnType<typeof setup>>,
  attempt: AttemptBundle,
): Promise<number> {
  const before = f.engines.runsAt.length;
  const started = Date.now();
  const outcome = await f.runtime.start(attempt, f.sink, new AbortController().signal);
  expect(outcome.kind).toBe('completed');
  return (f.engines.runsAt[before] ?? Number.POSITIVE_INFINITY) - started;
}

describe('Docker spare engines', () => {
  test("a loaded spare takes the attempt's first model call from the engine's start to its handoff", async () => {
    const cold = await setup({ spares: 0, bootMs: 600 });
    await cold.runtime.initialize();
    const coldMs = await timeToFirstRun(cold, bundle(0));
    const warm = await setup({ spares: 1, bootMs: 600 });
    await warm.runtime.initialize();
    warm.runtime.warm(bundle().model);
    // The spare loads while nothing waits for it.
    await until(() => warm.engines.calls.some((call) => call.path.endsWith('/start')));
    await Bun.sleep(700);
    const warmMs = await timeToFirstRun(warm, bundle(1));
    process.stdout.write(
      `engine start to first run: cold ${coldMs} ms, spare ${warmMs} ms (boot 600 ms)\n`,
    );
    expect(coldMs).toBeGreaterThanOrEqual(600);
    expect(warmMs).toBeLessThan(coldMs / 3);
  });

  test("a spare is started with nothing of an attempt and handed exactly the attempt's values", async () => {
    const f = await setup();
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await until(() => f.engines.spares().length === 1);
    const [spare] = f.engines.spares();
    if (!spare) throw new Error('No spare');
    const environment = spare.config.Env.join('\n');
    expect(environment).not.toContain('capability-of-attempt');
    for (const key of CONTAINER_ATTEMPT_KEYS) expect(environment).not.toContain(`${key}=`);
    expect(spare.config.Env).toContain(
      `MELETE_RUNTIME_SPARE_KEYS=${CONTAINER_ATTEMPT_KEYS.join(',')}`,
    );
    expect(spare.config.Env).toContain('MELETE_MODEL_PROVIDER=fake');
    expect(Object.keys(spare.config.Labels).sort()).toEqual([
      'com.melete.attempt-supervisor',
      'com.melete.project',
      'com.melete.spare',
    ]);
    const mount = spare.config.HostConfig.Mounts.find((entry) => entry.Target === '/work');
    expect(mount?.VolumeOptions?.Subpath).toMatch(/^\.spare-[a-f0-9]{24}$/);
    await Bun.sleep(400);
    await f.runtime.start(bundle(0), f.sink, new AbortController().signal);
    expect(spare.handoff).toEqual({
      cwd: '/work',
      env: {
        MELETE_ATTEMPT_TOKEN: 'capability-of-attempt-0',
        MELETE_ATTEMPT_ID: identity('att', 0),
        MELETE_JOB_ID: identity('job', 0),
        MELETE_MODEL_KEY: `melete-surrogate-${identity('att', 0)}`,
        HERMES_TIMEZONE: 'Europe/Paris',
      },
    });
    // The attempt's container is the spare; no other engine was started for it.
    expect(
      f.engines.containers.filter((entry) => !entry.config.Env.includes('MELETE_RUNTIME_SPARE=1')),
    ).toEqual([]);
    expect(spare.removed).toBe(true);
  });

  test("the spare's directory becomes the job's workspace with what the job already had", async () => {
    const f = await setup();
    await f.runtime.initialize();
    const job = join(f.root, identity('job', 0));
    await mkdir(join(job, 'notes'), { recursive: true });
    await writeFile(join(job, 'notes', 'draft.md'), 'kept');
    await writeFile(join(job, 'report.txt'), 'also kept');
    f.runtime.warm(bundle().model);
    await until(() => f.engines.spares().length === 1);
    const subpath =
      f.engines.spares()[0]?.config.HostConfig.Mounts[0]?.VolumeOptions?.Subpath ?? '';
    // Something the engine left in its own directory while it loaded.
    await writeFile(join(f.root, subpath, 'spare-scratch'), 'x');
    await Bun.sleep(400);
    await f.runtime.start(bundle(0), f.sink, new AbortController().signal);
    expect(await readFile(join(job, 'notes', 'draft.md'), 'utf8')).toBe('kept');
    expect(await readFile(join(job, 'report.txt'), 'utf8')).toBe('also kept');
    const entries = await readdir(f.root);
    expect(entries).not.toContain(subpath);
    expect(entries.filter((entry) => entry.startsWith('.adopt-'))).toEqual([]);
  });

  test('a new job takes the spare directory whole', async () => {
    const f = await setup();
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await Bun.sleep(400);
    await f.runtime.start(bundle(3), f.sink, new AbortController().signal);
    expect((await readdir(f.root)).sort()).toContain(identity('job', 3));
  });

  test('no container serves two attempts, and a spare is ready again for the next', async () => {
    const f = await setup();
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await Bun.sleep(400);
    await f.runtime.start(bundle(0), f.sink, new AbortController().signal);
    await Bun.sleep(400);
    await f.runtime.start(bundle(1), f.sink, new AbortController().signal);
    const handed = f.engines.containers.filter((entry) => entry.handoff);
    expect(handed).toHaveLength(2);
    expect(new Set(handed.map((entry) => entry.id)).size).toBe(2);
    expect(handed.map((entry) => entry.handoff?.env.MELETE_ATTEMPT_ID)).toEqual([
      identity('att', 0),
      identity('att', 1),
    ]);
    expect(handed.every((entry) => entry.removed)).toBe(true);
    // A third spare is loading for the next attempt.
    expect(f.engines.spares().filter((entry) => !entry.removed)).toHaveLength(1);
  });

  test('an attempt for another model starts its own engine, and the spare follows it', async () => {
    const f = await setup();
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await Bun.sleep(400);
    const [first] = f.engines.spares();
    await f.runtime.start(bundle(0, 'other-model'), f.sink, new AbortController().signal);
    expect(first?.handoff).toBeUndefined();
    await until(() => first?.removed === true);
    const own = f.engines.containers.find(
      (entry) => !entry.config.Env.includes('MELETE_RUNTIME_SPARE=1'),
    );
    expect(own?.config.Env).toContain('MELETE_ATTEMPT_TOKEN=capability-of-attempt-0');
    const next = f.engines.spares().find((entry) => !entry.removed);
    expect(next?.config.Env).toContain('MELETE_MODEL_NAME=other-model');
  });

  test('a spare that read its attempt while loading turns spares off', async () => {
    const f = await setup();
    f.engines.spareExit = 3;
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await until(() => f.engines.spares()[0]?.removed === true);
    await f.runtime.start(bundle(0), f.sink, new AbortController().signal);
    await f.runtime.start(bundle(1), f.sink, new AbortController().signal);
    expect(f.engines.spares()).toHaveLength(1);
    expect(f.engines.containers).toHaveLength(3);
  });

  test('shutdown removes a spare and its directory, loaded or not', async () => {
    const f = await setup({ bootMs: 10_000 });
    await f.runtime.initialize();
    f.runtime.warm(bundle().model);
    await until(() => f.engines.spares().length === 1);
    await f.runtime.close();
    expect(f.engines.spares()[0]?.removed).toBe(true);
    const removed = f.engines.calls.filter((call) => call.method === 'DELETE');
    expect(removed.map((call) => call.path.split('/')[1])).toEqual([
      'containers',
      'networks',
      'volumes',
    ]);
    expect((await readdir(f.root)).filter((entry) => entry.startsWith('.spare-'))).toEqual([]);
  });

  test('startup with no workspace root yet has nothing to put back', async () => {
    const f = await setup();
    await rm(f.root, { recursive: true, force: true });
    await f.runtime.initialize();
    await mkdir(f.root);
  });

  test('startup puts back a workspace left set aside and removes spares left behind', async () => {
    const f = await setup();
    const id = 'c'.repeat(24);
    f.engines.stale = [
      {
        Id: 'old-spare',
        Names: [`/test-melete-spare-${id}`],
        Labels: {
          'com.melete.attempt-supervisor': 'v1',
          'com.melete.project': 'test-melete',
          'com.melete.spare': id,
        },
      },
    ];
    const job = identity('job', 0);
    // Stopped between the renames: the job's files set aside, the spare's directory in place.
    await mkdir(join(f.root, `.adopt-${job}`));
    await writeFile(join(f.root, `.adopt-${job}`, 'kept.txt'), 'kept');
    await mkdir(join(f.root, job));
    await mkdir(join(f.root, `.spare-${id}`));
    await f.runtime.initialize();
    expect(
      f.engines.calls.some(
        (call) => call.method === 'DELETE' && call.path.startsWith('/containers/old-spare'),
      ),
    ).toBe(true);
    expect(await readFile(join(f.root, job, 'kept.txt'), 'utf8')).toBe('kept');
    expect((await readdir(f.root)).sort()).toEqual([job]);
  });
});
