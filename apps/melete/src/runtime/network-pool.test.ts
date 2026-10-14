import { describe, expect, test } from 'bun:test';
import { DockerError } from './cell-host-local.ts';
import {
  createPooledNetwork,
  DEFAULT_NETWORK_POOL,
  parseNetworkPool,
  subnetOfPool,
} from './network-pool.ts';

const body = { Name: 'melete-net', Driver: 'bridge', Internal: true };

/** An engine that refuses, as an overlapping subnet, each subnet in `taken`. */
function engine(taken: ReadonlySet<string> = new Set(), status = 403) {
  const asked: string[] = [];
  return {
    asked,
    request: async (_method: string, _path: string, request?: unknown) => {
      const subnet = (request as { IPAM?: { Config: Array<{ Subnet: string }> } }).IPAM?.Config[0]
        ?.Subnet;
      asked.push(subnet ?? 'engine');
      if (subnet && taken.has(subnet)) throw new DockerError(status, 'POST', '/networks/create');
      return { Id: 'net_1' };
    },
  };
}

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
      '10.0.0.0/29',
      'pool',
    ])
      expect(() => parseNetworkPool(bad)).toThrow('MELETE_NETWORK_POOL');
  });

  test('a subnet of the pool is one aligned /28 inside it', () => {
    const pool = parseNetworkPool('10.215.0.0/16');
    if (!pool) throw new Error('expected a pool');
    expect(subnetOfPool(pool, '10.215.255.240/28')).toBe(true);
    expect(subnetOfPool(pool, '10.215.0.16/28')).toBe(true);
    expect(subnetOfPool(pool, '10.216.0.0/28')).toBe(false);
    expect(subnetOfPool(pool, '10.215.0.8/28')).toBe(false);
    expect(subnetOfPool(pool, '10.215.0.0/24')).toBe(false);
    expect(subnetOfPool(pool, '192.168.1.0/28')).toBe(false);
    expect(subnetOfPool(pool, undefined)).toBe(false);
  });

  test('takes a subnet of the pool, and another when the engine says one is in use', async () => {
    const pool = parseNetworkPool('10.215.0.0/24');
    const picks = [0, 0.5, 0.99];
    const docker = engine(new Set(['10.215.0.0/28']));
    expect(await createPooledNetwork(docker, body, pool, () => picks.shift() ?? 0)).toEqual({
      Id: 'net_1',
    });
    expect(docker.asked).toEqual(['10.215.0.0/28', '10.215.0.128/28']);
  });

  test('says so when no subnet is free, and passes other refusals on', async () => {
    const pool = parseNetworkPool('10.215.0.0/28');
    await expect(
      createPooledNetwork(engine(new Set(['10.215.0.0/28'])), body, pool),
    ).rejects.toThrow('No free network was found in 10.215.0.0/28');
    const broken = engine(new Set(['10.215.0.0/28']), 500);
    await expect(createPooledNetwork(broken, body, pool)).rejects.toBeInstanceOf(DockerError);
    expect(broken.asked).toHaveLength(1);
  });

  test("off leaves the addresses to the engine's own pools", async () => {
    const docker = engine();
    await createPooledNetwork(docker, body, null);
    expect(docker.asked).toEqual(['engine']);
  });
});
