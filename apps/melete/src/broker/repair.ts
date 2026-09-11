/**
 * The typed repair policy: fix the cause, keep the objective, keep the
 * authority.
 *
 * A blind retry is the cheapest thing a service can do and the most expensive
 * thing a person can be handed. It turns one lost acknowledgement into two
 * invoices. The policy here never retries a class of failure it has not
 * identified, never retries an effect that may already have landed, and never
 * changes what the person asked for in order to make a call succeed.
 *
 * What a repair may touch: a selector, a wrapper, the route, the credential,
 * and a field's *name* under an explicitly safe mapping. What it may never
 * touch: the recipient, the amount, the resource, the business intent. The
 * action's own payload hash is therefore the same before and after every
 * repair, and a drift mapping renames fields while carrying every value across
 * unchanged, which `isSafeFieldMapping` decides rather than a model.
 *
 * Everything in the first half of this file is pure: a state, a fault, and a
 * decision. The driver in the second half is the only part that performs
 * anything, and it performs nothing the decision function did not choose.
 */
import {
  applyFieldMapping,
  type ConnectorFault,
  type ConnectorFaultKind,
  canonicalizePayload,
  type DispatchResult,
  isSafeFieldMapping,
  type JsonObject,
  type RepairCandidateTest,
  type RepairDecision,
  type RepairDisposition,
  type RepairTraceEntry,
  repairTraceEntry,
  type VerifyResult,
} from '@melete/contracts';
import type { ConnectorDescription } from '../connectors/faults.ts';

// --------------------------------------------------------------------------
// Limits
// --------------------------------------------------------------------------

export type RepairLimits = {
  /** Executions of the same operation, in total, before the policy gives up. */
  maxAttempts: number;
  /** First backoff, doubled each time and then jittered. */
  backoffBaseMs: number;
  maxBackoffMs: number;
  /** A ceiling no combination of repair paths can talk its way past. */
  maxExecutions: number;
  /** How long to park when a destination rate-limits without saying how long. */
  defaultRetryAfterSeconds: number;
};

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  maxAttempts: 3,
  backoffBaseMs: 200,
  maxBackoffMs: 5_000,
  maxExecutions: 8,
  defaultRetryAfterSeconds: 60,
};

/** What the policy knows about this action's repair history so far. */
export type RepairState = {
  /** Executions of the connector completed so far, from one. */
  attempt: number;
  refreshed: boolean;
  rediscovered: boolean;
  routesChanged: number;
  revisions: number;
  /** A mapping that `isSafeFieldMapping` has already accepted is in hand. */
  safeMapping: boolean;
  canRefresh: boolean;
  canRediscover: boolean;
  /** Whether this connector can offer an equivalent authorized route at all. */
  canReroute: boolean;
  canRevise: boolean;
  now: number;
  /** Wall-clock instant the attempt must be finished by, when there is one. */
  deadlineAt: number | null;
};

export type RepairChoice =
  | { act: 'retry'; decision: RepairDecision; delay_ms: number; detail: string }
  | { act: 'park'; decision: 'park_until_retry_after'; retry_after_ms: number; detail: string }
  | { act: 'refresh'; decision: 'refresh_credential_once'; detail: string }
  | { act: 'rediscover'; decision: 'rediscover_schema'; detail: string }
  | { act: 'reroute'; decision: 'change_route'; detail: string }
  | { act: 'reconcile'; decision: 'reconcile_by_verify'; detail: string }
  | { act: 'revise'; decision: 'revise_and_revalidate'; detail: string }
  | {
      act: 'stop';
      decision: RepairDecision;
      disposition: RepairDisposition;
      detail: string;
    };

/** Full jitter over an exponential backoff, so a fleet does not retry in step. */
export function backoffDelay(
  retries: number,
  limits: RepairLimits,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(limits.maxBackoffMs, limits.backoffBaseMs * 2 ** Math.max(0, retries));
  return Math.max(0, Math.round(random() * ceiling));
}

