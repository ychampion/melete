/**
 * Where the Docker engine may pull a stdio MCP server's image from: any
 * registry, public or private, except one that points back at the host.
 *
 * The name rules (`mayPullImage` in the contracts) refuse loopback, link-local
 * and metadata addresses, Docker's host aliases, the engine's API ports and
 * wildcard-DNS names that spell those addresses. Before a pull the registry's
 * name is also resolved here, and refused when any address it resolves to is
 * one of those. Private ranges such as 10.0.0.0/8 stay allowed, so a company's
 * own registry works.
 *
 * This is defence in depth, not a guarantee. The engine resolves the name
 * again itself, on the host, and follows a registry's redirects and its
 * sign-in address wherever they lead, so a registry that answers one way here
 * and another way to the engine is not caught.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { addressPointsAtHost, imageRegistry, mayPullImage, registryHost } from '@melete/contracts';

/** Every address a host name resolves to. */
export type HostResolver = (host: string) => Promise<string[]>;

export const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const RESOLVE_TIMEOUT_MS = 5_000;

export type PullCheck = {
  resolve?: HostResolver;
  /**
   * What a name that does not resolve here gets: `refuse`, or `names` to rest
   * on the name rules alone, for a caller with no DNS of its own.
   */
  unresolved: 'refuse' | 'names';
};

/** Whether the engine may pull this image reference (see the module comment). */
export async function imagePullAllowed(reference: string, check: PullCheck): Promise<boolean> {
  if (!mayPullImage(reference)) return false;
  const registry = imageRegistry(reference);
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registryHost(registry);
  // An address literal was judged whole by the name rules.
  if (isIP(host)) return true;
  let addresses: string[];
  try {
    addresses = await withTimeout((check.resolve ?? resolveHost)(host), RESOLVE_TIMEOUT_MS);
  } catch {
    return check.unresolved === 'names';
  }
  if (addresses.length === 0) return check.unresolved === 'names';
  return !addresses.some(addressPointsAtHost);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The registry name did not resolve in time')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
