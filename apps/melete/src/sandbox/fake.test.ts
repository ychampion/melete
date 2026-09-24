import { expect, test } from 'bun:test';
import { sandboxConformance } from './conformance.ts';
import { FakeSandboxProvider, fakeEgress } from './fake.ts';
import { runCommand } from './marker.ts';

sandboxConformance('fake', async () => {
  const provider = new FakeSandboxProvider();
  return {
    provider,
    secrets: ['melete-conformance-canary'],
    loseNextAcknowledgement: (when) => provider.loseNextAcknowledgement(when),
    close: async () => {},
  };
});

test('stdin given to a marked command reaches it', async () => {
  const provider = new FakeSandboxProvider();
  const handle = await provider.create(
    {
      image: 'base',
      egress: { kind: 'deny_all' },
      region: null,
      lifetimeSeconds: 60,
      idleSeconds: null,
      workdir: '/work',
      labels: {},
      env: {},
    },
    AbortSignal.timeout(1_000),
  );
  const result = await runCommand({
    provider,
    handle,
    request: {
      marker: 'act_01J0FAKESTDIN000000000000',
      argv: ['cat'],
      stdin: new TextEncoder().encode('piped'),
      timeoutMs: 5_000,
      dispatch: 'first',
    },
    workRoot: '.',
    jobId: 'job_FAKESTDIN',
    signal: AbortSignal.timeout(5_000),
  });
  expect(result.outcome === 'succeeded' && new TextDecoder().decode(result.record.preview)).toBe(
    'piped',
  );
});

test('the fake refuses an egress policy outside its declared capabilities', async () => {
  const provider = new FakeSandboxProvider({ capabilities: { egress: ['open'] } });
  await expect(
    provider.create(
      {
        image: 'base',
        egress: { kind: 'deny_all' },
        region: null,
        lifetimeSeconds: 60,
        idleSeconds: null,
        workdir: '/work',
        labels: {},
        env: {},
      },
      AbortSignal.timeout(1_000),
    ),
  ).rejects.toThrow('cannot enforce deny_all');
});

test('the fake allow-lists names on web ports only and addresses by CIDR', () => {
  const domains = { kind: 'domain_allowlist', domains: ['*.example.org'] } as const;
  expect(fakeEgress(domains, 'api.example.org', 443)).toBe('allowed');
  expect(fakeEgress(domains, 'api.example.org', 22)).toBe('blocked');
  expect(fakeEgress(domains, 'example.org', 443)).toBe('unresolved');
  expect(fakeEgress(domains, '1.1.1.1', 443)).toBe('blocked');
  const cidrs = { kind: 'cidr_allowlist', cidrs: ['10.0.0.0/8', '2001:db8::/32'] } as const;
  expect(fakeEgress(cidrs, '10.1.2.3', 5432)).toBe('allowed');
  expect(fakeEgress(cidrs, '11.1.2.3', 5432)).toBe('blocked');
  expect(fakeEgress(cidrs, '2001:db8::1', 443)).toBe('allowed');
  expect(fakeEgress(cidrs, 'example.com', 443)).toBe('unresolved');
  expect(fakeEgress({ kind: 'deny_all' }, 'example.com', null)).toBe('unresolved');
  expect(fakeEgress({ kind: 'open' }, 'example.com', 443)).toBe('allowed');
});
