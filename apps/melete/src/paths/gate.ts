/**
 * The path policy at the broker: where a proposed effect is checked against
 * `decidePath` before it is recorded, and again at admission.
 *
 * The broker asks two things here. Which path, service and action an effect
 * takes (`routeEffect`), recorded on the action so later checks, the receipt
 * and the registry read it from the row. And whether an effect may still be
 * admitted now that the same action may be unsettled (`unsettledBefore`).
 * Approval is not decided here: a browser submit asks or goes through on the
 * same rules as any other effect.
 */
import type { CapabilityClaims, JsonObject } from '@melete/contracts';
import { grantsConnectionScopes } from '../broker/connection-scopes.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import type { Connector } from '../connectors/types.ts';
import { type ActionClass, formClass, formTarget, toolClass } from './operations.ts';
import { type ApiState, decidePath, ROUTE_AROUND_FAULTS } from './policy.ts';
import { intentOfWork, pathRecord, taskKindOf, workOf } from './registry.ts';
import { serviceOfConnection, serviceOfUrl } from './services.ts';

/** The only browser step that changes anything outside: everything else stays in the browser. */
export const BROWSER_SUBMIT = 'browser.submit';

/** Unsettled: sent, and nobody knows yet whether it landed. */
const UNSETTLED = ['dispatched', 'unknown', 'unresolved'];
/** Asked for and not yet answered or sent. */
const PENDING = ['proposed', 'needs_approval', 'approved', 'admitted'];

/** A refusal by the path policy; `handTo` is set when the work goes to the person. */
export class PathRefusal extends BrokerFault {
  constructor(
    code: 'path_refused' | 'outcome_unconfirmed',
    message: string,
    readonly handTo: { service: string; sessionId: string; operation: string } | null = null,
  ) {
    super(code, message);
  }
}

export type Route = {
  path: 'api' | 'browser';
  service: string;
  /** The action at the service: a form's address, or an app request's own key. */
  operation: string;
  /** The one open intent the work is for, if there is exactly one. */
  intent: string | null;
  standsInFor: string | null;
  /** Why this path, in a sentence for the receipt. */
  reason: string;
};

const NO_API: ApiState = { tools: [], pending: false, denied: false, refused: null };

/** The fault kind the last repair step of an action met, if any. */
function lastFault(trace: unknown): string | null {
  if (!Array.isArray(trace)) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const kind = (trace[i] as { fault_kind?: unknown } | null)?.fault_kind;
    if (typeof kind === 'string') return kind;
  }
  return null;
}

/**
 * What a connected app can do for this browser action: the tools it has for
 * the same kind of action, and how its own tries at it have gone in this work.
 * An app counts as having a tool for the action when one of its tools does
 * what the form does, or when it was already asked for the same intent.
 */
async function apiState(
  tx: Query,
  input: {
    spaceId: string;
    claims: CapabilityClaims;
    allowed: readonly string[] | null;
    connectors: { get(id: string): Connector | undefined };
  },
  at: { service: string; work: string[]; action: ActionClass | null; intent: string | null },
): Promise<ApiState> {
  const rows = await tx`select id, provider, scopes, configuration from connection
    where space_id = ${input.spaceId} and status = 'active'`;
  const tools = new Set<string>();
  for (const row of rows) {
    if (input.allowed && !input.allowed.includes(String(row.id))) continue;
    const connector = input.connectors.get(String(row.id));
    if (!connector || connector.manifest.provider !== row.provider) continue;
    const reaches =
      connector.service ??
      serviceOfConnection({
        provider: String(row.provider),
        configuration: row.configuration as Record<string, unknown> | null,
      });
    if (reaches !== at.service) continue;
    const scopes = (row.scopes ?? []) as string[];
    for (const tool of connector.manifest.tools)
      if (
        tool.effect_class !== 'read' &&
        grantsConnectionScopes(input.claims, scopes, [...tool.required_scopes, tool.name])
      )
        tools.add(tool.name);
  }
  if (!tools.size) return NO_API;
  const tried = (
    await tx`select kind, status, repair_trace, operation_intent from action
      where job_id = any(${at.work}) and service_key = ${at.service} and path = 'api'
      order by created_at desc, id desc`
  ).filter(
    (row) =>
      tools.has(String(row.kind)) &&
      ((at.action !== null && toolClass(String(row.kind)) === at.action) ||
        (at.intent !== null && row.operation_intent === at.intent)),
  );
  const forAction = [...tools].filter(
    (tool) =>
      (at.action !== null && toolClass(tool) === at.action) ||
      tried.some((row) => row.kind === tool),
  );
  if (!forAction.length) return NO_API;
  const latest = tried.find((row) => row.status === 'failed' || row.status === 'succeeded');
  return {
    tools: forAction.sort(),
    pending: tried.some((row) => PENDING.includes(String(row.status))),
    denied: tried.some((row) => row.status === 'denied'),
    refused:
      latest?.status !== 'failed'
        ? null
        : ROUTE_AROUND_FAULTS.has(lastFault(latest.repair_trace) ?? '')
          ? 'around'
          : 'blocking',
  };
}