/**
 * The whole policy, as one pure function. Given a classified fault and what has
 * already been tried, choose one thing. It never performs anything and never
 * looks at a clock it was not handed.
 */
export function decideRepair(
  fault: ConnectorFault,
  state: RepairState,
  limits: RepairLimits = DEFAULT_REPAIR_LIMITS,
  random: () => number = Math.random,
): RepairChoice {
  // A failure nobody classified is not repaired and not resolved. Nothing here
  // knows whether the request left, so the action rests where the broker has
  // always rested it and reconciliation stays a separate, deliberate step.
  if (fault.kind === 'unclassified') {
    return {
      act: 'stop',
      decision: 'escalate_diagnosis',
      disposition: fault.may_have_committed ? 'needs_reconciliation' : 'repair_exhausted',
      detail: 'the connector did not classify this failure, so nothing was retried',
    };
  }

  // An effect that may already have landed is reconciled, never repaired. This
  // outranks the kind: a connector that is unsure has said so, and no class of
  // failure is a licence to send a second time.
  if (fault.may_have_committed || fault.kind === 'uncertain_outcome') {
    return {
      act: 'reconcile',
      decision: 'reconcile_by_verify',
      detail: 'the outcome is uncertain, so it is verified rather than sent again',
    };
  }

  if (state.attempt >= limits.maxExecutions) {
    return {
      act: 'stop',
      decision: 'escalate_diagnosis',
      disposition: 'repair_exhausted',
      detail: 'the repair budget for this action is spent',
    };
  }

  // The attempt's deadline binds every repair path, not only the retry. A
  // dispatch that has already run out of time does not start another request.
  if (state.deadlineAt !== null && state.now >= state.deadlineAt) {
    return {
      act: 'stop',
      decision: 'escalate_diagnosis',
      disposition: 'repair_exhausted',
      detail: 'the attempt deadline passed before this could be repaired',
    };
  }

  switch (fault.kind) {
    case 'revoked_credential':
      // Never switch identities. The person reconnects or nothing happens.
      return {
        act: 'stop',
        decision: 'stop_connection_revoked',
        disposition: 'needs_reconnect',
        detail: 'the connection was revoked, so the send stopped and nobody was substituted',
      };

    case 'rate_limited': {
      const seconds = fault.retry_after ?? limits.defaultRetryAfterSeconds;
      return {
        act: 'park',
        decision: 'park_until_retry_after',
        retry_after_ms: seconds * 1000,
        detail: `the destination asked for ${seconds}s, so the worker was released rather than held`,
      };
    }

    case 'expired_credential':
      if (state.refreshed || !state.canRefresh) {
        return {
          act: 'stop',
          decision: 'escalate_diagnosis',
          disposition: 'repair_exhausted',
          detail: state.refreshed
            ? 'the credential was refreshed once and the destination still refused it'
            : 'this connector cannot refresh a credential',
        };
      }
      return {
        act: 'refresh',
        decision: 'refresh_credential_once',
        detail: 'the token is stale and the grant is not, so it is refreshed exactly once',
      };

    case 'schema_drift':
      if (!state.rediscovered) {
        if (!state.canRediscover) {
          return {
            act: 'stop',
            decision: 'escalate_diagnosis',
            disposition: 'needs_input',
            detail: 'the destination changed shape and this connector cannot describe itself',
          };
        }
        return {
          act: 'rediscover',
          decision: 'rediscover_schema',
          detail: 'the destination changed shape, so it is asked what it wants now',
        };
      }
      if (state.safeMapping) {
        return {
          act: 'retry',
          decision: 'apply_safe_mapping',
          delay_ms: 0,
          detail: 'a field was renamed and every value survives it, so the same send goes again',
        };
      }
      return {
        act: 'stop',
        decision: 'record_repair_candidate',
        disposition: 'needs_input',
        detail:
          'the proposed mapping would change more than a field name, so it was recorded and not used',
      };

    case 'unsupported_route':
      if (state.routesChanged >= 1 || !state.canReroute) {
        return {
          act: 'stop',
          decision: 'escalate_diagnosis',
          disposition: 'repair_exhausted',
          detail:
            state.routesChanged >= 1
              ? 'the equivalent authorized route refused the same operation'
              : 'no equivalent authorized route exists for this operation',
        };
      }
      return {
        act: 'reroute',
        decision: 'change_route',
        detail: 'the route definitively did not execute, so an equivalent authorized one is used',
      };

    case 'bad_output':
      // A file existing is not a delivery. Re-open, revise, re-validate, once.
      if (state.canRevise && state.revisions < 1) {
        return {
          act: 'revise',
          decision: 'revise_and_revalidate',
          detail: 'the output failed its own validation, so it is re-opened and revised',
        };
      }
      return {
        act: 'stop',
        decision: 'stop_needs_input',
        disposition: 'needs_input',
        detail: state.canRevise
          ? 'the revised output failed validation too, so nothing was called delivered'
          : 'the output failed validation and nothing here can revise it',
      };

    case 'transient_before_dispatch': {
      if (state.attempt >= limits.maxAttempts) {
        return {
          act: 'stop',
          decision: 'escalate_diagnosis',
          disposition: 'repair_exhausted',
          detail: `the same transient failure happened ${state.attempt} times`,
        };
      }
      const delay = backoffDelay(state.attempt - 1, limits, random);
      if (state.deadlineAt !== null && state.now + delay >= state.deadlineAt) {
        return {
          act: 'stop',
          decision: 'escalate_diagnosis',
          disposition: 'repair_exhausted',
          detail: 'the attempt deadline left no room for another try',
        };
      }
      return {
        act: 'retry',
        decision: 'retry_with_backoff',
        delay_ms: delay,
        detail: 'the request did not leave, so the same bytes go again after a jittered wait',
      };
    }

    default:
      return {
        act: 'stop',
        decision: 'escalate_diagnosis',
        disposition: 'repair_exhausted',
        detail: 'the connector did not classify this failure, so nothing was retried',
      };
  }
}

