import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabase } from '../../../test/helpers/database.ts';
import { CONFORMANCE_TESTS, sandboxConformance } from '../conformance.ts';
import { checkSandboxConfiguration } from '../connection.ts';
import { openSandbox, SandboxRefusal, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import {
  type EgressPolicy,
  type ExecSpec,
  SandboxAdapterRefusal,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxHandle,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import { workspaceConformance } from '../workspace-conformance.ts';
import {
  createDaytonaProvider,
  DAYTONA_API_URL,
  DAYTONA_TOOLBOX_PROXY_URL,
  daytonaVariables,
} from './daytona.ts';
import {
  AUTHORED_NOTE,
  acknowledgementControl,
  DAYTONA_FIXTURE_API,
  DAYTONA_FIXTURE_DIR,
  fixturePath,
  latencyReplay,
} from './daytona-fixtures.ts';
import { AUTHORING_KEY, createDaytonaStandin } from './daytona-standin.ts';
import { RecordingFetch } from './fixtures.ts';

/**
 * Fixtures are replayed by default. `MELETE_SANDBOX_AUTHOR=daytona` rewrites
 * them through the stand-in; the live test re-records them from Daytona. Run
 * `bun run format` after either, since the linter formats JSON too.
 */
const AUTHOR = process.env.MELETE_SANDBOX_AUTHOR === 'daytona';
const SECRETS = [AUTHORING_KEY];
const signal = () => AbortSignal.timeout(60_000);
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const database = await testDatabase();
afterAll(async () => database?.close());

async function fixtureSubject(name: string, standinOptions: { ignoreLabelFilter?: boolean } = {}) {
  const file = fixturePath(name);
  if (AUTHOR) {
    const standin = createDaytonaStandin(standinOptions);
    const recorder = new RecordingFetch(standin.fetch, {
      fixture: 'daytona',
      source: 'authored-from-documented-api',
      note: AUTHORED_NOTE,
      api: DAYTONA_FIXTURE_API,
      secrets: SECRETS,
    });
    const control = acknowledgementControl(recorder.fetch);
    return {
      provider: createDaytonaProvider({
        credential: (use) => use(AUTHORING_KEY),
        fetch: control.fetch,
        pollMs: 20,
      }),
      control,
      standin,
      close: () => recorder.save(file),
    };
  }
  const replay = await latencyReplay(file);
  const control = acknowledgementControl(replay.fetch);
  return {
    provider: createDaytonaProvider({
      credential: (use) => use(AUTHORING_KEY),
      fetch: control.fetch,
      pollMs: 20,
    }),
    control,
    standin: null,
    close: async () => replay.assertConsumed(),
  };
}

const spec = (egress: EgressPolicy = { kind: 'deny_all' }): SandboxSpec => ({
  image: 'daytona-small',
  egress,
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'daytona-test', space: 'sp_DAYTONA', session: 'sbx_DAYTONA' }),
  env: {},
});

/** A provider over a live stand-in, with every request it sends written down. */
function standinProvider(
  rewrite?: (url: URL, response: Response) => Promise<Response>,
  options: { rewriteBody?: (url: URL, body: string) => string; graceMs?: number } = {},
) {
  const standin = createDaytonaStandin();
  const sent: { method: string; url: URL; body: string | null; authorization: string | null }[] =
    [];
  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    sent.push({
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      body: typeof init.body === 'string' ? init.body : null,
      authorization: new Headers(init.headers).get('authorization'),
    });
    const body =
      options.rewriteBody && typeof init.body === 'string'
        ? options.rewriteBody(url, init.body)
        : init.body;
    const response = await standin.fetch(input, { ...init, body });
    return rewrite ? rewrite(url, response) : response;
  };
  const provider = createDaytonaProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch,
    pollMs: 5,
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  });
  return { standin, provider, sent };
}

sandboxConformance('daytona on authored fixtures', async (name) => {
  const subject = await fixtureSubject(name);
  return {
    provider: subject.provider,
    image: 'daytona-small',
    secrets: SECRETS,
    loseNextAcknowledgement: subject.control.lose,
    close: subject.close,
  };
});

