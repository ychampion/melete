/**
 * The docker adapter on a real Docker engine. Skipped unless
 * `MELETE_SANDBOX_LIVE=docker`; never part of an ordinary run.
 *
 *   MELETE_SANDBOX_DOCKER_IMAGE   the image to run (default melete-sandbox:local, built from
 *                                 deploy/Dockerfile.sandbox)
 *   MELETE_DOCKER_SOCKET          the engine (default /var/run/docker.sock)
 *   MELETE_SANDBOX_LIVE_DESKTOP=0 an image without the desktop: the shell checks only
 *   DATABASE_URL                  also runs the workspace conformance suite
 *
 * Open egress needs this process to be a container on the same engine, as the
 * service is in the Compose deployment: run it in one with the socket mounted
 * and those checks run too. On a host they are skipped, and the shared suite
 * is run with the adapter declaring deny-all only, which is all it offers there.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxConformance } from '../conformance.ts';
import { serviceContainerId } from '../docker-default.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import type { EgressPolicy, SandboxHandle, SandboxProvider, SandboxSpec } from '../types.ts';
import { workspaceConformance } from '../workspace-conformance.ts';
import {
  DOCKER_SANDBOX_DEFAULTS,
  type DockerSandboxApi,
  DockerSandboxHost,
  type DockerSandboxSettings,
  DockerSandboxSocket,
} from './docker.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'docker';
const socket = process.env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock';
const image = process.env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local';
const withDesktop = process.env.MELETE_SANDBOX_LIVE_DESKTOP !== '0';
const selfId = serviceContainerId({ MELETE_RUNTIME_ADAPTER: 'docker' });
const PROJECT = `live${Date.now().toString(36)}`;
const signal = () => AbortSignal.timeout(180_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The engine, with the acknowledgement of the next command's exec lost on
 * purpose: before it started, or a moment after. The adapter's own execs (the
 * disk check, listings, reads) are never touched.
 */
class LossyDocker implements DockerSandboxApi {
  private readonly inner = new DockerSandboxSocket(socket);
  private readonly commands = new Set<string>();
  private lose: 'before_start' | 'after_start' | null = null;

  loseNext(when: 'before_start' | 'after_start') {
    this.lose = when;
  }

  async request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown) {
    const answer = await this.inner.request(method, route, body);
    const cmd = (body as { Cmd?: string[] } | undefined)?.Cmd;
    if (method === 'POST' && route.endsWith('/exec') && cmd?.[3] === 'melete-launch')
      this.commands.add((answer as { Id: string }).Id);
    return answer;
  }

  putArchive(container: string, target: string, tar: Uint8Array, s: AbortSignal) {
    return this.inner.putArchive(container, target, tar, s);
  }

  async startExec(id: string, s: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const when = this.commands.has(id) ? this.lose : null;
    if (!when) return this.inner.startExec(id, s);
    this.lose = null;
    if (when === 'before_start') throw new Error('the connection closed before any answer');
    const reader = (await this.inner.startExec(id, s)).getReader();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const lost = setTimeout(() => {
          controller.error(new Error('the connection closed while the command ran'));
          void reader.cancel().catch(() => {});
        }, 1_000);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          clearTimeout(lost);
          controller.close();
        } catch {
          // Already reported as lost.
        }
      },
    });
  }
}

function settings(extra: Partial<DockerSandboxSettings> = {}): DockerSandboxSettings {
  return {
    socket,
    project: PROJECT,
    ...DOCKER_SANDBOX_DEFAULTS,
    memoryMb: 1024,
    pids: 256,
    diskMb: 64,
    egressPort: 18_791,
    ...(selfId ? { selfId } : {}),
    ...extra,
  };
}

/** The same adapter, saying it offers what it can here and no more. */
function declaring(
  host: DockerSandboxHost,
  egress: readonly EgressPolicy['kind'][],
): SandboxProvider {
  const provider = Object.create(host) as DockerSandboxHost;
  Object.defineProperty(provider, 'capabilities', {
    value: { ...host.capabilities, egress },
  });
  return provider;
}

