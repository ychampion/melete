/**
 * Which socket peer a server believes about somebody else's address.
 *
 * Two servers ask this question. The owner API believes the client address
 * header from the web proxy named by `MELETE_TRUSTED_PROXY`. The web server
 * believes `X-Forwarded-For` from the upstream named by
 * `MELETE_WEB_TRUSTED_UPSTREAM`, which is the Tailscale node when the tailnet
 * overlay is in use. Both need the same rule, so it lives in one file: a
 * deployment names one peer, that peer is followed as its address changes, and
 * nobody else is believed.
 *
 * This file is copied into the web image on its own, so it stays free of
 * dependencies beyond the Node standard library.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Whether a socket peer is the one the deployment named. */
export type TrustedPeer = (peer: string) => boolean | Promise<boolean>;

const FOUND_MS = 30_000;
const MISSING_MS = 5_000;

/**
 * One address, in a single canonical form, or null. An IPv4-mapped IPv6 peer
 * is the same machine as the IPv4 address it wraps, so it compares equal.
 * Anything that is not one well-formed address — a list, a port, a name, an
 * empty string — is null, and a caller that reads a header must treat that as
 * "no address was stated" rather than as a value to pass on.
 */
export function plainAddress(value: string | null | undefined): string | null {
  const address = value?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') ?? '';
  return isIP(address) ? address.toLowerCase() : null;
}

/**
 * The one peer whose statement about another address is believed. Nothing is
 * trusted unless the deployment names it: a literal address, or a service name
 * on a shared Compose network. A name is resolved when needed and remembered
 * briefly, because the peer starts at its own pace and gets a new address when
 * it is recreated; while it does not resolve, nobody is trusted.
 */
export function trustedPeer(
  name: string | undefined,
  resolve: (name: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { family: 4, all: true })).map((entry) => entry.address),
  now: () => number = Date.now,
): TrustedPeer {
  if (!name) return () => false;
  const literal = plainAddress(name);
  if (literal) return (peer) => plainAddress(peer) === literal;
  let known: { addresses: Set<string>; until: number } | undefined;
  let pending: Promise<Set<string>> | undefined;
  return async (peer) => {
    if (!known || now() >= known.until) {
      pending ??= resolve(name)
        .then((found) => new Set(found.flatMap((entry) => plainAddress(entry) ?? [])))
        .catch(() => new Set<string>())
        .then((addresses) => {
          known = {
            addresses,
            until: now() + (addresses.size ? FOUND_MS : MISSING_MS),
          };
          pending = undefined;
          return addresses;
        });
      await pending;
    }
    const address = plainAddress(peer);
    return address !== null && known?.addresses.has(address) === true;
  };
}
