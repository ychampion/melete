import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptBundle,
  EMPTY_SINCE_LAST,
  type RuntimeEvent,
  type WaitSpec,
} from '@melete/contracts';
import { HERMES_PINNED_COMMIT } from '@melete/runtime-hermes';
import { type DockerApi, DockerError, DockerHermesRuntimeAdapter } from './docker.ts';

const imageId = `sha256:${'a'.repeat(64)}`;
const identity = (prefix: string, index = 0) => `${prefix}_01J0000000000000000000000${index}`;
const labels = (index = 0, project = 'test-melete') => ({
  'com.melete.attempt-supervisor': 'v1',
  'com.melete.project': project,
  'com.melete.attempt': identity('att', index),
  'com.melete.job': identity('job', index),
});

function bundle(index = 0): AttemptBundle {
  return {
    attempt: {
      id: identity('att', index),
      job_id: identity('job', index),
      epoch: 1,
      revision: 0,
      token: 'only-this-attempt',
    },
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

type Call = { method: string; path: string; body?: unknown };
type Created = {
  Image: string;
  Env: string[];
  HostConfig: {
    NetworkMode: string;
    Mounts: Array<{
      Type: string;
      Source: string;
      Target: string;
      VolumeOptions?: { Subpath: string; NoCopy?: boolean };
    }>;
  };
};

/** The daemon seam records actual lifecycle requests, including partial failure cleanup. */
class Daemon implements DockerApi {
  calls: Call[] = [];
  created: Created[] = [];
  containers = new Map<string, Created>();
  commit = HERMES_PINNED_COMMIT;
  stale: Array<{ Id: string; Names: string[]; Labels: Record<string, string> }> = [];
  beforeRequest?: (call: Call) => Promise<void>;
  foreignHome = false;

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const call = { method, path, body };
    this.calls.push(call);
    await this.beforeRequest?.(call);
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
            'com.melete.hermes.commit': this.commit,
            'com.melete.plugin.sha256': 'b'.repeat(64),
          },
        },
      };
    if (path.startsWith('/containers/json?')) return this.stale;
    if (path.startsWith('/networks?')) return [];
    if (path.startsWith('/volumes?')) return { Volumes: [] };
    if (path === '/networks/create') return { Id: (body as { Name: string }).Name };
    if (path === '/volumes/create')
      return this.foreignHome ? { ...(body as object), Labels: labels(0, 'someone-else') } : body;
    if (path.startsWith('/containers/create?')) {
      const config = body as Created;
      const id = `cell-${this.created.length}`;
      this.created.push(config);
      this.containers.set(id, config);
      return { Id: id };
    }
    if (path.endsWith('/json') && path.startsWith('/containers/')) {
      const config = this.containers.get(path.split('/')[2] ?? '');
      if (!config) throw new Error(`Unknown fixture container ${path}`);
      return {
        NetworkSettings: {
          Networks: { [config.HostConfig.NetworkMode]: { IPAddress: '172.30.0.2' } },
        },
      };
    }
    if (method !== 'GET') return null;
    throw new Error(`Unexpected daemon call ${method} ${path}`);
  }
}

