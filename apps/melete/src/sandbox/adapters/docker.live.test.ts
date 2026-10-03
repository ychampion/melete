/**
 * The docker adapter on a real Docker engine. Skipped unless
 * `MELETE_SANDBOX_LIVE=docker`; never part of an ordinary run.
 *
 *   MELETE_SANDBOX_DOCKER_IMAGE   the image to run (default melete-sandbox:local, built from
 *                                 deploy/Dockerfile.sandbox)
 *   MELETE_DOCKER_SOCKET          the engine (default /var/run/docker.sock)
 *   MELETE_SANDBOX_LIVE_DESKTOP=0 an image without the desktop: the shell checks only
 *   DATABASE_URL                  also runs the workspace conformance suite
 *   MELETE_LIVE_MOTO              a moto server (with INITIAL_NO_AUTH_ACTION_COUNT=6) the AWS
 *                                 check runs against, inside the open-egress checks
 *
 * Open egress needs this process to be a container on the same engine, as the
 * service is in the Compose deployment: run it in one with the socket mounted
 * and those checks run too. On a host they are skipped, and the shared suite
 * is run with the adapter declaring deny-all only, which is all it offers there.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EgressWriteInput } from '../../broker/egress-admission.ts';
import { resolveHost } from '../../connectors/web.ts';
import { createAwsAdapter } from '../../egress/adapters/aws.ts';
import { githubAdapter } from '../../egress/adapters/github.ts';
import type { CredentialAdapter } from '../../egress/adapters/types.ts';
import {
  awsFronts,
  bootstrapMoto,
  MOTO_BUCKET,
  MOTO_REGION,
  motoCall,
} from '../../egress/aws-fixture.ts';
import { awsSecret } from '../../egress/aws-session.ts';
import { fixtureUpstream, memoryCredentialPort } from '../../egress/fixtures.ts';
import { type GitRequestSeen, gitSmartHttp } from '../../egress/git-fixture.ts';
import type { EgressRecordOpen } from '../../egress/records.ts';
import { certificateAuthority, leafCertificate, newKeyPair, pem } from '../../egress/x509.ts';
import { selfSignedPair } from '../../gateway/fixtures/self-signed.ts';
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
import { SandboxEgressGuard } from './docker-egress.ts';

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
      // An address that answers with a picture opens in the same window, and
      // the answer says the window moved to it.
      async function* picture() {
        yield { path: '/work/site/pic.png', bytes: shot, mode: 0o644 };
      }
      await host.putFiles(handle, picture(), signal());
      const shown = JSON.parse(
        text(
          await host.computer(
            handle,
            { kind: 'open', url: 'http://127.0.0.1:8765/pic.png' },
            signal(),
          ),
        ),
      ) as { navigated: boolean; window: string };
      expect(shown.navigated).toBe(true);
      expect(shown.window).toStartWith('pic.png');
      // Opening what the window already shows moves nothing, and says so.
      const again = JSON.parse(
        text(
          await host.computer(
            handle,
            { kind: 'open', url: 'http://127.0.0.1:8765/pic.png' },
            signal(),
          ),
        ),
      ) as { navigated: boolean; window: string };
      expect(again.navigated).toBe(false);
      expect(again.window).toStartWith('pic.png');
    });
  });

  // The computer's own git (curl with GnuTLS) holds the egress CA to its name
  // constraints: a leaf the CA's key signed for another name is refused, with or
  // without a subject alternative name, while one inside them is trusted.
  test("the computer's git refuses a leaf the egress CA signed outside its constraints", async () => {
    const ca = newKeyPair();
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 3_600_000);
    const caCert = certificateAuthority({
      keys: ca,
      commonName: 'Melete egress CA',
      permitted: ['test'],
      notBefore,
      notAfter,
    });
    const leaf = (host: string, withoutSubjectAltName = false) => {
      const keys = newKeyPair();
      return {
        cert: pem(
          'CERTIFICATE',
          leafCertificate({
            host,
            keys,
            caCert,
            caKey: ca.privateKey,
            caCommonName: 'Melete egress CA',
            notBefore,
            notAfter,
            withoutSubjectAltName,
          }),
        ),
        key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      };
    };
    const cases = [
      { name: 'inside', host: 'ok.creds.test', port: 8443, pair: leaf('ok.creds.test') },
      { name: 'outside', host: 'evil.example', port: 8444, pair: leaf('evil.example') },
      { name: 'cn_only', host: 'evil.example', port: 8445, pair: leaf('evil.example', true) },
    ];
    const b64 = (value: string) => Buffer.from(value).toString('base64');
    const server = [
      'import socket, ssl, sys, threading, time',
      'def serve(port, cert, key):',
      '    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)',
      '    ctx.load_cert_chain(cert, key)',
      '    s = socket.socket()',
      '    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
      "    s.bind(('127.0.0.1', port))",
      '    s.listen(8)',
      '    while True:',
      '        c, _ = s.accept()',
      '        try:',
      '            t = ctx.wrap_socket(c, server_side=True)',
      '            t.recv(65536)',
      "            t.sendall(b'HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n')",
      '            t.close()',
      '        except Exception:',
      '            c.close()',
      ...cases.map(
        (each) =>
          `threading.Thread(target=serve, args=(${each.port}, '/tmp/${each.name}.crt', '/tmp/${each.name}.key'), daemon=True).start()`,
      ),
      'time.sleep(40)',
    ].join('\n');
    const script = [
      `echo ${b64(pem('CERTIFICATE', caCert))} | base64 -d > /tmp/egress-ca.pem`,
      ...cases.flatMap((each) => [
        `echo ${b64(each.pair.cert)} | base64 -d > /tmp/${each.name}.crt`,
        `echo ${b64(each.pair.key)} | base64 -d > /tmp/${each.name}.key`,
      ]),
      `echo ${b64(server)} | base64 -d > /tmp/serve.py`,
      'python3 /tmp/serve.py >/dev/null 2>&1 & SERVER=$!; sleep 2',
      ...cases.map(
        (each) =>
          `echo ${each.name}=$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy GIT_SSL_CAINFO=/tmp/egress-ca.pem GIT_TERMINAL_PROMPT=0 git -c http.curloptResolve=${each.host}:${each.port}:127.0.0.1 ls-remote https://${each.host}:${each.port}/r.git 2>&1 | grep -ciE 'certificate|issuer|verif')`,
      ),
      `echo reached=$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy GIT_SSL_CAINFO=/tmp/egress-ca.pem GIT_TERMINAL_PROMPT=0 git -c http.curloptResolve=ok.creds.test:8443:127.0.0.1 ls-remote https://ok.creds.test:8443/r.git 2>&1 | grep -ciE '404|not found')`,
      // git's own HTTPS helper links its own libcurl; the curl command may use another TLS library.
      'git --version; echo tls=$(ldd "$(git --exec-path)/git-remote-https" | grep -oE "libgnutls|libssl" | head -1); kill $SERVER',
    ].join('; ');
    const probe = await shell(await open(), script);
    process.stdout.write(`docker live, git trust: ${probe.text}\n`);
    expect(probe.text).toContain('tls=libgnutls');
    expect(probe.text).toContain('inside=0');
    expect(probe.text).toMatch(/reached=[1-9]/);
    expect(probe.text).toMatch(/outside=[1-9]/);
    expect(probe.text).toMatch(/cn_only=[1-9]/);
  }, 120_000);

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

    // A second host with its own guard, which records and holds a host list.
    const recorded: EgressRecordOpen[] = [];
    const watched = new DockerSandboxHost(
      settings({
        egressPort: 18_792,
        egressRecords: {
          opened: (record) => recorded.push(record),
          closed: () => {},
          counted: () => {},
        },
        egressExtraHosts: ['example.com'],
      }),
    );
    // Its computers are destroyed with the rest, through the same engine.
    afterAll(() => watched.guard.close());
    const attribution = (actionId: string, sessionId: string) => ({
      kind: 'command' as const,
      sessionId,
      jobId: 'job_LIVE',
      attemptId: 'att_LIVE',
      actionId,
    });
    /** One command with its own environment, answering what it printed. */
    const run = async (handle: SandboxHandle, script: string, env: Record<string, string>) => {
      const outcome = await watched.exec(
        handle,
        {
          marker: `act_${Date.now()}`,
          argv: ['/bin/sh', '-c', script],
          cwd: '/work',
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024,
          env,
        },
        signal(),
      );
      return text(outcome.output);
    };
    const CODE = "curl -s -m 15 -o /dev/null -w '%{http_code}'";

    test("each command's tunnels are recorded against it, and a token from one computer is refused from another", async () => {
      const one = await open({ kind: 'open' }, watched);
      const two = await open({ kind: 'open' }, watched);
      const session = one.providerSandboxId;
      const command = await watched.attributeCommand(one, attribution('act_LIVE_one', session));
      expect(await run(one, `${CODE} https://example.com/`, command.env)).toBe('200');
      const reached = command.settle();
      process.stdout.write(`docker live, egress hosts: ${JSON.stringify(reached)}\n`);
      expect(reached).toEqual([
        expect.objectContaining({ host: 'example.com', tunnels: 1, refused: 0 }),
      ]);
      expect(reached[0]?.bytes_down).toBeGreaterThan(0);
      // Without its token the computer still gets out, unattributed.
      expect(await run(one, `${CODE} https://example.com/`, {})).toBe('200');
      // Another computer's live token is refused outright.
      const borrowed = await watched.attributeCommand(
        one,
        attribution('act_LIVE_borrowed', session),
      );
      const refused = await run(two, `${CODE} https://example.com/; echo " exit=$?"`, borrowed.env);
      borrowed.settle();
      expect(refused).toMatch(/exit=(56|7)\b/);
      // The desktop may reach out on its own as well, so each record is looked for by kind.
      const seen = recorded.map((record) => [
        record.host,
        record.verdict,
        record.actionId,
        record.reason,
      ]);
      expect(seen).toContainEqual(['example.com', 'tunnel', 'act_LIVE_one', null]);
      expect(seen).toContainEqual(['example.com', 'unattributed', null, null]);
      expect(seen).toContainEqual(['example.com', 'refused', null, 'token_refused']);
      expect(seen.filter((record) => record[2] === 'act_LIVE_borrowed')).toEqual([]);
    });

    test('a computer held to its connected hosts reaches them and nothing else', async () => {
      const handle = await open({ kind: 'connected_hosts_only' }, watched);
      const probe = await run(
        handle,
        [
          `echo listed=$(${CODE} https://example.com/)`,
          'curl -s -m 15 -o /dev/null https://www.iana.org/; echo other=$?',
          "curl -s -m 10 --noproxy '*' -o /dev/null https://example.com/; echo direct=$?",
        ].join('; '),
        {},
      );
      process.stdout.write(`docker live, connected hosts only: ${probe}\n`);
      expect(probe).toContain('listed=200');
      expect(probe).toMatch(/other=(56|7)\b/);
      expect(probe).not.toContain('direct=0');
      expect(recorded.map((record) => [record.host, record.verdict, record.reason])).toContainEqual(
        ['www.iana.org', 'refused', 'host_not_connected'],
      );
    });

    // Conformance scenario 12, credential egress: a real computer uses a
    // connected account through the relay, and never holds its secret.
    test('a computer uses a connected account through the relay, and its environment, files and output never hold the secret', async () => {
      const HOST = 'api.creds.test';
      const secret = `tok_live_${randomBytes(16).toString('hex')}`;
      const upstream = await fixtureUpstream(HOST);
      const port = memoryCredentialPort({ secret, hosts: [HOST] });
      const guard = new SandboxEgressGuard({
        resolve: async (name) =>
          name === HOST ? [{ address: '93.184.216.34', family: 4 }] : resolveHost(name),
        credentials: port,
        intercept: {
          upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: upstream.port }),
          upstreamCa: upstream.ca,
        },
      });
      const credentialed = new DockerSandboxHost(
        settings({ egressPort: 18_793, egressCredentials: port }),
        new DockerSandboxSocket(socket),
        { guard },
      );
      try {
        const handle = await open({ kind: 'open' }, credentialed);
        const command = await credentialed.attributeCommand(
          handle,
          attribution('act_LIVE_credentialed', handle.providerSandboxId),
        );
        // The secret is looked for in two halves, so this command's own text never holds it.
        const half = Math.floor(secret.length / 2);
        const outcome = await credentialed.exec(
          handle,
          {
            marker: `act_${Date.now()}`,
            argv: [
              '/bin/sh',
              '-c',
              [
                `echo answer=$(curl -s -m 20 https://${HOST}/user)`,
                'echo trusted=$(test -s "$SSL_CERT_FILE" && echo yes)',
                `A='${secret.slice(0, half)}'; B='${secret.slice(half)}'`,
                'env | grep -cF "$A$B" | sed "s/^/env=/"',
                'grep -rlF "$A$B" /home /work /tmp /etc 2>/dev/null | wc -l | sed "s/^/files=/"',
              ].join('; '),
            ],
            cwd: '/work',
            timeoutMs: 60_000,
            maxOutputBytes: 64 * 1024,
            env: command.env,
          },
          signal(),
        );
        command.settle();
        const printed = text(outcome.output);
        process.stdout.write(`docker live, credential egress: ${printed}\n`);
        expect(printed).toContain('trusted=yes');
        expect(printed).toContain('Bearer [redacted]');
        expect(printed).toContain('env=0');
        expect(printed).toContain('files=0');
        expect(printed).not.toContain(secret);
        expect(upstream.seen.map((request) => request.headers.authorization)).toEqual([
          `Bearer ${secret}`,
        ]);
      } finally {
        await guard.close();
        await upstream.close();
      }
    });

    // GitHub through the relay: the computer's own git and gh, a git server
    // that speaks smart HTTP and checks the account, and an API fixture. The
    // first push is held and git prints why; the same push run again goes
    // through, bound to the same ref updates.
    test('git and gh in a real computer clone, push and change GitHub through the relay, and the computer never holds the token', async () => {
      const token = `github_pat_live_${randomBytes(16).toString('hex')}`;
      const run = promisify(execFile);
      const root = await mkdtemp(path.join(tmpdir(), 'melete-live-git-'));
      const bare = path.join(root, 'alice', 'site.git');
      await run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      const seed = path.join(root, 'seed');
      await run('git', ['init', '-q', '-b', 'main', seed]);
      await run('git', [
        '-C',
        seed,
        '-c',
        'user.name=A',
        '-c',
        'user.email=a@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Start',
      ]);
      await run('git', ['-C', seed, 'push', '-q', bare, 'main']);
      const pair = selfSignedPair('github.com');
      const gitSeen: GitRequestSeen[] = [];
      const gitServer = createHttpsServer(
        { key: pair.key, cert: pair.cert },
        gitSmartHttp({
          root,
          account: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          seen: gitSeen,
        }),
      );
      await new Promise<void>((resolve) => gitServer.listen(0, '127.0.0.1', resolve));
      const gitPort = (gitServer.address() as AddressInfo).port;
      const api = await fixtureUpstream('api.github.com', (request) =>
        request.path === '/user'
          ? { body: JSON.stringify({ login: 'alice' }) }
          : request.path === '/repos/alice/site/issues'
            ? {
                status: 201,
                body: JSON.stringify({
                  number: 1,
                  html_url: 'https://github.com/alice/site/issues/1',
                }),
              }
            : undefined,
      );
      const writes: EgressWriteInput[] = [];
      const port = memoryCredentialPort({
        secret: token,
        account: { adapter: githubAdapter as CredentialAdapter, config: {} },
        admitWrite: async (input) => {
          writes.push(input);
          // The first change waits for the person; after that, each is approved.
          if (writes.length === 1)
            return {
              kind: 'waiting',
              actionId: 'act_LIVE_push',
              message: `Waiting for your approval in Melete: ${input.write.summary.title}. Run the same command again once it is approved.`,
            };
          return {
            kind: 'sent',
            actionId: `act_LIVE_${writes.length}`,
            result: await input.forward(),
          };
        },
      });
      const ports: Record<string, number> = {
        'github.com': gitPort,
        'api.github.com': api.port,
      };
      const guard = new SandboxEgressGuard({
        resolve: async (name) =>
          name in ports ? [{ address: '140.82.112.3', family: 4 }] : resolveHost(name),
        credentials: port,
        intercept: {
          upstream: (host) => ({
            address: { address: '127.0.0.1', family: 4 },
            port: ports[host] ?? 0,
          }),
          upstreamCa: [pair.cert.toString(), api.ca],
        },
      });
      const credentialed = new DockerSandboxHost(
        settings({ egressPort: 18_794, egressCredentials: port }),
        new DockerSandboxSocket(socket),
        { guard },
      );
      try {
        const handle = await open({ kind: 'open' }, credentialed);
        const command = await credentialed.attributeCommand(
          handle,
          attribution('act_LIVE_github', handle.providerSandboxId),
        );
        const half = Math.floor(token.length / 2);
        const outcome = await credentialed.exec(
          handle,
          {
            marker: `act_${Date.now()}`,
            argv: [
              '/bin/sh',
              '-c',
              [
                'cd /work',
                'git clone -q https://github.com/alice/site site 2>&1; echo clone=$?',
                'cd site && git checkout -q -b melete/fix-login',
                'echo fixed > login.txt && git add login.txt',
                'git -c user.name=A -c user.email=a@example.com commit -q -m "Fix login"',
                'echo new=$(git rev-parse HEAD)',
                'git push origin melete/fix-login 2>&1 | sed "s/^/first: /"',
                'git push origin melete/fix-login 2>&1 | sed "s/^/second: /"',
                'echo gh_user=$(gh api user --jq .login 2>&1)',
                'echo issue=$(gh api -X POST repos/alice/site/issues -f title=Hello --jq .html_url 2>&1)',
                'echo gh=$(gh --version | head -1)',
                `A='${token.slice(0, half)}'; B='${token.slice(half)}'`,
                'env | grep -cF "$A$B" | sed "s/^/env=/"',
                'grep -rlF "$A$B" /home /work /tmp /etc 2>/dev/null | wc -l | sed "s/^/files=/"',
              ].join('\n'),
            ],
            cwd: '/work',
            timeoutMs: 120_000,
            maxOutputBytes: 64 * 1024,
            env: command.env,
          },
          signal(),
        );
        command.settle();
        const printed = text(outcome.output);
        process.stdout.write(`docker live, github: ${printed}\n`);
        expect(printed).toContain('clone=0');
        const newId = /new=([0-9a-f]{40})/.exec(printed)?.[1] ?? '';
        expect(newId).toMatch(/^[0-9a-f]{40}$/);
        // Held: git itself says why, beside the branch it pushed.
        expect(printed).toContain(
          'first:  ! [remote rejected] melete/fix-login -> melete/fix-login (Waiting for your approval in Melete: Push to alice/site (melete/fix-login).',
        );
        expect(printed).toContain('first: remote: Waiting for your approval in Melete');
        // Run again: sent once, and the branch is on the server at the commit approved.
        expect(printed).toMatch(
          /second: .*\* \[new branch\]\s+melete\/fix-login -> melete\/fix-login/,
        );
        const onServer = await run('git', ['-C', bare, 'rev-parse', 'refs/heads/melete/fix-login']);
        expect(onServer.stdout.trim()).toBe(newId);
        // Both runs asked for the same change, down to its bound bytes and headers.
        const [held, sent] = writes;
        expect(held?.write.payload).toMatchObject({
          resource: 'alice/site',
          updates: [{ ref: 'refs/heads/melete/fix-login', old: '0'.repeat(40), new: newId }],
        });
        expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
        // gh reads and asks through the same relay.
        expect(printed).toContain('gh_user=alice');
        expect(printed).toContain('issue=https://github.com/alice/site/issues/1');
        expect(printed).toContain('gh=gh version 2.83.2');
        expect(writes[2]?.write.summary.title).toBe('Open an issue in alice/site: Hello');
        // Every request upstream carried the account; nothing in the computer did.
        expect(gitSeen.length).toBeGreaterThanOrEqual(4);
        expect(new Set(api.seen.map((request) => request.headers.authorization))).toEqual(
          new Set([`Bearer ${token}`]),
        );
        expect(printed).toContain('env=0');
        expect(printed).toContain('files=0');
        expect(printed).not.toContain(token);
      } finally {
        await guard.close();
        await api.close();
        gitServer.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 240_000);

    // AWS through the relay: the computer's own aws command line against moto,
    // which checks every signature against the keys it issued. The relay signs
    // each request again with a session of the role it assumes for the
    // command; the first change is held and the same command run again lands.
    const motoUrl = process.env.MELETE_LIVE_MOTO;
    test.skipIf(!motoUrl)(
      'aws in a real computer reads, asks before a change and makes it once after approval, and the computer never holds the key',
      async () => {
        const moto = new URL(motoUrl ?? 'http://127.0.0.1:1');
        const { key, roleArn } = await bootstrapMoto(moto);
        // moto checks signatures from here on: a key it did not issue is turned away.
        const stranger = await motoCall(moto, {
          host: `s3.${MOTO_REGION}.amazonaws.com`,
          service: 's3',
          method: 'GET',
          path: `/${MOTO_BUCKET}`,
          key: {
            access_key_id: 'AKIANOTISSUED0000000',
            secret_access_key: 'not-issued-secret-0000',
          },
        });
        expect(stranger.status).toBe(403);
        const fronts = await awsFronts(moto, [
          `sts.${MOTO_REGION}.amazonaws.com`,
          `s3.${MOTO_REGION}.amazonaws.com`,
          `${MOTO_BUCKET}.s3.${MOTO_REGION}.amazonaws.com`,
        ]);
        const adapter = createAwsAdapter({
          sts: { ca: fronts.ca, route: fronts.route },
        }) as CredentialAdapter;
        const writes: EgressWriteInput[] = [];
        const port = memoryCredentialPort({
          secret: awsSecret(key),
          account: { adapter, config: { region: MOTO_REGION, role_arn: roleArn } },
          admitWrite: async (input) => {
            writes.push(input);
            const same = writes.filter(
              (each) => JSON.stringify(each.write.payload) === JSON.stringify(input.write.payload),
            );
            // A change waits for the person the first time; run again, it is approved.
            if (same.length === 1)
              return {
                kind: 'waiting',
                actionId: `act_LIVE_held_${writes.length}`,
                message: `Waiting for your approval in Melete: ${input.write.summary.title}. Run the same command again once it is approved.`,
              };
            return {
              kind: 'sent',
              actionId: `act_LIVE_aws_${writes.length}`,
              result: await input.forward(),
            };
          },
        });
        const guard = new SandboxEgressGuard({
          resolve: async (name) =>
            name.endsWith('.amazonaws.com')
              ? [{ address: '52.94.0.10', family: 4 }]
              : resolveHost(name),
          credentials: port,
          intercept: {
            upstream: (host) => {
              const route = fronts.route(host);
              if (!route) throw new Error(`no stand-in for ${host}`);
              return route;
            },
            upstreamCa: fronts.ca,
          },
        });
        const credentialed = new DockerSandboxHost(
          settings({ egressPort: 18_795, egressCredentials: port }),
          new DockerSandboxSocket(socket),
          { guard },
        );
        try {
          const handle = await open({ kind: 'open' }, credentialed);
          const command = await credentialed.attributeCommand(
            handle,
            attribution('act_LIVE_aws', handle.providerSandboxId),
          );
          const secret = key.secret_access_key;
          const half = Math.floor(secret.length / 2);
          const bucket = MOTO_BUCKET;
          const put = `aws s3api put-object --bucket ${bucket} --key reports/2026.csv --body report.csv`;
          const outcome = await credentialed.exec(
            handle,
            {
              marker: `act_${Date.now()}`,
              argv: [
                '/bin/sh',
                '-c',
                [
                  'cd /work',
                  'printf "month,total\\n2026-09,42\\n" > report.csv',
                  'echo who=$(aws sts get-caller-identity --query Arn --output text 2>&1)',
                  `${put} 2>&1 | sed "s/^/first: /"`,
                  `${put} 2>&1 | sed "s/^/second: /"`,
                  `echo listed=$(aws s3api list-objects-v2 --bucket ${bucket} --query "Contents[].Key" --output text 2>&1)`,
                  `echo got=$(aws s3 cp s3://${bucket}/reports/2026.csv - 2>&1 | tail -1)`,
                  `echo minted=$(aws sts assume-role --role-arn ${roleArn} --role-session-name try-it 2>&1)`,
                  'echo aws=$(aws --version 2>&1)',
                  `A='${secret.slice(0, half)}'; B='${secret.slice(half)}'`,
                  'env | grep -cF "$A$B" | sed "s/^/env=/"',
                  'grep -rlF "$A$B" /home /work /tmp /etc 2>/dev/null | wc -l | sed "s/^/files=/"',
                ].join('\n'),
              ],
              cwd: '/work',
              timeoutMs: 180_000,
              maxOutputBytes: 64 * 1024,
              env: command.env,
            },
            signal(),
          );
          command.settle();
          const printed = text(outcome.output);
          process.stdout.write(`docker live, aws: ${printed}\n`);
          // Reads went out signed with the command's own role session.
          expect(printed).toContain(
            'who=arn:aws:sts::123456789012:assumed-role/deploy/melete-act_LIVE_aws',
          );
          // Held: aws itself says why, and nothing was written.
          expect(printed).toContain('ApprovalRequired');
          expect(printed).toContain(
            `Waiting for your approval in Melete: s3:PutObject on ${bucket}/reports/2026.csv`,
          );
          // Run again: sent once, and the object is there with what the computer uploaded.
          expect(printed).toMatch(/second: .*"ETag"/s);
          expect(printed).toContain('listed=reports/2026.csv');
          expect(printed).toContain('got=2026-09,42');
          expect(writes).toHaveLength(2);
          const [held, sent] = writes;
          expect(JSON.stringify(sent?.write.payload)).toBe(JSON.stringify(held?.write.payload));
          // A call that would hand out credentials is refused; the computer never holds the key.
          expect(printed).toContain('hands out credentials');
          expect(printed).toContain('aws=aws-cli/2.');
          expect(printed).toContain('env=0');
          expect(printed).toContain('files=0');
          expect(printed).not.toContain(secret);
        } finally {
          await guard.close();
          await fronts.close();
        }
      },
      300_000,
    );
  });
}
