import { expect, test } from 'bun:test';
import { FAKE_CAPABILITIES, FakeSandboxProvider } from './fake.ts';
import {
  checkMarker,
  checkMarkerRoot,
  MARKER_SETUP_EXIT,
  markCommand,
  REENTERED_EXIT,
  reattachByMarker,
  runCommand,
  VAR_TMP_MARKER_ROOT,
} from './marker.ts';
import {
  type SandboxHandle,
  type SandboxProvider,
  SandboxStartRefused,
  SandboxTransportError,
} from './types.ts';

const MARKER = 'act_01J0MARKERTEST0000000000';
const MARKER_ROOT = FAKE_CAPABILITIES.markerRoot;
const signal = () => AbortSignal.timeout(10_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function sandbox() {
  const provider = new FakeSandboxProvider();
  const handle = await provider.create(
    {
      image: 'base',
      egress: { kind: 'deny_all' },
      region: null,
      lifetimeSeconds: 60,
      idleSeconds: null,
      workdir: '/work',
      labels: {},
      env: {},
    },
    signal(),
  );
  return { provider, handle };
}

const exec = (provider: FakeSandboxProvider, handle: SandboxHandle, argv: string[]) =>
  provider.exec(
    handle,
    {
      marker: MARKER,
      argv: markCommand(MARKER_ROOT, MARKER, argv),
      cwd: '/work',
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    },
    signal(),
  );

test('a marker must be an action id, so it cannot reach outside the marker root', () => {
  expect(checkMarker(MARKER)).toBe(MARKER);
  for (const bad of ['', '../escape', 'act x', 'act;rm', 'a/b', 'x'.repeat(65)])
    expect(() => checkMarker(bad)).toThrow('a marker must be an action id');
  expect(() => markCommand(MARKER_ROOT, '../etc', ['true'])).toThrow();
});

test('a marker root must be an absolute path of plain segments', () => {
  expect(checkMarkerRoot('/home/agent/.melete/exec')).toBe('/home/agent/.melete/exec');
  for (const bad of ['', 'relative/exec', '/a/../b', '/a/./b', '/a b', '/a;rm', '/a/', '/'])
    expect(() => checkMarkerRoot(bad)).toThrow('a marker root must be an absolute path');
  expect(() => markCommand('/tmp/$(id)', MARKER, ['true'])).toThrow();
});

test('every admitted word is quoted, so the wrapper never interprets the command', async () => {
  const { provider, handle } = await sandbox();
  const hostile = "'; printf pwned > /work/owned; echo '";
  const wrapped = markCommand(MARKER_ROOT, MARKER, ['printf', '%s', hostile]);
  expect(wrapped.slice(0, 2)).toEqual(['/bin/sh', '-c']);
  const outcome = await exec(provider, handle, ['printf', '%s', hostile]);
  expect(outcome.exitCode).toBe(0);
  const out = await provider.getFile(handle, `${MARKER_ROOT}/${MARKER}/out`, 1024, signal());
  expect(text(out)).toBe(hostile);
  await expect(provider.getFile(handle, '/work/owned', 16, signal())).rejects.toThrow();
});

test('the marker table: no marker is null, a marker without exit is lost, an exit is exited', async () => {
  const { provider, handle } = await sandbox();
  expect(await reattachByMarker(provider, handle, MARKER, signal())).toBeNull();
  const pending = exec(provider, handle, ['sleep', '0.5']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await reattachByMarker(provider, handle, MARKER, signal()))?.state).toBe('lost');
  await pending;
  expect(await reattachByMarker(provider, handle, MARKER, signal())).toMatchObject({
    state: 'exited',
    exitCode: 0,
  });
});

test('the wrapper refuses to start a command whose marker already exists', async () => {
  const { provider, handle } = await sandbox();
  await exec(provider, handle, ['sh', '-c', 'printf x >> /work/count']);
  const second = await exec(provider, handle, ['sh', '-c', 'printf x >> /work/count']);
  expect(second.exitCode).toBe(REENTERED_EXIT);
  expect(text(await provider.getFile(handle, '/work/count', 16, signal()))).toBe('x');
});

test('a wrapper that ends without a marker is a retryable failure, not a record', async () => {
  const { provider, handle } = await sandbox();
  // The marker root cannot be created when a file already holds its name.
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: MARKER_ROOT, bytes: new Uint8Array([1]), mode: 0o644 };
    })(),
    signal(),
  );
  const result = await runCommand({
    provider,
    handle,
    request: { marker: MARKER, argv: ['true'], timeoutMs: 5_000, dispatch: 'first' },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  expect(result).toMatchObject({ outcome: 'failed', retryable: true });
});

