/**
 * How many more networks the Docker engine can make. Every bridge network
 * Compose or Melete creates without naming a subnet takes one block from the
 * engine's address pools ("default-address-pools" in daemon.json); with
 * Docker's built-in pools that is 31 blocks for the whole machine. Each chat
 * attempt, agent computer and plugin that reaches a network gets a network of
 * its own, so on a busy machine the blocks run out, and each of those then
 * fails with "all predefined address pools have been fully subnetted".
 *
 * The judgement takes any list of pools, so a pool Melete carves its own
 * networks from can be judged the same way: how many blocks of its size are
 * free, and whether it overlaps a route of this machine.
 */
import type { Result } from './schema.ts';

/** An IPv4 range: its first address as a number, and its prefix length. */
export type Cidr = { start: number; prefix: number };

/** A pool networks are carved from: its range, and the prefix length of each network. */
export type Pool = { base: string; size: number };

/** Docker's pools when daemon.json names none (libnetwork's local-scope defaults). */
export const DOCKER_DEFAULT_POOLS: readonly Pool[] = [
  { base: '172.17.0.0/16', size: 16 },
  { base: '172.18.0.0/16', size: 16 },
  { base: '172.19.0.0/16', size: 16 },
  { base: '172.20.0.0/14', size: 16 },
  { base: '172.24.0.0/14', size: 16 },
  { base: '172.28.0.0/14', size: 16 },
  { base: '192.168.0.0/16', size: 20 },
];

/** Fewer free blocks than this is a warning: a few busy chats take that many. */
export const LOW_NETWORK_BLOCKS = 8;

/** `10.216.0.0/14` as a range; null for IPv6 or anything that is not an IPv4 range. */
export function parseCidr(text: string): Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  const address = octets.reduce((value, octet) => value * 256 + octet, 0);
  const span = 2 ** (32 - prefix);
  return { start: address - (address % span), prefix };
}

const end = (cidr: Cidr) => cidr.start + 2 ** (32 - cidr.prefix) - 1;

export const formatCidr = (cidr: Cidr): string =>
  `${[24, 16, 8, 0].map((shift) => Math.floor(cidr.start / 2 ** shift) % 256).join('.')}/${cidr.prefix}`;

export const overlap = (a: Cidr, b: Cidr): boolean => a.start <= end(b) && b.start <= end(a);

export type PoolHeadroom = {
  pool: string;
  size: number;
  /** The networks of `size` the pool holds. */
  blocks: number;
  /** Those no existing network touches. */
  free: number;
  /** The machine's routes the pool overlaps, as ranges. */
  routes: string[];
};

/**
 * The pool's blocks of its size, and how many no existing network overlaps.
 * Null for a pool that is not an IPv4 range, or whose size is smaller than
 * the range.
 */
export function poolHeadroom(
  pool: Pool,
  taken: readonly Cidr[],
  routes: readonly Cidr[] = [],
): PoolHeadroom | null {
  const range = parseCidr(pool.base);
  if (!range || pool.size < range.prefix || pool.size > 32) return null;
  const blockSize = 2 ** (32 - pool.size);
  const blocks = 2 ** (pool.size - range.prefix);
  // Each taken range covers a run of block indexes; their union is what is used.
  const runs = taken
    .filter((cidr) => overlap(cidr, range))
    .map((cidr): [number, number] => [
      Math.floor((Math.max(cidr.start, range.start) - range.start) / blockSize),
      Math.floor((Math.min(end(cidr), end(range)) - range.start) / blockSize),
    ])
    .sort((a, b) => a[0] - b[0]);
  let used = 0;
  let reach = -1;
  for (const [first, last] of runs) {
    if (last <= reach) continue;
    used += last - Math.max(first, reach + 1) + 1;
    reach = last;
  }
  return {
    pool: formatCidr(range),
    size: pool.size,
    blocks,
    free: blocks - used,
    routes: routes.filter((route) => overlap(route, range)).map(formatCidr),
  };
}

/**
 * This machine's IPv4 routes from /proc/net/route, leaving out the default
 * route and the routes of Docker's own bridges, which are its networks.
 */
export function parseRoutes(text: string): Cidr[] {
  const routes: Cidr[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [iface, destination, , , , , , mask] = line.trim().split(/\s+/);
    if (!iface || !destination || !mask || /^(docker\d*|br-[0-9a-f]+|veth.*)$/.test(iface))
      continue;
    const little = (hex: string) =>
      /^[0-9A-Fa-f]{8}$/.test(hex)
        ? (hex.match(/../g) ?? [])
            .reverse()
            .reduce((value, byte) => value * 256 + Number.parseInt(byte, 16), 0)
        : null;
    const address = little(destination);
    const bits = little(mask);
    if (address === null || bits === null || bits === 0) continue;
    const prefix = bits.toString(2).replace(/0+$/, '').length;
    routes.push({ start: address, prefix });
  }
  return routes;
}