const fixtures: Array<{ root: string; runtime: DockerHermesRuntimeAdapter }> = [];
async function setup(pendingWait?: () => Promise<WaitSpec | null>) {
  const root = await mkdtemp(join(tmpdir(), 'melete-supervisor-test-'));
  const daemon = new Daemon();
  const httpCalls: string[] = [];
  const events: RuntimeEvent[] = [];
  const mode = { durable: true, unavailable: false };
  const runtime = new DockerHermesRuntimeAdapter({
    project: 'test-melete',
    image: 'melete-runtime:local',
    socket: '/unused.sock',
    workRoot: root,
    workVolume: 'test-melete_work',
    probeUrl: 'http://probe:8790',
    probeKey: 'x'.repeat(64),
    selfId: 'self',
    docker: daemon,
    startTimeoutMs: 2000,
    parkedActions: async () => [],
    pendingWait,
    fetch: async (url) => {
      httpCalls.push(url);
      if (mode.unavailable) throw new Error('Not listening yet');
      if (url.endsWith('/v1/capabilities'))
        return Response.json({
          features: { runs_idempotency: { supported: true, durable: mode.durable } },
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
  fixtures.push({ root, runtime });
  return {
    root,
    daemon,
    runtime,
    mode,
    httpCalls,
    events,
    sink: {
      emit: async (event: RuntimeEvent) => {
        events.push(event);
      },
    },
  };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe('Docker attempt supervision', () => {
  test('a broker-owned wait survives the Docker adapter boundary', async () => {
    const wait: WaitSpec = { kind: 'timer', wake_at: '2030-01-01T00:00:00Z' };
    const f = await setup(async () => wait);
    expect(await f.runtime.start(bundle(), f.sink, new AbortController().signal)).toEqual({
      kind: 'waiting_for_event_or_time',
      wait,
    });
    expect(f.events.at(-1)).toMatchObject({
      type: 'attempt_outcome',
      outcome: { kind: 'waiting_for_event_or_time', wait },
    });
  });
  test('pins the image, mounts only the job subpath, and isolates its sole broker peer', async () => {
    const f = await setup();
    expect((await f.runtime.capabilities()).version).toContain('hermes@');
    expect((await f.runtime.start(bundle(), f.sink, new AbortController().signal)).kind).toBe(
      'completed',
    );
    expect(f.events.at(-1)?.type).toBe('attempt_outcome');
    expect(f.daemon.created).toHaveLength(1);
    const child = f.daemon.created[0];
    expect(child).toMatchObject({
      Image: imageId,
      User: '10001:10001',
      WorkingDir: '/work',
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: { Name: 'no' },
      },
    });
    expect(child?.HostConfig.Mounts).toEqual([
      {
        Type: 'volume',
        Source: 'test-melete_work',
        Target: '/work',
        VolumeOptions: { Subpath: bundle().attempt.job_id, NoCopy: true },
      },
      {
        Type: 'volume',
        Source: `test-melete-${identity('att').toLowerCase()}-home`,
        Target: '/var/lib/hermes',
      },
    ]);
    expect(child?.Env).toContain('MELETE_ATTEMPT_TOKEN=only-this-attempt');
    expect(child?.Env).toContain('MELETE_MODEL_PROVIDER=fake');
    expect(child?.Env).not.toContain('MELETE_APPROVAL_KEY=');
    expect(JSON.stringify(child)).not.toContain('docker.sock');
    expect(f.daemon.calls.find((call) => call.path === '/networks/create')?.body).toMatchObject({
      Internal: true,
      EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    });
    const peers = f.daemon.calls.filter((call) => call.path.endsWith('/connect'));
    expect(peers).toHaveLength(1);
    expect(peers[0]?.body).toEqual({ Container: 'self', EndpointConfig: { Aliases: ['melete'] } });
    const removals = f.daemon.calls.filter((call) => call.method === 'DELETE');
    expect(removals.map((call) => call.path.split('/')[1])).toEqual([
      'containers',
      'networks',
      'volumes',
    ]);
  });

  test('concurrent jobs never share a network or writable Hermes home', async () => {
    const f = await setup();
    await Promise.all(
      [0, 1].map((index) => f.runtime.start(bundle(index), f.sink, new AbortController().signal)),
    );
    const [a, b] = f.daemon.created;
    expect(a?.HostConfig.NetworkMode).not.toBe(b?.HostConfig.NetworkMode);
    expect(a?.HostConfig.Mounts[0]?.VolumeOptions?.Subpath).not.toBe(
      b?.HostConfig.Mounts[0]?.VolumeOptions?.Subpath,
    );
    expect(a?.HostConfig.Mounts[1]?.Source).not.toBe(b?.HostConfig.Mounts[1]?.Source);
  });

  test('rejects traversal ids and a sibling directory presented through a symlink', async () => {
    const f = await setup();
    const malformed = bundle();
    malformed.attempt.job_id = '../other-job';
    expect(() => f.runtime.start(malformed, f.sink, new AbortController().signal)).toThrow();
    await mkdir(join(f.root, 'sibling'));
    await symlink(join(f.root, 'sibling'), join(f.root, bundle().attempt.job_id));
    await expect(f.runtime.start(bundle(), f.sink, new AbortController().signal)).rejects.toThrow(
      'symlink',
    );
    expect(f.daemon.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  test('refuses an image whose Hermes revision differs before mutating Docker state', async () => {
    const f = await setup();
    f.daemon.commit = 'c'.repeat(40);
    await expect(f.runtime.initialize()).rejects.toThrow('pinned Hermes commit');
    expect(f.daemon.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  test('startup only removes abandoned containers with matching ownership and identity', async () => {
    const f = await setup();
    f.daemon.stale = [
      {
        Id: 'owned-cell',
        Names: [`/test-melete-${identity('att').toLowerCase()}`],
        Labels: labels(),
      },
      { Id: 'another-project', Names: ['/leave-alone'], Labels: labels(1, 'someone-else') },
      { Id: 'unlabelled', Names: ['/leave-alone-too'], Labels: {} },
    ];
    await f.runtime.initialize();
    expect(
      f.daemon.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    ).toEqual(['/containers/owned-cell?force=true']);
  });

  test('a non-durable child cannot start a run and all its resources are removed', async () => {
    const f = await setup();
    f.mode.durable = false;
    await expect(f.runtime.start(bundle(), f.sink, new AbortController().signal)).rejects.toThrow(
      'no durable run idempotency',
    );
    expect(f.httpCalls.some((url) => url.endsWith('/v1/runs'))).toBe(false);
    expect(f.daemon.calls.filter((call) => call.method === 'DELETE')).toHaveLength(3);
  });

  test('shutdown aborts startup and waits until the child has actually been removed', async () => {
    const f = await setup();
    f.mode.unavailable = true;
    let release = () => {};
    const removed = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.daemon.beforeRequest = async (call) => {
      if (call.method === 'DELETE' && call.path.startsWith('/containers/')) await removed;
    };
    const pending = f.runtime.start(bundle(), f.sink, new AbortController().signal);
    void pending.catch(() => {});
    while (f.httpCalls.length === 0) await Bun.sleep(1);
    let closed = false;
    const closing = f.runtime.close().then(() => {
      closed = true;
    });
    await Bun.sleep(20);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(f.daemon.calls.filter((call) => call.method === 'DELETE')).toHaveLength(3);
  });

  test('beginning shutdown interrupts a claim still waiting on warm capabilities', async () => {
    const f = await setup();
    f.mode.unavailable = true;
    const pending = f.runtime.capabilities();
    void pending.catch(() => {});
    while (f.httpCalls.length === 0) await Bun.sleep(1);
    f.runtime.beginShutdown();
    await expect(pending).rejects.toThrow('Runtime supervisor stopping');
    expect(f.daemon.created).toHaveLength(0);
  });

  test('partial provisioning cleans the network and never removes an unowned home', async () => {
    const f = await setup();
    f.daemon.foreignHome = true;
    await expect(f.runtime.start(bundle(), f.sink, new AbortController().signal)).rejects.toThrow(
      'another container',
    );
    expect(f.daemon.created).toHaveLength(0);
    expect(
      f.daemon.calls
        .filter((call) => call.method === 'DELETE')
        .map((call) => call.path.split('/')[1]),
    ).toEqual(['networks']);
  });

  test('a refused volume creation cleans resources already created and reports the failure', async () => {
    const f = await setup();
    f.daemon.beforeRequest = async (call) => {
      if (call.path === '/volumes/create') throw new DockerError(500, 'POST', call.path);
    };
    await expect(f.runtime.start(bundle(), f.sink, new AbortController().signal)).rejects.toThrow(
      'Docker POST /volumes/create answered 500',
    );
    expect(f.daemon.calls.some((call) => call.path.endsWith('/disconnect'))).toBe(true);
    expect(f.daemon.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });
});
