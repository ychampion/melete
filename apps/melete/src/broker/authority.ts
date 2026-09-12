import { type Action, canonicalizePayload, type JsonObject, jsonObject } from '@melete/contracts';
import { z } from 'zod';
import { BrokerFault } from './errors.ts';
import { appendEvent, type LockedJob, type Query } from './records.ts';

const authority = z.object({
  policyGeneration: z.number().int().nonnegative(),
  connectionGeneration: z.number().int().nonnegative(),
  actingPrincipal: z.string().min(1),
  resource: jsonObject,
  recipient: jsonObject,
  allowed: z.boolean(),
});
export type EffectAuthority = z.infer<typeof authority>;
export type AuthorityInput = {
  job: LockedJob;
  action: Action;
  phase: 'proposal' | 'decision' | 'admission' | 'execution';
};
/** W1 can read and lock its generation columns using this same admission transaction. */
export type EffectAuthorityResolver = (
  tx: Query,
  input: AuthorityInput,
) => Promise<Partial<EffectAuthority>>;

const bindingSchema = z.object({
  tuple: jsonObject,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  policy_generation: z.number().int().nonnegative(),
  connection_generation: z.number().int().nonnegative(),
});
export type EffectBinding = z.infer<typeof bindingSchema>;

function fields(payload: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    keys.filter((key) => key in payload).map((key) => [key, payload[key]]),
  ) as JsonObject;
}

/** The frozen v0.1 schema has one owner; injected policy may name a narrower account principal. */
export async function resolveEffectAuthority(
  tx: Query,
  input: AuthorityInput,
  resolver?: EffectAuthorityResolver,
): Promise<EffectAuthority> {
  const { action } = input;
  const resolved = authority.parse({
    policyGeneration: 0,
    connectionGeneration: 0,
    actingPrincipal: input.job.principal_id ?? 'owner',
    resource: {
      kind: action.kind,
      connection_id: action.connection_id,
      ...fields(action.canonical_payload, [
        'resource',
        'resource_id',
        'url',
        'path',
        'area',
        'from_path',
        'to_path',
        'to_area',
        'uid',
        'calendar',
        'mailbox',
        'folder',
        'id',
      ]),
    },
    recipient: fields(action.canonical_payload, [
      'to',
      'cc',
      'bcc',
      'recipient',
      'recipients',
      'attendees',
    ]),
    allowed: true,
    ...(await resolver?.(tx, input)),
  });
  if (!resolved.allowed)
    throw new BrokerFault('scope_denied', 'Current policy rejects this effect');
  return resolved;
}

export function bindEffect(
  action: Action,
  job: LockedJob,
  resolved: EffectAuthority,
  expiresAt: string | null,
): EffectBinding {
  const tuple = canonicalizePayload({
    action_id: action.id,
    payload_hash: action.payload_hash,
    resource: resolved.resource,
    recipient: resolved.recipient,
    connection_id: action.connection_id,
    acting_principal: resolved.actingPrincipal,
    expires_at: expiresAt,
    job_revision: job.revision,
  });
  return {
    tuple: tuple.canonical,
    hash: tuple.hash,
    policy_generation: resolved.policyGeneration,
    connection_generation: resolved.connectionGeneration,
  };
}

export async function saveBinding(
  tx: Query,
  action: Action,
  binding: EffectBinding,
): Promise<void> {
  await appendEvent(
    tx,
    action.job_id,
    action.attempt_id,
    'notice',
    {
      phase: 'effect_binding',
      action_id: action.id,
      ...binding,
    },
    `broker:binding:${action.id}`,
  );
}

export async function loadBinding(tx: Query, action: Action): Promise<EffectBinding> {
  const [row] = await tx`select payload from event where job_id = ${action.job_id}
    and dedup_key = ${`broker:binding:${action.id}`}`;
  const parsed = bindingSchema.safeParse(row?.payload);
  if (!parsed.success || canonicalizePayload(parsed.data.tuple).hash !== parsed.data.hash)
    throw new BrokerFault('approval_required', 'Recorded effect binding is unavailable');
  return parsed.data;
}

/** Generations fail closed; a changed policy or account needs a newly reviewed action. */
export function requireMatchingBinding(stored: EffectBinding, current: EffectBinding): void {
  if (stored.connection_generation !== current.connection_generation)
    throw new BrokerFault('scope_denied', 'connection_generation');
  if (stored.policy_generation !== current.policy_generation)
    throw new BrokerFault('scope_denied', 'policy_generation');
  if (stored.hash !== current.hash)
    throw new BrokerFault('approval_hash_mismatch', 'effect_binding');
}
