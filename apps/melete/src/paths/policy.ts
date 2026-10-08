/**
 * The path policy: which way Melete reaches a service for one effect.
 *
 * A pure function of what the service knows, so a test pins every rule and
 * the model never decides. The model proposes on a path; this says whether
 * that path may be used now, and if not, which one is.
 *
 * In order:
 * 1. An earlier effect on the same service whose outcome is unknown stops
 *    every path, the same one included, until it is settled by reading the
 *    service or by the person. Moving on after an unknown is how a booking
 *    is made twice.
 * 2. A connected app's own tools are always allowed (the broker's tiers still
 *    decide whether they ask).
 * 3. The browser is allowed for a service a connected app reaches only when
 *    that app refused the effect for a reason a browser can get around
 *    legitimately: it has no way to do it, its interface changed, or it is
 *    down. A refusal about permission, a rate limit, a pending answer or the
 *    person's own no is never routed around.
 * 4. With no app for the service, the browser is allowed, unless Melete's own
 *    record says the browser has not got through there lately; then the work
 *    goes to the person.
 */
import type { ActionPath } from '@melete/contracts';

/** What a connected app for the service has done in this piece of work. */
export type ApiState = {
  /** The app tools this work may use that change something at the service. */
  tools: readonly string[];
  /** An app effect on the service is waiting for an answer or to be sent. */
  pending: boolean;
  /** The person said no to an app effect on the service. */
  denied: boolean;
  /**
   * How the latest app effect on the service failed: in a way the browser may
   * get around, in a way it may not, or not at all.
   */
  refused: 'around' | 'blocking' | null;
};

/** Melete's record of one path at one service, from earlier outcomes. */
export type PathRecord = {
  attempts: number;
  successes: number;
  /** Outcomes in a row that did not get through, since the last that did. */
  streak: number;
  last_fault_at: Date | null;
};

export type PathInput = {
  service: string;
  via: Exclude<ActionPath, 'person'>;
  /** The earliest unsettled effect on this service in this piece of work. */
  unsettled: { action_id: string; via: string } | null;
  api: ApiState;
  /** The browser's record at this service, for this kind of work. */
  record: PathRecord | null;
  now: number;
};

export type PathDecision =
  | { allow: true; path: Exclude<ActionPath, 'person'>; reason: string }
  | {
      allow: false;
      code: 'outcome_unconfirmed' | 'path_refused';
      /** Where the work goes instead: settle first, a connected app, or the person. */
      path: 'settle' | 'api' | 'person';
      reason: string;
    };

/** A browser that has not got through this many times in a row is set aside. */
export const BROWSER_STREAK_LIMIT = 3;
/** For this long after its last miss. */
export const BROWSER_STREAK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Fault kinds a browser may legitimately get around: the app cannot do it, or is down. */
export const ROUTE_AROUND_FAULTS: ReadonlySet<string> = new Set([
  'unsupported_route',
  'schema_drift',
  'destination_offline',
]);

const listed = (tools: readonly string[]) =>
  tools.length === 1 ? tools[0] : `${tools.slice(0, -1).join(', ')} or ${tools.at(-1)}`;

export function decidePath(input: PathInput): PathDecision {
  const { service, api } = input;
  if (input.unsettled)
    return {
      allow: false,
      code: 'outcome_unconfirmed',
      path: 'settle',
      reason: `An earlier ${input.unsettled.via === 'browser' ? 'browser submit' : 'request'} to ${service} (${input.unsettled.action_id}) may have gone through and is not confirmed yet. Nothing more is tried at ${service}, on any path, until it is checked: wait for the check or for the person to say what happened.`,
    };
  if (input.via === 'api')
    return { allow: true, path: 'api', reason: `A connected app reaches ${service}.` };
  if (api.tools.length > 0) {
    if (api.denied)
      return {
        allow: false,
        code: 'path_refused',
        path: 'api',
        reason: `The person said no to this through ${listed(api.tools)}. The browser does not do it instead.`,
      };
    if (api.pending)
      return {
        allow: false,
        code: 'path_refused',
        path: 'api',
        reason: `This is already waiting through ${listed(api.tools)} for the person's answer. The browser does not do it instead.`,
      };
    if (api.refused !== 'around')
      return {
        allow: false,
        code: 'path_refused',
        path: 'api',
        reason: `A connected app reaches ${service}: use ${listed(api.tools)}. The browser is used there only when the app cannot do it.`,
      };
  }
  const record = input.record;
  if (
    record &&
    record.streak >= BROWSER_STREAK_LIMIT &&
    record.last_fault_at &&
    input.now - record.last_fault_at.getTime() < BROWSER_STREAK_WINDOW_MS
  )
    return {
      allow: false,
      code: 'path_refused',
      path: 'person',
      reason: `The browser has not got through at ${service} the last ${record.streak} times, so this goes to the person to finish.`,
    };
  return {
    allow: true,
    path: 'browser',
    reason:
      api.tools.length > 0
        ? `${listed(api.tools)} could not do this, so the browser is used, and it still asks first.`
        : `No connected app reaches ${service}.`,
  };
}
