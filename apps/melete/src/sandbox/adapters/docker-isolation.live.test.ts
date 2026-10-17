/**
 * Two people on one installation, each with a computer, on a real Docker
 * engine: neither person's computer reaches the other's. Not over the network
 * (by address, by container name, at a port a preview would show), not through
 * the service's egress guard even when the operator opened every private range
 * to it, not with the other computer's command token, not with the account the
 * other person's space connected, and not on disk (files, home, browser
 * profile). Skipped unless `MELETE_SANDBOX_LIVE=docker`.
 *
 * The network checks need this process to be a container on the same engine,
 * as the service is in the Compose deployment, so it can join each computer's
 * network as its one way out; on a host they are skipped and only the disk
 * check runs.
 *
 *   MELETE_SANDBOX_DOCKER_IMAGE   the image to run (default melete-sandbox:local)
 *   MELETE_DOCKER_SOCKET          the engine (default /var/run/docker.sock)
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { parsePrivateHosts } from '../../connectors/private-hosts.ts';
import { resolveHost } from '../../connectors/web.ts';
import type { EgressCredentialPort } from '../../egress/credentials.ts';
import { fixtureUpstream, memoryCredentialPort } from '../../egress/fixtures.ts';
import type { EgressRecordOpen } from '../../egress/records.ts';
import { serviceContainerId } from '../docker-default.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import type { EgressPolicy, SandboxHandle, SandboxSpec } from '../types.ts';
import {
  DOCKER_SANDBOX_DEFAULTS,
  DockerSandboxHost,
  type DockerSandboxSettings,
  DockerSandboxSocket,
} from './docker.ts';
import { SandboxEgressGuard } from './docker-egress.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'docker';
const socket = process.env.MELETE_DOCKER_SOCKET ?? '/var/run/docker.sock';
const image = process.env.MELETE_SANDBOX_DOCKER_IMAGE ?? 'melete-sandbox:local';
const selfId = serviceContainerId({ MELETE_RUNTIME_ADAPTER: 'docker' });
const PROJECT = `iso${Date.now().toString(36)}`;
const CONNECTION = 'conn_ISOLATION';
const signal = () => AbortSignal.timeout(180_000);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Person A's space and person B's: the label each computer carries, as the service sets it. */
const SPACE_A = 'sp_PERSON_A';
const SPACE_B = 'sp_PERSON_B';

function settings(extra: Partial<DockerSandboxSettings> = {}): DockerSandboxSettings {
  return {
    socket,
    project: PROJECT,
    ...DOCKER_SANDBOX_DEFAULTS,
    memoryMb: 1024,
    pids: 256,
    diskMb: 64,
    egressPort: 18_794,
    ...(selfId ? { selfId } : {}),
    ...extra,
  };
}

function spec(session: string, space: string, egress: EgressPolicy): SandboxSpec {
  return {
    image,
    egress,
    region: null,
    lifetimeSeconds: 1_800,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({ project: PROJECT, connection: CONNECTION, space, session }),
    env: { LANG: 'C.UTF-8' },
  };
}

/**
 * A server for B's computer: it answers every connection with B's secret, so
 * any reach from A shows as that secret in A's output.
 */
const SERVER = [
  'import socket, sys',
  's = socket.socket()',
  's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  "s.bind(('0.0.0.0', int(sys.argv[1])))",
  's.listen(16)',
  'while True:',
  '    c, _ = s.accept()',
  '    try:',
  '        c.sendall(sys.argv[2].encode())',
  '    finally:',
  '        c.close()',
].join('\n');

/** Starts one server per port in a session of its own, so it outlives the command. */
const LAUNCH = [
  'import subprocess, sys',
  `server = ${JSON.stringify(SERVER)}`,
  'for port in sys.argv[2:]:',
  '    subprocess.Popen([sys.executable, "-c", server, port, sys.argv[1]], start_new_session=True,',
  '        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
].join('\n');

/**
 * What A's computer can reach of B's: B's address and name directly, and
 * through the guard at the address the computer's own proxy names.
 */
