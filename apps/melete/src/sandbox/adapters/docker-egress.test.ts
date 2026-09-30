/**
 * The docker sandbox's only way out, over real sockets on loopback: a client
 * is admitted by the address it was granted, a tunnel goes to port 443 of the
 * address that was checked and nowhere else, and a revoked grant ends what it
 * opened.
 */
import { afterEach, expect, test } from 'bun:test';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ResolvedAddress } from '../../connectors/web.ts';
import { clientAddress, SandboxEgressGuard } from './docker-egress.ts';

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

async function guarded(names: Record<string, ResolvedAddress[]> = {}, maxTunnels?: number) {
  const target = await upstream();
  const dialled: { port: number; address: string }[] = [];
  const guard = new SandboxEgressGuard({
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
  return { guard, port, dialled };
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

const connectTo = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
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
