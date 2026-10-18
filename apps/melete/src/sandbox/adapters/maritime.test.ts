import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabase } from '../../../test/helpers/database.ts';
import { CONFORMANCE_TESTS, sandboxConformance } from '../conformance.ts';
import { openSandbox, SandboxRefusal, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import {
  type EgressPolicy,
  type ExecSpec,
  SandboxAdapterRefusal,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import { workspaceConformance } from '../workspace-conformance.ts';
import { RecordingFetch } from './fixtures.ts';
import {
  createMaritimeProvider,
  isMaritimeProvider,
  MARITIME_API_URL,
  MARITIME_FILE_LIMIT,
  maritimeActionsFor,
  maritimeExternalUserId,
  maritimeLabels,
  maritimeName,
  maritimeWords,
} from './maritime.ts';
import {
  AUTHORED_NOTE,
  acknowledgementControl,
  fixturePath,
  latencyReplay,
  MARITIME_FIXTURE_API,
  MARITIME_FIXTURE_DIR,
} from './maritime-fixtures.ts';
import { AUTHORING_KEY, createMaritimeStandin } from './maritime-standin.ts';

/**
 * Fixtures are replayed by default. `MELETE_SANDBOX_AUTHOR=maritime` rewrites
 * them through the stand-in. Run `bun run format` afterwards, since the linter
 * formats JSON too.
 */
const AUTHOR = process.env.MELETE_SANDBOX_AUTHOR === 'maritime';
const SECRETS = [AUTHORING_KEY];
const signal = () => AbortSignal.timeout(60_000);
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const database = await testDatabase();
afterAll(async () => database?.close());

/** Staged file names that repeat from run to run, so a replay matches them. */
const counter = () => {
  let next = 0;
  return () => {
    next += 1;
    return String(next).padStart(6, '0');
  };
};

async function fixtureSubject(name: string) {
  const file = fixturePath(name);
  const settings = { graceMs: 1_500, nonce: counter() };
  if (AUTHOR) {
    const standin = createMaritimeStandin();
    const recorder = new RecordingFetch(standin.fetch, {
      fixture: 'maritime',
      source: 'authored-from-documented-api',
      note: AUTHORED_NOTE,
      api: MARITIME_FIXTURE_API,
      secrets: SECRETS,
    });
    const control = acknowledgementControl(recorder.fetch);
    return {
      provider: createMaritimeProvider({
        credential: (use) => use(AUTHORING_KEY),
        fetch: control.fetch,
        ...settings,
      }),
      control,
      standin,
      close: () => recorder.save(file),
    };
  }
  const replay = await latencyReplay(file);
  const control = acknowledgementControl(replay.fetch);
  return {
    provider: createMaritimeProvider({
      credential: (use) => use(AUTHORING_KEY),
      fetch: control.fetch,
      ...settings,
    }),
    control,
    standin: null,
    close: async () => replay.assertConsumed(),
  };
}

const spec = (
  egress: EgressPolicy = { kind: 'open' },
  overrides: Partial<SandboxSpec> = {},
): SandboxSpec => ({
  image: 'linux',
  egress,
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({
    project: 'maritime-test',
    space: 'sp_MARITIME',
    session: 'sbx_MARITIME',
  }),
  env: {},
  ...overrides,
});

/** A provider over a live stand-in, with every request it sends written down. */
function standinProvider(
  rewrite?: (url: URL, init: RequestInit, response: Response) => Promise<Response>,
  options: { graceMs?: number } = {},
) {
  const standin = createMaritimeStandin();
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
    const response = await standin.fetch(input, init);
    return rewrite ? rewrite(url, init, response) : response;
  };
  const provider = createMaritimeProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch,
    nonce: counter(),
    graceMs: options.graceMs ?? 1_500,
  });
  return { standin, provider, sent };
}

sandboxConformance('maritime on authored fixtures', async (name) => {
  const subject = await fixtureSubject(name);
  return {
    provider: subject.provider,
    image: 'linux',
    secrets: SECRETS,
    loseNextAcknowledgement: subject.control.lose,
    close: subject.close,
  };
});