export type AddressPoolFact = {
  /**
   * Whose pools: the engine's own (daemon.json, or Docker's defaults), or the
   * range the service carves its networks from (MELETE_NETWORK_POOL).
   */
  source: 'docker' | 'melete';
  /** Docker's built-in pools, because daemon.json names none. */
  builtIn: boolean;
  pools: PoolHeadroom[];
  /** MELETE_NETWORK_POOL is unset, so the pool is the service's default. */
  defaultPool?: boolean;
  /** Why MELETE_NETWORK_POOL cannot be used, in the service's own words; nothing else is judged. */
  invalid?: string;
};

/**
 * The engine's pools as `docker info` reports them; Docker's own when it
 * reports no IPv4 pool, since IPv4 networks then come from the built-in ones.
 */
export function enginePools(reported: readonly Pool[] | null | undefined): {
  pools: readonly Pool[];
  builtIn: boolean;
} {
  const ipv4 = (reported ?? []).filter((pool) => parseCidr(pool.base) !== null);
  return ipv4.length > 0
    ? { pools: ipv4, builtIn: false }
    : { pools: DOCKER_DEFAULT_POOLS, builtIn: true };
}

const DOCS = 'docs/DEPLOYMENT.md, "Docker address pools"';

/** The rule for the pools networks come from: free blocks, and any route a pool overlaps. */
export function judgeAddressPools(fact: AddressPoolFact | null): Result[] {
  const id = 'docker.address_pools';
  if (fact === null)
    return [
      {
        id,
        level: 'warn',
        detail: "Docker's networks could not be listed, so how many more it can make is not known.",
      },
    ];
  const melete = fact.source === 'melete';
  if (fact.invalid !== undefined)
    return [
      {
        id,
        level: 'fail',
        detail: `${fact.invalid}. The service does not start with it.`,
        fix: `Set MELETE_NETWORK_POOL to a private IPv4 range from /8 to /24 that nothing on your network uses, clear it for the default, or set it to off for Docker's own pools: bun run melete set MELETE_NETWORK_POOL=<range> (${DOCS}).`,
      },
    ];
  const free = fact.pools.reduce((sum, pool) => sum + pool.free, 0);
  const blocks = fact.pools.reduce((sum, pool) => sum + pool.blocks, 0);
  const which = melete
    ? `Melete's network pool ${fact.pools.map((pool) => pool.pool).join(', ')} (MELETE_NETWORK_POOL${fact.defaultPool ? ' unset, so the default' : ''}) has`
    : fact.builtIn
      ? "Docker's built-in address pools have"
      : `Docker's address pools (${fact.pools.map((pool) => `${pool.pool} in /${pool.size}s`).join(', ')}) have`;
  const fix = melete
    ? `Give Melete a larger pool: bun run melete set MELETE_NETWORK_POOL=<range>, a private range from /8 to /24 that nothing on your network uses (a /16 holds 4096 networks) (${DOCS}). Networks no container uses also hold blocks: docker network ls lists them.`
    : `Give Docker a larger pool: in /etc/docker/daemon.json set "default-address-pools": [{"base": "10.216.0.0/14", "size": 24}] (any private range nothing on your network uses), then restart Docker (${DOCS}). Networks no container uses also hold blocks: docker network ls lists them.`;
  const results: Result[] = [
    free === 0
      ? {
          id,
          level: 'fail',
          detail: `${which} no network left: all ${blocks} are taken. Every chat, agent computer and plugin that needs a network of its own fails until one is free.`,
          fix,
        }
      : free < LOW_NETWORK_BLOCKS
        ? {
            id,
            level: 'warn',
            detail: `${which} ${free} of ${blocks} networks left. Each chat attempt, agent computer and plugin with network access takes one while it runs.`,
            fix,
          }
        : { id, level: 'ok', detail: `${which} ${free} of ${blocks} networks left.` },
  ];
  // Docker's built-in pools overlap many home networks, and Docker steps around them itself.
  for (const pool of fact.builtIn ? [] : fact.pools)
    if (pool.routes.length > 0)
      results.push({
        id: 'docker.address_pool_routes',
        level: 'warn',
        detail: `The address pool ${pool.pool} overlaps this machine's route to ${pool.routes.join(', ')}; a network made from it would hide those addresses from the containers on it.`,
        fix: melete
          ? `Choose a pool that no route of this machine overlaps (ip route lists them): bun run melete set MELETE_NETWORK_POOL=<range> (${DOCS}).`
          : `Choose a pool that no route of this machine overlaps (ip route lists them), in /etc/docker/daemon.json (${DOCS}).`,
      });
  return results;
}
