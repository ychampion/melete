import { describe, expect, test } from 'bun:test';
import { DockerError } from './cell-host-local.ts';
import {
  createPooledNetwork,
  DEFAULT_NETWORK_POOL,
  parseNetworkPool,
  subnetOfPool,
} from './network-pool.ts';

const body = { Name: 'melete-net', Driver: 'bridge', Internal: true };
const OVERLAP = 'invalid pool request: Pool overlaps with other one on this address space';

/** An engine that refuses each subnet in `taken`, by default as one another network has. */
function engine(taken: ReadonlySet<string> = new Set(), status = 403, reason = OVERLAP) {
  const asked: string[] = [];
  return {
    asked,
    request: async (_method: string, _path: string, request?: unknown) => {
      const subnet = (request as { IPAM?: { Config: Array<{ Subnet: string }> } }).IPAM?.Config[0]
        ?.Subnet;
      asked.push(subnet ?? 'engine');
      if (subnet && taken.has(subnet))
        throw new DockerError(status, 'POST', '/networks/create', reason);
      return { Id: 'net_1' };
    },
  };
}

const subnetsOf = (third: number) =>
  new Set(Array.from({ length: 16 }, (_, index) => `10.215.${third}.${index * 16}/28`));

describe('network pool', () => {
  test('reads a range, off, and the default when unset', () => {
    expect(parseNetworkPool(undefined)).toEqual(parseNetworkPool(DEFAULT_NETWORK_POOL));
    expect(parseNetworkPool(' ')).toEqual(parseNetworkPool(DEFAULT_NETWORK_POOL));
    expect(parseNetworkPool('off')).toBeNull();
    expect(parseNetworkPool('172.30.0.0/20')).toEqual({
      start: (172 * 256 + 30) * 65_536,
      prefix: 20,
    });
    for (const bad of [
      '10.215.0.1/16',
      '10.215.0.0',
      '10.256.0.0/16',
      '10.0.0.0/7',
      '10.0.0.0/25',
      'pool',
      '127.0.0.0/16',
      '169.254.0.0/16',
      '160.0.0.0/4',
      '0.0.0.0/8',
      '230.0.0.0/8',
    ])
      expect(() => parseNetworkPool(bad)).toThrow('MELETE_NETWORK_POOL');
  });

  test('a subnet of the pool is one aligned /28 inside it, written plainly', () => {
    const pool = parseNetworkPool('10.215.0.0/16');
    if (!pool) throw new Error('expected a pool');
    expect(subnetOfPool(pool, '10.215.255.240/28')).toBe(true);
    expect(subnetOfPool(pool, '10.215.0.16/28')).toBe(true);
    for (const other of [
      '10.216.0.0/28',
      '10.215.0.8/28',
      '10.215.0.0/24',
      '192.168.1.0/28',
      ' 10.215.0.16/28',
      '10.215.0.016/28',
      undefined,
    ])
      expect(subnetOfPool(pool, other)).toBe(false);
  });

  test('takes a subnet of the pool, and a different one when the engine says it is in use', async () => {
    const pool = parseNetworkPool('10.215.0.0/24');
    const docker = engine(new Set(['10.215.0.0/28']));
    expect(await createPooledNetwork(docker, body, pool, () => 0)).toEqual({ Id: 'net_1' });
    expect(docker.asked).toEqual(['10.215.0.0/28', '10.215.0.16/28']);
  });

  test('finds the last free subnet once the random picks miss', async () => {
    const pool = parseNetworkPool('10.215.0.0/20');
    const taken = new Set(Array.from({ length: 16 }, (_, third) => [...subnetsOf(third)]).flat());
    taken.delete('10.215.9.48/28');
    const docker = engine(taken);
    expect(await createPooledNetwork(docker, body, pool)).toEqual({ Id: 'net_1' });
    expect(docker.asked.at(-1)).toBe('10.215.9.48/28');
    expect(new Set(docker.asked).size).toBe(docker.asked.length);
  });

  test('says so when no subnet is free, and passes any other refusal on at once', async () => {
    const pool = parseNetworkPool('10.215.0.0/24');
    const full = engine(subnetsOf(0));
    await expect(createPooledNetwork(full, body, pool)).rejects.toThrow(
      'No free network was found in 10.215.0.0/24: all 16 of its subnets are taken',
    );
    expect(new Set(full.asked)).toEqual(subnetsOf(0));
    expect(full.asked).toHaveLength(16);
    for (const docker of [
      engine(subnetsOf(0), 500),
      engine(subnetsOf(0), 403, "a profile network's addresses are one subnet of its network pool"),
    ]) {
      await expect(createPooledNetwork(docker, body, pool)).rejects.toBeInstanceOf(DockerError);
      expect(docker.asked).toHaveLength(1);
    }
  });

  test("off leaves the addresses to the engine's own pools", async () => {
    const docker = engine();
    await createPooledNetwork(docker, body, null);
    expect(docker.asked).toEqual(['engine']);
  });
});