workspaceConformance('maritime on authored fixtures', {
  sql: database?.sql ?? null,
  open: async (name) => {
    const subject = await fixtureSubject(`maritime workspace ${name}`);
    return {
      provider: subject.provider,
      persistence: 'pause',
      image: 'linux',
      // Replayed, the fixture already holds the refusal.
      failNextSuspend: () => subject.standin?.refuseNextSleep(),
      snapshotHeld: async () => false,
      replayed: true,
      close: subject.close,
    };
  },
});

test('the API key never appears in a fixture or an error message', async () => {
  const fixtures = await readdir(MARITIME_FIXTURE_DIR);
  expect(fixtures.length).toBeGreaterThanOrEqual(CONFORMANCE_TESTS.length);
  for (const name of fixtures) {
    const text = await readFile(path.join(MARITIME_FIXTURE_DIR, name), 'utf8');
    for (const secret of SECRETS) expect(text.includes(secret)).toBe(false);
    expect(text).not.toMatch(/"(authorization|x-api-key)"/i);
    expect(text).not.toMatch(/mk_[A-Za-z0-9]{8,}/);
    expect(['authored-from-documented-api', 'recorded']).toContain(JSON.parse(text).source);
  }
  const sentinel = 'mk_sentinel_key_that_must_never_leak_0001';
  const echoes = createMaritimeProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) =>
      new Response(
        JSON.stringify({
          error: 'unauthorized',
          message: `invalid key ${new Headers(init?.headers).get('authorization')}`,
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  });
  const rejected = await echoes.create(spec(), signal()).catch((error: unknown) => error);
  expect(String((rejected as Error).message)).toContain('401');
  expect(String((rejected as Error).message).includes(sentinel)).toBe(false);
  const breaks = createMaritimeProvider({
    credential: (use) => use(sentinel),
    fetch: async (_input, init) => {
      throw new TypeError(`proxy refused ${new Headers(init?.headers).get('authorization')}`);
    },
  });
  const failed = await breaks
    .inspect({ providerSandboxId: 'abc', imageDigest: null, region: null }, signal())
    .catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(SandboxTransportError);
  expect(String((failed as Error).message)).toContain('did not answer');
  expect(String((failed as Error).message).includes(sentinel)).toBe(false);
});

test('the key goes to the API only, as a bearer token, and never into the computer', async () => {
  const { provider, sent, standin } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  await provider.exec(
    handle,
    {
      marker: 'act_01J0MARITIMEKEY000000000',
      argv: ['sh', '-c', 'env > /work/env.txt'],
      cwd: '/work',
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    },
    signal(),
  );
  for (const request of sent) {
    expect(request.url.href.startsWith(`${MARITIME_API_URL}/api/v1/computers`)).toBe(true);
    expect(request.authorization).toBe(`Bearer ${AUTHORING_KEY}`);
    expect(request.body?.includes(AUTHORING_KEY) ?? false).toBe(false);
  }
  const environment = new TextDecoder().decode(
    standin.engine.get(handle.providerSandboxId)?.fs.readFile('/data/work/env.txt'),
  );
  expect(environment).toContain('HOME=/home/desk');
  expect(environment.includes(AUTHORING_KEY)).toBe(false);
  await provider.destroy(handle, signal());
  expect(() =>
    createMaritimeProvider({
      credential: (use) => use(AUTHORING_KEY),
      apiUrl: 'http://api.maritime.sh',
    }),
  ).toThrow('https');
});

test('what Maritime cannot do is refused before Maritime is called', async () => {
  let calls = 0;
  const provider = createMaritimeProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    },
  });
  // No egress control: deny-all and allow-lists are refused by the manifest.
  for (const egress of [
    { kind: 'deny_all' },
    { kind: 'cidr_allowlist', cidrs: ['1.1.1.1/32'] },
    { kind: 'domain_allowlist', domains: ['example.com'] },
  ] as EgressPolicy[]) {
    const refused = await openSandbox(provider, spec(egress), signal()).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SandboxRefusal);
    expect((refused as SandboxRefusal).code).toBe('egress_unsupported');
    // And by the adapter itself, should a caller skip the manifest.
    expect(await provider.create(spec(egress), signal()).catch((error) => error)).toBeInstanceOf(
      SandboxAdapterRefusal,
    );
  }
  for (const overrides of [
    { image: 'ghcr.io/example/custom:1' },
    { region: 'eu' },
    { idleSeconds: 60 },
    { cpu: 4 },
    { memoryMb: 8192 },
  ] as Partial<SandboxSpec>[])
    expect(
      await provider.create(spec(undefined, overrides), signal()).catch((error) => error),
    ).toBeInstanceOf(SandboxAdapterRefusal);
  expect(calls).toBe(0);
  expect(provider.capabilities).toMatchObject({
    adapter: 'maritime',
    egress: ['open'],
    ports: 'none',
    regions: [],
    maxUploadBytes: MARITIME_FILE_LIMIT,
  });
  expect(provider.previewAddress).toBeUndefined();
});