workspaceConformance('daytona on authored fixtures', {
  sql: database?.sql ?? null,
  open: async (name) => {
    const subject = await fixtureSubject(`daytona workspace ${name}`);
    return {
      provider: subject.provider,
      persistence: 'pause',
      image: 'daytona-small',
      // Replayed, the fixture already holds the refusal.
      failNextSuspend: () => subject.standin?.refuseNextStop(),
      snapshotHeld: async () => false,
      // Authored and replayed runs must send the same requests, so neither races.
      replayed: true,
      close: subject.close,
    };
  },
});

test('deny-all egress is sent on create', async () => {
  const fixtures = await readdir(DAYTONA_FIXTURE_DIR);
  let creates = 0;
  for (const name of fixtures) {
    const fixture = JSON.parse(await readFile(path.join(DAYTONA_FIXTURE_DIR, name), 'utf8')) as {
      exchanges: { request: { method: string; path: string; body?: Record<string, unknown> } }[];
    };
    const first = fixture.exchanges.find(
      (exchange) => exchange.request.method === 'POST' && exchange.request.path === '/api/sandbox',
    );
    if (!first) continue;
    creates += 1;
    if (name.startsWith('a-cidr-allow-list')) {
      expect(first.request.body).toMatchObject({
        networkBlockAll: false,
        networkAllowList: '1.1.1.1/32',
        public: false,
      });
      continue;
    }
    // Every other scenario opens deny-all first; only the egress control asks for more.
    expect(first.request.body).toMatchObject({ networkBlockAll: true, public: false });
    expect(first.request.body?.networkAllowList).toBeUndefined();
    expect(first.request.body?.domainAllowList).toBeUndefined();
  }
  expect(creates).toBeGreaterThanOrEqual(8);
  // And the adapter builds that body itself, whatever the fixtures say.
  const { provider, sent } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  await provider.destroy(handle, signal());
  const creates2 = sent.filter(
    (request) => request.method === 'POST' && request.url.pathname === '/api/sandbox',
  );
  expect(creates2).toHaveLength(1);
  expect(JSON.parse(creates2[0]?.body ?? '{}')).toMatchObject({
    networkBlockAll: true,
    public: false,
    autoStopInterval: 10,
  });
});

