/**
 * Entitlements an operator can grant, and connections can require.
 *
 * The operator grants a person's account a name from a closed list
 * (`verified`), on the operator routes here or on the host with
 * `bun run entitlements`. A connection's operator policy can say a tool
 * requires one (`requires_entitlements`); the broker then refuses the call
 * before anyone is asked and before anything reaches the server, and a remote
 * server that asks for an identity assertion sees the names in it.
 *
 * Only the account that set Melete up writes this table. No route a person or
 * an agent reaches writes it, and nothing a model says is read as a grant.
 */
import {
  type EntitlementKey,
  type EntitlementList,
  entitlementGrantInput,
  entitlementKey,
  entitlementList,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Database } from '../db/client.ts';
import { installationRole } from './admin.ts';

type Reader = Sql | TransactionSql;

/** What a person is told when they lack an entitlement, unless the operator words it. */
export const DEFAULT_GATE_MESSAGE = 'Contact support to get your account verified.';

/** Every entitlement the person holds now, sorted. A lapsed grant is not held. */
export async function entitlementsOf(
  sql: Reader,
  principalId: string | null,
): Promise<EntitlementKey[]> {
  if (!principalId) return [];
  const rows = await sql<{ key: string }[]>`select key from person_entitlement
    where principal_id = ${principalId} and (expires_at is null or expires_at > now())
    order by key`;
  return rows.flatMap((row) => {
    const key = entitlementKey.safeParse(row.key);
    return key.success ? [key.data] : [];
  });
}

/**
 * The one check: refuses unless the person holds every key in `required`.
 * No person (a call with nobody behind it) holds nothing, so it fails closed.
 * Throws a broker fault carrying `message`, which the person reads as is.
 */
export async function requireEntitlement(
  sql: Reader,
  principalId: string | null,
  required: readonly EntitlementKey[] | EntitlementKey,
  message: string = DEFAULT_GATE_MESSAGE,
): Promise<void> {
  const keys = typeof required === 'string' ? [required] : required;
  if (!keys.length) return;
  const held = new Set(await entitlementsOf(sql, principalId));
  if (keys.some((key) => !held.has(key))) throw new BrokerFault('scope_denied', message);
}

/** The person's grants, lapsed ones included, as the routes answer them. */
export async function listEntitlements(sql: Reader, principalId: string): Promise<EntitlementList> {
  const rows = await sql<
    {
      key: string;
      value: Record<string, string>;
      granted_at: Date | string;
      granted_by: string;
      expires_at: Date | string | null;
    }[]
  >`select key, value, granted_at, granted_by, expires_at from person_entitlement
    where principal_id = ${principalId} order by key`;
  return entitlementList.parse({
    principal_id: principalId,
    entitlements: rows.map((row) => ({
      key: row.key,
      value: row.value,
      granted_at: new Date(row.granted_at).toISOString(),
      granted_by: row.granted_by,
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    })),
  });
}

/**
 * Grants one, or replaces the grant's value and expiry. False when there is no
 * such person's account (a room is not one).
 */
export async function grantEntitlement(
  sql: Reader,
  principalId: string,
  key: string,
  grantedBy: string,
  input: unknown = {},
): Promise<boolean> {
  const name = entitlementKey.parse(key);
  const { value, expires_at } = entitlementGrantInput.parse(input);
  const [person] = await sql`select 1 from principal where id = ${principalId} and kind <> 'room'`;
  if (!person) return false;
  await sql`insert into person_entitlement (principal_id, key, value, granted_by, expires_at)
    values (${principalId}, ${name}, ${JSON.stringify(value ?? {})}::jsonb, ${grantedBy}, ${expires_at ?? null})
    on conflict (principal_id, key) do update set value = excluded.value,
      granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at`;
  return true;
}

/** Takes one away. True when it was there. */
export async function revokeEntitlement(sql: Reader, principalId: string, key: string) {
  const removed = await sql`delete from person_entitlement
    where principal_id = ${principalId} and key = ${entitlementKey.parse(key)} returning key`;
  return removed.length > 0;
}

/** Only the account that set Melete up is the operator here. */
async function requireOperator(db: Database, actor: string | undefined) {
  if (!actor) throw new ServiceError('scope_denied', 'Sign in first.', 401);
  if (!(await installationRole(db, actor)).setupOwner)
    throw new ServiceError(
      'scope_denied',
      'Only the account that set Melete up grants entitlements.',
      403,
    );
  return actor;
}

function keyParam(value: string | undefined) {
  const key = entitlementKey.safeParse(value);
  if (!key.success) throw new ServiceError('invalid_request', 'Not an entitlement name.', 400);
  return key.data;
}

export const ENTITLEMENT_ROUTE = '/operator/people/:id/entitlements';

export function mountEntitlements(app: Hono, deps: { db: Database; sql: Sql }) {
  const { db, sql } = deps;
  app.get(ENTITLEMENT_ROUTE, async (c) => {
    await requireOperator(db, c.get('owner')?.id);
    return c.json(await listEntitlements(sql, c.req.param('id') ?? ''));
  });
  app.put(`${ENTITLEMENT_ROUTE}/:key`, async (c) => {
    const actor = await requireOperator(db, c.get('owner')?.id);
    const id = c.req.param('id') ?? '';
    const key = keyParam(c.req.param('key'));
    const text = await c.req.text();
    let body: unknown = {};
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new ServiceError('invalid_request', 'The body is not JSON.', 400);
    }
    const input = entitlementGrantInput.safeParse(body);
    if (!input.success) throw new ServiceError('invalid_request', 'Not a grant.', 400);
    if (!(await grantEntitlement(sql, id, key, actor, input.data)))
      throw new ServiceError('not_found', 'No such account.', 404);
    return c.json(await listEntitlements(sql, id));
  });
  app.delete(`${ENTITLEMENT_ROUTE}/:key`, async (c) => {
    await requireOperator(db, c.get('owner')?.id);
    const id = c.req.param('id') ?? '';
    await revokeEntitlement(sql, id, keyParam(c.req.param('key')));
    return c.json(await listEntitlements(sql, id));
  });
}