function spec(session: string, egress: EgressPolicy = { kind: 'deny_all' }): SandboxSpec {
  return {
    image,
    egress,
    region: null,
    lifetimeSeconds: 1_800,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({ project: PROJECT, connection: 'conn_LIVE', space: 'sp_LIVE', session }),
    env: { LANG: 'C.UTF-8' },
  };
}

if (!live) {
  test.skip('docker live checks need MELETE_SANDBOX_LIVE=docker and an engine', () => {});
} else {
  const lossy = new LossyDocker();
  const host = new DockerSandboxHost(settings(), lossy);
  const opened: SandboxHandle[] = [];
  let sessions = 0;
  const open = async (egress: EgressPolicy = { kind: 'deny_all' }, target = host) => {
    sessions += 1;
    const handle = await openSandbox(target, spec(`sbx_live${sessions}`, egress), signal());
    opened.push(handle);
    return handle;
  };
  /** One command straight through the adapter, answering what it printed. */
  const shell = async (handle: SandboxHandle, script: string, target = host) => {
    const outcome = await target.exec(
      handle,
      {
        marker: 'act_LIVE',
        argv: ['/bin/sh', '-c', script],
        cwd: '/work',
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
      },
      signal(),
    );
    return { ...outcome, text: text(outcome.output) };
  };

  afterAll(async () => {
    for (const handle of opened) await host.destroy(handle, signal()).catch(() => {});
    // Nothing labelled for this run may be left behind.
    const left = await host.reconcile(PROJECT, new Set(), signal(), 'conn_LIVE');
    if (left.length) process.stderr.write(`docker live: reconciled leftovers ${left.join(', ')}\n`);
    await host.guard.close();
  }, 180_000);

  sandboxConformance(
    'docker live',
    async () => ({
      provider: declaring(host, ['deny_all']),
      image,
      secrets: [],
      loseNextAcknowledgement: (when) => lossy.loseNext(when),
      close: async () => {},
    }),
    { timeoutMs: 240_000, log: (line) => process.stdout.write(`${line}\n`) },
  );

  if (process.env.DATABASE_URL) {
    const { testDatabase } = await import('../../../test/helpers/database.ts');
    const database = await testDatabase();
    afterAll(async () => database?.close());
    let failPause = false;
    const pausing = Object.create(declaring(host, ['deny_all'])) as DockerSandboxHost;
    pausing.pause = async (handle, s) => {
      if (failPause) {
        failPause = false;
        throw new Error('the engine did not answer the pause');
      }
      return host.pause(handle, s);
    };
    workspaceConformance('docker live, paused', {
      sql: database?.sql ?? null,
      open: async () => ({
        provider: pausing,
        persistence: 'pause',
        image,
        failNextSuspend: () => {
          failPause = true;
        },
        snapshotHeld: async () => false,
        replayed: false,
        close: async () => {},
      }),
    });
  }

  describe('docker sandbox live: the container', () => {
    test('it runs as the sandbox user with no capability, a read-only root and its limits', async () => {
      const handle = await open();
      const seen = await shell(
        handle,
        [
          'echo uid=$(id -u) gid=$(id -g)',
          "grep -E '^(CapEff|NoNewPrivs)' /proc/self/status | tr -s '\\t ' '='",
          'touch /usr/local/probe 2>/dev/null; echo root_write=$?',
          'test -e /var/run/docker.sock; echo socket=$?',
          'echo pids=$(cat /sys/fs/cgroup/pids.max) memory=$(cat /sys/fs/cgroup/memory.max)',
          'echo mounts=$(awk \'$2=="/work"||$2=="/home/agent"{print $2}\' /proc/mounts | sort | tr \'\\n\' ,)',
          'echo network=$(ls /sys/class/net | sort | tr "\\n" ,)',
          'echo core=$(ulimit -c)',
          'uname -a',
        ].join('; '),
      );
      process.stdout.write(`docker live, container: ${seen.text}\n`);
      expect(seen.exitCode).toBe(0);
      expect(seen.text).toContain('uid=10004 gid=10004');
      expect(seen.text).toContain('CapEff:=0000000000000000');
      expect(seen.text).toContain('NoNewPrivs:=1');
      expect(seen.text).toContain('root_write=1');
      expect(seen.text).toContain('socket=1');
      expect(seen.text).toContain(`pids=256 memory=${1024 * 1024 * 1024}`);
      expect(seen.text).toContain('mounts=/home/agent,/work,');
      expect(seen.text).toContain('network=lo,');
      expect(seen.text).toContain('core=0');
      expect(seen.text).toMatch(/Linux sandbox /);
    });

    test('a real task: write a Python file and run it, in the agent own container', async () => {
      const handle = await open();
      const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-docker-live-'));
      try {
        await writeFile(path.join(workRoot, 'unused'), '');
        const record = await runCommand({
          provider: host,
          handle,
          request: {
            marker: 'act_LIVEHELLO0000000000000',
            argv: [
              'sh',
              '-c',
              'printf \'import platform\\nprint("hello from", platform.node(), platform.python_version())\\n\' > hello.py && python3 hello.py && ls -l hello.py',
            ],
            timeoutMs: 30_000,
            dispatch: 'first',
          },
          workRoot,
          jobId: 'job_LIVE',
          signal: signal(),
        });
        expect(record.outcome).toBe('succeeded');
        if (record.outcome !== 'succeeded') return;
        const said = text(record.record.preview);
        process.stdout.write(`docker live, hello.py: ${said}\n`);
        expect(record.record.exitCode).toBe(0);
        expect(said).toMatch(/^hello from sandbox 3\.12\.\d+/m);
        expect(text(await host.getFile(handle, '/work/hello.py', 1024, signal()))).toContain(
          'platform',
        );
      } finally {
        await rm(workRoot, { recursive: true, force: true });
      }
    });

    test('no one file may outgrow the allowance, and past it files can still be removed', async () => {
      let now = Date.now();
      const clocked = new DockerSandboxHost(
        settings({ diskMb: 64 }),
        new DockerSandboxSocket(socket),
        {
          now: () => now,
        },
      );
      const handle = await open({ kind: 'deny_all' }, clocked);
      const big = await shell(
        handle,
        'head -c 80M /dev/zero > /work/big; echo rc=$?; echo size=$(stat -c %s /work/big)',
        clocked,
      );
      process.stdout.write(`docker live, file limit: ${big.text}\n`);
      expect(big.text).toMatch(/rc=(153|1)\b/);
      expect(big.text).toContain(`size=${64 * 1024 * 1024}`);
      now += 30_000; // the disk figure is measured again
      const over = await shell(
        handle,
        'head -c 3M /dev/zero > /work/more 2>/dev/null; echo more=$?; rm /work/big; echo removed=$?',
        clocked,
      );
      process.stdout.write(`docker live, past the allowance: ${over.text}\n`);
      expect(over.text).toMatch(/more=(153|1)\b/);
      expect(over.text).toContain('removed=0');
      now += 30_000;
      const back = await shell(handle, 'head -c 3M /dev/zero > /work/more; echo more=$?', clocked);
      expect(back.text).toContain('more=0');
      clocked.stopReaper();
    });

    test('an idle container is stopped and the next use starts it again with its files', async () => {
      let now = Date.now();
      const clocked = new DockerSandboxHost(
        settings({ idleSeconds: 60 }),
        new DockerSandboxSocket(socket),
        {
          now: () => now,
        },
      );
      const handle = await open({ kind: 'deny_all' }, clocked);
      await shell(handle, 'echo kept > /work/note; echo also > ~/note', clocked);
      now += 61_000;
      expect(await clocked.reap(signal())).toContain(handle.providerSandboxId);
      expect(await clocked.running(handle, signal())).toBe(false);
      const again = await shell(handle, 'cat /work/note ~/note', clocked);
      expect(again.text).toBe('kept\nalso\n');
      expect(await clocked.running(handle, signal())).toBe(true);
    });
  });

  describe('docker sandbox live: command markers', () => {
    test('a command interrupted by an idle stop keeps its marker and is reported from it', async () => {
      let now = Date.now();
      const engine = new LossyDocker();
      const clocked = new DockerSandboxHost(settings({ idleSeconds: 60 }), engine, {
        now: () => now,
      });
      const handle = await open({ kind: 'deny_all' }, clocked);
      const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-docker-live-marker-'));
      const request = {
        marker: 'act_LIVEIDLESTOP00000000000',
        argv: ['sh', '-c', 'sleep 3; printf finished'],
        timeoutMs: 30_000,
      };
      const run = (dispatch: 'first' | 'again') =>
        runCommand({
          provider: clocked,
          handle,
          request: { ...request, dispatch },
          workRoot,
          jobId: 'job_LIVE',
          signal: signal(),
        });
      try {
        // The answer is lost while the command runs, so its outcome is open.
        engine.loseNext('after_start');
        expect((await run('first')).outcome).toBe('unknown');
        await delay(5_000);
        // Then nobody uses the computer, and the idle clock stops it.
        now += 61_000;
        expect(await clocked.reap(signal())).toContain(handle.providerSandboxId);
        expect(await clocked.running(handle, signal())).toBe(false);
        const again = await run('again');
        process.stdout.write(
          `docker live, after the idle stop: ${again.outcome}${'reason' in again ? `, ${again.reason}` : ''}\n`,
        );
        expect(again).toMatchObject({ outcome: 'succeeded', late: true, reattached: true });
        if (again.outcome !== 'succeeded') return;
        expect(again.record.exitCode).toBe(0);
        expect(text(again.record.preview)).toBe('finished');
      } finally {
        clocked.stopReaper();
        await rm(workRoot, { recursive: true, force: true });
      }
    });

    test('a marker keeps at most the capture limit, and old or settled markers are removed', async () => {
      const handle = await open();
      const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-docker-live-keep-'));
      const root = host.capabilities.markerRoot;
      const run = (marker: string, argv: string[], forget: string[] = []) =>
        runCommand({
          provider: host,
          handle,
          request: { marker, argv, timeoutMs: 60_000, dispatch: 'first', forget },
          workRoot,
          jobId: 'job_LIVE',
          signal: signal(),
        });
      try {
        const big = await run('act_LIVEKEEP000000000000001', [
          'sh',
          '-c',
          'head -c 6M /dev/zero; printf done > /work/after-big',
        ]);
        expect(big.outcome).toBe('succeeded');
        if (big.outcome === 'succeeded') expect(big.record.captureLimited).toBe(true);
        const sizes = await shell(
          handle,
          `stat -c %s ${root}/act_LIVEKEEP000000000000001/out; cat /work/after-big; stat -c %a ${root}`,
        );
        process.stdout.write(`docker live, kept output: ${sizes.text}\n`);
        expect(sizes.text).toBe('4194305\ndone700\n');
        // An unsettled marker from long ago, and a recent one.
        await shell(
          handle,
          `mkdir -p ${root}/act_LIVEOLD ${root}/act_LIVERECENT && touch -d '10 days ago' ${root}/act_LIVEOLD`,
        );
        const next = await run(
          'act_LIVEKEEP000000000000002',
          ['true'],
          ['act_LIVEKEEP000000000000001'],
        );
        expect(next.outcome).toBe('succeeded');
        const left = await shell(handle, `ls ${root} | sort`);
        expect(left.text).toBe('act_LIVEKEEP000000000000002\nact_LIVERECENT\n');
      } finally {
        await rm(workRoot, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!withDesktop)('docker sandbox live: the desktop', () => {
    const PAGE = `<!doctype html><title>ready</title>
<body style="margin:0">
<input id="i" style="position:fixed;top:0;left:0;width:100%;height:40%;font-size:40px"
  oninput="document.title='typed:'+this.value">
<button style="position:fixed;top:50%;left:0;width:100%;height:50%;font-size:40px"
  onclick="document.title='clicked'">press</button>`;

    test('the agent opens a page, clicks, types and presses keys, and sees each land', async () => {
      const handle = await open();
      async function* site() {
        yield { path: '/work/site/index.html', bytes: new TextEncoder().encode(PAGE), mode: 0o644 };
      }
      await host.putFiles(handle, site(), signal());
      const served = await shell(
        handle,
        'cd /work/site && (nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/http.log 2>&1 &) ; sleep 1; echo up',
      );
      expect(served.text).toContain('up');
      const window = async (want: string) => {
        let last = '';
        for (let tries = 0; tries < 40; tries += 1) {
          const info = JSON.parse(
            text(await host.computer(handle, { kind: 'info' }, signal())),
          ) as {
            window: string;
          };
          last = info.window;
          if (last.startsWith(want)) return last;
          await delay(250);
        }
        throw new Error(`the window says ${JSON.stringify(last)}, not ${want}`);
      };
      const openedPage = JSON.parse(
        text(
          await host.computer(handle, { kind: 'open', url: 'http://127.0.0.1:8765/' }, signal()),
        ),
      ) as { browser: boolean };
      expect(openedPage.browser).toBe(true);
      await window('ready');
      await host.computer(handle, { kind: 'click', x: 512, y: 600, button: 1, count: 1 }, signal());
      await window('clicked');
      await host.computer(handle, { kind: 'click', x: 512, y: 250, button: 1, count: 1 }, signal());
      await host.computer(handle, { kind: 'type', text: 'hello' }, signal());
      await window('typed:hello');
      await host.computer(handle, { kind: 'key', keys: ['BackSpace'] }, signal());
      await window('typed:hell');
      // A person's live input goes through the same desktop.
      await host.computer(handle, { kind: 'input', events: [{ k: 'text', text: '!' }] }, signal());
      const title = await window('typed:hell!');
      process.stdout.write(`docker live, window: ${title}\n`);
      const shot = await host.computer(handle, { kind: 'screenshot' }, signal());
      expect([...shot.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const size = new DataView(shot.buffer, shot.byteOffset, shot.byteLength);
      expect([size.getUint32(16), size.getUint32(20)]).toEqual([1024, 768]);
      const out = process.env.MELETE_SANDBOX_LIVE_OUT;
      if (out) await writeFile(path.join(out, 'sandbox-desktop.png'), shot);
      const frames = host.frames(handle, 2, AbortSignal.timeout(20_000));
      for await (const frame of frames) {
        expect([frame[0], frame[1]]).toEqual([0xff, 0xd8]);
        break;
      }
    });
  });

  describe.skipIf(!selfId)('docker sandbox live: open egress through the service', () => {
    test('public HTTPS goes through the guard; nothing else leaves', async () => {
      const handle = await open({ kind: 'open' });
      const probe = await shell(
        handle,
        [
          "echo https=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://example.com/)",
          "echo plain=$(curl -s -m 15 -o /dev/null -w '%{http_code}' http://example.com/)",
          'curl -s -m 10 -o /dev/null https://169.254.169.254/; echo metadata=$?',
          'curl -s -m 10 -o /dev/null https://10.0.0.1/; echo private=$?',
          "curl -s -m 10 --noproxy '*' -o /dev/null https://example.com/; echo direct=$?",
          'getent hosts example.com >/dev/null; echo dns=$?',
        ].join('; '),
      );
      process.stdout.write(`docker live, open egress: ${probe.text}\n`);
      expect(probe.text).toContain('https=200');
      expect(probe.text).toContain('plain=405');
      expect(probe.text).toMatch(/metadata=(56|35|7)\b/);
      expect(probe.text).toMatch(/private=(56|35|7)\b/);
      expect(probe.text).not.toContain('direct=0');
      expect(probe.text).not.toContain('dns=0');
      if (withDesktop) {
        await host.computer(handle, { kind: 'open', url: 'https://example.com/' }, signal());
        let title = '';
        for (let tries = 0; tries < 60 && !title.startsWith('Example Domain'); tries += 1) {
          title = (
            JSON.parse(text(await host.computer(handle, { kind: 'info' }, signal()))) as {
              window: string;
            }
          ).window;
          await delay(500);
        }
        expect(title).toStartWith('Example Domain');
        const out = process.env.MELETE_SANDBOX_LIVE_OUT;
        if (out)
          await writeFile(
            path.join(out, 'sandbox-example.png'),
            await host.computer(handle, { kind: 'screenshot' }, signal()),
          );
      }
    });
  });
}
