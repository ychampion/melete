import { afterAll, expect, test } from 'bun:test';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { EgressProxy, egressDestination } from './mcp-egress.ts';

// Every destination is served by one local echo server; the proxy only ever chooses the address.
const echo = createServer((socket) => socket.pipe(socket));
await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
const echoPort = (echo.address() as AddressInfo).port;
const dialed: string[] = [];
const proxy = new EgressProxy({
  resolve: async (host) =>
    ({
      'api.example.com': [{ address: '93.184.216.34', family: 4 as const }],
      'mixed.example.com': [
        { address: '93.184.216.34', family: 4 as const },
        { address: '10.0.0.8', family: 4 as const },
      ],
      'metadata.example.com': [{ address: '169.254.169.254', family: 4 as const }],
    })[host] ?? [],
  dial: (_port, address) => {
    dialed.push(address);
    return connect(echoPort, '127.0.0.1');
  },
});
const port = await proxy.listen(0, '127.0.0.1');
afterAll(async () => {
  await proxy.close();
  await new Promise((resolve) => echo.close(resolve));
});

const basic = (token: string) => `Basic ${Buffer.from(`mcp:${token}`).toString('base64')}`;

/** Sends a request head, then `after` once the tunnel is open, and collects what comes back. */
function ask(head: string, after?: string): Promise<{ text: string; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    let sent = false;
    const done = () => resolve({ text, socket });
    socket.on('data', (bytes) => {
      text += bytes.toString();
      if (after && !sent && text.includes('\r\n\r\n')) {
        sent = true;
        socket.write(after);
        return;
      }
      if (!after || text.includes(after)) done();
    });
    socket.on('close', done);
    socket.on('error', done);
    socket.write(head);
  });
}
const tunnel = (target: string, authorization?: string) =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${
    authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''
  }\r\n`;

test('a grant opens exactly its named destinations, at a public address that was checked', async () => {
  const grant = proxy.grant(['api.example.com', 'other.example.com:8443']);
  const open = await ask(tunnel('api.example.com:443', basic(grant.token)), 'ping\n');
  expect(open.text).toStartWith('HTTP/1.1 200');
  expect(open.text).toContain('ping\n');
  expect(dialed.at(-1)).toBe('93.184.216.34');
  open.socket.destroy();

  // Another host, another port of a named host, or no port at all is refused.
  for (const target of ['elsewhere.example.com:443', 'api.example.com:80', 'api.example.com'])
    expect((await ask(tunnel(target, basic(grant.token)))).text).toContain('403');
  grant.revoke();
});

test('a name that resolves to any private address is refused before a connection is made', async () => {
  const grant = proxy.grant(['mixed.example.com', 'metadata.example.com']);
  const before = dialed.length;
  for (const target of ['mixed.example.com:443', 'metadata.example.com:443']) {
    const answer = await ask(tunnel(target, basic(grant.token)));
    expect(answer.text).toContain('403');
    expect(answer.text).toContain('address_denied');
  }
  expect(dialed.length).toBe(before);
  grant.revoke();
});

test('without a live grant nothing is opened, and plain HTTP is never proxied', async () => {
  const grant = proxy.grant(['api.example.com']);
  expect((await ask(tunnel('api.example.com:443'))).text).toContain('407');
  expect((await ask(tunnel('api.example.com:443', basic('not-a-token')))).text).toContain('407');
  expect(
    (await ask('GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n')).text,
  ).toContain('405');

  // Revoking a grant closes the tunnels it opened and refuses new ones.
  const open = await ask(tunnel('api.example.com:443', basic(grant.token)), 'ping\n');
  expect(open.text).toStartWith('HTTP/1.1 200');
  const closed = new Promise((resolve) => open.socket.once('close', resolve));
  grant.revoke();
  await closed;
  expect((await ask(tunnel('api.example.com:443', basic(grant.token)))).text).toContain('407');
});

test('a destination without a port means HTTPS', () => {
  expect(egressDestination('API.example.com')).toBe('api.example.com:443');
  expect(egressDestination('api.example.com:8443')).toBe('api.example.com:8443');
});