// --------------------------------------------------------------------------
// Drift mappings
// --------------------------------------------------------------------------

export type MappingProposal = {
  mapping: Record<string, string>;
  safe: boolean;
  test: RepairCandidateTest;
  detail: string;
};

/**
 * Compare what was sent with what the destination says it wants now, and
 * propose the one mapping that could be right.
 *
 * Only an unambiguous one-to-one rename is proposed, and only a rename that
 * carries every value across is marked safe. Two missing fields, or two surplus
 * ones, is a guess, and a guess is recorded as a rejected candidate rather than
 * applied.
 */
export function proposeMapping(
  sent: JsonObject,
  description: ConnectorDescription,
): MappingProposal {
  const optional = new Set(description.optional ?? []);
  const required = description.required.filter((field) => !optional.has(field));
  const missing = required.filter((field) => !(field in sent));
  const surplus = Object.keys(sent).filter(
    (field) => !optional.has(field) && !required.includes(field),
  );
  if (missing.length !== 1 || surplus.length !== 1) {
    const mapping: Record<string, string> = {};
    return {
      mapping,
      safe: false,
      test: { name: 'rename is unambiguous', input: sent, expected: sent },
      detail:
        missing.length === 0
          ? 'the destination wants nothing this send is missing'
          : `${missing.length} fields are missing and ${surplus.length} are surplus, which is a guess`,
    };
  }
  const mapping = { [surplus[0] as string]: missing[0] as string };
  const expected = applyFieldMapping(sent, mapping) as JsonObject;
  const safe = isSafeFieldMapping(sent, mapping);
  return {
    mapping,
    safe,
    test: {
      name: `rename ${surplus[0]} to ${missing[0]} without changing a value`,
      input: sent,
      expected,
    },
    detail: safe
      ? `${surplus[0]} is ${missing[0]} under a new name and every value is unchanged`
      : `${surplus[0]} to ${missing[0]} would not carry every value across`,
  };
}

