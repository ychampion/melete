import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAKE_CAPABILITIES, FakeSandboxProvider } from './fake.ts';
import {
  checkMarker,
  checkMarkerRoot,
  keptFor,
  launchScript,
  MARKER_RETENTION_DAYS,
  MARKER_SETUP_EXIT,
  markCommand,
  previewOf,
  REENTERED_EXIT,
  reattachByMarker,
  runCommand,
  settleOutcome,
  VAR_TMP_MARKER_ROOT,
} from './marker.ts';
import {
  type SandboxHandle,
  type SandboxProvider,
  SandboxStartRefused,
  SandboxTransportError,
} from './types.ts';

const MARKER = 'act_01J0MARKERTEST0000000000';
/** The exec wrapper as the recorded provider fixtures hold it, for the inputs in its test. */
const EXEC_WRAPPER_SHA256 = '42f6d2d930783b2e400c2dedd8bf26a108b82a0fa0e09881b1af5160aa71fef6';
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

const putFile = (provider: FakeSandboxProvider, handle: SandboxHandle, path: string) =>
  provider.putFiles(
    handle,
    (async function* () {
      yield { path, bytes: new Uint8Array([1]), mode: 0o644 };
    })(),
    signal(),
  );

test('a wrapper that ends without a marker is a retryable failure, not a record', async () => {
  const { provider, handle } = await sandbox();
  // Neither root can be made: files hold the names on the way to both.
  await putFile(provider, handle, MARKER_ROOT.slice(0, MARKER_ROOT.lastIndexOf('/')));
  await putFile(provider, handle, VAR_TMP_MARKER_ROOT);
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
    // Each value fits; together they pass the total.
    Object.fromEntries(
      [
        'GH_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_ACCESS_KEY_ID',
        'SSL_CERT_FILE',
        'CURL_CA_BUNDLE',
      ].map((name) => [name, 'x'.repeat(4000)]),
    ),
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

test('a marker root that was replaced by a file or made unwritable is made again, and the command runs', async () => {
  const { provider, handle } = await sandbox();
  await putFile(provider, handle, MARKER_ROOT);
  const replaced = await runWith(provider, handle, ['printf', 'ran']);
  expect(replaced.outcome).toBe('succeeded');
  expect(text(await provider.getFile(handle, `${MARKER_ROOT}/${MARKER}/out`, 64, signal()))).toBe(
    'ran',
  );
  const locked = await sandbox();
  await runCommand({
    provider: locked.provider,
    handle: locked.handle,
    request: {
      marker: 'act_01J0MARKERTEST0000000009',
      argv: ['true'],
      timeoutMs: 5_000,
      dispatch: 'first',
    },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  // chmod 000 on the root: the next command repairs it rather than reporting itself re-entered.
  const chmod = await locked.provider.exec(
    locked.handle,
    {
      marker: 'x',
      argv: ['chmod', '000', MARKER_ROOT],
      cwd: '/',
      timeoutMs: 5_000,
      maxOutputBytes: 64,
    },
    signal(),
  );
  expect(chmod.exitCode).toBe(0);
  const again = await runWith(locked.provider, locked.handle, ['printf', 'ran']);
  expect(again.outcome).toBe('succeeded');
});

test('when the marker root cannot be made again, the marker goes under /var/tmp and is still read', async () => {
  const { provider, handle } = await sandbox();
  // A file where the root's parent should be: nothing under it can be made.
  await putFile(provider, handle, MARKER_ROOT.slice(0, MARKER_ROOT.lastIndexOf('/')));
  const result = await runWith(provider, handle, ['printf', 'kept aside']);
  expect(result.outcome).toBe('succeeded');
  if (result.outcome === 'succeeded') expect(text(result.record.preview)).toBe('kept aside');
  expect(
    text(await provider.getFile(handle, `${VAR_TMP_MARKER_ROOT}/${MARKER}/out`, 64, signal())),
  ).toBe('kept aside');
  const again = await runWith(provider, handle, ['true'], { dispatch: 'again' });
  expect(again).toMatchObject({ outcome: 'succeeded', reattached: true });
});

test("a command's kept output never exceeds the capture limit, and the rest is read and dropped", async () => {
  const { provider, handle } = await sandbox();
  const result = await runCommand({
    provider,
    handle,
    request: {
      marker: MARKER,
      argv: ['sh', '-c', 'head -c 300000 /dev/zero; printf done > /work/after'],
      timeoutMs: 5_000,
      dispatch: 'first',
    },
    workRoot: await mkdtemp(path.join(tmpdir(), 'melete-marker-')),
    jobId: 'job_UNUSED',
    signal: signal(),
    limits: { maxCaptureBytes: 1_000, maxOutputBytes: 1_000 },
  });
  expect(result.outcome).toBe('succeeded');
  if (result.outcome !== 'succeeded') return;
  expect(result.record.exitCode).toBe(0);
  expect(result.record.outputBytes).toBe(1_000);
  expect(result.record.captureLimited).toBe(true);
  const listed = await provider.listFiles(handle, `${MARKER_ROOT}/${MARKER}`, signal());
  expect(listed.find((entry) => entry.path === 'out')?.size).toBe(1_001);
  expect(listed.map((entry) => entry.path).sort()).toEqual(['exit', 'out']);
  // The command was not cut short by the cap: it went on past its output.
  expect(text(await provider.getFile(handle, '/work/after', 16, signal()))).toBe('done');
  // What is shown last is not how it ended, and a last line says so, within the cap.
  expect(result.record.truncated).toBe(true);
  expect(result.record.preview.byteLength).toBeLessThanOrEqual(1_000);
  expect(
    text(result.record.preview)
      .trimEnd()
      .endsWith(
        'the rest was not kept; what was kept is at .melete/exec/act_01J0MARKERTEST0000000000.out⟧',
      ),
  ).toBe(true);
});

test("a command's marker is removed by the next command once its outcome is recorded", async () => {
  const { provider, handle } = await sandbox();
  const FIRST = 'act_01J0MARKERTEST0000000002';
  const first = await runCommand({
    provider,
    handle,
    request: { marker: FIRST, argv: ['printf', 'first'], timeoutMs: 5_000, dispatch: 'first' },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  expect(first.outcome).toBe('succeeded');
  expect((await provider.listFiles(handle, MARKER_ROOT, signal())).map((e) => e.path)).toContain(
    FIRST,
  );
  const second = await runCommand({
    provider,
    handle,
    request: {
      marker: MARKER,
      argv: ['printf', 'second'],
      timeoutMs: 5_000,
      dispatch: 'first',
      forget: [FIRST],
    },
    workRoot: '.',
    jobId: 'job_UNUSED',
    signal: signal(),
  });
  expect(second.outcome).toBe('succeeded');
  const left = (await provider.listFiles(handle, MARKER_ROOT, signal()))
    .filter((entry) => !entry.path.includes('/'))
    .map((entry) => entry.path);
  expect(left).toEqual([MARKER]);
  expect(await reattachByMarker(provider, handle, FIRST, signal())).toBeNull();
});

test('every command prunes markers untouched for the retention period, and never its own', () => {
  const [, , script] = markCommand(MARKER_ROOT, MARKER, ['true'], {
    forget: [MARKER, 'act_01J0MARKERTEST0000000003'],
  });
  const lines = (script ?? '').split('\n');
  const prune = lines.findIndex((line) => line.startsWith('find "$r"'));
  const own = lines.findIndex((line) => line.startsWith('mkdir "$d"'));
  expect(lines[prune]).toBe(
    `find "$r" -mindepth 1 -maxdepth 1 -type d -mtime +${MARKER_RETENTION_DAYS - 1} -exec rm -rf -- {} + 2>/dev/null`,
  );
  // Pruned before this command's own marker exists, and a forget list never names it.
  expect(prune).toBeLessThan(own);
  expect(script).toContain('rm -rf -- "$r/act_01J0MARKERTEST0000000003" 2>/dev/null');
  expect(script).not.toContain(`"$r/${MARKER}" 2>/dev/null`);
  expect(() => markCommand(MARKER_ROOT, MARKER, ['true'], { forget: ['../home'] })).toThrow();
});

test("the stage that keeps a command's output runs in a session of its own, so a timeout's kill spares it", () => {
  const [, , script] = markCommand(MARKER_ROOT, MARKER, ['sleep', '9'], { keepBytes: 10 });
  const line = (script ?? '').split('\n').find((each) => each.includes('"$d/status"; }'));
  expect(line).toBeDefined();
  // The command and its status on the left; the keeping stage, in a new session, on the right.
  expect(line?.split(' | ')[1]).toBe(
    `setsid -w sh -c 'head -c "$1"; exec cat > /dev/null' melete-keep 10; } > "$d/out"`,
  );
  // `out` is opened by the group around both stages, before the command starts, and by
  // nothing else: no stage creates a file in the marker while the command can remove it.
  expect(line?.startsWith('{ { ( ')).toBe(true);
  expect((script ?? '').match(/"\$d\/out"/g)).toHaveLength(1);
});

test("the wrapper a provider's exec runs is the one its recorded fixtures hold", () => {
  // Recorded exchanges match on a hash of the request body, so a byte changed
  // here would make every recorded command unmatched.
  const [, , script] = markCommand(MARKER_ROOT, MARKER, ['sh', '-c', 'echo hi'], {
    keepBytes: 4_194_305,
    forget: ['act_01J0MARKERTEST0000000003'],
  });
  expect(new Bun.CryptoHasher('sha256').update(script ?? '').digest('hex')).toBe(
    EXEC_WRAPPER_SHA256,
  );
  expect(script).not.toContain('/dev/fd/3');
  expect(script).not.toContain('memory.events');
});

test("a process's wrapper keeps the start and the end", () => {
  const [, , script] = markCommand(MARKER_ROOT, MARKER, ['sleep', '9'], {
    asProcess: { head: 4, tail: 6 },
  });
  const line = (script ?? '').split('\n').find((each) => each.includes('"$d/status"; }'));
  // Descriptor 3 is the launcher's output: the keeping stage copies to it.
  expect(line?.startsWith(`{ { ( 'sleep' '9' ) 2>&1; `)).toBe(true);
  expect(line?.split(' | ').slice(1).join(' | ')).toBe(
    `setsid -w sh -c 'trap '\\'''\\'' PIPE; tee /dev/fd/3 | { head -c "$1"; exec tail -c "$2"; }' melete-keep 4 7; } 3>&1 > "$d/out"`,
  );
  // Its layout is said by a file made before the command starts, as `out` is.
  const lines = (script ?? '').split('\n');
  expect(lines.indexOf(': > "$d/ends"')).toBeGreaterThan(-1);
  expect(lines.indexOf(': > "$d/ends"')).toBeLessThan(lines.indexOf(line ?? ''));
});

test('a command that removes its own marker leaves it removed, with no status written after it', async () => {
  const { provider, handle } = await sandbox();
  const result = await runWith(provider, handle, [
    'sh',
    '-c',
    `rm -rf ${MARKER_ROOT}/${MARKER}; printf once`,
  ]);
  expect(result.outcome).toBe('unknown');
  expect(await reattachByMarker(provider, handle, MARKER, signal())).toBeNull();
});

/** Put files into the fake sandbox, as a sync or a seed would. */
async function seed(
  provider: FakeSandboxProvider,
  handle: SandboxHandle,
  files: Record<string, string>,
) {
  await provider.putFiles(
    handle,
    (async function* () {
      for (const [where, body] of Object.entries(files))
        yield { path: where, bytes: new TextEncoder().encode(body), mode: 0o644 };
    })(),
    signal(),
  );
}

/**
 * Run a command as a process's launcher does: its wrapper (`launchScript`)
 * run whole, then settled from its marker. The provider's exec stands in for
 * the launcher, and what the launcher saw goes to `settleOutcome`.
 */
const runIn = async (
  provider: FakeSandboxProvider,
  handle: SandboxHandle,
  script: string,
  more: { timeoutMs?: number; limits?: { maxCaptureBytes?: number; maxOutputBytes?: number } } = {},
) => {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-marker-'));
  const options = {
    provider,
    handle,
    request: {
      marker: MARKER,
      argv: ['sh', '-c', script],
      timeoutMs: more.timeoutMs ?? 5_000,
      dispatch: 'first' as const,
    },
    workRoot,
    jobId: 'job_UNUSED',
    signal: signal(),
    ...(more.limits ? { limits: more.limits } : {}),
  };
  const launched = await provider.exec(
    handle,
    {
      marker: MARKER,
      argv: [
        '/bin/sh',
        '-c',
        launchScript(MARKER_ROOT, options.request, { keep: keptFor(options), envFile: null }),
      ],
      cwd: '/work',
      timeoutMs: options.request.timeoutMs,
      maxOutputBytes: 4096,
    },
    signal(),
  );
  const result = await settleOutcome(options, launched);
  if (result.outcome !== 'succeeded') throw new Error(`not recorded: ${JSON.stringify(result)}`);
  return { record: result.record, workRoot };
};

test('output that does not fit is shown as its start and its end, with what was left out counted', async () => {
  const { provider, handle } = await sandbox();
  const lines = Array.from({ length: 3000 }, (_, index) => `ok test_${index + 1}\n`).join('');
  const failure = 'FAILED test_checkout_rounding: expected 10.00, got 9.99\n';
  await seed(provider, handle, { '/work/run.log': lines + failure });
  const { record, workRoot } = await runIn(provider, handle, 'cat /work/run.log; exit 1');
  expect(record.exitCode).toBe(1);
  expect(record.stoppedBy).toBe('exit');
  expect(record.truncated).toBe(true);
  expect(record.captureLimited).toBe(false);
  const shown = text(record.preview);
  // The start and the end are both there, each on whole lines.
  expect(shown.startsWith('ok test_1\nok test_2\n')).toBe(true);
  expect(shown.endsWith(failure)).toBe(true);
  // One line between them says how much was left out, and where all of it is.
  const separator = shown.split('\n').find((line) => line.startsWith('⟦melete:'));
  expect(separator).toBe(
    `⟦melete: ${record.elidedBytes} bytes (${record.elidedLines} lines) of output left out here; the kept output is at ${record.outputPath}⟧`,
  );
  const [head = '', tail = ''] = shown.split(`${separator}\n`);
  expect(head.length).toBeLessThanOrEqual(4096);
  expect(tail.length).toBeLessThanOrEqual(12_288);
  expect(head.length + tail.length + record.elidedBytes).toBe(record.outputBytes);
  expect(record.elidedLines).toBe(
    (lines + failure).split('\n').length -
      1 -
      head.split('\n').length -
      tail.split('\n').length +
      2,
  );
  // Nothing printed is mistaken for the line, and the stored copy is the whole output.
  expect(shown.match(/⟦melete:/g)).toHaveLength(1);
  const stored = await readFile(path.join(workRoot, 'job_UNUSED', record.outputPath ?? ''), 'utf8');
  expect(stored).toBe(lines + failure);
});

test('output that fits is shown whole, with nothing left out', async () => {
  const { provider, handle } = await sandbox();
  const { record } = await runIn(provider, handle, 'printf "one\ntwo\n"');
  expect(text(record.preview)).toBe('one\ntwo\n');
  expect(record).toMatchObject({
    truncated: false,
    elidedBytes: 0,
    elidedLines: 0,
    outputPath: null,
    stoppedBy: 'exit',
  });
});

test('above the capture limit the start and the newest output are kept, never only the first bytes', async () => {
  const { provider, handle } = await sandbox();
  const body = Array.from(
    { length: 500 },
    (_, index) => `line ${String(index).padStart(4, '0')}\n`,
  );
  await seed(provider, handle, { '/work/big.log': body.join('') });
  const { record, workRoot } = await runIn(provider, handle, 'cat /work/big.log', {
    limits: { maxCaptureBytes: 1_000, maxOutputBytes: 400 },
  });
  // 5,000 bytes printed: the first 100 and the newest 900 are kept.
  expect(record.outputBytes).toBe(1_000);
  expect(record.captureLimited).toBe(true);
  expect(record.totalBytes).toBeGreaterThan(record.outputBytes);
  const stored = await readFile(path.join(workRoot, 'job_UNUSED', record.outputPath ?? ''), 'utf8');
  const all = body.join('');
  expect(stored).toBe(all.slice(0, 100) + all.slice(-900));
  const shown = text(record.preview);
  expect(shown.startsWith('line 0000\n')).toBe(true);
  expect(shown.endsWith('line 0499\n')).toBe(true);
  // More was dropped before capture than can be counted, and the line says so.
  expect(shown).toContain('⟦melete: at least ');
});

test('a command past its time is stopped by the timeout, and its receipt says so', async () => {
  const { provider, handle } = await sandbox();
  const { record } = await runIn(provider, handle, 'printf started; sleep 5', { timeoutMs: 300 });
  expect(record).toMatchObject({ timedOut: true, exitCode: null, stoppedBy: 'timeout' });
  expect(record.memoryLimitBytes).toBeNull();
});

test("a command killed for memory says so, with the computer's limit", async () => {
  const { provider, handle } = await sandbox();
  await seed(provider, handle, {
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 4\noom 1\noom_kill 0\n',
    '/sys/fs/cgroup/memory.max': '536870912\n',
  });
  const { record } = await runIn(
    provider,
    handle,
    "printf 'low 0\nhigh 0\nmax 9\noom 2\noom_kill 1\n' > /sys/fs/cgroup/memory.events; exit 137",
  );
  expect(record).toMatchObject({
    exitCode: 137,
    stoppedBy: 'memory_limit',
    memoryLimitBytes: 536_870_912,
  });
});

test('an exit 137 the memory count does not explain is an ordinary exit', async () => {
  const { provider, handle } = await sandbox();
  await seed(provider, handle, {
    '/sys/fs/cgroup/memory.events': 'oom_kill 3\n',
    '/sys/fs/cgroup/memory.max': 'max\n',
  });
  const { record } = await runIn(provider, handle, 'exit 137');
  expect(record).toMatchObject({ exitCode: 137, stoppedBy: 'exit', memoryLimitBytes: null });
});

test('a preview, the line between its parts included, never goes past the cap', () => {
  // Every byte the same, as the conformance check prints: the parts fill the cap exactly.
  const zeros = previewOf(new Uint8Array(70_000), {
    maxOutputBytes: 16_384,
    gap: false,
    path: '.melete/exec/x.out',
  });
  expect(zeros.preview.byteLength).toBe(16_384);
  expect(zeros.elidedBytes + zeros.preview.byteLength).toBeGreaterThan(70_000 - 16_384);
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  const alphabet = new TextEncoder().encode('ab\n€é');
  for (let round = 0; round < 300; round += 1) {
    const size = next() % 60_000;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1)
      bytes[index] = alphabet[next() % alphabet.byteLength] ?? 0x61;
    const max = [200, 1_000, 16_384][round % 3] ?? 16_384;
    for (const flags of [
      { gap: false, cut: false },
      { gap: true, cut: false },
      { gap: false, cut: true },
    ]) {
      const { preview } = previewOf(bytes, {
        maxOutputBytes: max,
        ...flags,
        path: round % 2 ? '.melete/exec/act.out' : null,
      });
      expect(preview.byteLength).toBeLessThanOrEqual(max);
      if (size <= max && !flags.gap && !flags.cut) expect(preview).toEqual(bytes);
    }
  }
});