test('a computer is found by a hash of Melete ids, and its name carries the labels back', () => {
  const labels = sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ONE' });
  const id = maritimeExternalUserId(labels);
  expect(id).toMatch(/^melete-[0-9a-f]{48}$/);
  expect(maritimeExternalUserId(labels)).toBe(id);
  expect(
    maritimeExternalUserId(
      sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_TWO' }),
    ),
  ).not.toBe(id);
  const name = maritimeName(labels);
  expect(maritimeLabels(name)).toMatchObject({
    'melete.project': 'install-a',
    'melete.session': 'sbx_ONE',
  });
  expect(maritimeLabels('someone else')).toBeNull();
  expect(maritimeLabels(`${name} extra`)).toBeNull();
});

test('a create whose answer was lost finds the same computer again', async () => {
  const { provider, standin } = standinProvider();
  const first = await openSandbox(provider, spec(), signal());
  const second = await openSandbox(provider, spec(), signal());
  expect(second.providerSandboxId).toBe(first.providerSandboxId);
  expect(standin.records.size).toBe(1);
  await provider.destroy(first, signal());
  expect(standin.records.size).toBe(0);
});

test("reconcile destroys only this installation's orphans and leaves other computers alone", async () => {
  const { provider, standin } = standinProvider();
  const make = async (session: string, project = 'install-a') =>
    (
      await openSandbox(
        provider,
        spec(undefined, { labels: sandboxLabels({ project, space: 'sp_A', session }) }),
        signal(),
      )
    ).providerSandboxId;
  const one = await make('sbx_ONE');
  const orphan = await make('sbx_ORPHAN');
  const live = await make('sbx_LIVE');
  const other = await make('sbx_OTHER', 'install-b');
  // Someone else's computer on the same account, and one whose name was edited.
  const foreign = await standin.fetch(`${MARITIME_API_URL}/api/v1/computers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTHORING_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalUserId: 'user-42', name: 'melete v1 install-a - sbx_FAKE' }),
  });
  const foreignId = ((await foreign.json()) as { id: string }).id;
  const destroyed = await provider.reconcile(
    'install-a',
    new Set([one, 'sbx_LIVE']),
    signal(),
    null,
  );
  expect(destroyed).toEqual([orphan]);
  expect([...standin.records.keys()].sort()).toEqual([one, live, other, foreignId].sort());
});

test('the launch decides whether a command started', async () => {
  let markers = 0;
  const exec = (argv = ['sh', '-c', 'exit 0'], timeoutMs = 5_000): ExecSpec => {
    markers += 1;
    return {
      marker: `act_01J0MARITIMEFACTS${String(markers).padStart(4, '0')}`,
      argv,
      cwd: '/work',
      timeoutMs,
      maxOutputBytes: 4096,
    };
  };
  let answer: { launch: boolean; response: () => Response } | null = null;
  const { provider } = standinProvider(async (url, init, response) => {
    const chosen = answer;
    const launch = typeof init.body === 'string' && init.body.includes('melete-launch');
    if (!chosen || !url.pathname.endsWith('/exec') || launch !== chosen.launch) return response;
    await response.body?.cancel().catch(() => {});
    answer = null;
    return chosen.response();
  });
  const handle = await openSandbox(provider, spec(), signal());
  const body = (status: number, value: unknown) => () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const outcome = (request: ExecSpec) =>
    provider.exec(handle, request, signal()).catch((error: unknown) => error);
  // Refused before it reached the computer's shell: nothing ran.
  for (const status of [400, 402, 409, 422, 429]) {
    answer = { launch: true, response: body(status, { error: 'no', message: 'no' }) };
    expect(await outcome(exec())).toBeInstanceOf(SandboxStartRefused);
  }
  // Sent, and no pid came back: it may be running.
  for (const response of [
    body(500, { error: 'wake_transient', message: 'gateway' }),
    body(503, { error: 'no_capacity', message: 'busy' }),
  ]) {
    answer = { launch: true, response };
    const lost = await outcome(exec());
    expect(lost).toBeInstanceOf(SandboxTransportError);
    expect((lost as SandboxTransportError).started).toBe('unknown');
  }
  // The launcher's own refusal: nothing started.
  expect(await provider.exec(handle, { ...exec(), cwd: '/nowhere' }, signal())).toMatchObject({
    started: 'no',
    exitCode: 112,
  });
  // A command's own 137 before its deadline is its own exit, not a kill.
  expect(await outcome(exec(['sh', '-c', 'exit 137']))).toMatchObject({
    started: 'yes',
    state: 'exited',
    exitCode: 137,
    timedOut: false,
  });
  await provider.destroy(handle, signal());
});

test('a command longer than one exec runs in the background and is never run twice', async () => {
  let cut = 2;
  // The first polls are lost: the command must still finish once.
  const { provider, standin } = standinProvider(async (url, init, response) => {
    const poll =
      url.pathname.endsWith('/exec') &&
      typeof init.body === 'string' &&
      init.body.includes('.rc') &&
      !init.body.includes('melete-launch');
    if (cut > 0 && poll) {
      cut -= 1;
      await response.body?.cancel().catch(() => {});
      throw new TypeError('network connection lost');
    }
    return response;
  });
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-maritime-long-'));
  try {
    const handle = await openSandbox(provider, spec(), signal());
    const result = await runCommand({
      provider,
      handle,
      request: {
        marker: 'act_01J0MARITIMELONG000000',
        argv: ['sh', '-c', 'printf once >> /work/counter; sleep 1; printf done'],
        timeoutMs: 120_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_MARITIMELONG',
      signal: signal(),
    });
    expect(result).toMatchObject({ outcome: 'succeeded' });
    const counted = standin.engine.get(handle.providerSandboxId)?.fs.readFile('/data/work/counter');
    expect(new TextDecoder().decode(counted)).toBe('once');
    await provider.destroy(handle, signal());
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test("without root, Melete's /work is /data/work, translated at the adapter's boundary", async () => {
  const { provider, standin } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  const computer = standin.engine.get(handle.providerSandboxId);
  // The stand-in refuses /work as Maritime does, and nothing tried to make it.
  expect(computer?.fs.lstat('/work')).toBeUndefined();
  expect(() => computer?.fs.mkdir('/work', true)).toThrow('EACCES');
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: '/work/notes/a.txt', bytes: new TextEncoder().encode('hello'), mode: 0o644 };
    })(),
    signal(),
  );
  expect(new TextDecoder().decode(computer?.fs.readFile('/data/work/notes/a.txt'))).toBe('hello');
  expect((await provider.listFiles(handle, '/work', signal())).map((each) => each.path)).toEqual([
    'notes',
    'notes/a.txt',
  ]);
  expect(
    new TextDecoder().decode(await provider.getFile(handle, '/work/notes/a.txt', 64, signal())),
  ).toBe('hello');
  let markers = 0;
  const run = (argv: string[], cwd = '/work') => {
    markers += 1;
    return provider.exec(
      handle,
      {
        marker: `act_01J0MARITIMEWORK${String(markers).padStart(4, '0')}`,
        argv,
        cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
      },
      signal(),
    );
  };
  const text = (outcome: Awaited<ReturnType<typeof run>>) =>
    new TextDecoder().decode(outcome.output);
  // A command starts in the workspace; a relative path reaches it.
  expect(text(await run(['cat', 'notes/a.txt']))).toBe('hello');
  expect(text(await run(['cat', 'a.txt'], '/work/notes'))).toBe('hello');
  // A word that is a /work path names the workspace (the service's own `rm -- /work/...`).
  expect(await run(['rm', '-f', '--', '/work/notes/a.txt'])).toMatchObject({ exitCode: 0 });
  expect(computer?.fs.lstat('/data/work/notes/a.txt')).toBeUndefined();
  // A /work path inside a command's own words names the workspace too.
  expect(await run(['sh', '-c', 'printf kept > /work/notes/b.txt'])).toMatchObject({ exitCode: 0 });
  expect(text(await run(['sh', '-c', 'cd /work && cat "/work/notes/b.txt"'], '/tmp'))).toBe('kept');
  expect(new TextDecoder().decode(computer?.fs.readFile('/data/work/notes/b.txt'))).toBe('kept');
  await provider.destroy(handle, signal());
});

test('only /work standing as a path is respelled in a command', () => {
  const cases: [string, string][] = [
    ['/work', '/data/work'],
    ['/work/a b', '/data/work/a b'],
    ["cat '/work/x' > /work/y", "cat '/data/work/x' > /data/work/y"],
    ['cd /work&&ls', 'cd /data/work&&ls'],
    ['PATH=/work/bin:/work/tools', 'PATH=/data/work/bin:/data/work/tools'],
    ['$(cd /work)', '$(cd /data/work)'],
    ['/workspace /worker ./work ~/work a/work', '/workspace /worker ./work ~/work a/work'],
    ['https://example.com/work/x', 'https://example.com/work/x'],
    ['/data/work', '/data/work'],
  ];
  for (const [word, spelled] of cases) expect(maritimeWords(word)).toBe(spelled);
});

test("a command's output comes back byte for byte up to the caller's cap, with its true size", async () => {
  const { provider } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  // Not text: every byte value, then enough to pass any small fixed cap.
  const bytes = new Uint8Array(10_000).map((_, index) => index % 256);
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: '/work/out.bin', bytes, mode: 0o644 };
    })(),
    signal(),
  );
  let markers = 0;
  const run = (maxOutputBytes: number) => {
    markers += 1;
    return provider.exec(
      handle,
      {
        marker: `act_01J0MARITIMEOUTPUT${String(markers).padStart(4, '0')}`,
        argv: ['cat', '/work/out.bin'],
        cwd: '/work',
        timeoutMs: 5_000,
        maxOutputBytes,
      },
      signal(),
    );
  };
  const whole = await run(256 * 1024);
  expect(whole).toMatchObject({
    state: 'exited',
    exitCode: 0,
    totalBytes: 10_000,
    captureLimited: false,
  });
  expect(Buffer.from(whole.output).equals(Buffer.from(bytes))).toBe(true);
  const cut = await run(100);
  expect(cut).toMatchObject({ exitCode: 0, totalBytes: 10_000, captureLimited: true });
  expect(Buffer.from(cut.output).equals(Buffer.from(bytes.slice(0, 100)))).toBe(true);
  const none = await run(0);
  expect(none).toMatchObject({ exitCode: 0, totalBytes: 10_000, captureLimited: true });
  expect(none.output.byteLength).toBe(0);
  await provider.destroy(handle, signal());
});

test('a computer that goes away under a running command ends the wait at once', async () => {
  let gone = false;
  const { provider } = standinProvider(async (url, init, response) => {
    const poll =
      url.pathname.endsWith('/exec') &&
      typeof init.body === 'string' &&
      init.body.includes('.rc') &&
      !init.body.includes('melete-launch');
    if (!gone || !poll) return response;
    await response.body?.cancel().catch(() => {});
    return new Response(JSON.stringify({ error: 'not_found', message: 'computer not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  const handle = await openSandbox(provider, spec(), signal());
  gone = true;
  const started = performance.now();
  const lost = await provider
    .exec(
      handle,
      {
        marker: 'act_01J0MARITIMEGONE0000000',
        argv: ['sh', '-c', 'sleep 3'],
        cwd: '/work',
        timeoutMs: 120_000,
        maxOutputBytes: 4096,
      },
      signal(),
    )
    .catch((error: unknown) => error);
  expect(lost).toBeInstanceOf(SandboxTransportError);
  expect((lost as SandboxTransportError).started).toBe('yes');
  expect(performance.now() - started).toBeLessThan(10_000);
}, 30_000);

test("stdin and a command's own environment reach it in files, never in its words", async () => {
  const { provider, sent } = standinProvider();
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-maritime-env-'));
  try {
    const handle = await openSandbox(provider, spec(), signal());
    const result = await runCommand({
      provider,
      handle,
      request: {
        marker: 'act_01J0MARITIMEENV00000000',
        argv: ['sh', '-c', 'read line; printf "%s|%s|%s" "$line" "$TZ" "$LANG"'],
        stdin: new TextEncoder().encode('from stdin\n'),
        env: { TZ: 'Europe/Paris' },
        timeoutMs: 20_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_MARITIMEENV',
      signal: signal(),
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded')
      expect(new TextDecoder().decode(result.record.preview)).toBe('from stdin|Europe/Paris|');
    for (const request of sent.filter((each) => each.url.pathname.endsWith('/exec')))
      expect(request.body?.includes('Europe/Paris') ?? false).toBe(false);
    await provider.destroy(handle, signal());
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('files above 8 MiB are refused clearly, and smaller ones land outside the API roots', async () => {
  const { provider, standin } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  const one = async function* (bytes: Uint8Array, at = '/work/big.bin') {
    yield { path: at, bytes, mode: 0o644 };
  };
  const big = await provider
    .putFiles(handle, one(new Uint8Array(MARITIME_FILE_LIMIT + 1)), signal())
    .catch((error: unknown) => error);
  expect(big).toBeInstanceOf(SandboxAdapterRefusal);
  expect(String(big)).toContain('8 MiB');
  await provider.putFiles(handle, one(new TextEncoder().encode('hi'), '/work/a/b/c.txt'), signal());
  await provider.putFiles(handle, one(new TextEncoder().encode('etc'), '/tmp/x/y.txt'), signal());
  expect(
    new TextDecoder().decode(await provider.getFile(handle, '/work/a/b/c.txt', 64, signal())),
  ).toBe('hi');
  expect(
    new TextDecoder().decode(await provider.getFile(handle, '/tmp/x/y.txt', 2, signal())),
  ).toBe('et');
  expect(
    await provider.getFile(handle, '/work/missing', 64, signal()).catch((error) => error),
  ).toBeInstanceOf(SandboxFileNotFound);
  const listed = await provider.listFiles(handle, '/work', signal());
  expect(listed.map((entry) => entry.path).sort()).toEqual(['a', 'a/b', 'a/b/c.txt']);
  // A file larger than one transfer can still be read up to the cap, not past it.
  standin.engine
    .get(handle.providerSandboxId)
    ?.fs.writeFile('/data/work/huge.bin', new Uint8Array(MARITIME_FILE_LIMIT + 10));
  expect((await provider.getFile(handle, '/work/huge.bin', 1024, signal())).byteLength).toBe(1024);
  expect(
    await provider
      .getFile(handle, '/work/huge.bin', MARITIME_FILE_LIMIT * 2, signal())
      .catch((error) => error),
  ).toBeInstanceOf(SandboxAdapterRefusal);
  await provider.destroy(handle, signal());
});

test('sleep keeps the computer, wake brings the same one back, and a deleted one is gone', async () => {
  const { provider } = standinProvider();
  const pause = provider.pause as NonNullable<typeof provider.pause>;
  const resume = provider.resume as NonNullable<typeof provider.resume>;
  const handle = await openSandbox(provider, spec(), signal(), 'pause');
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: '/work/kept.txt', bytes: new TextEncoder().encode('kept'), mode: 0o644 };
    })(),
    signal(),
  );
  const { resumeRef } = await pause(handle, signal());
  expect(resumeRef).toBe(handle.providerSandboxId);
  expect(await provider.inspect(handle, signal())).toBe('paused');
  const resumed = await resume(resumeRef, spec(), signal());
  expect(resumed.providerSandboxId).toBe(handle.providerSandboxId);
  expect(await provider.inspect(resumed, signal())).toBe('running');
  expect(
    new TextDecoder().decode(await provider.getFile(resumed, '/work/kept.txt', 64, signal())),
  ).toBe('kept');
  await provider.destroy(resumed, signal());
  expect(await provider.inspect(resumed, signal())).toBe('gone');
  expect(await pause(resumed, signal()).catch((error: unknown) => error)).toBeInstanceOf(
    SandboxGone,
  );
  expect(await resume(resumeRef, spec(), signal()).catch((error: unknown) => error)).toBeInstanceOf(
    SandboxGone,
  );
});

test('desktop commands map onto Maritime actions, and what has none is refused', () => {
  expect(isMaritimeProvider(createMaritimeProvider({ credential: (use) => use('x') }))).toBe(true);
  expect(maritimeActionsFor({ kind: 'click', x: 10, y: 20, button: 1, count: 1 })).toEqual([
    { action: 'left_click', coordinate: [10, 20] },
  ]);
  expect(maritimeActionsFor({ kind: 'click', x: 1, y: 2, button: 3, count: 1 })).toEqual([
    { action: 'right_click', coordinate: [1, 2] },
  ]);
  expect(maritimeActionsFor({ kind: 'click', x: 1, y: 2, button: 1, count: 2 })[0]?.action).toBe(
    'double_click',
  );
  expect(maritimeActionsFor({ kind: 'click', x: 1, y: 2, button: 1, count: 3 })[0]?.action).toBe(
    'triple_click',
  );
  expect(() => maritimeActionsFor({ kind: 'click', x: 1, y: 2, button: 3, count: 2 })).toThrow(
    SandboxAdapterRefusal,
  );
  expect(maritimeActionsFor({ kind: 'type', text: 'hello' })).toEqual([
    { action: 'type', text: 'hello' },
  ]);
  expect(maritimeActionsFor({ kind: 'key', keys: ['ctrl+l', 'Return'] })).toEqual([
    { action: 'key', text: 'ctrl+l' },
    { action: 'key', text: 'Return' },
  ]);
  expect(maritimeActionsFor({ kind: 'scroll', x: 5, y: 6, dy: -3 })).toEqual([
    { action: 'scroll', coordinate: [5, 6], scrollDirection: 'up', scrollAmount: 3 },
  ]);
  expect(maritimeActionsFor({ kind: 'screenshot' })).toEqual([{ action: 'screenshot' }]);
  expect(() => maritimeActionsFor({ kind: 'open', url: 'https://example.com' })).toThrow(
    SandboxAdapterRefusal,
  );
});

test('viewer links: watch to look, control to take the wheel', async () => {
  const { provider, sent, standin } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  const watch = await provider.viewerLink(handle, { mode: 'watch' }, signal());
  expect(watch.mode).toBe('watch');
  expect(watch.url).toMatch(/^https:\/\//);
  const control = await provider.viewerLink(
    handle,
    { mode: 'control', ttlSeconds: 300, reason: 'sign in to the bank' },
    signal(),
  );
  expect(control.mode).toBe('control');
  expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toEqual({
    mode: 'control',
    ttlS: 300,
    reason: 'sign in to the bank',
  });
  expect(
    await provider.viewerLink(handle, { mode: 'watch', ttlSeconds: 5 }, signal()).catch((e) => e),
  ).toBeInstanceOf(SandboxAdapterRefusal);
  // A link that lets someone drive the desktop is short-lived: five minutes unless asked, ten at most.
  await provider.viewerLink(handle, { mode: 'control' }, signal());
  expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toEqual({ mode: 'control', ttlS: 300 });
  const asked = sent.length;
  expect(
    await provider
      .viewerLink(handle, { mode: 'control', ttlSeconds: 3600 }, signal())
      .catch((e) => e),
  ).toBeInstanceOf(SandboxAdapterRefusal);
  expect(sent.length).toBe(asked);
  expect(
    (await provider.viewerLink(handle, { mode: 'watch', ttlSeconds: 3600 }, signal())).mode,
  ).toBe('watch');
  const shot = await provider.screenshot(handle, signal());
  expect(shot).toMatchObject({ type: 'image/png', width: 1200, height: 750, frameId: 1 });
  // Ending the session ends every link it handed out; a person holding the desktop lets go.
  standin.hold(handle.providerSandboxId);
  await provider.endViewers(handle, signal());
  expect(sent.at(-1)?.url.pathname).toEndWith(`/${handle.providerSandboxId}/sessions/close`);
  expect(standin.closed).toEqual([handle.providerSandboxId]);
  // Closing the session leaves a person holding the desktop until they press Done.
  expect(await provider.holder(handle, signal())).toBe('human');
  standin.hold(handle.providerSandboxId, false);
  expect(await provider.holder(handle, signal())).toBe('agent');
  expect(
    await provider.act(handle, maritimeActionsFor({ kind: 'key', keys: ['Return'] }), signal()),
  ).toMatchObject({ action: 'key', ok: true });
  await provider.destroy(handle, signal());
});

test('ending the viewers of a computer already gone is not an error', async () => {
  const { provider } = standinProvider();
  const handle = await openSandbox(provider, spec(), signal());
  await provider.destroy(handle, signal());
  await provider.endViewers(handle, signal());
});

test('the adapter reads no credential or setting from its own environment', async () => {
  const source = await readFile(new URL('./maritime.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('process.env');
  expect(source).not.toContain('Bun.env');
});