/** The candidate's own test, run before anything is allowed to use the mapping. */
export function evaluateMapping(proposal: MappingProposal): { passed: boolean; detail: string } {
  if (!proposal.safe) return { passed: false, detail: proposal.detail };
  const produced = applyFieldMapping(proposal.test.input, proposal.mapping);
  const passed = JSON.stringify(produced) === JSON.stringify(proposal.test.expected);
  return {
    passed,
    detail: passed ? proposal.detail : 'the mapping did not reproduce its own expected payload',
  };
}

// --------------------------------------------------------------------------
// The driver
// --------------------------------------------------------------------------

export type RepairExecution = {
  payload: JsonObject;
  route: string | null;
  mapping: Record<string, string> | null;
  attempt: number;
};

export type RecordedCandidate = { id: string };

export type RepairPorts = {
  execute(input: RepairExecution): Promise<DispatchResult>;
  verify(): Promise<VerifyResult>;
  describe?(): Promise<ConnectorDescription>;
  /** True when a fresh credential is in hand and the grant still permits the call. */
  refreshCredential?(): Promise<boolean>;
  routes?(): Promise<string[]>;
  /** Re-open a bad output and produce a revised payload, or nothing. */
  revise?(fault: ConnectorFault): Promise<JsonObject | null>;
  /** Persist a drift mapping as a proposal. Called before it is ever applied. */
  recordCandidate?(input: {
    fault: ConnectorFault;
    proposal: MappingProposal;
    description: ConnectorDescription;
    evaluation: { passed: boolean; detail: string };
  }): Promise<RecordedCandidate>;
};

export type RepairRun = {
  disposition: RepairDisposition;
  /**
   * What the broker should record. Null only when the action was parked: it is
   * still admitted, nothing left, and nothing is settled.
   */
  result: DispatchResult | null;
  retry_after_at: string | null;
  trace: RepairTraceEntry[];
  counters: Record<string, number>;
  executions: number;
  /** The one diagnosis to put in front of the owner, when there is one. */
  question: string | null;
  /** The bytes the last execution actually sent. */
  payload: JsonObject;
  route: string | null;
};