const PROBE = [
  'import base64, socket, sys',
  'ip, name, port, borrowed = sys.argv[1:5]',
  'def direct(host, p):',
  '    try:',
  '        s = socket.create_connection((host, p), timeout=5)',
  '        s.settimeout(5)',
  "        return 'open:' + s.recv(200).decode(errors='replace')",
  '    except Exception as e:',
  "        return 'closed:' + type(e).__name__",
  'def guard(target, token=None):',
  '    try:',
  "        s = socket.create_connection(('melete-egress', int(port)), timeout=10)",
  '        s.settimeout(10)',
  "        auth = ''",
  '        if token:',
  "            auth = 'Proxy-Authorization: Basic ' + base64.b64encode(('cmd:' + token).encode()).decode() + '\\r\\n'",
  "        s.sendall(('CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n%s\\r\\n' % (target, target, auth)).encode())",
  "        head = b''",
  "        while b'\\r\\n\\r\\n' not in head:",
  '            chunk = s.recv(4096)',
  '            if not chunk:',
  '                break',
  '            head += chunk',
  "        top, _, rest = head.partition(b'\\r\\n\\r\\n')",
  "        lines = top.decode(errors='replace').split('\\r\\n')",
  "        status = lines[0].split(' ')[1] if len(lines[0].split(' ')) > 1 else '?'",
  "        reason = ''.join(l.split(':', 1)[1].strip() for l in lines if l.lower().startswith('x-melete-egress:'))",
  "        if status == '200':",
  '            try:',
  '                rest += s.recv(200)',
  '            except Exception:',
  '                pass',
  "        return '%s:%s:%s' % (status, reason, rest.decode(errors='replace'))",
  '    except Exception as e:',
  "        return 'error:' + type(e).__name__",
  'def resolve(host):',
  '    try:',
  "        return 'resolved:' + socket.gethostbyname(host)",
  '    except Exception as e:',
  "        return 'unresolved:' + type(e).__name__",
  "print('direct_ip_8080=' + direct(ip, 8080))",
  "print('direct_ip_443=' + direct(ip, 443))",
  "print('direct_name_8080=' + direct(name, 8080))",
  "print('name=' + resolve(name))",
  "print('guard_public=' + guard('example.com:443'))",
  "print('guard_ip_443=' + guard(ip + ':443'))",
  "print('guard_name_443=' + guard(name + ':443'))",
  "print('guard_ip_8080=' + guard(ip + ':8080'))",
  "print('guard_borrowed=' + guard('example.com:443', borrowed))",
].join('\n');

/** The first line of `output` that starts with `key=`, without the key. */
const line = (output: string, key: string) =>
  output
    .split('\n')
    .find((each) => each.startsWith(`${key}=`))
    ?.slice(key.length + 1) ?? '';

/** What a plain connection from this process to `host:port` reads before the server closes it. */
function readFrom(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const client = connect(port, host);
    let read = '';
    client.setTimeout(5_000, () => client.destroy());
    client.on('data', (chunk) => {
      read += chunk.toString();
    });
    client.on('error', () => resolve(''));
    client.on('close', () => resolve(read));
  });
}

