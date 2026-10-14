import { describe, expect, test } from 'bun:test';
import type { DockerHostFacts } from '../../../apps/melete/src/runtime/docker-host.ts';
import {
  DEFAULT_NETWORK_POOL,
  NETWORK_SUBNET_PREFIX,
  parseNetworkPool,
} from '../../../apps/melete/src/runtime/network-pool.ts';
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
import { readAddressPools } from './commands/doctor.ts';
import type { Run } from './context.ts';

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

  test("a Docker network's own bridge is not a route, whatever the bridge is called", () => {
    // One network on a bridge named by com.docker.network.bridge.name, and a real
    // route of this machine inside the pool.
    const table = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'br-spacere\t0005D80A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
      'wg0\t0009D80A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
    ].join('\n');
    const run: Run = (command) => {
      const line = command.join(' ');
      const answer = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (line === 'docker network ls --quiet') return answer('aa01aa01aa01\n');
      if (line.startsWith('docker network inspect')) return answer('10.216.5.0/24 \n');
      if (line === 'cat /proc/net/route') return answer(table);
      return { code: 1, stdout: '', stderr: '' };
    };
    const fact = readAddressPools(run, linuxHost([{ base: '10.216.0.0/14', size: 24 }]), 'off');
    expect(fact?.pools[0]).toMatchObject({ free: 1023, routes: ['10.216.9.0/24'] });
  });
});

/** A local Linux engine whose daemon reports `pools`. */
const linuxHost = (pools?: { base: string; size: number }[]): DockerHostFacts => ({
  platform: 'linux',
  endpoint: null,
  pipePresent: null,
  info: {
    osType: 'linux',
    operatingSystem: 'Ubuntu',
    kernelVersion: '6.8.0',
    memTotal: 0,
    dockerRootDir: '/var/lib/docker',
    ...(pools ? { defaultAddressPools: pools } : {}),
  },
});

const ROUTE_HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';

