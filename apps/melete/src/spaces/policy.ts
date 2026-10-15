/**
 * A space's rules: which models its work may run on, and which kinds of
 * connected app and tool it may not use. The installation's setup owner sets
 * them for any space, and a space's own owner for theirs; anyone the space
 * admits may read them.
 *
 * They are read where each choice is made rather than copied into it, so a
 * change applies from the next attempt, the next catalog and the next call:
 *
 * - the model an attempt runs on, and the routes its calls may take
 *   (`gateway/model-settings.ts`, `broker/gateway-budget.ts`);
 * - the tools an attempt is offered and admitted (`broker/catalog.ts`,
 *   `broker/service.ts`, `knowledge/catalog.ts`);
 * - a new connection installed into the space (`api/connections.ts`).
 *
 * A space with no rules, or with every list empty, is restricted in nothing.
 */
import {
  type SpacePolicy,
  type SpacePolicyRules,
  spacePolicyResponse,
  spacePolicyRules,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { owner, space } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { GatewayRoutes } from '../gateway/types.ts';
import { SPACE_BEING_CLEARED, spaceAuthority } from '../principals/authority.ts';
import { spacePolicy } from './schema.ts';

export type SpaceRules = {
  allowedModels: readonly string[];
  deniedConnectorKinds: readonly string[];
  deniedToolKinds: readonly string[];
};

export const NO_RULES: SpaceRules = {
  allowedModels: [],
  deniedConnectorKinds: [],
  deniedToolKinds: [],
};

type ModelChoice = { provider: string; model: string };

const named = (choice: ModelChoice) => `${choice.provider}/${choice.model}`;

/** Whether the rules let work run on this model. With no list, every model is allowed. */
export function modelAllowed(rules: SpaceRules, choice: ModelChoice): boolean {
  return rules.allowedModels.length === 0 || rules.allowedModels.includes(named(choice));
}

/** The allowed models in the order they were listed, each split at its first slash. */
export function allowedChoices(rules: SpaceRules): ModelChoice[] {
  return rules.allowedModels.flatMap((entry) => {
    const slash = entry.indexOf('/');
    return slash > 0 ? [{ provider: entry.slice(0, slash), model: entry.slice(slash + 1) }] : [];
  });
}

/** Whether the rules keep this kind of connection, by its provider, out of the space. */
export function connectorDenied(rules: SpaceRules, provider: string): boolean {
  return rules.deniedConnectorKinds.includes(provider.toLowerCase());
}

/**
 * Whether the rules keep this tool out of the space: named exactly, or as a
 * family by the start of its name up to a dot, so `email` covers `email.send`
 * and `email.read` but not `emailer.run`.
 */
export function toolDenied(rules: SpaceRules, name: string): boolean {
  const tool = name.toLowerCase();
  return rules.deniedToolKinds.some((kind) => tool === kind || tool.startsWith(`${kind}.`));
}

/** Whether a connection's tool may be offered here: neither its kind of connection nor it is denied. */
export const toolAllowedHere = (rules: SpaceRules, provider: string, name: string): boolean =>
  !connectorDenied(rules, provider) && !toolDenied(rules, name);

/** The routes a call may take, less any model the rules do not allow. */
export function allowedRoutes(
  rules: SpaceRules,
  routes: GatewayRoutes | undefined,
): GatewayRoutes | undefined {
  if (!routes || rules.allowedModels.length === 0) return routes;
  const vision = routes.vision && modelAllowed(rules, routes.vision) ? routes.vision : undefined;
  const fallback = (routes.fallback ?? []).filter((choice) => modelAllowed(rules, choice));
  if (!vision && !fallback.length) return undefined;
  return { ...(vision ? { vision } : {}), ...(fallback.length ? { fallback } : {}) };
}

/** What a person is told when no model the rules allow can be used. */
export function modelRefusal(rules: SpaceRules, asked: ModelChoice): string {
  const allowed = rules.allowedModels;
  const list =
    allowed.length === 1
      ? allowed[0]
      : `${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}`;
  return `This space's rules let its work run only on ${list}, and none of them is connected here, so ${named(asked)} was not used. Connect an allowed model in Settings, under Models, or ask whoever set this space's rules to allow another.`;
}

/** What installing a denied kind of connection is told. */
export const connectorRefusal = (provider: string) =>
  `This space's rules do not allow ${provider} connections. Ask whoever set its rules to allow them first.`;

/** What asking for a denied tool is told. */
export const toolRefusal = (name: string) => `This space's rules do not allow ${name}.`;

const rulesOf = (row: {
  allowedModels: unknown;
  deniedConnectorKinds: unknown;
  deniedToolKinds: unknown;
}): SpaceRules => ({
  allowedModels: strings(row.allowedModels),
  deniedConnectorKinds: strings(row.deniedConnectorKinds),
  deniedToolKinds: strings(row.deniedToolKinds),
});

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** A space's rules, read through the typed connection. */
export async function readSpaceRules(
  reader: Database | Transaction,
  spaceId: string,
): Promise<SpaceRules> {
  const [row] = await reader.select().from(spacePolicy).where(eq(spacePolicy.spaceId, spaceId));
  return row ? rulesOf(row) : NO_RULES;
}

/** The same, for code that holds a raw SQL connection. */
export async function spaceRulesFor(
  query: Sql | TransactionSql,
  spaceId: string,
): Promise<SpaceRules> {
  const [row] = await query`select allowed_models, denied_connector_kinds, denied_tool_kinds
    from space_policy where space_id = ${spaceId}`;
  return row
    ? rulesOf({
        allowedModels: row.allowed_models,
        deniedConnectorKinds: row.denied_connector_kinds,
        deniedToolKinds: row.denied_tool_kinds,
      })
    : NO_RULES;
}

/** Each entry once, in the order it was first given. */
const once = (values: readonly string[]) => [...new Set(values)];

/** The rules as the API shows them. */
async function view(db: Database, spaceId: string): Promise<SpacePolicy> {
  const [row] = await db.select().from(spacePolicy).where(eq(spacePolicy.spaceId, spaceId));
  const rules = row ? rulesOf(row) : NO_RULES;
  return {
    space_id: spaceId,
    allowed_models: [...rules.allowedModels],
    denied_connector_kinds: [...rules.deniedConnectorKinds],
    denied_tool_kinds: [...rules.deniedToolKinds],
    updated_by: row?.updatedBy ?? null,
    updated_at: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Who may read and who may change a space's rules. The setup owner may do both
 * for any space there is, a member of it or not; anyone else reads them where
 * the space admits them and changes them only as its owner.
 */
async function standing(
  reader: Database | Transaction,
  spaceId: string,
  actor: string,
  lock = false,
): Promise<{ canChange: boolean }> {
  const [installation] = await reader.select({ id: owner.id }).from(owner).limit(1);
  if (installation?.id === actor) {
    const query = reader
      .select({ removedAt: space.removedAt })
      .from(space)
      .where(eq(space.id, spaceId));
    const [row] = lock ? await query.for('share') : await query;
    if (!row) throw new ServiceError('scope_denied', 'Space is not accessible.', 403);
    if (row.removedAt) throw new ServiceError('scope_denied', SPACE_BEING_CLEARED, 403);
    return { canChange: true };
  }
  const access = await spaceAuthority(reader, spaceId, actor, lock);
  return { canChange: access.role === 'owner' };
}

/**
 * GET and PUT `/spaces/:id/policy`. The guard on `/spaces/:id` lets these
 * through to answer for themselves, because the setup owner may set the rules
 * of a space they are not a member of.
 */
export function mountSpacePolicy(app: Hono, deps: { db: Database }): void {
  const { db } = deps;
  const actorOf = (c: Context) => c.get('owner').id as string;

  app.get('/spaces/:id/policy', async (c) => {
    const spaceId = c.req.param('id');
    const { canChange } = await standing(db, spaceId, actorOf(c));
    return c.json(
      spacePolicyResponse.parse({ policy: await view(db, spaceId), can_change: canChange }),
    );
  });

  app.put('/spaces/:id/policy', async (c) => {
    const spaceId = c.req.param('id');
    const actor = actorOf(c);
    const refuse = () => {
      throw new ServiceError(
        'scope_denied',
        "Only this space's owner, or whoever set up this installation, can change its rules.",
        403,
      );
    };
    if (!(await standing(db, spaceId, actor)).canChange) refuse();
    const input: SpacePolicyRules = spacePolicyRules.parse(await c.req.json());
    const values = {
      allowedModels: once(input.allowed_models),
      deniedConnectorKinds: once(input.denied_connector_kinds),
      deniedToolKinds: once(input.denied_tool_kinds),
      updatedBy: actor,
      updatedAt: new Date(),
    };
    // Checked again and written under a share lock on the space, so a removal
    // that starts meanwhile waits for this write and then clears it, rather
    // than leaving rules behind on a space it has emptied.
    await db.transaction(async (tx) => {
      if (!(await standing(tx, spaceId, actor, true)).canChange) refuse();
      await tx
        .insert(spacePolicy)
        .values({ spaceId, ...values })
        .onConflictDoUpdate({ target: spacePolicy.spaceId, set: values });
    });
    return c.json(spacePolicyResponse.parse({ policy: await view(db, spaceId), can_change: true }));
  });
}
