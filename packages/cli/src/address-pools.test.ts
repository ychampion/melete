import { describe, expect, test } from 'bun:test';
import {
  type Cidr,
  DOCKER_DEFAULT_POOLS,
  enginePools,
  formatCidr,
  judgeAddressPools,
  parseCidr,
  parseRoutes,
  poolHeadroom,
} from './address-pools.ts';

const cidr = (text: string): Cidr => {
  const parsed = parseCidr(text);
  if (!parsed) throw new Error(`not a range: ${text}`);
  return parsed;
};

/** Counts free blocks one by one: the reference poolHeadroom must agree with. */
function bruteFree(base: string, size: number, taken: readonly Cidr[]): number {
  const range = cidr(base);
  const blockSize = 2 ** (32 - size);
  let free = 0;
  for (
    let start = range.start;
    start < range.start + 2 ** (32 - range.prefix);
    start += blockSize
  ) {
    const last = start + blockSize - 1;
    if (!taken.some((t) => t.start <= last && start <= t.start + 2 ** (32 - t.prefix) - 1)) free++;
  }
  return free;
}

describe("Docker's address pools", () => {
  test('ranges are read as IPv4 only, aligned to their prefix', () => {
    expect(formatCidr(cidr('10.216.0.0/14'))).toBe('10.216.0.0/14');
    expect(formatCidr(cidr('10.217.3.9/14'))).toBe('10.216.0.0/14');
    expect(parseCidr('fd00::/64')).toBeNull();
    expect(parseCidr('300.1.1.1/8')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
  });

  test("Docker's built-in pools hold 31 networks, the number a busy machine runs out at", () => {
    const total = DOCKER_DEFAULT_POOLS.map((pool) => poolHeadroom(pool, [])?.blocks ?? 0).reduce(
      (a, b) => a + b,
    );
    expect(total).toBe(31);
    expect(enginePools(undefined)).toEqual({ pools: DOCKER_DEFAULT_POOLS, builtIn: true });
    const configured = [{ base: '10.216.0.0/14', size: 24 }];
    expect(enginePools(configured)).toEqual({ pools: configured, builtIn: false });
  });

  test('a network inside a block, across blocks, or covering the pool counts each block once', () => {
    const pool = { base: '10.216.0.0/14', size: 24 };
    expect(poolHeadroom(pool, [])).toMatchObject({ blocks: 1024, free: 1024 });
    expect(poolHeadroom(pool, [cidr('10.216.1.0/24'), cidr('10.216.1.16/28')])?.free).toBe(1023);
    expect(poolHeadroom(pool, [cidr('10.216.4.0/22')])?.free).toBe(1020);
    expect(poolHeadroom(pool, [cidr('10.0.0.0/8')])?.free).toBe(0);
    expect(poolHeadroom(pool, [cidr('172.17.0.0/16')])?.free).toBe(1024);
    // A future pool of /28s: 4096 in a /16.
    expect(
      poolHeadroom({ base: '10.215.0.0/16', size: 28 }, [cidr('10.215.0.16/28')]),
    ).toMatchObject({
      blocks: 4096,
      free: 4095,
    });
    expect(poolHeadroom({ base: '10.0.0.0/16', size: 8 }, [])).toBeNull();
  });

  test('the free count agrees with counting block by block, for random networks', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    for (let round = 0; round < 200; round++) {
      const size = 20 + (next() % 9);
      const base = `10.${200 + (next() % 20)}.0.0/16`;
      const taken = Array.from({ length: next() % 12 }, () => {
        const prefix = 12 + (next() % 21);
        return cidr(`10.${200 + (next() % 20)}.${next() % 256}.${next() % 256}/${prefix}`);
      });
      expect(poolHeadroom({ base, size }, taken)?.free).toBe(bruteFree(base, size, taken));
    }
  });

  test("this machine's routes leave out the default route and Docker's own bridges", () => {
    const table = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t011090A8\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t00002F0A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'eth1\t00007A0A\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
      'br-d4ae814c9dfb\t0001D50A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    ].join('\n');
    expect(parseRoutes(table).map(formatCidr)).toEqual(['10.47.0.0/16', '10.122.0.0/20']);
  });

  test('no network left fails, a few left warns, and the fix names daemon.json', () => {
    const at = (free: number) =>
      judgeAddressPools({
        source: 'docker',
        builtIn: true,
        pools: [{ pool: '172.17.0.0/16', size: 16, blocks: 31, free, routes: [] }],
      });
    expect(at(0)[0]).toMatchObject({ id: 'docker.address_pools', level: 'fail' });
    expect(at(0)[0]?.detail).toContain('all 31 are taken');
    expect(at(0)[0]?.fix).toContain('"default-address-pools"');
    expect(at(0)[0]?.fix).toContain('Docker address pools');
    expect(at(3)[0]?.level).toBe('warn');
    expect(at(20)[0]).toMatchObject({ level: 'ok', detail: expect.stringContaining('20 of 31') });
    expect(judgeAddressPools(null)[0]?.level).toBe('warn');
  });

  test("a configured pool over one of this machine's routes is a warning; Docker's own pools are not judged so", () => {
    const pool = poolHeadroom({ base: '10.0.0.0/8', size: 24 }, [], [cidr('10.47.0.0/16')]);
    if (!pool) throw new Error('no pool');
    expect(pool.routes).toEqual(['10.47.0.0/16']);
    const configured = judgeAddressPools({ source: 'docker', builtIn: false, pools: [pool] });
    expect(configured.find((r) => r.id === 'docker.address_pool_routes')?.level).toBe('warn');
    const builtIn = judgeAddressPools({ source: 'docker', builtIn: true, pools: [pool] });
    expect(builtIn.some((r) => r.id === 'docker.address_pool_routes')).toBe(false);
  });
});
