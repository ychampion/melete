import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabase } from '../../../test/helpers/database.ts';
import { CONFORMANCE_TESTS, sandboxConformance } from '../conformance.ts';
import { openSandbox, type SandboxRefusal, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import { type EgressPolicy, SandboxGone, type SandboxSpec } from '../types.ts';
import { workspaceConformance } from '../workspace-conformance.ts';
import { createE2bProvider, E2bApiError } from './e2b.ts';
import {
  AUTHORED_NOTE,
  acknowledgementControl,
  E2B_FIXTURE_API,
  E2B_FIXTURE_DIR,
  fixturePath,
} from './e2b-fixtures.ts';
import {
  AUTHORING_ENVD_TOKEN,
  AUTHORING_KEY,
  AUTHORING_TRAFFIC_TOKEN,
  createE2bStandin,
} from './e2b-standin.ts';
import { RecordingFetch, ReplayFetch } from './fixtures.ts';

/**
 * Fixtures are replayed by default. `MELETE_SANDBOX_AUTHOR=e2b` rewrites them
 * through the documented-API stand-in; the live test re-records them from E2B.
 * Run `bun run format` after either, since the linter formats JSON too.
 */
const AUTHOR = process.env.MELETE_SANDBOX_AUTHOR === 'e2b';
const SECRETS = [AUTHORING_KEY, AUTHORING_ENVD_TOKEN, AUTHORING_TRAFFIC_TOKEN];
const signal = () => AbortSignal.timeout(60_000);

const database = await testDatabase();
afterAll(async () => database?.close());

async function fixtureSubject(
  name: string,
  standinOptions: { ignoreMetadataFilter?: boolean } = {},
) {
  const file = fixturePath(name);
  if (AUTHOR) {
    const standin = createE2bStandin(standinOptions);
    const recorder = new RecordingFetch(standin.fetch, {
      fixture: 'e2b',
      source: 'authored-from-documented-api',
      note: AUTHORED_NOTE,
      api: E2B_FIXTURE_API,
      secrets: SECRETS,
    });
    const control = acknowledgementControl(recorder.fetch);
    return {
      provider: createE2bProvider({
        credential: (use) => use(AUTHORING_KEY),
        fetch: control.fetch,
      }),
      control,
      standin,
      close: () => recorder.save(file),
    };
  }
  const replay = await ReplayFetch.load(file);
  const control = acknowledgementControl(replay.fetch);
  return {
    provider: createE2bProvider({ credential: (use) => use(AUTHORING_KEY), fetch: control.fetch }),
    control,
    standin: null,
    close: async () => replay.assertConsumed(),
  };
}

const spec = (egress: EgressPolicy = { kind: 'deny_all' }): SandboxSpec => ({
  image: 'base',
  egress,
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'e2b-test', space: 'sp_E2B', session: 'sbx_E2B' }),
  env: {},
});

sandboxConformance('e2b on authored fixtures', async (name) => {
  const subject = await fixtureSubject(name);
  return {
    provider: subject.provider,
    image: 'base',
    secrets: SECRETS,
    loseNextAcknowledgement: subject.control.lose,
    close: subject.close,
  };
});

workspaceConformance('e2b on authored fixtures', {
  sql: database?.sql ?? null,
  open: async (name) => {
    const subject = await fixtureSubject(`e2b workspace ${name}`);
    return {
      provider: subject.provider,
      persistence: 'pause',
      image: 'base',
      // Replayed, the fixture already holds the 503.
      failNextSuspend: () => subject.standin?.refuseNextPause(),
      snapshotHeld: async () => false,
      // Authored and replayed runs must send the same requests, so neither races.
      replayed: true,
      close: subject.close,
    };
  },
});

