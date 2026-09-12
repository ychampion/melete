import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Hono } from 'hono';
import type { Env } from '../env.ts';

export type ApiNetwork = {
  hostname: string;
  acceptsPeer: (address: string | undefined) => boolean;
};
export type RequestSource = { remoteAddress?: string };
type SocketSource = { requestIP: (request: Request) => { address: string } | null };

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

/** Use socket metadata only. Forwarded headers are untrusted and cannot select a source. */
export function apiFetch(app: Pick<Hono, 'fetch'>, network: ApiNetwork) {
  return (request: Request, server: SocketSource): Response | Promise<Response> => {
    const remoteAddress = server.requestIP(request)?.address;
    if (!network.acceptsPeer(remoteAddress))
      return Response.json(
        { error: { code: 'control_plane_forbidden', message: 'Forbidden.' } },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    return app.fetch(request, { remoteAddress } satisfies RequestSource);
  };
}