export type RepairOptions = {
  limits?: RepairLimits;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineAt?: number | null;
  classify(error: unknown): ConnectorFault;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one operation to a disposition.
 *
 * The outer loop is executions of the connector. The inner loop is decisions
 * about one fault: re-discovery and route lookup change what the policy knows
 * without sending anything, so the policy is asked again rather than the
 * destination. Nothing happens that `decideRepair` did not choose, and every
 * choice is written into the trace beside the hash of the bytes that attempt
 * put on the wire.
 */
export async function runRepair(
  initialPayload: JsonObject,
  ports: RepairPorts,
  options: RepairOptions,
): Promise<RepairRun> {
  const limits = options.limits ?? DEFAULT_REPAIR_LIMITS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? wait;
  const trace: RepairTraceEntry[] = [];
  const counters: Record<string, number> = {};

  let payload = initialPayload;
  let route: string | null = null;
  let mapping: Record<string, string> | null = null;
  let candidateId: string | null = null;
  let pending: MappingProposal | null = null;
  const state: RepairState = {
    attempt: 0,
    refreshed: false,
    rediscovered: false,
    routesChanged: 0,
    revisions: 0,
    safeMapping: false,
    canRefresh: Boolean(ports.refreshCredential),
    canRediscover: Boolean(ports.describe),
    canReroute: Boolean(ports.routes),
    canRevise: Boolean(ports.revise),
    now: now(),
    deadlineAt: options.deadlineAt ?? null,
  };

  const note = (entry: Omit<RepairTraceEntry, 'at' | 'payload_hash'>) => {
    trace.push(
      repairTraceEntry.parse({
        ...entry,
        at: new Date(now()).toISOString(),
        payload_hash: canonicalizePayload(payload).hash,
      }),
    );
  };
  const count = (kind: ConnectorFaultKind) => {
    counters[kind] = (counters[kind] ?? 0) + 1;
  };
  const finish = (
    disposition: RepairDisposition,
    result: DispatchResult | null,
    question: string | null,
    retryAfterAt: string | null = null,
  ): RepairRun => ({
    disposition,
    result,
    retry_after_at: retryAfterAt,
    trace,
    counters,
    executions: state.attempt,
    question,
    payload,
    route,
  });

  const stopReason = (disposition: RepairDisposition): string =>
    disposition === 'needs_reconnect'
      ? 'connection_revoked'
      : disposition === 'needs_input'
        ? 'output_validation_failed'
        : 'repair_exhausted';

  executions: for (;;) {
    state.now = now();
    state.attempt += 1;
    let outcome: DispatchResult;
    let fault: ConnectorFault | null = null;
    try {
      outcome = await ports.execute({ payload, route, mapping, attempt: state.attempt });
    } catch (error) {
      fault = options.classify(error);
      outcome = { outcome: 'failed', reason: fault.detail, retryable: false };
    }

    if (!fault) {
      if (outcome.outcome === 'succeeded') {
        note({
          attempt: state.attempt,
          fault_kind: null,
          decision: 'verified_completion',
          detail: 'the destination acknowledged the send',
          delay_ms: null,
          retry_after: null,
          candidate_id: candidateId,
          route,
        });
        return finish('completed', outcome, null);
      }
      // A connector that answered rather than threw has already decided. The
      // policy does not second-guess a plain failed or a plain unknown, which
      // is exactly what the broker did before typed faults existed.
      if (outcome.outcome === 'unknown') return finish('needs_reconciliation', outcome, null);
      return finish('repair_exhausted', outcome, null);
    }

    count(fault.kind);

    // One fault, as many decisions as it takes to know what to do about it.
    for (;;) {
      state.now = now();
      const choice = decideRepair(fault, state, limits, random);

      if (choice.act === 'reconcile') {
        note({
          attempt: state.attempt,
          fault_kind: fault.kind,
          decision: choice.decision,
          detail: choice.detail,
          delay_ms: null,
          retry_after: null,
          candidate_id: candidateId,
          route,
        });
        let verdict: VerifyResult;
        try {
          verdict = await ports.verify();
        } catch {
          verdict = { decision: 'undecided', reason: 'verification could not be reached' };
        }
        if (verdict.decision === 'succeeded') {
          note({
            attempt: state.attempt,
            fault_kind: fault.kind,
            decision: 'verified_completion',
            detail: 'verification found the send already at the destination',
            delay_ms: null,
            retry_after: null,
            candidate_id: candidateId,
            route,
          });
          return finish(
            'completed',
            verdict.receipt
              ? { outcome: 'succeeded', receipt: verdict.receipt }
              : { outcome: 'unknown', reason: fault.detail },
            null,
          );
        }
        if (verdict.decision === 'failed') {
          note({
            attempt: state.attempt,
            fault_kind: fault.kind,
            decision: 'escalate_diagnosis',
            detail: 'verification found nothing at the destination',
            delay_ms: null,
            retry_after: null,
            candidate_id: candidateId,
            route,
          });
          return finish(
            'repair_exhausted',
            { outcome: 'failed', reason: 'repair_exhausted', retryable: false },
            `Nothing arrived at the destination. ${fault.detail}.`,
          );
        }
        // Insufficient evidence stays insufficient. This is the honest rest.
        note({
          attempt: state.attempt,
          fault_kind: fault.kind,
          decision: 'escalate_diagnosis',
          detail: 'verification could not decide, so the outcome stays unknown',
          delay_ms: null,
          retry_after: null,
          candidate_id: candidateId,
          route,
        });
        return finish('needs_reconciliation', { outcome: 'unknown', reason: fault.detail }, null);
      }

      if (choice.act === 'park') {
        const at = new Date(state.now + choice.retry_after_ms).toISOString();
        note({
          attempt: state.attempt,
          fault_kind: fault.kind,
          decision: choice.decision,
          detail: choice.detail,
          delay_ms: null,
          retry_after: at,
          candidate_id: candidateId,
          route,
        });
        return finish('parked_until_retry', null, null, at);
      }

      if (choice.act === 'stop') {
        note({
          attempt: state.attempt,
          fault_kind: fault.kind,
          decision: choice.decision,
          detail: choice.detail,
          delay_ms: null,
          retry_after: null,
          candidate_id: candidateId,
          route,
        });
        // An uncertain stop is unknown, not failed: nothing here may declare
        // that a send did not happen when nobody has looked.
        if (choice.disposition === 'needs_reconciliation') {
          return finish('needs_reconciliation', { outcome: 'unknown', reason: fault.detail }, null);
        }
        return finish(
          choice.disposition,
          { outcome: 'failed', reason: stopReason(choice.disposition), retryable: false },
          `${choice.detail}. ${fault.detail}.`,
        );
      }

      note({
        attempt: state.attempt,
        fault_kind: fault.kind,
        decision: choice.decision,
        detail: choice.detail,
        delay_ms: choice.act === 'retry' ? choice.delay_ms : null,
        retry_after: null,
        candidate_id: candidateId,
        route,
      });

      if (choice.act === 'refresh') {
        state.refreshed = true;
        const permitted = ports.refreshCredential ? await ports.refreshCredential() : false;
        if (!permitted) {
          note({
            attempt: state.attempt,
            fault_kind: fault.kind,
            decision: 'stop_connection_revoked',
            detail: 'the refresh found the grant gone, so nothing was retried',
            delay_ms: null,
            retry_after: null,
            candidate_id: candidateId,
            route,
          });
          return finish(
            'needs_reconnect',
            { outcome: 'failed', reason: 'connection_revoked', retryable: false },
            'This connection no longer permits the send. Reconnect it and Melete carries on.',
          );
        }
        continue executions;
      }

      if (choice.act === 'rediscover') {
        state.rediscovered = true;
        const description = ports.describe
          ? await ports.describe()
          : { required: [] as string[], optional: [] as string[] };
        const proposal = proposeMapping(payload, description);
        const evaluation = evaluateMapping(proposal);
        const recorded = ports.recordCandidate
          ? await ports.recordCandidate({ fault, proposal, description, evaluation })
          : null;
        candidateId = recorded?.id ?? candidateId;
        pending = proposal;
        state.safeMapping = proposal.safe && evaluation.passed;
        note({
          attempt: state.attempt,
          fault_kind: fault.kind,
          decision: 'record_repair_candidate',
          detail: evaluation.detail,
          delay_ms: null,
          retry_after: null,
          candidate_id: candidateId,
          route,
        });
        // Nothing was sent. Ask the policy again, now that the shape is known.
        continue;
      }

      if (choice.act === 'reroute') {
        const available = ports.routes ? await ports.routes() : [];
        if (available.length === 0) {
          state.canReroute = false;
          continue;
        }
        route = available[0] as string;
        state.routesChanged += 1;
        continue executions;
      }

      if (choice.act === 'revise') {
        state.revisions += 1;
        const revised = ports.revise ? await ports.revise(fault) : null;
        if (!revised) {
          state.canRevise = false;
          continue;
        }
        payload = revised;
        continue executions;
      }

      // A retry: either the same bytes again, or the same values under the
      // names the destination now uses.
      if (choice.decision === 'apply_safe_mapping' && pending) {
        payload = applyFieldMapping(payload, pending.mapping) as JsonObject;
        mapping = { ...(mapping ?? {}), ...pending.mapping };
        pending = null;
        state.safeMapping = false;
      }
      if (choice.delay_ms > 0) await sleep(choice.delay_ms);
      continue executions;
    }
  }
}

/**
 * Counters split the only two ways that matter: an effect that happened, and a
 * stop that kept the world unchanged. A safe stop is never counted as a
 * completion and never shown as a failure.
 */
export const isCompletion = (disposition: RepairDisposition): boolean =>
  disposition === 'completed';
