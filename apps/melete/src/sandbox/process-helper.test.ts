/**
 * The process helper itself, run for real by `python3` on this machine through
 * a provider whose `exec` is a local process. It needs Linux (`setsid`,
 * `/proc`); elsewhere it is skipped. `MELETE_TEST_LINUX_PREFIX` runs every
 * command under a prefix such as `wsl -e`, for a Linux shell on another host.
 *
 * The machine has no `melete-proc` on its path, so every call here also
 * proves the fallback: the service sends the helper's source to `python3`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  helperComputer,
  type ProcessComputer,
  ProcessHelperRefusal,
  processRoot,
} from './process-helper.ts';
import type { ExecOutcome, ExecSpec, SandboxHandle, SandboxProvider } from './types.ts';

const prefix = process.env.MELETE_TEST_LINUX_PREFIX?.split(' ').filter(Boolean) ?? [];
const linux = process.platform === 'linux' || prefix.length > 0;
const base = `/tmp/melete-proc-test-${randomBytes(6).toString('hex')}`;
const signal = () => AbortSignal.timeout(60_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Run a command on this machine, the way an adapter runs one in a sandbox. */
async function run(
  argv: readonly string[],
  timeoutMs: number,
  limit: number,
): Promise<ExecOutcome> {
  const started = Date.now();
  const child = Bun.spawn([...prefix, ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  const code = await child.exited;
  clearTimeout(timer);
  const output = new Uint8Array([...new Uint8Array(out), ...new Uint8Array(err)]);
  return {
    started: 'yes',
    state: 'exited',
    exitCode: code,
    signal: null,
    timedOut: false,
    durationMs: Date.now() - started,
    output: output.slice(0, limit),
    totalBytes: output.byteLength,
    captureLimited: output.byteLength > limit,
  };
}

const local = {
  capabilities: { adapter: 'local', markerRoot: `${base}/exec` },
  exec: (_handle: SandboxHandle, spec: ExecSpec) =>
    run(spec.argv, spec.timeoutMs, spec.maxOutputBytes),
} as unknown as SandboxProvider;

const handle: SandboxHandle = { providerSandboxId: 'local', imageDigest: null, region: null };
const shell = (script: string) => run(['/bin/sh', '-c', script], 30_000, 65_536);

const start = (computer: ProcessComputer, id: string, command: string, halfBytes = 4096) =>
  computer.start(
    { id, cwd: '/tmp', command, halfBytes, waitMs: 2_000, firstMaxBytes: 4096 },
    signal(),
  );

const waitFor = async (check: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error('the condition was not met in time');
};

const withLinux = linux ? describe : describe.skip;

withLinux('the process helper in a computer', () => {
  const computer = helperComputer(local, handle);
  const root = processRoot(local.capabilities);

  afterAll(async () => {
    await shell(
      `for d in ${root}/*/; do [ -f "$d/sid" ] && pkill -KILL -s "$(cat "$d/sid")"; done; rm -rf ${base}`,
    );
  });

  test('its root sits beside the command markers', () => {
    expect(processRoot({ markerRoot: '/home/agent/.melete/exec' })).toBe(
      '/home/agent/.melete/proc',
    );
    expect(processRoot({ markerRoot: '/var/tmp/.melete-exec' })).toBe('/var/tmp/.melete-exec-proc');
  });

  test('process output is a ring of the configured size, and a read past it says what was dropped', async () => {
    const started = await start(
      computer,
      'prc_ring',
      'for i in $(seq 1 400); do echo "line-$i-0123456789"; done',
      1000,
    );
    if (started.outcome !== 'started') throw new Error('expected a start');
    await waitFor(
      async () => (await computer.status(['prc_ring'], signal())).processes[0]?.state === 'exited',
    );
    const status = await computer.status(['prc_ring'], signal());
    const facts = status.processes[0];
    // 400 lines of 20 or so bytes: far more than the two 1000-byte halves.
    expect(facts?.cursor).toBeGreaterThan(7_000);
    expect(facts?.exit_code).toBe(0);
    expect(facts?.last_line).toBe('line-400-0123456789');
    const all = await computer.read('prc_ring', 0, 65_536, 0, signal());
    expect(all.read.dropped).toBe(all.read.from);
    expect(all.read.from).toBeGreaterThan(0);
    expect(all.data.byteLength).toBeLessThanOrEqual(2000);
    expect(all.read.next).toBe(facts?.cursor ?? -1);
    expect(text(all.data).trimEnd().endsWith('line-400-0123456789')).toBe(true);
    // The newest bytes, without a cursor.
    const tail = await computer.read('prc_ring', -1, 20, 0, signal());
    expect(text(tail.data)).toBe('line-400-0123456789\n');
  }, 60_000);

  test('a cursor continues where the last read ended, and a read waits for new output', async () => {
    const started = await start(computer, 'prc_slow', 'echo first; sleep 3; echo second; sleep 30');
    if (started.outcome !== 'started') throw new Error('expected a start');
    expect(text(started.data)).toBe('first\n');
    const next = await computer.read('prc_slow', started.read.next, 4096, 5_000, signal());
    expect(text(next.data)).toBe('second\n');
    expect(next.process.state).toBe('running');
    await computer.stop('prc_slow', 1_000, signal());
  }, 60_000);

  test('starting the same id twice starts nothing the second time', async () => {
    const first = await start(computer, 'prc_once', 'echo once; sleep 30');
    expect(first.outcome).toBe('started');
    const second = await start(computer, 'prc_once', 'echo twice');
    expect(second.outcome).toBe('reentered');
    const read = await computer.read('prc_once', 0, 4096, 0, signal());
    expect(text(read.data)).toBe('once\n');
    await computer.stop('prc_once', 1_000, signal());
  }, 60_000);

  test('a stopped process records 143, and nothing of its session is left', async () => {
    const started = await start(computer, 'prc_stop', 'sleep 300 & sleep 300 & wait');
    if (started.outcome !== 'started') throw new Error('expected a start');
    expect(started.process.state).toBe('running');
    expect(started.process.members).toBeGreaterThanOrEqual(3);
    const stopped = await computer.stop('prc_stop', 5_000, signal());
    expect(stopped.process).toMatchObject({ state: 'exited', exit_code: 143, members: 0 });
  }, 60_000);

  test('a process that ignores TERM is killed once the grace has passed', async () => {
    await start(computer, 'prc_stubborn', "trap '' TERM; while true; do sleep 1; done");
    const stopped = await computer.stop('prc_stubborn', 500, signal());
    expect(stopped.process.members).toBe(0);
    expect(stopped.process.exit_code).toBe(137);
  }, 60_000);

  test('text written to a process reaches its input', async () => {
    await start(computer, 'prc_cat', 'cat');
    const { written } = await computer.write(
      'prc_cat',
      new TextEncoder().encode('typed in\n'),
      signal(),
    );
    expect(written).toBe(9);
    const read = await computer.read('prc_cat', 0, 4096, 5_000, signal());
    expect(text(read.data)).toBe('typed in\n');
    await computer.signal('prc_cat', 'INT', signal());
    await waitFor(
      async () => (await computer.status(['prc_cat'], signal())).processes[0]?.state === 'exited',
    );
    expect((await computer.status(['prc_cat'], signal())).processes[0]?.exit_code).toBe(130);
    // An ended process takes no more input.
    await expect(computer.write('prc_cat', new Uint8Array([10]), signal())).rejects.toBeInstanceOf(
      ProcessHelperRefusal,
    );
  }, 60_000);

  test('a process recorded under another boot is lost', async () => {
    await start(computer, 'prc_boot', 'sleep 300');
    await shell(`printf 'another:boot' > ${root}/prc_boot/boot`);
    const status = await computer.status('all', signal());
    expect(status.processes.find((each) => each.id === 'prc_boot')?.state).toBe('lost');
    expect(status.boot).not.toBe('another:boot');
    // The real process is still there under its session; clean it up by hand.
    await shell(`pkill -KILL -s "$(cat ${root}/prc_boot/sid)"`);
  }, 60_000);

  test('a server is reported with the port it listens on', async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    await start(computer, 'prc_server', `exec python3 -m http.server ${port} --bind 127.0.0.1`);
    await waitFor(async () =>
      ((await computer.status(['prc_server'], signal())).processes[0]?.ports ?? []).includes(port),
    );
    await computer.stop('prc_server', 2_000, signal());
    expect((await computer.status(['prc_server'], signal())).processes[0]?.ports).toEqual([]);
  }, 60_000);

  test('a command that cannot start ends with 127 and says why', async () => {
    const started = await computer.start(
      {
        id: 'prc_nowhere',
        cwd: '/no/such/directory',
        command: 'true',
        halfBytes: 4096,
        waitMs: 2_000,
        firstMaxBytes: 4096,
      },
      signal(),
    );
    if (started.outcome !== 'started') throw new Error('expected a start');
    expect(started.process).toMatchObject({ state: 'exited', exit_code: 127 });
    expect(text(started.data)).toContain('could not start');
  }, 60_000);
});
