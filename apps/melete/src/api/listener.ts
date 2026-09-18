import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Hono } from 'hono';
import type { Env } from '../env.ts';
import { plainAddress, type TrustedPeer, trustedPeer } from './trusted-peer.ts';

export type ApiNetwork = {
  hostname: string;
  acceptsPeer: (address: string | undefined) => boolean;
};
/**
 * `remoteAddress` is the socket peer. `clientAddress` is who the request is
 * from: the peer itself, or the browser the trusted web proxy says it carries.
 */
export type RequestSource = { remoteAddress?: string; clientAddress?: string };
type SocketSource = { requestIP: (request: Request) => { address: string } | null };

/**
 * Written by the web proxy from its own socket, over anything the browser sent.
 * Routes never read it; only this listener does, and only from the trusted proxy.
 */
export const CLIENT_ADDRESS_HEADER = 'x-melete-client-address';

/** Whether a socket peer is the deployment's web proxy. */
export type TrustedProxy = TrustedPeer;

/**
 * The one peer whose client address header is believed: the web proxy named by
 * `MELETE_TRUSTED_PROXY`. The rule is shared with the web server, which asks
 * the same question about its own upstream.
 */
export const trustedProxy = trustedPeer;

function ipv4(address: string | undefined): number | null {
  const value = address?.replace(/^::ffff:/i, '');
  if (!value || isIP(value) !== 4) return null;
  return value.split('.').reduce((result, octet) => (result << 8) | Number(octet), 0);
}

/** The listener and its independent source filter use the same local interface. */
export function apiNetwork(address: string, netmask: string): ApiNetwork {
  const host = ipv4(address);
  const mask = ipv4(netmask);
  if (host === null || host === 0 || mask === null || mask === 0 || (~mask & (~mask + 1)) !== 0)
    throw new Error('The owner API requires a specific IPv4 interface and contiguous netmask.');
  const subnet = host & mask;
  return {
    hostname: address,
    acceptsPeer: (peer) => {
      const parsed = ipv4(peer);
      return parsed !== null && (parsed & mask) === subnet;
    },
  };
}

/** Compose assigns this name only on edge; never resolve the multi-network `melete` alias. */
export async function resolveApiNetwork(env: Env): Promise<ApiNetwork> {
  const addresses = await lookup(env.MELETE_API_BIND, { family: 4, all: true });
  const hosts = [...new Set(addresses.map((entry) => entry.address))];
  if (hosts.length !== 1)
    throw new Error('MELETE_API_BIND must resolve to exactly one local IPv4 interface.');
  const nic = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && entry.address === hosts[0]);
  if (!nic || (env.MELETE_RUNTIME_ADAPTER === 'docker' && nic.internal))
    throw new Error('MELETE_API_BIND must identify the owner-facing edge interface.');
  return apiNetwork(nic.address, nic.netmask);
}

/**
 * Admission uses socket metadata only. Forwarded headers are untrusted and
 * cannot select a source; the single exception is the client address header,
 * and only when the socket peer is the trusted web proxy and the value is one
 * well-formed address. From any other peer the header is ignored, so nobody
 * can mint fresh throttle buckets by inventing addresses.
 */
export function apiFetch(
  app: Pick<Hono, 'fetch'>,
  network: ApiNetwork,
  proxy: TrustedProxy = () => false,
) {
  return (request: Request, server: SocketSource): Response | Promise<Response> => {
    const remoteAddress = server.requestIP(request)?.address;
    if (!network.acceptsPeer(remoteAddress))
      return Response.json(
        { error: { code: 'control_plane_forbidden', message: 'Forbidden.' } },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    const peer = plainAddress(remoteAddress) ?? remoteAddress;
    const pass = (clientAddress: string | undefined) =>
      app.fetch(request, { remoteAddress, clientAddress } satisfies RequestSource);
    const claimed = plainAddress(request.headers.get(CLIENT_ADDRESS_HEADER));
    if (!claimed || !peer) return pass(peer);
    const trusted = proxy(peer);
    return trusted instanceof Promise
      ? trusted.then((yes) => pass(yes ? claimed : peer))
      : pass(trusted ? claimed : peer);
  };
}