/**
 * The path, service and action a proposed effect takes, after the policy has
 * allowed it; null for an effect on no outside service. Throws `PathRefusal`
 * when the policy sends the work elsewhere. Called under the job lock, for
 * effects only. `key` is the proposal's own identity, which names an app
 * request's action.
 */
export async function routeEffect(
  tx: Query,
  input: {
    job: { id: string; space_id: string };
    claims: CapabilityClaims;
    allowed: readonly string[] | null;
    connectors: { get(id: string): Connector | undefined };
    connector: Connector;
    connectionId: string;
    kind: string;
    key: string;
    payload: JsonObject;
    now?: number;
  },
): Promise<Route | null> {
  const via = input.kind === BROWSER_SUBMIT ? 'browser' : 'api';
  const form = (input.payload.intent ?? {}) as {
    url?: unknown;
    method?: unknown;
    fields?: unknown;
  };
  let service: string | null;
  let operation: string | null;
  if (via === 'browser') {
    service = typeof form.url === 'string' ? serviceOfUrl(form.url) : null;
    operation =
      typeof form.url === 'string'
        ? formTarget(form.url, typeof form.method === 'string' ? form.method : 'POST')
        : null;
  } else {
    operation = `${input.kind} ${input.key}`;
    if (input.connector.service !== undefined) service = input.connector.service;
    else {
      const [row] = await tx`select provider, configuration from connection
        where id = ${input.connectionId}`;
      service = row
        ? serviceOfConnection({
            provider: String(row.provider),
            configuration: row.configuration as Record<string, unknown> | null,
          })
        : null;
    }
  }
  if (!service || !operation) return null;
  const work = await workOf(tx, input.job.id);
  const intent = await intentOfWork(tx, work);
  const [unsettled] = await tx`select id, path from action
    where job_id = any(${work}) and service_key = ${service} and status = any(${UNSETTLED})
      and (operation_key = ${operation}
        or (${intent}::text is not null and operation_intent = ${intent}))
    order by created_at, id limit 1`;
  const fields =
    form.fields && typeof form.fields === 'object' && !Array.isArray(form.fields)
      ? (form.fields as Record<string, unknown>)
      : {};
  const api =
    via === 'browser'
      ? await apiState(
          tx,
          {
            spaceId: input.job.space_id,
            claims: input.claims,
            allowed: input.allowed,
            connectors: input.connectors,
          },
          { service, work, action: formClass(fields), intent },
        )
      : NO_API;
  const record =
    via === 'browser' && api.tools.length === 0
      ? await pathRecord(tx, {
          spaceId: input.job.space_id,
          service,
          operation,
          taskKind: await taskKindOf(tx, input.job.id),
          path: 'browser',
        })
      : null;
  const decision = decidePath({
    service,
    via,
    unsettled: unsettled ? { action_id: String(unsettled.id), via: String(unsettled.path) } : null,
    api,
    record,
    now: input.now ?? Date.now(),
  });
  if (!decision.allow) {
    const sessionId = input.payload.session_id;
    throw new PathRefusal(
      decision.code,
      decision.reason,
      decision.path === 'person' && typeof sessionId === 'string'
        ? { service, sessionId, operation }
        : null,
    );
  }
  return {
    path: via,
    service,
    operation,
    intent,
    standsInFor: via === 'browser' && api.tools.length ? api.tools.join(', ') : null,
    reason: decision.reason,
  };
}

/**
 * At admission: the same action, or another for the same intent, proposed
 * since, may have been sent and not settled. Then this one waits too,
 * whatever path it is on. Returns the refusal, or null.
 */
export async function unsettledBefore(tx: Query, actionId: string): Promise<PathRefusal | null> {
  const [own] = await tx`select job_id, service_key, operation_key, operation_intent
    from action where id = ${actionId}`;
  if (!own?.service_key || !own.operation_key) return null;
  const work = await workOf(tx, String(own.job_id));
  const intent = (own.operation_intent as string | null) ?? null;
  const [other] = await tx`select id, path from action
    where job_id = any(${work}) and service_key = ${own.service_key} and id <> ${actionId}
      and status = any(${UNSETTLED})
      and (operation_key = ${own.operation_key}
        or (${intent}::text is not null and operation_intent = ${intent}))
    order by created_at, id limit 1`;
  if (!other) return null;
  const decided = decidePath({
    service: String(own.service_key),
    via: 'api',
    unsettled: { action_id: String(other.id), via: String(other.path) },
    api: NO_API,
    record: null,
    now: Date.now(),
  });
  return decided.allow ? null : new PathRefusal(decided.code, decided.reason);
}