/** /proc/net/route's line for `iface` reaching `range`. */
function routeLine(iface: string, range: string): string {
  const { start, prefix } = cidr(range);
  const mask = prefix === 0 ? 0 : (2 ** 32 - 2 ** (32 - prefix)) >>> 0;
  const little = (value: number) =>
    [0, 8, 16, 24]
      .map((shift) => (Math.floor(value / 2 ** shift) % 256).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  return `${iface}\t${little(start)}\t00000000\t0001\t0\t0\t0\t${little(mask)}\t0\t0\t0`;
}

/** An engine with networks on `subnets` and a machine with `routes`; every command it ran. */
function engine(subnets: string[], routes: string[] = []) {
  const commands: string[] = [];
  const run: Run = (command) => {
    const line = command.join(' ');
    commands.push(line);
    const answer = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (line === 'docker network ls --quiet')
      return answer(subnets.map((_, index) => `${(0xaa0000 + index).toString(16)}\n`).join(''));
    if (line.startsWith('docker network inspect')) return answer(subnets.join(' \n'));
    if (line === 'cat /proc/net/route') return answer([ROUTE_HEADER, ...routes].join('\n'));
    return { code: 1, stdout: '', stderr: '' };
  };
  return { run, commands };
}

/** The service's own refusal of `value`. */
function refusal(value: string): string {
  try {
    parseNetworkPool(value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`the service takes ${value}`);
}

describe('MELETE_NETWORK_POOL', () => {
  // The daemon names a pool too: with MELETE_NETWORK_POOL on, it is not what is judged.
  const daemon = linuxHost([{ base: '10.216.0.0/14', size: 24 }]);

  test("unset, the service's default pool is judged in /28s, not the engine's pools", () => {
    expect(DEFAULT_NETWORK_POOL).toBe('10.215.0.0/16');
    const { run } = engine(['10.215.0.16/28', '10.215.0.32/28', '10.216.0.0/24', '172.17.0.0/16']);
    for (const unset of [undefined, '', '  ']) {
      const fact = readAddressPools(run, daemon, unset);
      expect(fact).toMatchObject({ source: 'melete', builtIn: false, defaultPool: true });
      expect(fact?.pools).toEqual([
        {
          pool: '10.215.0.0/16',
          size: NETWORK_SUBNET_PREFIX,
          blocks: 4096,
          free: 4094,
          routes: [],
        },
      ]);
      const [result] = judgeAddressPools(fact);
      expect(result).toMatchObject({ id: 'docker.address_pools', level: 'ok' });
      expect(result?.detail).toBe(
        "Melete's network pool 10.215.0.0/16 (MELETE_NETWORK_POOL unset, so the default) has 4094 of 4096 networks left.",
      );
    }
  });

  test('set, its own range is judged: a /24 holds 16 networks, and a few left warns with the setting as the fix', () => {
    const inside = Array.from({ length: 10 }, (_, index) => `10.214.0.${index * 16}/28`);
    const fact = readAddressPools(engine(inside).run, daemon, ' 10.214.0.0/24 ');
    expect(fact).toMatchObject({ source: 'melete', builtIn: false });
    expect(fact?.defaultPool).toBeUndefined();
    expect(fact?.pools[0]).toMatchObject({ pool: '10.214.0.0/24', blocks: 16, free: 6 });
    const [result] = judgeAddressPools(fact);
    expect(result).toMatchObject({ id: 'docker.address_pools', level: 'warn' });
    expect(result?.detail).toContain(
      "Melete's network pool 10.214.0.0/24 (MELETE_NETWORK_POOL) has 6 of 16 networks left.",
    );
    expect(result?.fix).toContain('MELETE_NETWORK_POOL=');
    expect(result?.fix).not.toContain('daemon.json');

    const full = Array.from({ length: 16 }, (_, index) => `10.214.0.${index * 16}/28`);
    const [none] = judgeAddressPools(readAddressPools(engine(full).run, daemon, '10.214.0.0/24'));
    expect(none).toMatchObject({
      level: 'fail',
      detail: expect.stringContaining('all 16 are taken'),
    });
  });

  test("off judges the engine's own pools, as before", () => {
    const { run } = engine(['10.216.5.0/24', '10.215.0.16/28']);
    for (const off of ['off', 'OFF', ' off ']) {
      const fact = readAddressPools(run, daemon, off);
      expect(fact).toMatchObject({ source: 'docker', builtIn: false });
      expect(fact?.pools).toEqual([
        { pool: '10.216.0.0/14', size: 24, blocks: 1024, free: 1023, routes: [] },
      ]);
    }
    expect(readAddressPools(run, daemon, undefined)?.source).toBe('melete');
  });

  test("an unusable value fails with the service's own rule, before Docker is asked", () => {
    for (const bad of [
      '10.214.0.0/25',
      '10.0.0.0/7',
      '127.0.0.0/16',
      '169.254.0.0/16',
      '10.214.0.1/24',
      'nonsense',
      'fd00::/8',
    ]) {
      const { run, commands } = engine(['10.215.0.16/28']);
      const fact = readAddressPools(run, daemon, bad);
      expect(fact).toMatchObject({ source: 'melete', pools: [], invalid: refusal(bad) });
      expect(commands).toEqual([]);
      const results = judgeAddressPools(fact);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'docker.address_pools', level: 'fail' });
      expect(results[0]?.detail).toContain(refusal(bad));
      expect(results[0]?.fix).toContain('/8 to /24');
      expect(results[0]?.fix).toContain('off');
    }
  });

  test("routes are checked against the pool in use, leaving out a Docker network's own bridge", () => {
    const routes = [
      // A network of the pool on a bridge that is not called br-*: its own subnet, not a route.
      routeLine('meletebr0', '10.215.3.0/28'),
      // A VPN reaching into the default pool.
      routeLine('wg0', '10.215.128.0/20'),
      // A LAN route outside it.
      routeLine('eth0', '192.168.1.0/24'),
    ];
    const { run } = engine(['10.215.3.0/28'], routes);
    const fact = readAddressPools(run, daemon, undefined);
    expect(fact?.pools[0]?.routes).toEqual(['10.215.128.0/20']);
    const warning = judgeAddressPools(fact).find((r) => r.id === 'docker.address_pool_routes');
    expect(warning).toMatchObject({ level: 'warn' });
    expect(warning?.detail).toContain('10.215.0.0/16');
    expect(warning?.fix).toContain('MELETE_NETWORK_POOL=');
    expect(warning?.fix).not.toContain('daemon.json');

    // A pool set clear of the VPN is not warned about.
    const moved = readAddressPools(run, daemon, '10.214.0.0/16');
    expect(judgeAddressPools(moved).some((r) => r.id === 'docker.address_pool_routes')).toBe(false);
  });
});

describe('a daemon that reports only IPv6 pools', () => {
  const v6 = { base: 'fd00:dead:beef::/48', size: 64 };

  test("takes IPv4 networks from Docker's built-in pools, so it is judged as unconfigured", () => {
    expect(enginePools([v6])).toEqual({ pools: DOCKER_DEFAULT_POOLS, builtIn: true });
    const v4 = { base: '10.216.0.0/14', size: 24 };
    expect(enginePools([v6, v4])).toEqual({ pools: [v4], builtIn: false });
  });

  test('is not "0 of 0 networks left"', () => {
    const fact = readAddressPools(engine(['172.17.0.0/16']).run, linuxHost([v6]), 'off');
    expect(fact).toMatchObject({ source: 'docker', builtIn: true });
    const [result] = judgeAddressPools(fact);
    expect(result).toMatchObject({ id: 'docker.address_pools', level: 'ok' });
    expect(result?.detail).toBe("Docker's built-in address pools have 30 of 31 networks left.");
  });
});
