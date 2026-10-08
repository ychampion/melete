/**
 * The path policy at the broker: where a proposed effect is checked against
 * `decidePath` before it is recorded, and again at admission.
 *
 * The broker asks three things here. Which path and service an effect takes
 * (`routeEffect`), recorded on the action so later checks and the registry
 * read it from the row. Whether an effect may still be admitted now that
 * something else on its service may be unsettled (`unsettledBefore`). And
 * whether a browser submit stands in for a connected app, which keeps it off
 * every standing permission (`standsIn`).
 */
import type { CapabilityClaims, JsonObject } from '@melete/contracts';
import { grantsConnectionScopes } from '../broker/connection-scopes.ts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import type { Connector } from '../connectors/types.ts';
import { type ApiState, decidePath, ROUTE_AROUND_FAULTS } from './policy.ts';
import { pathRecord, taskKindOf, workOf } from './registry.ts';
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
    readonly handTo: { service: string; sessionId: string } | null = null,
  ) {
    super(code, message);
  }
}

export type Route = { path: 'api' | 'browser'; service: string; standsInFor: string | null };

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

async function apiState(
  tx: Query,
  input: {
    spaceId: string;
    claims: CapabilityClaims;
    allowed: readonly string[] | null;
    connectors: { get(id: string): Connector | undefined };
  },
  service: string,
  work: string[],
): Promise<ApiState> {
  const rows = await tx`select id, provider, scopes, configuration from connection
    where space_id = ${input.spaceId} and status = 'active'`;
  const tools: string[] = [];
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
    if (reaches !== service) continue;
    const scopes = (row.scopes ?? []) as string[];
    for (const tool of connector.manifest.tools)
      if (
        tool.effect_class !== 'read' &&
        grantsConnectionScopes(input.claims, scopes, [...tool.required_scopes, tool.name])
      )
        tools.push(tool.name);
  }
  if (!tools.length) return NO_API;
  const tried = await tx`select status, repair_trace from action
    where job_id = any(${work}) and service_key = ${service} and path = 'api'
    order by created_at desc, id desc`;
  const latest = tried.find((row) => row.status === 'failed' || row.status === 'succeeded');
  return {
    tools: [...new Set(tools)].sort(),
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
 * The path and service a proposed effect takes, after the policy has allowed
 * it; null for an effect on no outside service. Throws `PathRefusal` when the
 * policy sends the work elsewhere. Called under the job lock, for effects only.
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
    payload: JsonObject;
    now?: number;
  },
): Promise<Route | null> {
  const via = input.kind === BROWSER_SUBMIT ? 'browser' : 'api';
  let service: string | null;
  if (via === 'browser') {
    const url = (input.payload.intent as { url?: unknown } | undefined)?.url;
    service = typeof url === 'string' ? serviceOfUrl(url) : null;
  } else if (input.connector.service !== undefined) service = input.connector.service;
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
  if (!service) return null;
  const work = await workOf(tx, input.job.id);
  const [unsettled] = await tx`select id, path from action
    where job_id = any(${work}) and service_key = ${service} and status = any(${UNSETTLED})
    order by created_at, id limit 1`;
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
          service,
          work,
        )
      : NO_API;
  const record =
    via === 'browser' && api.tools.length === 0
      ? await pathRecord(tx, {
          spaceId: input.job.space_id,
          service,
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
      decision.path === 'person' && typeof sessionId === 'string' ? { service, sessionId } : null,
    );
  }
  return {
    path: via,
    service,
    standsInFor: via === 'browser' && api.tools.length ? api.tools.join(', ') : null,
  };
}

/**
 * At admission: another effect on this action's service in the same work,
 * proposed since, may have been sent and not settled. Then this one waits too,
 * whatever path it is on. Returns the refusal, or null.
 */
export async function unsettledBefore(tx: Query, actionId: string): Promise<PathRefusal | null> {
  const [own] = await tx`select job_id, service_key from action where id = ${actionId}`;
  if (!own?.service_key) return null;
  const work = await workOf(tx, String(own.job_id));
  const [other] = await tx`select id, path from action
    where job_id = any(${work}) and service_key = ${own.service_key} and id <> ${actionId}
      and status = any(${UNSETTLED})
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

/** Whether this action is a browser submit standing in for a connected app's own tools. */
export async function standsIn(tx: Query, actionId: string): Promise<boolean> {
  const [row] = await tx`select stands_in_for from action where id = ${actionId}`;
  return typeof row?.stands_in_for === 'string' && row.stands_in_for.length > 0;
}
