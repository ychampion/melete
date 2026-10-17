/**
 * The operator's list of internal hosts that anyone on the installation may
 * reach: MELETE_PRIVATE_HOSTS.
 *
 * Without it, an address a person other than the installation's owner names
 * must be public (see public-fetch.ts). A team that runs its own MCP servers,
 * calendars or mail on an internal network lists them here. The list is off by
 * default, and a list that does not parse stops the service at startup.
 *
 * It takes three kinds of entry, comma-separated:
 * - a host name, `mcp.corp.internal`, matched exactly;
 * - a wildcard, `*.corp.internal`, for every name below one (not the name
 *   itself); it needs two labels at least, so `*.internal` alone is refused;
 * - an address range, `10.20.0.0/16` or `fd00:20::/32`, or one address.
 *
 * Ranges decide where a request may land: a private answer is accepted only
 * when it falls in a listed range, whatever name led to it, so a listed name
 * that answers with some other private address (a rebinding) reaches nothing.
 * Names decide where a token may travel without TLS: a bearer token goes over
 * plain http:// only to a listed name, or to an address in a listed range.
 * Cloud metadata is refused whatever the list says, and so is Melete's own
 * network pool (MELETE_NETWORK_POOL), where every agent computer has its
 * network: a range listed for a team's hosts never opens one person's computer
 * to another's.
 */
import { isIP } from 'node:net';

type Range = { family: 4 | 6; base: bigint; prefix: number };

export type PrivateHosts = {
  readonly names: readonly string[];
  /** Each wildcard's suffix with its leading dot: `*.corp.internal` is `.corp.internal`. */
  readonly suffixes: readonly string[];
  readonly ranges: readonly Range[];
};

export const NO_PRIVATE_HOSTS: PrivateHosts = { names: [], suffixes: [], ranges: [] };

/** The most entries the list takes. */
export const MAX_PRIVATE_HOSTS = 64;
/** The widest range an entry may name, by family. */
const WIDEST = { 4: 8, 6: 7 } as const;

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** A DNS name with at least one letter, so it is never read as an address. */
const NAME = new RegExp(`^(?=[a-z0-9.-]*[a-z])${LABEL}(\\.${LABEL})*$`);

/** An IPv6 address as one number, or undefined. An embedded IPv4 tail is read too. */
export function ipv6Number(address: string): bigint | undefined {
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

/** Four decimal octets with no leading zeros, so no spelling is read two ways. */
function ipv4Number(address: string): bigint | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part)))
    return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets.reduce((sum, octet) => (sum << 8n) | BigInt(octet), 0n);
}

/**
 * An address as its family and number. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.5`) is the IPv4 address it carries, so either spelling
 * lands in the same range.
 */
function addressNumber(address: string): { family: 4 | 6; value: bigint } | undefined {
  const text = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(text);
  if (family === 4) {
    const value = ipv4Number(text);
    return value === undefined ? undefined : { family: 4, value };
  }
  if (family !== 6 || text.includes('%')) return undefined;
  const value = ipv6Number(text);
  if (value === undefined) return undefined;
  if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
  return { family: 6, value };
}

const bitsOf = (family: 4 | 6) => (family === 4 ? 32 : 128);

function parseRange(entry: string): Range | string {
  const [base = '', bits, ...rest] = entry.split('/');
  if (rest.length) return `"${entry}" is not an address range`;
  const family = isIP(base);
  if (!family || base.includes('%')) return `"${entry}" is not an address range`;
  let value = family === 4 ? ipv4Number(base) : ipv6Number(base);
  if (value === undefined) return `"${entry}" is not an address range`;
  if (bits !== undefined && !/^\d{1,3}$/.test(bits))
    return `"${entry}" has no usable prefix length`;
  let width = bitsOf(family as 4 | 6);
  let prefix = bits === undefined ? width : Number(bits);
  if (prefix > width) return `"${entry}" has a prefix longer than /${width}`;
  let kind = family as 4 | 6;
  // An answer written as ::ffff:a.b.c.d is matched as the IPv4 address it
  // carries, so a range written that way is held to the IPv4 rules too.
  if (kind === 6 && prefix >= 96 && value >> 32n === 0xffffn) {
    kind = 4;
    value &= 0xffffffffn;
    prefix -= 96;
    width = 32;
  }
  const widest = WIDEST[kind];
  if (prefix < widest) return `"${entry}" covers too much; name a range of /${widest} or narrower`;
  const hostBits = BigInt(width - prefix);
  if ((value & ((1n << hostBits) - 1n)) !== 0n)
    return `"${entry}" has host bits set; write the range from its first address`;
  return { family: kind, base: value, prefix };
}

