/**
 * The docker sandbox's only way out, over real sockets on loopback: a client
 * is admitted by the address it was granted, a tunnel goes to port 443 of the
 * address that was checked and nowhere else, and a revoked grant ends what it
 * opened. Each command's token names its tunnels on the record, and a
 * computer held to its connected hosts reaches those and nothing else.
 */
import { afterEach, expect, test } from 'bun:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ResolvedAddress } from '../../connectors/web.ts';
import type { EgressRecordClose, EgressRecordOpen } from '../../egress/records.ts';
import type { EgressAttribution } from '../../egress/tokens.ts';
import {
  clientAddress,
  hostListed,
  proxyToken,
  SandboxEgressGuard,
  type SandboxEgressOptions,
} from './docker-egress.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A server standing in for the internet: it echoes what arrives, prefixed. */
async function upstream(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    socket.on('data', (data) => socket.write(`echo:${data.toString()}`));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, server };
}

async function guarded(
  names: Record<string, ResolvedAddress[]> = {},
  maxTunnels?: number,
  extra: SandboxEgressOptions = {},
) {
  const target = await upstream();
  const dialled: { port: number; address: string }[] = [];
  const opened: EgressRecordOpen[] = [];
  const closed: (EgressRecordClose & { id: string })[] = [];
  const counted = new Map<string, number>();
  const guard = new SandboxEgressGuard({
    records: {
      opened: (record) => opened.push(record),
      closed: (id, totals) => closed.push({ id, ...totals }),
      counted: (id, count) => counted.set(id, count),
    },
    ...extra,
    resolve: async (host) => {
      const found = names[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    },
    // Every checked address is dialled on loopback, so the test needs no network.
    dial: (port, address) => {
      dialled.push({ port, address });
      return connect(target.port, '127.0.0.1');
    },
    ...(maxTunnels ? { maxTunnels } : {}),
  });
  const port = await guard.listen(0, '127.0.0.1');
  cleanups.push(() => guard.close());
  return { guard, port, dialled, opened, closed, counted };
}

/** Sends a request line to the guard and reads until the status line and headers end. */
async function ask(port: number, request: string) {
  const socket = connect(port, '127.0.0.1');
  cleanups.push(() => void socket.destroy());
  let received = '';
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('data', (data) => {
    received += data.toString();
  });
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(request);
  for (let tries = 0; tries < 100 && !received.includes('\r\n\r\n'); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
  const reason = /x-melete-egress: (\S+)/i.exec(received)?.[1] ?? null;
  return { socket, status, reason, received: () => received, closed };
}

const connectTo = (target: string, token?: string) => {
  const auth =
    token === undefined
      ? ''
      : `Proxy-Authorization: Basic ${Buffer.from(`cmd:${token}`).toString('base64')}\r\n`;
  return `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`;
};
const PUBLIC: ResolvedAddress[] = [{ address: '93.184.215.14', family: 4 }];

test('an address with no grant is not a sandbox', async () => {
  const { port, dialled } = await guarded({ 'example.com': PUBLIC });
  const answer = await ask(port, connectTo('example.com:443'));
  expect([answer.status, answer.reason]).toEqual([407, 'not_a_sandbox']);
  expect(dialled).toEqual([]);
});

test('a granted sandbox tunnels to port 443 of the address that was checked', async () => {
  const { guard, port, dialled } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const answer = await ask(port, connectTo('example.com:443'));
  expect(answer.status).toBe(200);
  expect(dialled).toEqual([{ port: 443, address: '93.184.215.14' }]);
  answer.socket.write('hello');
  for (let tries = 0; tries < 50 && !answer.received().includes('echo:hello'); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answer.received()).toContain('echo:hello');
});

test('other ports, plain requests and non-public addresses are refused', async () => {
  const { guard, port, dialled } = await guarded({
    'example.com': PUBLIC,
    'inside.example': [{ address: '10.0.0.5', family: 4 }],
    'mixed.example': [...PUBLIC, { address: '192.168.1.1', family: 4 }],
    'metadata.example': [{ address: '169.254.169.254', family: 4 }],
  });
  guard.allow('::ffff:127.0.0.1', 'melete-sbx-a');
  for (const [request, status, reason] of [
    [connectTo('example.com:80'), 403, 'destination_denied'],
    [connectTo('example.com:22'), 403, 'destination_denied'],
    [connectTo('inside.example:443'), 403, 'address_denied'],
    [connectTo('mixed.example:443'), 403, 'address_denied'],
    [connectTo('metadata.example:443'), 403, 'address_denied'],
    [connectTo('169.254.169.254:443'), 403, 'address_denied'],
    [connectTo('127.0.0.1:443'), 403, 'address_denied'],
    [connectTo('[::1]:443'), 403, 'address_denied'],
    [connectTo('unknown.example:443'), 403, 'address_denied'],
    ['GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n', 405, 'https_only'],
  ] as const) {
    const answer = await ask(port, request);
    expect([request, answer.status, answer.reason]).toEqual([request, status, reason]);
  }
  expect(dialled).toEqual([]);
});

test('revoking a sandbox ends its open tunnels and refuses new ones', async () => {
  const { guard, port } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const open = await ask(port, connectTo('example.com:443'));
  expect(open.status).toBe(200);
  guard.revoke('melete-sbx-a');
  await open.closed;
  expect(guard.granted('melete-sbx-a')).toEqual([]);
  expect((await ask(port, connectTo('example.com:443'))).status).toBe(407);
});

test('an address given to a new sandbox ends what the old one held', async () => {
  const { guard, port } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-old');
  const open = await ask(port, connectTo('example.com:443'));
  guard.allow('127.0.0.1', 'melete-sbx-new');
  await open.closed;
  expect(guard.granted('melete-sbx-old')).toEqual([]);
  expect(guard.granted('melete-sbx-new')).toEqual(['127.0.0.1']);
});

test('one sandbox holds a bounded number of tunnels', async () => {
  const { guard, port } = await guarded({ 'example.com': PUBLIC }, 2);
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const held: Socket[] = [];
  for (let each = 0; each < 2; each += 1) {
    const answer = await ask(port, connectTo('example.com:443'));
    expect(answer.status).toBe(200);
    held.push(answer.socket);
  }
  const third = await ask(port, connectTo('example.com:443'));
  expect([third.status, third.reason]).toEqual([403, 'too_many_tunnels']);
});

test('a grant needs an IP address, written either way', () => {
  const guard = new SandboxEgressGuard();
  expect(() => guard.allow('sandbox.local', 'melete-sbx-a')).toThrow('needs an IP address');
  expect(clientAddress('::FFFF:10.0.0.2')).toBe('10.0.0.2');
  expect(clientAddress('fe80::1')).toBe('fe80::1');
});

const attribution = (actionId: string, sessionId = 'sbx_a'): EgressAttribution => ({
  kind: 'command',
  sessionId,
  jobId: 'job_one',
  attemptId: 'att_one',
  actionId,
});

/** Waits until the socket has read `text`. */
async function received(answer: { received: () => string }, text: string) {
  for (let tries = 0; tries < 100 && !answer.received().includes(text); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answer.received()).toContain(text);
}

/** Waits until `check` holds; records are written as sockets close. */
async function until(check: () => boolean) {
  for (let tries = 0; tries < 100 && !check(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

test("each command's tunnels are recorded against its action, and a child that outlives its command is recorded unattributed", async () => {
  const { guard, port, opened, closed } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a', space: 'sp_a' });
  const token = guard.mint('melete-sbx-a', attribution('act_one'));

  const tunnel = await ask(port, connectTo('example.com:443', token));
  expect(tunnel.status).toBe(200);
  tunnel.socket.write('hello');
  await received(tunnel, 'echo:hello');
  const refused = await ask(port, connectTo('example.com:22', token));
  expect([refused.status, refused.reason]).toEqual([403, 'destination_denied']);

  // The command settles: its receipt lists what it reached, and its token ends.
  expect(guard.tokens.settle(token)).toEqual([
    { host: 'example.com', tunnels: 1, refused: 1, bytes_up: 5, bytes_down: 10 },
  ]);
  // A process the command left behind still gets out, as nobody's command.
  const child = await ask(port, connectTo('example.com:443', token));
  expect(child.status).toBe(200);

  expect(
    opened.map((record) => [record.host, record.verdict, record.actionId, record.tokenKind]),
  ).toEqual([
    ['example.com', 'tunnel', 'act_one', 'command'],
    ['example.com', 'refused', 'act_one', 'command'],
    ['example.com', 'unattributed', null, null],
  ]);
  expect(opened.map((record) => record.sessionId)).toEqual(['sbx_a', 'sbx_a', 'sbx_a']);
  expect(opened[0]).toMatchObject({ jobId: 'job_one', attemptId: 'att_one', port: 443 });
  expect(opened[1]).toMatchObject({ reason: 'destination_denied', port: 22 });
  expect(opened[1]?.closedAt).toBeInstanceOf(Date);

  tunnel.socket.destroy();
  await until(() => closed.some((each) => each.id === opened[0]?.id));
  expect(closed.find((each) => each.id === opened[0]?.id)).toMatchObject({
    bytesUp: 5,
    bytesDown: 10,
  });
});

test('a token from one computer is refused from another', async () => {
  const { guard, port, dialled, opened } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a', space: 'sp_a' });
  guard.allow('10.9.9.9', 'melete-sbx-b', { session: 'sbx_b', space: 'sp_b' });
  const own = guard.mint('melete-sbx-a', attribution('act_a'));
  const other = guard.mint('melete-sbx-b', attribution('act_b', 'sbx_b'));

  const borrowed = await ask(port, connectTo('example.com:443', other));
  expect([borrowed.status, borrowed.reason]).toEqual([407, 'token_refused']);
  expect(dialled).toEqual([]);
  // Recorded against the computer that asked, naming nothing of the other's command.
  expect(opened).toEqual([
    expect.objectContaining({
      sessionId: 'sbx_a',
      actionId: null,
      verdict: 'refused',
      reason: 'token_refused',
    }),
  ]);
  expect(guard.tokens.settle(other)).toEqual([]);

  expect((await ask(port, connectTo('example.com:443', own))).status).toBe(200);
  expect(opened[1]).toMatchObject({ actionId: 'act_a', verdict: 'tunnel' });
});

test('in connected-hosts-only mode the computer reaches GitHub and nothing else', async () => {
  const GITHUB: ResolvedAddress[] = [{ address: '140.82.112.3', family: 4 }];
  const { guard, port, dialled, opened } = await guarded(
    {
      'github.com': GITHUB,
      'raw.githubusercontent.com': [{ address: '185.199.108.133', family: 4 }],
      'example.com': PUBLIC,
      'api.github.com': GITHUB,
    },
    undefined,
    {
      connectedHosts: (space) => (space === 'sp_a' ? ['github.com', '.githubusercontent.com'] : []),
    },
  );
  guard.allow('127.0.0.1', 'melete-sbx-a', {
    mode: 'connected_hosts_only',
    session: 'sbx_a',
    space: 'sp_a',
  });
  for (const [target, status, reason] of [
    ['github.com:443', 200, null],
    ['GitHub.com:443', 200, null],
    ['raw.githubusercontent.com:443', 200, null],
    ['githubusercontent.com:443', 403, 'host_not_connected'],
    ['api.github.com:443', 403, 'host_not_connected'],
    ['example.com:443', 403, 'host_not_connected'],
    ['github.com.example.com:443', 403, 'host_not_connected'],
    ['140.82.112.3:443', 403, 'host_not_connected'],
    ['github.com:22', 403, 'destination_denied'],
  ] as const) {
    const answer = await ask(port, connectTo(target));
    expect([target, answer.status, answer.reason]).toEqual([target, status, reason]);
  }
  expect(dialled.map((each) => each.address)).toEqual([
    '140.82.112.3',
    '140.82.112.3',
    '185.199.108.133',
  ]);
  expect(opened.filter((record) => record.verdict === 'refused')).toHaveLength(6);
});

test('a host list that cannot be read lets nothing through', async () => {
  const { guard, port, dialled } = await guarded({ 'github.com': PUBLIC }, undefined, {
    connectedHosts: () => Promise.reject(new Error('the database did not answer')),
  });
  guard.allow('127.0.0.1', 'melete-sbx-a', { mode: 'connected_hosts_only' });
  const answer = await ask(port, connectTo('github.com:443'));
  expect([answer.status, answer.reason]).toEqual([403, 'host_not_connected']);
  expect(dialled).toEqual([]);
});

test('an open computer still reaches any public host, and records each tunnel', async () => {
  const { guard, port, opened } = await guarded(
    { 'example.com': PUBLIC, 'github.com': PUBLIC },
    undefined,
    { connectedHosts: () => [] },
  );
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a' });
  for (const target of ['example.com:443', 'github.com:443'])
    expect((await ask(port, connectTo(target))).status).toBe(200);
  expect(opened.map((record) => [record.host, record.verdict])).toEqual([
    ['example.com', 'unattributed'],
    ['github.com', 'unattributed'],
  ]);
});

test('a malformed or unknown token leaves the tunnel unattributed and grants nothing more', async () => {
  const { guard, port, opened } = await guarded({ 'example.com': PUBLIC });
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a' });
  const live = guard.mint('melete-sbx-a', attribution('act_live'));
  const bearer = `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Bearer ${live}\r\n\r\n`;
  for (const request of [
    connectTo('example.com:443', 'not-a-token'),
    connectTo('example.com:443', ''),
    connectTo('example.com:443', live.slice(0, -1)),
    bearer,
  ])
    expect((await ask(port, request)).status).toBe(200);
  expect(opened.map((record) => [record.verdict, record.actionId])).toEqual([
    ['unattributed', null],
    ['unattributed', null],
    ['unattributed', null],
    ['unattributed', null],
  ]);
  expect(guard.tokens.settle(live)).toEqual([]);
});

test('a plain request from a computer is refused and recorded with what it named', async () => {
  const { guard, port, opened, dialled } = await guarded();
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a' });
  const token = guard.mint('melete-sbx-a', attribution('act_plain'));
  const auth = Buffer.from(`cmd:${token}`).toString('base64');
  const answer = await ask(
    port,
    `GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
  );
  expect([answer.status, answer.reason]).toEqual([405, 'https_only']);
  expect(dialled).toEqual([]);
  expect(opened).toEqual([
    expect.objectContaining({
      host: 'example.com',
      port: 80,
      verdict: 'refused',
      reason: 'https_only',
      actionId: 'act_plain',
    }),
  ]);
  expect(guard.tokens.settle(token)).toEqual([
    { host: 'example.com', tunnels: 0, refused: 1, bytes_up: 0, bytes_down: 0 },
  ]);
});

test("revoking a computer ends its commands' tokens, and an address given away ends them too", async () => {
  const { guard } = await guarded();
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const first = guard.mint('melete-sbx-a', attribution('act_one'));
  guard.revoke('melete-sbx-a');
  expect(guard.tokens.find(first)).toBeUndefined();
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const second = guard.mint('melete-sbx-a', attribution('act_two'));
  guard.allow('127.0.0.1', 'melete-sbx-new');
  expect(guard.tokens.find(second)).toBeUndefined();
  expect(guard.tokens.size).toBe(0);
});

test('host lists and proxy tokens are read strictly', () => {
  expect(hostListed('github.com', ['github.com'])).toBe(true);
  expect(hostListed('api.github.com', ['github.com'])).toBe(false);
  expect(hostListed('api.github.com', ['.github.com'])).toBe(true);
  expect(hostListed('github.com', ['.github.com'])).toBe(false);
  expect(hostListed('evilgithub.com', ['.github.com'])).toBe(false);
  expect(hostListed('1.2.3.4', ['1.2.3.4'])).toBe(false);
  const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;
  expect(proxyToken(basic('cmd:abc'))).toBe('abc');
  expect(proxyToken(basic('cmd:a:b'))).toBe('a:b');
  expect(proxyToken(basic('cmd:'))).toBeNull();
  expect(proxyToken(basic('nocolon'))).toBeNull();
  expect(proxyToken('Bearer abc')).toBeNull();
  expect(proxyToken(undefined)).toBeNull();
});

/** Sends `total` requests, `together` at a time, each on its own connection, and waits for every answer. */
async function blast(port: number, request: (index: number) => string, total: number) {
  const together = 50;
  for (let sent = 0; sent < total; sent += together)
    await Promise.all(
      Array.from(
        { length: Math.min(together, total - sent) },
        (_, offset) =>
          new Promise<void>((resolve) => {
            const socket = connect(port, '127.0.0.1', () => socket.write(request(sent + offset)));
            socket.on('data', () => {});
            socket.on('error', () => resolve());
            socket.on('close', () => resolve());
          }),
      ),
    );
}

/** What the records stand for once every count has been written: each id's last count. */
function countsOf(opened: EgressRecordOpen[], counted: Map<string, number>) {
  return opened.map((record) => ({ ...record, count: counted.get(record.id) ?? record.count }));
}

test('a computer that loops on refused connections is held to its record budget', async () => {
  const { guard, port, opened, counted } = await guarded({}, undefined, {
    connectedHosts: () => [],
    recordsPerMinute: 120,
  });
  guard.allow('127.0.0.1', 'melete-sbx-a', { mode: 'connected_hosts_only', session: 'sbx_a' });
  // Half to one host, half each to a host of its own, so coalescing alone cannot hold it.
  await blast(
    port,
    (index) => {
      const host = index % 2 ? 'blocked.example' : `x${index}.invalid`;
      return `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`;
    },
    10_000,
  );
  guard.flushRecords();
  // At most the budget, plus the one record that counts what was over it.
  expect(opened.length).toBeLessThanOrEqual(121);
  const records = countsOf(opened, counted);
  expect(records.reduce((sum, record) => sum + record.count, 0)).toBe(10_000);
  expect(records.filter((record) => record.verdict === 'suppressed')).toEqual([
    expect.objectContaining({ reason: 'over_record_budget', sessionId: 'sbx_a' }),
  ]);
  expect(records.find((record) => record.host === 'blocked.example')?.count).toBe(5_000);
}, 60_000);

test('the same refusal within a minute is one record with a count, and the next minute starts another', async () => {
  let now = 1_000_000;
  const { guard, port, opened, counted } = await guarded({}, undefined, {
    connectedHosts: () => [],
    now: () => now,
  });
  guard.allow('127.0.0.1', 'melete-sbx-a', { mode: 'connected_hosts_only', session: 'sbx_a' });
  const token = guard.mint('melete-sbx-a', attribution('act_loop'));
  for (let each = 0; each < 5; each += 1)
    expect((await ask(port, connectTo('blocked.example:443', token))).reason).toBe(
      'host_not_connected',
    );
  // Its command's receipt still counts every one.
  expect(guard.tokens.settle(token)).toEqual([
    { host: 'blocked.example', tunnels: 0, refused: 5, bytes_up: 0, bytes_down: 0 },
  ]);
  expect(opened).toHaveLength(1);
  guard.flushRecords();
  expect(counted.get(opened[0]?.id ?? '')).toBe(5);
  now += 61_000;
  await ask(port, connectTo('blocked.example:443'));
  expect(opened).toHaveLength(2);
  expect(opened[1]).toMatchObject({ count: 1, actionId: null });
});

test('tunnels count against the budget too, and one past it is counted rather than recorded', async () => {
  const { guard, port, opened, closed, counted } = await guarded(
    { 'example.com': PUBLIC },
    undefined,
    { recordsPerMinute: 2 },
  );
  guard.allow('127.0.0.1', 'melete-sbx-a', { session: 'sbx_a' });
  const tunnels = [];
  for (let each = 0; each < 4; each += 1) {
    const answer = await ask(port, connectTo('example.com:443'));
    expect(answer.status).toBe(200);
    tunnels.push(answer);
  }
  expect(opened.map((record) => record.verdict)).toEqual([
    'unattributed',
    'unattributed',
    'suppressed',
  ]);
  for (const each of tunnels) each.socket.destroy();
  await until(() => closed.length === 2);
  guard.flushRecords();
  expect(counted.get(opened[2]?.id ?? '')).toBe(2);
});

test('narrowing a computer to its listed hosts ends the tunnels it opened while open', async () => {
  const { guard, port } = await guarded({ 'example.com': PUBLIC }, undefined, {
    connectedHosts: () => [],
  });
  guard.allow('127.0.0.1', 'melete-sbx-a');
  const wide = await ask(port, connectTo('example.com:443'));
  expect(wide.status).toBe(200);
  guard.allow('127.0.0.1', 'melete-sbx-a', { mode: 'connected_hosts_only' });
  await wide.closed;
  expect((await ask(port, connectTo('example.com:443'))).reason).toBe('host_not_connected');
});