test('the API key never appears in a fixture or an error message', async () => {
  const fixtures = await readdir(DAYTONA_FIXTURE_DIR);
  expect(fixtures.length).toBeGreaterThanOrEqual(CONFORMANCE_TESTS.length);
  for (const name of fixtures) {
    const text = await readFile(path.join(DAYTONA_FIXTURE_DIR, name), 'utf8');
    for (const secret of SECRETS) expect(text.includes(secret)).toBe(false);
    expect(text).not.toMatch(/"(authorization|x-api-key|x-access-token)"/i);
    expect(['authored-from-documented-api', 'recorded']).toContain(JSON.parse(text).source);
  }
  const sentinel = 'dtn_sentinel_key_that_must_never_leak_0001';
  const echoes = createDaytonaProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) =>
      new Response(
        JSON.stringify({
          statusCode: 401,
          message: `invalid key ${new Headers(init?.headers).get('authorization')}`,
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  });
  const rejected = await echoes.create(spec(), signal()).catch((error: unknown) => error);
  expect(String((rejected as Error).message)).toContain('401');
  expect(String((rejected as Error).message).includes(sentinel)).toBe(false);
  const breaks = createDaytonaProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) => {
      throw new TypeError(`proxy refused ${new Headers(init?.headers).get('authorization')}`);
    },
  });
  const failed = await breaks
    .inspect({ providerSandboxId: 'abc', imageDigest: null, region: null }, signal())
    .catch((error: unknown) => error);
  expect(String((failed as Error).message)).toContain('did not answer');
  expect(String((failed as Error).message).includes(sentinel)).toBe(false);
  // A toolbox that echoes the key in its error body is scrubbed too.
  const { provider } = standinProvider(async (url, response) =>
    url.pathname.endsWith('/process/execute') && url.href.includes('/toolbox/')
      ? new Response(
          JSON.stringify({ statusCode: 502, message: `upstream saw ${AUTHORING_KEY}` }),
          {
            status: 502,
            headers: { 'content-type': 'application/json' },
          },
        )
      : response,
  );
  const echoed = await provider.create(spec(), signal()).catch((error: unknown) => error);
  expect(echoed).toBeInstanceOf(SandboxTransportError);
  expect(String((echoed as Error).message).includes(AUTHORING_KEY)).toBe(false);
  // A recording that would keep a secret is refused rather than written.
  const directory = await mkdtemp(path.join(tmpdir(), 'melete-daytona-fixture-'));
  try {
    const recorder = new RecordingFetch(
      async () =>
        new Response(JSON.stringify({ echoed: sentinel }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      { fixture: 'daytona', source: 'recorded', note: '', api: {}, secrets: [sentinel] },
    );
    await (await recorder.fetch(`${DAYTONA_API_URL}/sandbox`)).text();
    const saved = await recorder.save(path.join(directory, 'leak.json')).then(
      () => 'saved',
      (error: unknown) => String(error),
    );
    expect(saved).toContain('a secret reached a fixture');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the key is sent only to the API and the configured toolbox proxy', async () => {
  // A sandbox record naming some other proxy is refused and destroyed, and
  // nothing is sent to that proxy.
  const elsewhere = 'https://proxy.example.net/toolbox';
  const { provider, sent } = standinProvider(async (url, response) => {
    if (!url.pathname.startsWith('/api/sandbox') || response.status !== 200) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, toolboxProxyUrl: elsewhere }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const refused = await provider.create(spec(), signal()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SandboxAdapterRefusal);
  expect(String(refused)).toContain('toolbox proxy');
  for (const request of sent)
    expect(
      request.url.href.startsWith(`${DAYTONA_API_URL}/`) ||
        request.url.href.startsWith(`${DAYTONA_TOOLBOX_PROXY_URL}/`),
    ).toBe(true);
  expect(sent.at(-1)).toMatchObject({ method: 'DELETE' });
  // Every request carries the key as a bearer token and nothing else does.
  expect(sent.every((request) => request.authorization === `Bearer ${AUTHORING_KEY}`)).toBe(true);
  expect(() =>
    createDaytonaProvider({
      credential: (use) => use(AUTHORING_KEY),
      toolboxProxyUrl: 'http://proxy.app.daytona.io/toolbox',
    }),
  ).toThrow('https');
});

test('a sandbox whose recorded egress differs from the request is refused and destroyed', async () => {
  const { provider, sent, standin } = standinProvider(async (url, response) => {
    if (!url.pathname.startsWith('/api/sandbox/') || response.status !== 200) return response;
    const body = (await response.json()) as Record<string, unknown>;
    // As an organisation whose network policy overrides the sandbox's would show it.
    return new Response(JSON.stringify({ ...body, networkBlockAll: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const refused = await provider.create(spec(), signal()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SandboxAdapterRefusal);
  expect(String(refused)).toContain('egress');
  // Nothing ran in it, and it is gone.
  expect(sent.some((request) => request.url.href.includes('/process/execute'))).toBe(false);
  expect(standin.engine.sandboxes.size).toBe(0);
});

test('a domain allow-list, an IPv6 range and an eleventh range are refused before Daytona is called', async () => {
  let calls = 0;
  const provider = createDaytonaProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    },
  });
  const domain = await openSandbox(
    provider,
    spec({ kind: 'domain_allowlist', domains: ['example.com'] }),
    signal(),
  ).catch((error: unknown) => error);
  expect((domain as SandboxRefusal).code).toBe('egress_unsupported');
  for (const cidrs of [['2001:db8::/32'], Array.from({ length: 11 }, (_, i) => `10.0.${i}.0/24`)]) {
    const direct = await provider
      .create(spec({ kind: 'cidr_allowlist', cidrs }), signal())
      .catch((error: unknown) => error);
    expect(direct).toBeInstanceOf(SandboxAdapterRefusal);
    // And at installation, before a connection exists.
    const installed = (() => {
      try {
        checkSandboxConfiguration(
          {
            adapter: 'daytona',
            image: 'daytona-small',
            egress: 'cidr_allowlist',
            cidrs,
            persistence: 'ephemeral',
            lifetime_seconds: 600,
          },
          { project: 'install-a', spaceId: 'sp_DAYTONA' },
        );
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(installed).toBeInstanceOf(SandboxRefusal);
    expect((installed as SandboxRefusal).code).toBe('egress_invalid');
  }
  // Snapshot persistence is not something Daytona's containers offer.
  expect(() =>
    checkSandboxConfiguration(
      {
        adapter: 'daytona',
        image: 'daytona-small',
        egress: 'deny_all',
        persistence: 'snapshot',
        lifetime_seconds: 600,
      },
      { project: 'install-a', spaceId: 'sp_DAYTONA' },
    ),
  ).toThrow(SandboxRefusal);
  expect(calls).toBe(0);
});

test("reconcile destroys only this installation's labelled orphans and leaves foreign sandboxes alone", async () => {
  // The listing is authored to ignore the label filter, so the adapter's own
  // ownership check is what stands between it and a stranger's sandbox.
  const subject = await fixtureSubject('daytona reconcile', { ignoreLabelFilter: true });
  if (subject.standin) {
    const make = async (labels: Record<string, string>) => {
      const response = await subject.standin.fetch(`${DAYTONA_API_URL}/sandbox`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTHORING_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: 'daytona-small', labels, networkBlockAll: true }),
      });
      return ((await response.json()) as { id: string }).id;
    };
    await make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ONE' }));
    await make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ORPHAN' }));
    await make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_LIVE' }));
    await make(sandboxLabels({ project: 'install-b', space: 'sp_B', session: 'sbx_OTHER' }));
    await make({});
    await make({ 'melete.project': 'install-a', 'melete.session': 'sbx_NOOWNER' });
  }
  const destroyed = await subject.provider.reconcile(
    'install-a',
    new Set(['fake-sbx-0001', 'sbx_LIVE']),
    signal(),
    null,
  );
  expect(destroyed).toEqual(['fake-sbx-0002']);
  if (subject.standin)
    expect([...subject.standin.engine.sandboxes.keys()].sort()).toEqual([
      'fake-sbx-0001',
      'fake-sbx-0003',
      'fake-sbx-0004',
      'fake-sbx-0005',
      'fake-sbx-0006',
    ]);
  await subject.close();
});

test('stdin reaches a marked command once', async () => {
  const subject = await fixtureSubject('daytona stdin');
  const handle = await openSandbox(subject.provider, spec(), signal());
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-daytona-stdin-'));
  try {
    const result = await runCommand({
      provider: subject.provider,
      handle,
      request: {
        marker: 'act_01J0DAYTONASTDIN000000000',
        argv: ['cat'],
        stdin: new TextEncoder().encode('from stdin'),
        timeoutMs: 20_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_DAYTONASTDIN',
      signal: signal(),
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded')
      expect(new TextDecoder().decode(result.record.preview)).toBe('from stdin');
  } finally {
    await subject.provider.destroy(handle, signal());
    await rm(workRoot, { recursive: true, force: true });
    await subject.close();
  }
});

test("the toolbox's answers decide whether a command started", async () => {
  let markers = 0;
  const exec = (argv = ['sh', '-c', 'exit 0'], timeoutMs = 5_000): ExecSpec => {
    markers += 1;
    return {
      marker: `act_01J0DAYTONAFACTS${String(markers).padStart(4, '0')}`,
      argv,
      cwd: '/work',
      timeoutMs,
      maxOutputBytes: 4096,
    };
  };
  let answer: { route: RegExp; response: () => Response } | null = null;
  const { provider } = standinProvider(async (url, response) => {
    const chosen = answer;
    if (!chosen?.route.test(url.pathname)) return response;
    await response.body?.cancel().catch(() => {});
    const replaced = chosen.response();
    answer = null;
    return replaced;
  });
  const handle: SandboxHandle = await openSandbox(provider, spec(), signal());
  const body = (status: number, value: unknown) => () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const opening = /\/process\/session$/;
  const sending = /\/process\/session\/[^/]+\/exec$/;
  const polling = /\/process\/session\/[^/]+\/command\/[^/]+$/;
  const outcome = async (spec: ExecSpec) =>
    provider.exec(handle, spec, signal()).catch((error: unknown) => error);
  // The session could not be opened, or the command was turned away: nothing ran.
  for (const route of [opening, sending])
    for (const status of [400, 401, 404, 429]) {
      answer = { route, response: body(status, { statusCode: status, message: 'no' }) };
      expect(await outcome(exec())).toBeInstanceOf(SandboxStartRefused);
    }
  // A session for this action exists already: an earlier dispatch may have sent it.
  answer = { route: opening, response: body(409, { statusCode: 409, message: 'exists' }) };
  const conflict = await outcome(exec());
  expect(conflict).toBeInstanceOf(SandboxTransportError);
  expect((conflict as SandboxTransportError).started).toBe('unknown');
  // Sent, and no command id came back: it may be running.
  for (const response of [
    body(408, { statusCode: 408, message: 'timeout' }),
    body(502, { statusCode: 502, message: 'gateway' }),
    body(202, {}),
  ]) {
    answer = { route: sending, response };
    const lost = await outcome(exec());
    expect(lost).toBeInstanceOf(SandboxTransportError);
    expect((lost as SandboxTransportError).started).toBe('unknown');
  }
  // Once it has a command id it has started, whatever is lost afterwards.
  answer = { route: polling, response: body(500, { statusCode: 500, message: 'broken' }) };
  const after = await outcome(exec(['sh', '-c', 'sleep 1']));
  expect(after).toBeInstanceOf(SandboxTransportError);
  expect((after as SandboxTransportError).started).toBe('yes');
  // A command's own 137 before its deadline is its own exit, not a kill.
  expect(await outcome(exec(['sh', '-c', 'exit 137']))).toMatchObject({
    started: 'yes',
    state: 'exited',
    exitCode: 137,
    timedOut: false,
  });
  await provider.destroy(handle, signal());
});

test('a poll lost after the command started is unknown and the command is never run again', async () => {
  let cut = true;
  const { provider } = standinProvider(async (url, response) => {
    if (cut && /\/process\/session\/[^/]+\/command\/[^/]+$/.test(url.pathname)) {
      cut = false;
      await response.body?.cancel().catch(() => {});
      throw new TypeError('network connection lost');
    }
    return response;
  });
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-daytona-poll-'));
  try {
    const handle = await openSandbox(provider, spec(), signal());
    const request = {
      marker: 'act_01J0DAYTONAPOLLLOST00000',
      argv: ['sh', '-c', 'printf once >> /work/counter; sleep 1; printf done'],
      timeoutMs: 10_000,
    };
    const run = (dispatch: 'first' | 'again') =>
      runCommand({
        provider,
        handle,
        request: { ...request, dispatch },
        workRoot,
        jobId: 'job_DAYTONAPOLL',
        signal: signal(),
      });
    expect((await run('first')).outcome).toBe('unknown');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await run('again')).toMatchObject({
      outcome: 'succeeded',
      late: true,
      reattached: true,
    });
    // And a duplicate that reaches the sandbox meets its session, not a second run.
    expect(await run('first')).toMatchObject({
      outcome: 'succeeded',
      late: true,
      reattached: true,
    });
    const counter = await provider.getFile(handle, '/work/counter', 64, signal());
    expect(new TextDecoder().decode(counter)).toBe('once');
    await provider.destroy(handle, signal());
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('a command given no stdin reads an empty one, not the session pipe Daytona holds open', async () => {
  const { provider } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  expect(
    await provider.exec(
      handle,
      {
        marker: 'act_01J0DAYTONANOSTDIN00000',
        argv: ['cat'],
        cwd: '/work',
        timeoutMs: 2_000,
        maxOutputBytes: 4096,
      },
      signal(),
    ),
  ).toMatchObject({ state: 'exited', exitCode: 0, timedOut: false });
  await provider.destroy(handle, signal());
});

test('a command that outlives its timeout and the grace after it is ended with its session', async () => {
  // As if `timeout` were missing from the image: the command would run on.
  const { provider } = standinProvider(undefined, {
    graceMs: 300,
    rewriteBody: (url, body) =>
      url.pathname.endsWith('/exec') ? body.replace(`'timeout' '-s' 'KILL' '1' `, '') : body,
  });
  const handle = await openSandbox(provider, spec(), signal());
  const outcome = await provider.exec(
    handle,
    {
      marker: 'act_01J0DAYTONAGRACE0000000',
      argv: ['sh', '-c', 'sleep 3; printf late > /work/late'],
      cwd: '/work',
      timeoutMs: 1_000,
      maxOutputBytes: 4096,
    },
    signal(),
  );
  expect(outcome).toMatchObject({ state: 'killed', timedOut: true, signal: 'SIGKILL' });
  expect(outcome.durationMs).toBeGreaterThanOrEqual(1_300);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(
    await provider.getFile(handle, '/work/late', 64, signal()).catch((error: unknown) => error),
  ).toBeInstanceOf(SandboxFileNotFound);
  await provider.destroy(handle, signal());
});

test('a stop keeps the files, a start brings the same sandbox back, and a sandbox that is gone says so', async () => {
  const { provider } = standinProvider();
  const pause = provider.pause as NonNullable<typeof provider.pause>;
  const resume = provider.resume as NonNullable<typeof provider.resume>;
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-daytona-pause-'));
  try {
    const handle = await openSandbox(provider, spec(), signal(), 'pause');
    const wrote = await runCommand({
      provider,
      handle,
      request: {
        marker: 'act_01J0DAYTONAPAUSE0000000',
        argv: ['sh', '-c', 'printf kept > /work/kept.txt'],
        timeoutMs: 10_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_DAYTONAPAUSE',
      signal: signal(),
    });
    expect(wrote.outcome).toBe('succeeded');
    const { resumeRef } = await pause(handle, signal());
    expect(resumeRef).toBe(handle.providerSandboxId);
    expect(await provider.inspect(handle, signal())).toBe('paused');
    // A second stop is what was asked, not an error.
    expect(await pause(handle, signal())).toEqual({ resumeRef });
    const resumed = await resume(resumeRef, spec(), signal());
    expect(resumed.providerSandboxId).toBe(handle.providerSandboxId);
    expect(await provider.inspect(resumed, signal())).toBe('running');
    expect(
      new TextDecoder().decode(await provider.getFile(resumed, '/work/kept.txt', 64, signal())),
    ).toBe('kept');
    // A workspace comes back only under the egress it was given.
    await pause(resumed, signal());
    expect(
      await resume(resumeRef, spec({ kind: 'open' }), signal()).catch((error: unknown) => error),
    ).toBeInstanceOf(SandboxAdapterRefusal);
    await provider.destroy(resumed, signal());
    expect(await provider.inspect(resumed, signal())).toBe('gone');
    expect(await pause(resumed, signal()).catch((error: unknown) => error)).toBeInstanceOf(
      SandboxGone,
    );
    expect(
      await resume(resumeRef, spec(), signal()).catch((error: unknown) => error),
    ).toBeInstanceOf(SandboxGone);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("only the provider's own variables are left out of a command's environment, by name", () => {
  expect(
    daytonaVariables(
      'PATH=/bin\nDAYTONA_SANDBOX_ID=abc\nDAYTONA_REGION_ID=us\nNOT_DAYTONA_X=1\nX=DAYTONA_Y=2\n',
    ),
  ).toEqual(['DAYTONA_REGION_ID', 'DAYTONA_SANDBOX_ID']);
});

test('the adapter reads no credential or setting from its own environment', async () => {
  const source = await readFile(new URL('./daytona.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('process.env');
  expect(source).not.toContain('Bun.env');
});