test('deny-all egress is sent on create', async () => {
  const fixtures = await readdir(E2B_FIXTURE_DIR);
  let creates = 0;
  for (const name of fixtures) {
    const fixture = JSON.parse(await readFile(path.join(E2B_FIXTURE_DIR, name), 'utf8')) as {
      exchanges: { request: { method: string; path: string; body?: Record<string, unknown> } }[];
    };
    const first = fixture.exchanges.find(
      (exchange) => exchange.request.method === 'POST' && exchange.request.path === '/sandboxes',
    );
    if (!first) continue;
    creates += 1;
    if (name.startsWith('a-cidr-allow-list')) {
      // The one scenario whose own subject is an allow-list. Its create must
      // fence both families here too, or the fixture would record the hole
      // instead of failing on it.
      expect(first.request.body).toMatchObject({
        allow_internet_access: true,
        secure: true,
        network: {
          allowPublicTraffic: false,
          allowOut: ['1.1.1.1/32'],
          denyOut: ['0.0.0.0/0', '::/0'],
        },
      });
      continue;
    }
    // Every other scenario opens deny-all first; only the egress control asks for more.
    expect(first.request.body).toMatchObject({
      allow_internet_access: false,
      secure: true,
      network: { allowPublicTraffic: false },
    });
    expect(
      (first.request.body?.network as Record<string, unknown> | undefined)?.allowOut,
    ).toBeUndefined();
  }
  expect(creates).toBeGreaterThanOrEqual(8);
  // And the adapter builds that body itself, whatever the fixtures say. What
  // is checked is the request as the adapter sent it, captured before the
  // stand-in sees it, and the network block must match exactly: a missing
  // deny rule or an extra allow rule both fail here.
  const standin = createE2bStandin();
  const sent: Record<string, unknown>[] = [];
  const provider = createE2bProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === '/sandboxes' && init?.method === 'POST')
        sent.push(JSON.parse(String(init.body)));
      return standin.fetch(input, init);
    },
  });
  const policies: [EgressPolicy, { allow_internet_access: boolean; network: unknown }][] = [
    [
      { kind: 'deny_all' },
      { allow_internet_access: false, network: { allowPublicTraffic: false } },
    ],
    [
      { kind: 'cidr_allowlist', cidrs: ['1.1.1.1/32'] },
      {
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          allowOut: ['1.1.1.1/32'],
          denyOut: ['0.0.0.0/0', '::/0'],
        },
      },
    ],
  ];
  for (const [egress, expected] of policies) {
    sent.length = 0;
    // The stand-in refuses a body it considers unsafe. The body sent is what
    // is judged here, so a refusal is kept rather than thrown.
    const opened = await openSandbox(provider, spec(egress), signal()).catch(() => null);
    if (opened) await provider.destroy(opened, signal());
    expect(sent).toHaveLength(1);
    const body = sent[0] ?? {};
    expect([egress.kind, body.secure, body.allow_internet_access, body.network]).toEqual([
      egress.kind,
      true,
      expected.allow_internet_access,
      expected.network,
    ]);
  }
});