/**
 * The list `value` names. Every entry must be a host name, a `*.` wildcard or
 * an address range; anything else is an error saying which entry and why, so
 * the service refuses to start rather than guess.
 */
export function parsePrivateHosts(value: string | undefined): PrivateHosts {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return NO_PRIVATE_HOSTS;
  if (entries.length > MAX_PRIVATE_HOSTS)
    throw new Error(`takes at most ${MAX_PRIVATE_HOSTS} entries; it has ${entries.length}`);
  const names: string[] = [];
  const suffixes: string[] = [];
  const ranges: Range[] = [];
  for (const entry of entries) {
    if (entry.length > 253) throw new Error(`"${entry.slice(0, 40)}…" is longer than a host name`);
    if (isIP(entry.split('/')[0] ?? '')) {
      const range = parseRange(entry);
      if (typeof range === 'string') throw new Error(range);
      ranges.push(range);
    } else if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (!NAME.test(suffix))
        throw new Error(`"${entry}" is not a wildcard; write it as *.corp.example.com`);
      if (!suffix.includes('.'))
        throw new Error(
          `"${entry}" covers too much with one label; name at least two, as in *.corp.internal`,
        );
      suffixes.push(`.${suffix}`);
    } else if (NAME.test(entry)) {
      names.push(entry);
    } else {
      throw new Error(
        `"${entry}" is not a host name, a *.wildcard or an address range such as 10.20.0.0/16`,
      );
    }
  }
  return { names, suffixes, ranges };
}

let configured: { value: string | undefined; hosts: PrivateHosts } | undefined;

/**
 * This process's list, from MELETE_PRIVATE_HOSTS. A list that does not parse
 * stopped the service at startup; one that turns bad later opens nothing.
 */
export function privateHostsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PrivateHosts {
  const value = env.MELETE_PRIVATE_HOSTS;
  if (!configured || configured.value !== value) {
    let hosts = NO_PRIVATE_HOSTS;
    try {
      hosts = parsePrivateHosts(value);
    } catch {
      hosts = NO_PRIVATE_HOSTS;
    }
    configured = { value, hosts };
  }
  return configured.hosts;
}

/** Whether an address falls in one of the list's ranges. */
export function inPrivateRange(address: string, hosts: PrivateHosts): boolean {
  if (!hosts.ranges.length) return false;
  const parsed = addressNumber(address);
  if (!parsed) return false;
  return hosts.ranges.some((range) => {
    if (range.family !== parsed.family) return false;
    const shift = BigInt(bitsOf(range.family) - range.prefix);
    return parsed.value >> shift === range.base >> shift;
  });
}

/**
 * Whether an address is on one of these networks, each written as an
 * interface reports it (`172.18.0.3/16`, host bits and all) or as a range.
 * An entry that does not parse matches nothing.
 */
export function onNetworks(address: string, networks: readonly string[]): boolean {
  const parsed = addressNumber(address);
  if (!parsed) return false;
  return networks.some((network) => {
    const [base = '', bits, ...rest] = network.split('/');
    const net = addressNumber(base);
    if (rest.length || !net || net.family !== parsed.family || !/^\d{1,3}$/.test(bits ?? ''))
      return false;
    // An IPv4-mapped network is read as the IPv4 network it carries.
    const prefix = Number(bits) - (isIP(base) === 6 && net.family === 4 ? 96 : 0);
    if (prefix < 0 || prefix > bitsOf(net.family)) return false;
    const shift = BigInt(bitsOf(net.family) - prefix);
    return parsed.value >> shift === net.value >> shift;
  });
}

/**
 * Whether a host, as a URL names it, is on the list: a listed name, a name
 * below a wildcard, or an address literal in a listed range.
 */
export function privateHostListed(host: string, hosts: PrivateHosts): boolean {
  const name = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (isIP(name)) return inPrivateRange(name, hosts);
  return (
    hosts.names.includes(name) ||
    hosts.suffixes.some((suffix) => name.length > suffix.length && name.endsWith(suffix))
  );
}

/** Whether two ranges share any address. */
export function rangesOverlap(
  hosts: PrivateHosts,
  other: { family: 4 | 6; base: bigint; prefix: number },
): Range | undefined {
  return hosts.ranges.find((range) => {
    if (range.family !== other.family) return false;
    const shift = BigInt(bitsOf(range.family) - Math.min(range.prefix, other.prefix));
    return range.base >> shift === other.base >> shift;
  });
}

/** A range as it was written, for messages. */
export function formatRange(range: Range): string {
  if (range.family === 4)
    return `${[24n, 16n, 8n, 0n].map((shift) => String((range.base >> shift) & 255n)).join('.')}/${range.prefix}`;
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((range.base >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  return `${groups.join(':')}/${range.prefix}`;
}
