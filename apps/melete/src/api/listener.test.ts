import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { apiFetch, apiNetwork, resolveApiNetwork } from './listener.ts';

describe('owner API network boundary', () => {
  const network = apiNetwork('172.20.0.3', '255.255.0.0');

  test('only the owner interface subnet is admitted, including IPv4-mapped peers', () => {
    for (const peer of ['172.20.0.1', '172.20.0.4', '::ffff:172.20.0.4'])
      expect(network.acceptsPeer(peer)).toBe(true);
    for (const peer of ['172.18.0.2', '172.21.0.2', '127.0.0.1', '::1', undefined])
      expect(network.acceptsPeer(peer)).toBe(false);
    expect(() => apiNetwork('0.0.0.0', '255.255.0.0')).toThrow();
    expect(() => apiNetwork('172.20.0.3', '0.0.0.0')).toThrow();
    expect(() => apiNetwork('172.20.0.3', '255.0.255.0')).toThrow();
  });

  test('the transport guard rejects setup, login and health before any account lookup', async () => {
    let calls = 0;
    const fetch = apiFetch(
      {
        fetch: () => {
          calls++;
          return Response.json({ account_state: 'must not be reached' });
        },
      },
      network,
    );
    for (const path of ['/setup', '/login', '/health']) {
      const request = new Request(`http://172.20.0.3:8787${path}`, {
        method: path === '/health' ? 'GET' : 'POST',
        headers: { 'X-Forwarded-For': '172.20.0.1', 'X-Real-IP': '172.20.0.1' },
      });
      const response = await fetch(request, { requestIP: () => ({ address: '172.21.0.2' }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: 'control_plane_forbidden', message: 'Forbidden.' },
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(calls).toBe(0);
  });

  test('a real socket supplies the login source instead of forwarded headers', async () => {
    const network = await resolveApiNetwork(loadEnv({}));
    const fetch = apiFetch({ fetch: (_request, bindings) => Response.json(bindings) }, network);
    const server = Bun.serve({ hostname: network.hostname, port: 0, fetch });
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${server.port}/login`, {
        headers: { 'X-Forwarded-For': '192.0.2.1', 'X-Real-IP': '192.0.2.2' },
      });
      expect(await response.json()).toEqual({
        remoteAddress: '127.0.0.1',
        clientAddress: '127.0.0.1',
      });
    } finally {
      await server.stop(true);
    }
  });

  test('the client address header counts only when the trusted proxy is the socket peer', async () => {
    const proxy = '172.20.0.5';
    const fetch = apiFetch(
      { fetch: (_request, bindings) => Response.json(bindings) },
      network,
      (peer) => peer === proxy,
    );
    const seen = async (peer: string, headers: Record<string, string>) =>
      (
        await fetch(new Request('http://melete-api:8787/login', { method: 'POST', headers }), {
          requestIP: () => ({ address: peer }),
        })
      ).json();
    expect(await seen(proxy, { 'X-Melete-Client-Address': '203.0.113.9' })).toEqual({
      remoteAddress: proxy,
      clientAddress: '203.0.113.9',
    });
    expect(
      await seen(`::ffff:${proxy}`, { 'X-Melete-Client-Address': '::ffff:203.0.113.9' }),
    ).toEqual({ remoteAddress: `::ffff:${proxy}`, clientAddress: '203.0.113.9' });
    expect(await seen(proxy, { 'X-Melete-Client-Address': '2001:db8::1' })).toEqual({
      remoteAddress: proxy,
      clientAddress: '2001:db8::1',
    });
    // Any other peer on the edge network speaks only for itself, whatever it claims.
    const claims: Record<string, string>[] = [
      { 'X-Melete-Client-Address': '203.0.113.9' },
      { 'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '203.0.113.9' },
    ];
    for (const headers of claims)
      expect(await seen('172.20.0.1', headers)).toEqual({
        remoteAddress: '172.20.0.1',
        clientAddress: '172.20.0.1',
      });
    // The proxy is believed only for a well-formed address, and never through other headers.
    const unusable: Record<string, string>[] = [
      { 'X-Melete-Client-Address': '203.0.113.9, 198.51.100.4' },
      { 'X-Melete-Client-Address': 'owner' },
      { 'X-Forwarded-For': '203.0.113.9' },
      {},
    ];
    for (const headers of unusable)
      expect(await seen(proxy, headers)).toEqual({ remoteAddress: proxy, clientAddress: proxy });
  });

  test('without a configured proxy no peer is believed', async () => {
    const fetch = apiFetch({ fetch: (_request, bindings) => Response.json(bindings) }, network);
    const response = await fetch(
      new Request('http://melete-api:8787/login', {
        method: 'POST',
        headers: { 'X-Melete-Client-Address': '203.0.113.9' },
      }),
      { requestIP: () => ({ address: '172.20.0.5' }) },
    );
    expect(await response.json()).toEqual({
      remoteAddress: '172.20.0.5',
      clientAddress: '172.20.0.5',
    });
  });

  test('missing socket metadata is denied instead of trusting a forwarded address', async () => {
    const fetch = apiFetch({ fetch: () => new Response('account state') }, network);
    const response = await fetch(new Request('http://melete:8787/setup'), {
      requestIP: () => null,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('account state');
  });
});