test('the API key never appears in a fixture or an error message', async () => {
  const fixtures = await readdir(E2B_FIXTURE_DIR);
  expect(fixtures.length).toBeGreaterThanOrEqual(CONFORMANCE_TESTS.length);
  for (const name of fixtures) {
    const text = await readFile(path.join(E2B_FIXTURE_DIR, name), 'utf8');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(
      /"(x-api-key|authorization|x-access-token|e2b-traffic-access-token)"/i,
    );
    expect(['authored-from-documented-api', 'recorded']).toContain(JSON.parse(text).source);
  }
  const sentinel = 'e2b_sentinel_key_that_must_never_leak_0001';
  const echoes = createE2bProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) =>
      new Response(
        JSON.stringify({
          code: 401,
          message: `invalid key ${new Headers(init?.headers).get('x-api-key')}`,
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  });
  const rejected = await echoes.create(spec(), signal()).catch((error: unknown) => error);
  expect(String((rejected as Error).message)).toContain('401');
  expect(String((rejected as Error).message)).not.toContain(sentinel);
  const breaks = createE2bProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) => {
      throw new TypeError(`proxy refused X-API-Key ${new Headers(init?.headers).get('x-api-key')}`);
    },
  });
  const failed = await breaks
    .inspect({ providerSandboxId: 'abc', imageDigest: null, region: null }, signal())
    .catch((error: unknown) => error);
  expect(String((failed as Error).message)).toContain('did not answer');
  expect(String((failed as Error).message)).not.toContain(sentinel);
  // A recording that would keep a secret is refused rather than written.
  const directory = await mkdtemp(path.join(tmpdir(), 'melete-e2b-fixture-'));
  try {
    const recorder = new RecordingFetch(
      async () =>
        new Response(JSON.stringify({ echoed: sentinel }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      { fixture: 'e2b', source: 'recorded', note: '', api: {}, secrets: [sentinel] },
    );
    await (await recorder.fetch('https://api.e2b.app/v2/sandboxes')).text();
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

test("reconcile destroys only this installation's labelled orphans and leaves foreign sandboxes alone", async () => {
  // The listing is authored to ignore the metadata filter, so the adapter's
  // own ownership check is what stands between it and a stranger's sandbox.
  const subject = await fixtureSubject('e2b reconcile', { ignoreMetadataFilter: true });
  const labels = (over: Record<string, string>) => ({ ...over });
  if (subject.standin) {
    const engine = subject.standin.engine;
    const make = (sandboxLabelsFor: Record<string, string>) =>
      engine.create({
        image: 'base',
        egress: { kind: 'deny_all' },
        labels: sandboxLabelsFor,
        env: {},
        lifetimeSeconds: 600,
      }).id;
    make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ONE' }));
    make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ORPHAN' }));
    make(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_LIVE' }));
    make(sandboxLabels({ project: 'install-b', space: 'sp_B', session: 'sbx_OTHER' }));
    make({});
    make(labels({ 'melete.project': 'install-a', 'melete.session': 'sbx_NOOWNER' }));
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
  const subject = await fixtureSubject('e2b stdin');
  const handle = await openSandbox(subject.provider, spec(), signal());
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-e2b-stdin-'));
  try {
    const result = await runCommand({
      provider: subject.provider,
      handle,
      request: {
        marker: 'act_01J0E2BSTDIN0000000000000',
        argv: ['cat'],
        stdin: new TextEncoder().encode('from stdin'),
        timeoutMs: 20_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_E2BSTDIN',
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

test('a domain allow-list is refused before E2B is called', async () => {
  let calls = 0;
  const provider = createE2bProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    },
  });
  const refused = await openSandbox(
    provider,
    spec({ kind: 'domain_allowlist', domains: ['example.com'] }),
    signal(),
  ).catch((error: unknown) => error);
  expect((refused as SandboxRefusal).code).toBe('egress_unsupported');
  const direct = await provider
    .create(spec({ kind: 'domain_allowlist', domains: ['example.com'] }), signal())
    .catch((error: unknown) => error);
  expect(String(direct)).toContain('cannot enforce');
  expect(calls).toBe(0);
});

test('the adapter reads no credential or setting from its own environment', async () => {
  const source = await readFile(new URL('./e2b.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('process.env');
  expect(source).not.toContain('Bun.env');
});

test("a pause restarts E2B's continuous runtime, so a resumed sandbox is given its whole lifetime again", async () => {
  const standin = createE2bStandin({ maxContinuousSeconds: 2 });
  const connects: unknown[] = [];
  const provider = createE2bProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/connect'))
        connects.push(JSON.parse(String(init?.body)));
      return standin.fetch(input, init);
    },
  });
  const short = { ...spec(), lifetimeSeconds: 2 };
  const handle = await openSandbox(provider, short, signal());
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const { resumeRef } = await (provider.pause as NonNullable<typeof provider.pause>)(
    handle,
    signal(),
  );
  // Past the first window's end while paused: a paused sandbox does not expire.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const resumed = await (provider.resume as NonNullable<typeof provider.resume>)(
    resumeRef,
    short,
    signal(),
  );
  expect(connects).toEqual([{ timeout: 2 }]);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  // Three seconds after it was created, in a two-second plan, it still runs.
  expect(await provider.inspect(resumed, signal())).toBe('running');
  await provider.destroy(resumed, signal());
});

test('a second pause is not an error, a refused pause says the sandbox keeps running, and a missing sandbox is gone', async () => {
  const standin = createE2bStandin();
  const provider = createE2bProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: standin.fetch,
  });
  const pause = provider.pause as NonNullable<typeof provider.pause>;
  const resume = provider.resume as NonNullable<typeof provider.resume>;
  const handle = await openSandbox(provider, spec(), signal());
  standin.refuseNextPause();
  const refused = await pause(handle, signal()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(E2bApiError);
  expect((refused as E2bApiError).status).toBe(503);
  expect(String(refused)).toContain('keeps running');
  expect(await provider.inspect(handle, signal())).toBe('running');
  expect(await pause(handle, signal())).toEqual({ resumeRef: handle.providerSandboxId });
  // E2B answers 409 to a sandbox that is already paused; that is what was asked.
  expect(await pause(handle, signal())).toEqual({ resumeRef: handle.providerSandboxId });
  expect(await provider.inspect(handle, signal())).toBe('paused');
  await provider.destroy(handle, signal());
  expect(await pause(handle, signal()).catch((error: unknown) => error)).toBeInstanceOf(
    SandboxGone,
  );
  expect(
    await resume(handle.providerSandboxId, spec(), signal()).catch((error: unknown) => error),
  ).toBeInstanceOf(SandboxGone);
});