if (!live) {
  test.skip('docker isolation checks need MELETE_SANDBOX_LIVE=docker and an engine', () => {});
} else {
  const engine = new DockerSandboxSocket(socket);
  const hosts: DockerSandboxHost[] = [];
  const opened: { host: DockerSandboxHost; handle: SandboxHandle }[] = [];
  let sessions = 0;
  const open = async (host: DockerSandboxHost, space: string, egress: EgressPolicy) => {
    sessions += 1;
    const handle = await openSandbox(host, spec(`sbx_iso${sessions}`, space, egress), signal());
    opened.push({ host, handle });
    return handle;
  };
  /** One command straight through the adapter, answering what it printed. */
  const run = async (
    host: DockerSandboxHost,
    handle: SandboxHandle,
    argv: string[],
    env: Record<string, string> = {},
  ) => {
    const outcome = await host.exec(
      handle,
      {
        marker: `act_ISO${Date.now()}`,
        argv,
        cwd: '/work',
        timeoutMs: 90_000,
        maxOutputBytes: 64 * 1024,
        env,
      },
      signal(),
    );
    return { exitCode: outcome.exitCode, text: text(outcome.output) };
  };
  const sh = (host: DockerSandboxHost, handle: SandboxHandle, script: string, env = {}) =>
    run(host, handle, ['/bin/sh', '-c', script], env);
  const hostWith = (extra: Partial<DockerSandboxSettings>, guard?: SandboxEgressGuard) => {
    const host = new DockerSandboxHost(settings(extra), engine, guard ? { guard } : {});
    hosts.push(host);
    return host;
  };

  afterAll(async () => {
    for (const { host, handle } of opened) await host.destroy(handle, signal()).catch(() => {});
    const first = hosts[0];
    if (first) {
      // Nothing labelled for this run may be left behind.
      const left = await first.reconcile(PROJECT, new Set(), signal(), CONNECTION);
      if (left.length) process.stderr.write(`docker isolation: leftovers ${left.join(', ')}\n`);
    }
    for (const host of hosts) await host.guard.close();
  }, 180_000);

  describe('docker sandbox live: two people on one installation', () => {
    test("one person's computer holds none of another's files, home or browser profile", async () => {
      const host = hostWith({});
      const a = await open(host, SPACE_A, { kind: 'deny_all' });
      const b = await open(host, SPACE_B, { kind: 'deny_all' });
      // Looked for in two halves, so no command line ever holds the whole of it.
      const mark = `b-only-${randomBytes(12).toString('hex')}`;
      const half = Math.floor(mark.length / 2);
      const halves = `A='${mark.slice(0, half)}'; B='${mark.slice(half)}'`;
      const look = `${halves}; grep -rlF "$A$B" /work /home /tmp /var/tmp 2>/dev/null | wc -l | sed "s/^/found=/"`;
      const wrote = await sh(
        host,
        b,
        [
          halves,
          'mkdir -p "$HOME/.config/melete-browser/Default"',
          'printf "%s%s" "$A" "$B" > /work/notes.txt',
          'printf "%s%s" "$A" "$B" > "$HOME/.profile-note"',
          'printf "%s%s" "$A" "$B" > "$HOME/.config/melete-browser/Default/Cookies"',
          'printf "%s%s" "$A" "$B" > /tmp/scratch.txt',
          'echo done',
        ].join('; '),
      );
      expect(wrote.text).toContain('done');
      // B finds all four of its own; A finds none, and has no such profile or file.
      expect(line((await sh(host, b, look)).text, 'found')).toBe('4');
      const seen = await sh(
        host,
        a,
        [
          look,
          'test -e /work/notes.txt; echo notes=$?',
          'test -e "$HOME/.config/melete-browser/Default/Cookies"; echo profile=$?',
          'echo hosts=$(grep -c . /etc/hosts)',
        ].join('; '),
      );
      process.stdout.write(`docker isolation, files: ${seen.text}\n`);
      expect(line(seen.text, 'found')).toBe('0');
      expect(line(seen.text, 'notes')).toBe('1');
      expect(line(seen.text, 'profile')).toBe('1');
      // Each computer's two volumes are its own: none is mounted into the other.
      const mounts = async (handle: SandboxHandle) =>
        (
          (await engine.request('GET', `/containers/${handle.providerSandboxId}/json`)) as {
            Mounts?: { Name?: string; Destination?: string }[];
          }
        ).Mounts ?? [];
      const ofA = (await mounts(a)).map((mount) => mount.Name);
      const ofB = (await mounts(b)).map((mount) => mount.Name);
      expect(ofA.sort()).toEqual(
        [`${a.providerSandboxId}-home`, `${a.providerSandboxId}-work`].sort(),
      );
      expect(ofB.sort()).toEqual(
        [`${b.providerSandboxId}-home`, `${b.providerSandboxId}-work`].sort(),
      );
    });
  });

  describe.skipIf(!selfId)('docker sandbox live: two people, open egress', () => {
    // The operator opened every private range to the computers, as a team that
    // wants its internal hosts reachable might: still neither reaches the other.
    const everyPrivateRange = parsePrivateHosts('10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16');
    const recorded: EgressRecordOpen[] = [];

    test("one person's computer cannot reach another's, directly, by name or through the service", async () => {
      const host = hostWith(
        {},
        new SandboxEgressGuard({
          privateHosts: () => everyPrivateRange,
          records: {
            opened: (record) => recorded.push(record),
            closed: () => {},
            counted: () => {},
          },
        }),
      );
      const a = await open(host, SPACE_A, { kind: 'open' });
      const b = await open(host, SPACE_B, { kind: 'open' });
      const secret = `b-secret-${randomBytes(12).toString('hex')}`;
      // B serves its secret on a preview-style port and on 443, as an agent's dev server might.
      const started = await run(host, b, ['python3', '-c', LAUNCH, secret, '8080', '443']);
      expect(started.exitCode).toBe(0);
      // The address the service would forward B's preview to, on B's own network.
      const preview = await host.previewAddress(b, 8080, signal());
      expect(preview).not.toBeNull();
      const bAddress = preview?.host ?? '';
      // The service itself reaches B's server there: the port is real and serving.
      let served = '';
      for (let tries = 0; tries < 40 && !served.includes(secret); tries += 1) {
        served = await readFrom(bAddress, 8080);
        if (!served.includes(secret)) await delay(250);
      }
      expect(served).toBe(secret);
      const on443 = await readFrom(bAddress, 443);
      process.stdout.write(
        `docker isolation: B serves on ${bAddress}:8080${on443 === secret ? ' and :443' : ' (443 not bound)'}\n`,
      );

      // Each computer's network holds it and the service, and nothing of the other's.
      const members = async (handle: SandboxHandle) =>
        Object.keys(
          (
            (await engine.request('GET', `/networks/${handle.providerSandboxId}-net`)) as {
              Containers?: Record<string, unknown>;
            }
          ).Containers ?? {},
        );
      const idOf = async (handle: SandboxHandle) =>
        String(
          (
            (await engine.request('GET', `/containers/${handle.providerSandboxId}/json`)) as {
              Id?: string;
            }
          ).Id,
        );
      const [aId, bId] = [await idOf(a), await idOf(b)];
      const onA = await members(a);
      const onB = await members(b);
      expect(onA).toContain(aId);
      expect(onA).not.toContain(bId);
      expect(onB).toContain(bId);
      expect(onB).not.toContain(aId);
      expect(onA.filter((id) => id !== aId).every((id) => id.startsWith(selfId ?? ''))).toBe(true);

      // A token minted for one of B's commands, presented from A.
      const borrowed = await host.attributeCommand(b, {
        kind: 'command',
        sessionId: 'sbx_PERSON_B',
        jobId: 'job_PERSON_B',
        attemptId: 'att_PERSON_B',
        actionId: 'act_PERSON_B',
      });
      const probe = await run(host, a, [
        'python3',
        '-c',
        PROBE,
        bAddress,
        b.providerSandboxId,
        String(settings().egressPort),
        /cmd:([^@]+)@/.exec(borrowed.env.HTTPS_PROXY ?? '')?.[1] ?? '',
      ]);
      borrowed.settle();
      process.stdout.write(`docker isolation, network:\n${probe.text}\n`);
      // Nothing of B's ever reached A.
      expect(probe.text).not.toContain(secret);
      for (const key of ['direct_ip_8080', 'direct_ip_443', 'direct_name_8080'])
        expect([key, line(probe.text, key)]).toEqual([key, expect.stringMatching(/^closed:/)]);
      expect(line(probe.text, 'name')).toMatch(/^unresolved:/);
      // A's own way out works, so each refusal below is the guard's, not a broken probe.
      expect(line(probe.text, 'guard_public')).toMatch(/^200:/);
      expect(line(probe.text, 'guard_ip_443')).toBe('403:address_denied:');
      expect(line(probe.text, 'guard_name_443')).toBe('403:address_denied:');
      expect(line(probe.text, 'guard_ip_8080')).toBe('403:destination_denied:');
      expect(line(probe.text, 'guard_borrowed')).toBe('407:token_refused:');
      const refusals = recorded
        .filter((record) => record.verdict === 'refused')
        .map((record) => [record.host, record.reason]);
      expect(refusals).toContainEqual([bAddress, 'address_denied']);
      expect(refusals).toContainEqual([b.providerSandboxId, 'address_denied']);
      expect(refusals).toContainEqual(['example.com', 'token_refused']);
    });

    test("the account one person's space connected is used only from that person's computer", async () => {
      const HOST = 'api.creds.test';
      const secret = `tok_iso_${randomBytes(16).toString('hex')}`;
      const upstream = await fixtureUpstream(HOST);
      const account = memoryCredentialPort({ secret, hosts: [HOST] });
      // B's space connected the account; A's space connected nothing.
      const port: EgressCredentialPort = {
        ca: account.ca,
        find: async (input) => (input.space === SPACE_B ? account.find(input) : null),
        computer: async (space) => (space === SPACE_B ? account.computer(space) : null),
        hosts: async (space) => (space === SPACE_B ? account.hosts(space) : []),
        admitWrite: account.admitWrite,
      };
      const guard = new SandboxEgressGuard({
        resolve: async (name) =>
          name === HOST ? [{ address: '93.184.216.34', family: 4 }] : resolveHost(name),
        // A tunnel that is not credentialed goes nowhere here, rather than to that address.
        dial: () => connect(9, '127.0.0.1'),
        credentials: port,
        intercept: {
          upstream: () => ({ address: { address: '127.0.0.1', family: 4 }, port: upstream.port }),
          upstreamCa: upstream.ca,
        },
      });
      const host = hostWith({ egressPort: 18_795, egressCredentials: port }, guard);
      try {
        const a = await open(host, SPACE_A, { kind: 'open' });
        const b = await open(host, SPACE_B, { kind: 'open' });
        const attribution = (who: string) => ({
          kind: 'command' as const,
          sessionId: `sbx_${who}`,
          jobId: `job_${who}`,
          attemptId: `att_${who}`,
          actionId: `act_${who}`,
        });
        const half = Math.floor(secret.length / 2);
        const call = [
          `echo answer=$(curl -s -m 20 https://${HOST}/user; echo " exit=$?")`,
          'echo trusted=$(test -s "$SSL_CERT_FILE" && echo yes || echo no)',
          `A='${secret.slice(0, half)}'; B='${secret.slice(half)}'`,
          'env | grep -cF "$A$B" | sed "s/^/env=/"',
          'grep -rlF "$A$B" /home /work /tmp /etc 2>/dev/null | wc -l | sed "s/^/files=/"',
        ].join('; ');
        // B's command, with B's token, from B's computer: credentialed.
        const ofB = await host.attributeCommand(b, attribution('PERSON_B'));
        const fromB = await sh(host, b, call, ofB.env);
        ofB.settle();
        // A's command, with A's own token, from A's computer: no account here.
        const ofA = await host.attributeCommand(a, attribution('PERSON_A'));
        const fromA = await sh(host, a, call, ofA.env);
        ofA.settle();
        // B's token, carried into A's computer: refused outright.
        const borrowed = await host.attributeCommand(b, attribution('PERSON_B_AGAIN'));
        const stolen = await sh(host, a, call, borrowed.env);
        borrowed.settle();
        process.stdout.write(
          `docker isolation, accounts:\nB: ${fromB.text}\nA: ${fromA.text}\nA with B's token: ${stolen.text}\n`,
        );
        expect(line(fromB.text, 'trusted')).toBe('yes');
        expect(line(fromB.text, 'answer')).toContain('Bearer [redacted]');
        for (const printed of [fromA.text, stolen.text]) {
          expect(line(printed, 'answer')).not.toContain('Bearer');
          expect(line(printed, 'answer')).not.toContain('exit=0');
          expect(line(printed, 'trusted')).toBe('no');
        }
        for (const printed of [fromA.text, fromB.text, stolen.text]) {
          expect(printed).not.toContain(secret);
          expect(line(printed, 'env')).toBe('0');
          expect(line(printed, 'files')).toBe('0');
        }
        // Only B's one request ever reached the service with the account.
        expect(upstream.seen.map((request) => request.headers.authorization)).toEqual([
          `Bearer ${secret}`,
        ]);
      } finally {
        await upstream.close();
      }
    });
  });
}
