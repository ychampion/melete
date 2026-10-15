import { describe, expect, test } from 'bun:test';
import { tokenMayTravel } from './mcp-credentials.ts';
import {
  formatRange,
  inPrivateRange,
  NO_PRIVATE_HOSTS,
  parsePrivateHosts,
  privateHostListed,
  privateHostsFromEnv,
} from './private-hosts.ts';

describe('the operator’s list of internal hosts', () => {
  test('takes names, wildcards and ranges, and is empty by default', () => {
    expect(parsePrivateHosts(undefined)).toBe(NO_PRIVATE_HOSTS);
    expect(parsePrivateHosts(' , ')).toBe(NO_PRIVATE_HOSTS);
    const hosts = parsePrivateHosts(
      'MCP.Corp.Internal, *.tools.corp.internal, 10.20.0.0/16, fd00:20::/32, 192.168.7.9, wiki',
    );
    expect(hosts.names).toEqual(['mcp.corp.internal', 'wiki']);
    expect(hosts.suffixes).toEqual(['.tools.corp.internal']);
    expect(hosts.ranges.map(formatRange)).toEqual([
      '10.20.0.0/16',
      'fd00:20:0:0:0:0:0:0/32',
      '192.168.7.9/32',
    ]);
  });

  test('refuses every entry it cannot read exactly, and says which', () => {
    for (const [value, says] of [
      ['*', 'is not a host name'],
      ['*.internal', 'covers too much with one label'],
      ['*.*.corp.internal', 'is not a wildcard'],
      ['mcp.*.internal', 'is not a host name'],
      ['https://mcp.corp.internal', 'is not a host name'],
      ['mcp.corp.internal:8080', 'is not a host name'],
      ['under_score.internal', 'is not a host name'],
      ['10.20.0.1/16', 'host bits set'],
      ['10.0.0.0/4', 'covers too much'],
      ['0.0.0.0/0', 'covers too much'],
      ['::/0', 'covers too much'],
      ['10.20.0.0/33', 'longer than /32'],
      ['10.20.0.0/', 'no usable prefix'],
      ['10.20.0.0/x', 'no usable prefix'],
      ['010.20.0.0/16', 'is not a host name'],
      ['fe80::1%eth0', 'is not an address range'],
      ['10.20.0.0/16/8', 'is not an address range'],
    ] as const) {
      expect(() => parsePrivateHosts(value)).toThrow(says);
    }
    expect(() =>
      parsePrivateHosts(Array.from({ length: 65 }, (_, i) => `h${i}.x`).join(',')),
    ).toThrow('at most 64');
  });

  test('a range holds its own addresses, in either spelling, and nothing beside them', () => {
    const hosts = parsePrivateHosts('10.20.0.0/16, fd00:20::/32');
    for (const address of ['10.20.0.1', '10.20.255.254', '::ffff:10.20.3.4', 'fd00:20:1::5'])
      expect([address, inPrivateRange(address, hosts)]).toEqual([address, true]);
    for (const address of [
      '10.21.0.1',
      '10.2.0.1',
      '127.0.0.1',
      '::1',
      'fd00:21::5',
      'fe80::1%eth0',
      'not an address',
    ])
      expect([address, inPrivateRange(address, hosts)]).toEqual([address, false]);
    expect(inPrivateRange('10.20.0.1', NO_PRIVATE_HOSTS)).toBe(false);
  });

  test('a range written as IPv4-mapped IPv6 is the IPv4 range it carries, held to the same limits', () => {
    const mapped = parsePrivateHosts('::ffff:10.20.0.0/112, ::ffff:192.168.7.9');
    expect(mapped.ranges.map(formatRange)).toEqual(['10.20.0.0/16', '192.168.7.9/32']);
    for (const address of ['10.20.0.5', '::ffff:10.20.0.5', '192.168.7.9'])
      expect([address, inPrivateRange(address, mapped)]).toEqual([address, true]);
    expect(inPrivateRange('10.21.0.5', mapped)).toBe(false);
    // Every IPv4 address at once is still too wide, however it is written.
    expect(() => parsePrivateHosts('::ffff:0:0/96')).toThrow('covers too much; name a range of /8');
    expect(() => parsePrivateHosts('::ffff:10.20.0.1/112')).toThrow('host bits set');
  });

  test('a host is listed by its name, by a wildcard above it, or as an address in a range', () => {
    const hosts = parsePrivateHosts('mcp.corp.internal, *.tools.corp.internal, 10.20.0.0/16');
    for (const host of [
      'mcp.corp.internal',
      'MCP.corp.internal.',
      'a.tools.corp.internal',
      'b.a.tools.corp.internal',
      '10.20.1.1',
    ])
      expect([host, privateHostListed(host, hosts)]).toEqual([host, true]);
    for (const host of [
      'tools.corp.internal',
      'corp.internal',
      'mcp.corp.internal.evil.example',
      'xtools.corp.internal',
      '10.21.1.1',
      '[::1]',
    ])
      expect([host, privateHostListed(host, hosts)]).toEqual([host, false]);
  });

  test('is read from the environment where it is used, and a bad one opens nothing', () => {
    expect(privateHostsFromEnv({}).ranges).toEqual([]);
    expect(privateHostsFromEnv({ MELETE_PRIVATE_HOSTS: '10.20.0.0/16' }).ranges).toHaveLength(1);
    expect(privateHostsFromEnv({ MELETE_PRIVATE_HOSTS: '10.20.0.0/16, *' })).toBe(NO_PRIVATE_HOSTS);
  });
});

describe('where a token may travel', () => {
  test('over TLS anywhere, over plain http only to this machine or a listed host', () => {
    const hosts = parsePrivateHosts('mcp.corp.internal, *.tools.corp.internal, 10.20.0.0/16');
    for (const url of [
      'https://mcp.example.com/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://localhost:3000/mcp',
      'http://[::1]:3000/mcp',
      'http://mcp.corp.internal/mcp',
      'http://search.tools.corp.internal:8080/mcp',
      'http://10.20.4.4/mcp',
    ])
      expect([url, tokenMayTravel(url, hosts)]).toEqual([url, true]);
    for (const url of [
      'http://mcp.example.com/mcp',
      'http://other.corp.internal/mcp',
      'http://10.30.4.4/mcp',
      'http://user:pass@mcp.corp.internal/mcp',
      'http://mcp.corp.internal/mcp#fragment',
      'ftp://mcp.corp.internal/mcp',
      'not a url',
    ])
      expect([url, tokenMayTravel(url, hosts)]).toEqual([url, false]);
    // With nothing listed, only loopback takes plain http.
    expect(tokenMayTravel('http://mcp.corp.internal/mcp', NO_PRIVATE_HOSTS)).toBe(false);
    expect(tokenMayTravel('http://10.20.4.4/mcp', NO_PRIVATE_HOSTS)).toBe(false);
  });
});
