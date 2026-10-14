/**
 * The addresses Melete's own networks take. Every attempt cell, agent computer
 * and egress MCP server gets a network of its own; left to the engine, each
 * takes a whole block of its default pools, and a host runs out after about
 * thirty. Each network here takes one /28 of MELETE_NETWORK_POOL instead.
 */
import type { DockerApi } from './cell-host-local.ts';

export type NetworkPool = { readonly start: number; readonly prefix: number };

/** Unless MELETE_NETWORK_POOL names another range, or `off` for the engine's own pools. */
export const DEFAULT_NETWORK_POOL = '10.215.0.0/16';
/** 14 addresses: a network has its service, its container and at most a guard. */
export const NETWORK_SUBNET_PREFIX = 28;
const SUBNET_SIZE = 2 ** (32 - NETWORK_SUBNET_PREFIX);
/** Tries at a free subnet before giving up: an engine refuses one that overlaps any of its networks. */
const TRIES = 8;

function address(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((sum, octet) => sum * 256 + octet, 0);
}

const dotted = (value: number) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

function cidr(text: string): NetworkPool | null {
  const [base, bits, ...rest] = text.trim().split('/');
  if (rest.length || base === undefined || bits === undefined || !/^\d{1,2}$/.test(bits))
    return null;
  const start = address(base);
  const prefix = Number(bits);
  if (start === null || prefix > 32) return null;
  // The range's own address, with no host bits set.
  return start % 2 ** (32 - prefix) === 0 ? { start, prefix } : null;
}

/** The pool `value` names: null for `off`; an error saying why for anything else unusable. */
export function parseNetworkPool(value: string | undefined): NetworkPool | null {
  const text = value?.trim() || DEFAULT_NETWORK_POOL;
  if (text.toLowerCase() === 'off') return null;
  const pool = cidr(text);
  if (!pool)
    throw new Error(
      `MELETE_NETWORK_POOL is "${text}"; it takes an IPv4 range such as ${DEFAULT_NETWORK_POOL}, or off`,
    );
  if (pool.prefix < 8 || pool.prefix > NETWORK_SUBNET_PREFIX)
    throw new Error(
      `MELETE_NETWORK_POOL is "${text}"; its size is between /8 and /${NETWORK_SUBNET_PREFIX}`,
    );
  return pool;
}

export const formatPool = (pool: NetworkPool) => `${dotted(pool.start)}/${pool.prefix}`;

let configured: { value: string | undefined; pool: NetworkPool | null } | undefined;

/** This process's pool, from MELETE_NETWORK_POOL (checked when the service starts). */
export function networkPool(): NetworkPool | null {
  const value = process.env.MELETE_NETWORK_POOL;
  if (!configured || configured.value !== value)
    configured = { value, pool: parseNetworkPool(value) };
  return configured.pool;
}

/** Whether `subnet` is exactly one network's share of `pool`. */
export function subnetOfPool(pool: NetworkPool, subnet: unknown): boolean {
  if (typeof subnet !== 'string') return false;
  const range = cidr(subnet);
  if (!range || range.prefix !== NETWORK_SUBNET_PREFIX) return false;
  return range.start >= pool.start && range.start < pool.start + 2 ** (32 - pool.prefix);
}

/**
 * Create the network `body` describes on a free subnet of `pool`, or on one of
 * the engine's own pools when there is none. Subnets are tried at random, so
 * services and installations on one engine rarely want the same one.
 */
export async function createPooledNetwork(
  docker: DockerApi,
  body: Record<string, unknown>,
  pool: NetworkPool | null = networkPool(),
  random: () => number = Math.random,
): Promise<{ Id: string }> {
  if (!pool) return (await docker.request('POST', '/networks/create', body)) as { Id: string };
  const subnets = 2 ** (NETWORK_SUBNET_PREFIX - pool.prefix);
  let refused: unknown;
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const subnet = `${dotted(pool.start + Math.floor(random() * subnets) * SUBNET_SIZE)}/${NETWORK_SUBNET_PREFIX}`;
    try {
      return (await docker.request('POST', '/networks/create', {
        ...body,
        IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
      })) as { Id: string };
    } catch (error) {
      // The engine answers 403 for a subnet another network already has.
      if (!(error instanceof Error && 'status' in error && error.status === 403)) throw error;
      refused = error;
    }
  }
  throw new Error(
    `No free network was found in ${formatPool(pool)} after ${TRIES} tries; set MELETE_NETWORK_POOL to a larger range no other network on this host uses`,
    { cause: refused },
  );
}
