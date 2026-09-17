/**
 * What a sandbox adapter can honour, checked before anything is created.
 *
 * An adapter's capabilities are a promise about one provider. A spec that asks
 * for more than that promise is refused here, with the reason, and the provider
 * is never called: a sandbox created with open egress because the requested
 * allow-list was unavailable is exactly the failure this file exists to stop.
 */
import { isIP } from 'node:net';
import type {
  EgressPolicy,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.ts';
import { SANDBOX_WORKDIR } from './workspace.ts';

export type RefusalCode =
  | 'egress_unsupported'
  | 'egress_invalid'
  | 'lifetime_exceeded'
  | 'idle_unsupported'
  | 'persistence_unsupported'
  | 'region_unsupported'
  | 'resources_unsupported'
  | 'workdir_invalid'
  | 'labels_invalid'
  | 'env_not_allowed'
  | 'image_invalid'
  | 'session_exists'
  | 'workspace_exists'
  | 'workspace_busy'
  | 'workspace_incompatible'
  | 'workspace_lost'
  | 'workspace_not_live'
  | 'suspend_failed'
  | 'sandbox_time_exhausted';

export class SandboxRefusal extends Error {
  override readonly name = 'SandboxRefusal';
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** Session persistence as stored; `ephemeral` is the capability `none`. */
export type SessionPersistence = 'ephemeral' | 'pause' | 'snapshot';

export const LABEL_OWNER = 'melete.owner';
export const LABEL_PROJECT = 'melete.project';
export const LABEL_SESSION = 'melete.session';
const LABEL_KEYS = new Set([
  LABEL_OWNER,
  LABEL_PROJECT,
  'melete.space',
  'melete.job',
  'melete.attempt',
  LABEL_SESSION,
]);
const LABEL_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Names a sandbox environment may carry. None of them can hold a credential,
 * and a name outside this list is refused rather than dropped.
 */
export const SANDBOX_ENV_ALLOWED: ReadonlySet<string> = new Set([
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PIP_DISABLE_PIP_VERSION_CHECK',
  'NO_COLOR',
]);

export function sandboxLabels(ids: {
  project: string;
  space: string;
  job?: string | null;
  attempt?: string | null;
  session: string;
}): Record<string, string> {
  return {
    [LABEL_OWNER]: 'v1',
    [LABEL_PROJECT]: ids.project,
    'melete.space': ids.space,
    ...(ids.job ? { 'melete.job': ids.job } : {}),
    ...(ids.attempt ? { 'melete.attempt': ids.attempt } : {}),
    [LABEL_SESSION]: ids.session,
  };
}

/** The installation's own sandboxes, by the same strict test as the local cell runtime. */
export function ownedLabels(
  labels: Readonly<Record<string, string>> | undefined,
  project: string,
): boolean {
  return labels?.[LABEL_OWNER] === 'v1' && labels[LABEL_PROJECT] === project;
}

const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function validCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length || !address || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false;
  const family = isIP(address);
  const bits = Number(prefix);
  return (family === 4 && bits <= 32) || (family === 6 && bits <= 128);
}

function checkEgress(capabilities: SandboxCapabilities, egress: EgressPolicy): void {
  if (!capabilities.egress.includes(egress.kind))
    throw new SandboxRefusal(
      'egress_unsupported',
      `the ${capabilities.adapter} adapter cannot enforce a ${egress.kind} egress policy`,
    );
  if (egress.kind === 'domain_allowlist') {
    if (egress.domains.length === 0 || egress.domains.some((domain) => !DOMAIN.test(domain)))
      throw new SandboxRefusal('egress_invalid', 'a domain allow-list needs valid domain names');
  }
  if (egress.kind === 'cidr_allowlist') {
    if (egress.cidrs.length === 0 || egress.cidrs.some((cidr) => !validCidr(cidr)))
      throw new SandboxRefusal('egress_invalid', 'a CIDR allow-list needs valid CIDR blocks');
  }
}

/** Refuse a spec the capabilities cannot honour. Returns nothing: honour it or throw. */
export function checkSpec(
  capabilities: SandboxCapabilities,
  spec: SandboxSpec,
  persistence: SessionPersistence = 'ephemeral',
): void {
  checkEgress(capabilities, spec.egress);
  if (!spec.image || spec.image.length > 256 || /[\s\0]/.test(spec.image))
    throw new SandboxRefusal('image_invalid', 'the sandbox image reference is not usable');
  if (
    !Number.isSafeInteger(spec.lifetimeSeconds) ||
    spec.lifetimeSeconds <= 0 ||
    spec.lifetimeSeconds > capabilities.maxLifetimeSeconds
  )
    throw new SandboxRefusal(
      'lifetime_exceeded',
      `a ${spec.lifetimeSeconds}s lifetime is above the ${capabilities.adapter} maximum of ${capabilities.maxLifetimeSeconds}s`,
    );
  if (spec.idleSeconds !== null) {
    if (capabilities.maxIdleSeconds === null)
      throw new SandboxRefusal(
        'idle_unsupported',
        `the ${capabilities.adapter} adapter has no idle timeout`,
      );
    if (
      !Number.isSafeInteger(spec.idleSeconds) ||
      spec.idleSeconds <= 0 ||
      spec.idleSeconds > capabilities.maxIdleSeconds
    )
      throw new SandboxRefusal('idle_unsupported', 'the idle timeout is out of range');
  }
  const kind = persistence === 'ephemeral' ? 'none' : persistence;
  if (!capabilities.persistence.includes(kind))
    throw new SandboxRefusal(
      'persistence_unsupported',
      `the ${capabilities.adapter} adapter does not offer ${persistence} persistence`,
    );
  if (spec.region !== null && !capabilities.regions.includes(spec.region))
    throw new SandboxRefusal(
      'region_unsupported',
      `the ${capabilities.adapter} adapter cannot place a sandbox in ${spec.region}`,
    );
  if (spec.workdir !== SANDBOX_WORKDIR)
    throw new SandboxRefusal('workdir_invalid', `the sandbox workdir is always ${SANDBOX_WORKDIR}`);
  for (const [key, value] of Object.entries(spec.labels)) {
    if (!LABEL_KEYS.has(key) || !LABEL_VALUE.test(value))
      throw new SandboxRefusal('labels_invalid', `the label ${JSON.stringify(key)} is not allowed`);
  }
  if (
    spec.labels[LABEL_OWNER] !== 'v1' ||
    !spec.labels[LABEL_PROJECT] ||
    !spec.labels[LABEL_SESSION]
  )
    throw new SandboxRefusal(
      'labels_invalid',
      'a sandbox must carry the owner, project and session labels',
    );
  for (const key of Object.keys(spec.env)) {
    if (!SANDBOX_ENV_ALLOWED.has(key))
      throw new SandboxRefusal(
        'env_not_allowed',
        `the environment name ${JSON.stringify(key)} is not allowed in a sandbox`,
      );
  }
}

/** Check, then create. The provider is not called for a spec it cannot honour. */
export async function openSandbox(
  provider: SandboxProvider,
  spec: SandboxSpec,
  signal: AbortSignal,
  persistence: SessionPersistence = 'ephemeral',
): Promise<SandboxHandle> {
  checkSpec(provider.capabilities, spec, persistence);
  return provider.create(spec, signal);
}
