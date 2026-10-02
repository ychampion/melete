/**
 * The egress relay with a connected account: the computer's request is read
 * inside a tunnel the relay terminated, sent upstream with the account added,
 * and answered with the account's secret kept out. Hosts with no account stay
 * blind tunnels. The broker's side of writes is faked here; it has its own
 * tests against Postgres.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import type { EgressWriteInput, EgressWriteOutcome } from '../broker/egress-admission.ts';
import { SandboxEgressGuard } from '../sandbox/adapters/docker-egress.ts';
import { fixtureUpstream, memoryCredentialPort, rawRequest, throughRelay } from './fixtures.ts';
import type { EgressRecordClose, EgressRecordOpen } from './records.ts';

const HOST = 'api.creds.test';
const SECRET = `tok_${'s3cr3t'.repeat(6)}`;
const upstream = await fixtureUpstream(HOST, (request) =>
  request.path === '/leak' ? { body: `you sent ${SECRET} and ${SECRET.slice(0, 5)}` } : undefined,
);
afterAll(() => upstream.close());

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | null = null;
afterEach(async () => {
  await current?.guard.close();
  current = null;
});

async function setup(
  options: {
    admitWrite?: (input: EgressWriteInput) => Promise<EgressWriteOutcome>;
    none?: boolean;
    holdMaxBytes?: number;
    deadlineAt?: number;
  } = {},
) {
  const opened: EgressRecordOpen[] = [];
  const closed: Array<{ id: string } & EgressRecordClose> = [];
  const port = memoryCredentialPort({
    secret: SECRET,
    hosts: [HOST, 'mirror.creds.test'],
    readOnlyHosts: ['mirror.creds.test'],
    ...(options.admitWrite ? { admitWrite: options.admitWrite } : {}),
    none: () => options.none === true,
  });
  const route = { address: { address: '127.0.0.1', family: 4 as const }, port: upstream.port };
  const guard = new SandboxEgressGuard({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    dial: () => connect(upstream.port, '127.0.0.1'),
    records: {
      opened: (record) => opened.push(record),
      closed: (id, totals) => closed.push({ id, ...totals }),
      counted: () => {},
    },
    credentials: port,
    intercept: {
      upstream: () => route,
      upstreamCa: upstream.ca,
      ...(options.holdMaxBytes ? { holdMaxBytes: options.holdMaxBytes } : {}),
    },
  });
  const relayPort = await guard.listen(0, '127.0.0.1');
  guard.allow('127.0.0.1', 'melete-sbx-one', { mode: 'open', session: 'sbx_one', space: 'sp_one' });
  const token = guard.mint('melete-sbx-one', {
    kind: 'command',
    sessionId: 'sbx_one',
    jobId: 'job_one',
    attemptId: 'att_one',
    actionId: 'act_one',
    deadlineAt: options.deadlineAt ?? Date.now() + 120_000,
  });
  const ca = (await port.ca.certificate()).pem;
  const value = { guard, port, relayPort, token, ca, opened, closed };
  current = value;
  return value;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  upstream.seen.length = 0;
});

describe('a connected host', () => {
  test('a read through a connected host is injected, recorded and redacted', async () => {
    const { relayPort, token, ca, guard, opened, closed } = await setup();
    const [echo, leak] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [
        rawRequest('GET', HOST, '/user', {
          headers: { authorization: 'Bearer melete-proxy-adds-this', cookie: 'kept=no' },
        }),
        rawRequest('GET', HOST, '/leak'),
      ],
    });
    // The computer was shown the egress CA's leaf, and the service got the account.
    expect(echo?.issuer).toBe('Melete egress CA');
    expect(upstream.seen.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
    ]);
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    expect(upstream.seen[0]?.headers['accept-encoding']).toBe('identity');
    // What came back never holds the secret, even when the service echoes it.
    expect(echo?.status).toBe(200);
    expect(echo?.body).toContain('Bearer [redacted]');
    expect(leak?.body).toBe(`you sent [redacted] and ${SECRET.slice(0, 5)}`);
    for (const answer of [echo, leak]) {
      expect(answer?.body).not.toContain(SECRET);
      expect(answer?.headers['alt-svc']).toBeUndefined();
      expect(answer?.headers['set-cookie']).toBeUndefined();
    }
    const summary = guard.tokens.settle(token);
    expect(summary).toEqual([
      expect.objectContaining({ host: HOST, tunnels: 1, credentialed: true, reads: 2, writes: 0 }),
    ]);
    await settle();
    expect(opened).toEqual([
      expect.objectContaining({
        host: HOST,
        verdict: 'credentialed',
        connectionId: 'conn_TEST',
        actionId: 'act_one',
      }),
    ]);
    expect(closed).toEqual([expect.objectContaining({ reads: 2, writes: 0, writeActionIds: [] })]);
  });

  test('a host with no connection stays a blind tunnel', async () => {
    const { relayPort, token, opened, port } = await setup({ none: true });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca: upstream.ca,
      token,
      requests: [rawRequest('GET', HOST, '/user', { headers: { authorization: 'Bearer mine' } })],
    });
    // The service's own certificate, and the computer's own header, untouched.
    expect(answer?.issuer).toBe(HOST);
    expect(answer?.status).toBe(200);
    expect(upstream.seen[0]?.headers.authorization).toBe('Bearer mine');
    expect(port.lookups).toBe(1);
    expect(opened).toEqual([expect.objectContaining({ host: HOST, verdict: 'tunnel' })]);
  });

  test('a connection with no token is never offered the account', async () => {
    const { relayPort, port, opened } = await setup();
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca: upstream.ca,
      requests: [rawRequest('GET', HOST, '/user')],
    });
    expect(answer?.issuer).toBe(HOST);
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined();
    expect(port.lookups).toBe(0);
    expect(opened).toEqual([expect.objectContaining({ verdict: 'unattributed' })]);
  });

  test("a request whose Host differs from the tunnel's is refused", async () => {
    const { relayPort, token, ca } = await setup();
    const answers = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [
        rawRequest('GET', 'other.creds.test', '/user'),
        rawRequest('GET', HOST, 'https://other.creds.test/user'),
        rawRequest('GET', HOST, '/user', {
          headers: { upgrade: 'websocket', connection: 'upgrade' },
        }),
      ],
    });
    expect(
      answers.slice(0, 2).map((answer) => [answer.status, answer.headers['x-melete-egress']]),
    ).toEqual([
      [403, 'host_mismatch'],
      [403, 'destination_denied'],
    ]);
    // An upgrade is answered with a refusal, or the runtime drops the connection; never followed.
    expect([403, 0]).toContain(answers[2]?.status ?? 0);
    expect(upstream.seen).toEqual([]);
  });

  test('a credentialed tunnel carries no account once its command has settled', async () => {
    const { relayPort, token, ca, guard } = await setup();
    const answers = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [rawRequest('GET', HOST, '/one'), rawRequest('GET', HOST, '/two')],
      // The command settles between the two requests on one kept-alive tunnel.
      between: async () => {
        guard.tokens.settle(token);
        await settle();
      },
    });
    expect(answers[0]?.status).toBe(200);
    expect(answers[1]?.status).not.toBe(200);
    expect(upstream.seen.map((request) => request.path)).toEqual(['/one']);
  });

  test('a write to a read-only host is refused with its reason', async () => {
    const { relayPort, token, ca } = await setup();
    const [answer] = await throughRelay({
      relayPort,
      host: 'mirror.creds.test',
      ca,
      token,
      requests: [rawRequest('POST', 'mirror.creds.test', '/upload', { body: 'x' })],
    });
    expect(answer?.status).toBe(403);
    expect(answer?.body).toContain('read only');
    expect(upstream.seen).toEqual([]);
  });
});

describe('a write', () => {
  test('a push larger than the hold limit is refused with a plain message', async () => {
    let asked = 0;
    const { relayPort, token, ca } = await setup({
      holdMaxBytes: 4096,
      admitWrite: async () => {
        asked += 1;
        return { kind: 'refused', status: 403, message: 'no', actionId: null };
      },
    });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [rawRequest('POST', HOST, '/upload', { body: 'x'.repeat(5000) })],
    });
    expect(answer?.status).toBe(413);
    expect(answer?.headers['content-type']).toStartWith('text/plain');
    expect(answer?.body).toContain('larger than');
    expect(asked).toBe(0);
    expect(upstream.seen).toEqual([]);
  });

  test('a write waiting for approval is answered in plain words with the action named', async () => {
    const asked: EgressWriteInput[] = [];
    const deadlineAt = Date.now() + 30_000;
    const { relayPort, token, ca } = await setup({
      deadlineAt,
      admitWrite: async (input) => {
        asked.push(input);
        return {
          kind: 'waiting',
          actionId: 'act_WAITING',
          message: 'Waiting for your approval in Melete: POST /repos on api.creds.test.',
        };
      },
    });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [
        rawRequest('POST', HOST, '/repos?draft=1', {
          headers: { 'content-type': 'application/json' },
          body: '{"b":2,"a":1}',
        }),
      ],
    });
    expect(answer?.status).toBe(403);
    expect(answer?.headers['x-melete-approval']).toBe('act_WAITING');
    expect(answer?.body).toContain('Waiting for your approval in Melete');
    expect(upstream.seen).toEqual([]);
    // Classified as the exact request, and held only while the command has time left.
    expect(asked[0]?.write.payload).toEqual({
      host: HOST,
      method: 'POST',
      url_path: '/repos',
      query: 'draft=1',
      body: { json: { a: 1, b: 2 } },
    });
    expect(asked[0]?.connectionId).toBe('conn_TEST');
    expect(asked[0]?.holdMs).toBeLessThanOrEqual(deadlineAt - Date.now() - 9_000);
  });

  test('an admitted write is sent once, with the account, and its answer redacted', async () => {
    let forwards = 0;
    const { relayPort, token, ca, guard, closed } = await setup({
      admitWrite: async (input) => {
        forwards += 1;
        return { kind: 'sent', actionId: 'act_SENT', result: await input.forward() };
      },
    });
    const [answer] = await throughRelay({
      relayPort,
      host: HOST,
      ca,
      token,
      requests: [rawRequest('DELETE', HOST, '/repos/a/b')],
    });
    expect(forwards).toBe(1);
    expect(upstream.seen.map((request) => [request.method, request.headers.authorization])).toEqual(
      [['DELETE', `Bearer ${SECRET}`]],
    );
    expect(answer?.status).toBe(200);
    expect(answer?.body).toContain('Bearer [redacted]');
    expect(guard.tokens.settle(token)).toEqual([
      expect.objectContaining({ host: HOST, credentialed: true, reads: 0, writes: 1 }),
    ]);
    await settle();
    expect(closed).toEqual([expect.objectContaining({ writes: 1, writeActionIds: ['act_SENT'] })]);
  });

  test('at most four requests of one computer are held at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relayPort, token, ca } = await setup({
      admitWrite: async () => {
        await gate;
        return { kind: 'waiting', actionId: 'act_HELD', message: 'Waiting.' };
      },
    });
    const send = () =>
      throughRelay({
        relayPort,
        host: HOST,
        ca,
        token,
        requests: [rawRequest('POST', HOST, '/held', { body: 'x' })],
      });
    const held = [send(), send(), send(), send()];
    await new Promise((resolve) => setTimeout(resolve, 500));
    const [fifth] = await send();
    release();
    const answers = await Promise.all(held);
    expect(fifth?.status).toBe(429);
    expect(answers.map(([answer]) => answer?.status)).toEqual([403, 403, 403, 403]);
  });
});
