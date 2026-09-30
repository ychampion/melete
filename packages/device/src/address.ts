/**
 * Which web addresses belong to this computer or the network it sits on.
 *
 * The companion uses this twice. A page on this computer or the local network
 * (a router, a printer, a development server, an admin page) opens only when
 * the person approved that exact address. And the companion talks to Melete
 * over plain http only when Melete runs on this same computer, because the
 * token it sends would otherwise cross the network in clear.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv6Number(address: string): bigint | undefined {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const octets = value
      .slice(separator + 1)
      .split('.')
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    )
      return undefined;
    value = `${value.slice(0, separator)}:${((octets[0] as number) * 256 + (octets[1] as number)).toString(16)}:${((octets[2] as number) * 256 + (octets[3] as number)).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((sum, part) => (sum << 16n) | BigInt(`0x${part}`), 0n);
}

/** Only globally routable unicast counts as public, including mapped IPv4. */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6Number(address);
  if (value === undefined) return false;
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isPublicIp(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
  }
  return (
    value >> 125n === 1n &&
    value >> 96n !== 0x20010db8n &&
    value >> 112n !== 0x2002n &&
    value >> 105n !== 0x20010000000000000000000000000000n >> 105n
  );
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.internal', '.home.arpa'];

/** The host of a parsed address, without IPv6 brackets or a trailing dot, lower case. */
export const hostOf = (url: URL) =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

/**
 * True when the name or literal address itself says it is local: an address
 * that is not public, `localhost`, a local-only suffix, or a single-label name
 * that only a local resolver answers.
 */
export function namesLocalHost(host: string): boolean {
  if (isIP(host)) return !isPublicIp(host);
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export type Resolve = (host: string) => Promise<string[]>;

export const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((answer) => answer.address);

/**
 * True when the address is on this computer or its local network, judged by
 * its name and by every address this computer's resolver gives for it, so a
 * public-looking name that points at a local address is caught too. A name
 * that does not resolve is left to the browser, which cannot open it either.
 */
export async function onLocalNetwork(url: URL, resolve: Resolve = resolveHost): Promise<boolean> {
  const host = hostOf(url);
  if (namesLocalHost(host)) return true;
  const answers = await resolve(host).catch(() => [] as string[]);
  return answers.some((answer) => !isPublicIp(answer));
}

/** Loopback only: the one place a token may travel over plain http. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) {
    const value = ipv6Number(host);
    if (value === 1n) return true;
    return value !== undefined && value >> 32n === 0xffffn && Number(value >> 24n) % 256 === 127;
  }
  return false;
}

/**
 * The address Melete is reached at, checked before a code or token is sent to
 * it: https anywhere, plain http only on this same computer.
 */
export function checkServiceAddress(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('The address starts with http:// or https://');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') throw new Error('The address starts with http:// or https://');
  if (!isLoopbackHost(hostOf(url)))
    throw new Error(
      'Melete on another computer is reached over https:// only, so the connection cannot be read on the way.',
    );
  return url;
}