test('an unreadable marker after a lost acknowledgement is unknown, never a retry', async () => {
  const { provider, handle } = await sandbox();
  provider.loseNextAcknowledgement('after_start');
  const broken = Object.create(provider) as FakeSandboxProvider;
  broken.reattach = async () => {
    throw new Error('the sandbox did not answer');
  };
  const result = await runCommand({
    provider: broken,
    handle,
    request: { marker: MARKER, argv: ['sleep', '0.4'], timeoutMs: 5_000, dispatch: 'first' },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  expect(result.outcome).toBe('unknown');
});

const run = (provider: SandboxProvider, handle: SandboxHandle, argv: string[]) =>
  runCommand({
    provider,
    handle,
    request: { marker: MARKER, argv, timeoutMs: 5_000, dispatch: 'first' },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });

test('a start the provider refused is a retryable failure', async () => {
  const { provider, handle } = await sandbox();
  const refusing = Object.create(provider) as FakeSandboxProvider;
  refusing.exec = async () => {
    throw new SandboxStartRefused('no such image');
  };
  expect(await run(refusing, handle, ['true'])).toMatchObject({
    outcome: 'failed',
    retryable: true,
  });
  // A lost answer is not a refusal, whatever the transport believes about the start.
  for (const started of ['unknown', 'yes', 'no'] as const) {
    const losing = Object.create(provider) as FakeSandboxProvider;
    losing.exec = async () => {
      throw new SandboxTransportError('the connection dropped', started);
    };
    expect((await run(losing, handle, ['true'])).outcome).toBe('unknown');
  }
});

test("a command that fakes the wrapper's setup failure is not a retry", async () => {
  const { provider, handle } = await sandbox();
  const result = await run(provider, handle, [
    'sh',
    '-c',
    `rm -rf ${MARKER_ROOT}/${MARKER}; exit ${MARKER_SETUP_EXIT}`,
  ]);
  expect(result.outcome).toBe('unknown');
  // Without the marker the command can only be found by what it did, and it did run.
  expect(await provider.reattach(handle, MARKER, signal())).toBeNull();
});

test("a command's own exit 111 or 112 is recorded as its own, never as the wrapper's", async () => {
  for (const status of [REENTERED_EXIT, MARKER_SETUP_EXIT]) {
    const { provider, handle } = await sandbox();
    const result = await run(provider, handle, ['sh', '-c', `printf ran; exit ${status}`]);
    expect(result).toMatchObject({ outcome: 'succeeded', late: false, reattached: false });
    if (result.outcome === 'succeeded') {
      expect(result.record.exitCode).toBe(status);
      expect(text(result.record.preview)).toBe('ran');
    }
  }
});

const runWith = (
  provider: SandboxProvider,
  handle: SandboxHandle,
  argv: string[],
  more: { env?: Record<string, string>; dispatch?: 'first' | 'again' } = {},
) =>
  runCommand({
    provider,
    handle,
    request: { marker: MARKER, argv, timeoutMs: 5_000, dispatch: 'first', ...more },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });

test("the marker is kept under the adapter's own root, made private to the sandbox user", async () => {
  const { provider, handle } = await sandbox();
  const result = await runWith(provider, handle, ['printf', 'kept']);
  expect(result.outcome).toBe('succeeded');
  expect(text(await provider.getFile(handle, `${MARKER_ROOT}/${MARKER}/out`, 64, signal()))).toBe(
    'kept',
  );
  const parent = MARKER_ROOT.slice(0, MARKER_ROOT.lastIndexOf('/'));
  const listed = await provider.listFiles(handle, parent, signal());
  expect(listed.find((entry) => entry.path === 'exec')).toMatchObject({
    directory: true,
    mode: 0o700,
  });
  await expect(provider.listFiles(handle, VAR_TMP_MARKER_ROOT, signal())).rejects.toThrow();
});

test('an attempt started before the upgrade that finds its marker under the old root is read from there', async () => {
  const { provider, handle } = await sandbox();
  // What the wrapper left before the root moved: the output and the exit record.
  const old = `${VAR_TMP_MARKER_ROOT}/${MARKER}`;
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: `${old}/out`, bytes: new TextEncoder().encode('from before'), mode: 0o644 };
      yield { path: `${old}/exit`, bytes: new TextEncoder().encode('0'), mode: 0o644 };
    })(),
    signal(),
  );
  expect(await reattachByMarker(provider, handle, MARKER, signal())).toMatchObject({
    state: 'exited',
    exitCode: 0,
  });
  const result = await runWith(provider, handle, ['true'], { dispatch: 'again' });
  expect(result).toMatchObject({ outcome: 'succeeded', late: true, reattached: true });
  if (result.outcome === 'succeeded') expect(text(result.record.preview)).toBe('from before');
});

test('an environment name outside the allow-list is refused before anything runs', async () => {
  const { provider, handle } = await sandbox();
  const refused: Record<string, string>[] = [
    { LD_PRELOAD: '/work/evil.so' },
    { PATH: '/work' },
    { MELETE_MASTER_KEY: 'x' },
    { https_proxy: 'http://cmd:token@melete-egress:8791', BASH_ENV: '/work/rc' },
    { TZ: `UTC${String.fromCharCode(0)}; rm -rf /work` },
    { GH_TOKEN: 'x'.repeat(4097) },
  ];
  for (const env of refused) {
    const before = provider.calls.exec;
    const result = await runWith(provider, handle, ['sh', '-c', 'printf ran >> /work/ran'], {
      env,
    });
    expect(result).toMatchObject({ outcome: 'failed', retryable: false });
    expect(provider.calls.exec).toBe(before);
  }
  await expect(provider.getFile(handle, '/work/ran', 16, signal())).rejects.toThrow();
  await expect(provider.listFiles(handle, MARKER_ROOT, signal())).rejects.toThrow();
});

test('an allowed environment is set on that command only', async () => {
  const { provider, handle } = await sandbox();
  const result = await runWith(
    provider,
    handle,
    ['sh', '-c', 'printf "%s|%s" "$TZ" "$GH_PROMPT_DISABLED"'],
    {
      env: { TZ: 'Europe/Paris', GH_PROMPT_DISABLED: '1' },
    },
  );
  expect(result.outcome).toBe('succeeded');
  if (result.outcome === 'succeeded') expect(text(result.record.preview)).toBe('Europe/Paris|1');
  const next = await runCommand({
    provider,
    handle,
    request: {
      marker: 'act_01J0MARKERTEST0000000001',
      argv: ['sh', '-c', 'printf "%s|%s" "$TZ" "$GH_PROMPT_DISABLED"'],
      timeoutMs: 5_000,
      dispatch: 'first',
    },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  if (next.outcome === 'succeeded') expect(text(next.record.preview)).toBe('|');
  else throw new Error(`the second command did not run: ${JSON.stringify(next)}`);
});
