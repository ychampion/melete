import { expect, test } from 'bun:test';
import { FAKE_CAPABILITIES, FakeSandboxProvider } from './fake.ts';
import {
  checkSpec,
  openSandbox,
  type RefusalCode,
  SandboxRefusal,
  sandboxLabels,
} from './manifest.ts';
import type { SandboxCapabilities, SandboxSpec } from './types.ts';

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: 'base',
  egress: { kind: 'deny_all' },
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'p1', space: 'sp_1', session: 'sbx_1' }),
  env: {},
  ...over,
});

const refusal = (
  capabilities: SandboxCapabilities,
  candidate: SandboxSpec,
  persistence?: 'ephemeral' | 'pause' | 'snapshot',
): RefusalCode | null => {
  try {
    checkSpec(capabilities, candidate, persistence);
    return null;
  } catch (error) {
    if (!(error instanceof SandboxRefusal)) throw error;
    return error.code;
  }
};

test('a spec inside the capabilities is accepted', () => {
  expect(refusal(FAKE_CAPABILITIES, spec())).toBeNull();
  expect(refusal(FAKE_CAPABILITIES, spec(), 'pause')).toBeNull();
});

test('an egress kind the adapter does not declare is refused, never widened', () => {
  const openOnly = { ...FAKE_CAPABILITIES, egress: ['open'] as const };
  expect(refusal(openOnly, spec())).toBe('egress_unsupported');
  expect(
    refusal(FAKE_CAPABILITIES, spec({ egress: { kind: 'domain_allowlist', domains: [] } })),
  ).toBe('egress_invalid');
  expect(
    refusal(
      FAKE_CAPABILITIES,
      spec({ egress: { kind: 'domain_allowlist', domains: ['no spaces.com'] } }),
    ),
  ).toBe('egress_invalid');
  expect(
    refusal(
      FAKE_CAPABILITIES,
      spec({ egress: { kind: 'cidr_allowlist', cidrs: ['10.0.0.0/33'] } }),
    ),
  ).toBe('egress_invalid');
  expect(
    refusal(
      FAKE_CAPABILITIES,
      spec({ egress: { kind: 'cidr_allowlist', cidrs: ['10.0.0.0/8', '2001:db8::/32'] } }),
    ),
  ).toBeNull();
});

test('lifetime, idle, persistence, region, workdir, labels and environment are each refused', () => {
  expect(refusal(FAKE_CAPABILITIES, spec({ lifetimeSeconds: 3_601 }))).toBe('lifetime_exceeded');
  expect(refusal(FAKE_CAPABILITIES, spec({ lifetimeSeconds: 0 }))).toBe('lifetime_exceeded');
  expect(refusal(FAKE_CAPABILITIES, spec({ idleSeconds: 60 }))).toBe('idle_unsupported');
  expect(refusal(FAKE_CAPABILITIES, spec(), 'snapshot')).toBe('persistence_unsupported');
  expect(refusal(FAKE_CAPABILITIES, spec({ region: 'eu' }))).toBe('region_unsupported');
  expect(refusal(FAKE_CAPABILITIES, spec({ workdir: '/home/user' }))).toBe('workdir_invalid');
  expect(refusal(FAKE_CAPABILITIES, spec({ labels: { 'melete.owner': 'v1' } }))).toBe(
    'labels_invalid',
  );
  expect(
    refusal(FAKE_CAPABILITIES, spec({ labels: { ...spec().labels, 'other.label': 'x' } })),
  ).toBe('labels_invalid');
  expect(refusal(FAKE_CAPABILITIES, spec({ env: { MELETE_ATTEMPT_TOKEN: 'x' } }))).toBe(
    'env_not_allowed',
  );
  expect(refusal(FAKE_CAPABILITIES, spec({ image: 'two words' }))).toBe('image_invalid');
});

test('a refused spec never reaches the provider', async () => {
  const provider = new FakeSandboxProvider({ capabilities: { egress: ['open'] } });
  const refused = await openSandbox(provider, spec(), AbortSignal.timeout(1_000)).catch(
    (error: unknown) => error,
  );
  expect((refused as SandboxRefusal).code).toBe('egress_unsupported');
  expect(provider.calls.create).toBe(0);
});
