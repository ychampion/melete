/**
 * The falsifier for the repair policy.
 *
 * Every fault class in the taxonomy is run against a deterministic destination
 * double, and for each one three things are asserted rather than hoped for: the
 * disposition is the one the policy promises, the destination holds exactly one
 * effect or none, and the bytes that went on the wire are the bytes that were
 * approved. Completions and safe stops are counted separately, because a run
 * that stops safely eleven times out of eleven is not a run that delivered
 * eleven things and must never be reported as one.
 *
 * The blind-retry baseline is here for the same reason a control group is: it
 * runs the identical cases with the policy switched off and shows the duplicate
 * send that the classification is what prevents.
 */
import { describe, expect, test } from 'bun:test';
import {
  type ConnectorFault,
  canonicalizePayload,
  type DispatchResult,
  isSafeFieldMapping,
  isSafeStop,
  type JsonObject,
  type Receipt,
  type VerifyResult,
} from '@melete/contracts';
import {
  asConnectorFault,
  type ConnectorDescription,
  ConnectorFaultError,
  unclassifiedFault,
} from '../connectors/faults.ts';
import {
  DEFAULT_REPAIR_LIMITS,
  decideRepair,
  evaluateMapping,
  isCompletion,
  proposeMapping,
  type RepairExecution,
  type RepairPorts,
  type RepairState,
  runRepair,
} from './repair.ts';

const ACTION_ID = 'act_01J0000000000000000000000A';
const CONNECTION_ID = 'conn_01J0000000000000000000000B';
const FALLBACK_ROUTE = 'send/authorized-fallback';

/** The eleven reference cases, plus the two the lane brief adds. */
const CASES = {
  healthy: 'completed',
  transient_before_dispatch: 'completed',
  expired_credential: 'completed',
  schema_drift: 'completed',
  unsupported_route: 'completed',
  lost_ack_verifiable: 'completed',
  rate_limited: 'parked_until_retry',
  lost_ack_unverifiable: 'needs_reconciliation',
  revoked_credential: 'needs_reconnect',
  bad_output: 'needs_input',
  persistent_transient: 'repair_exhausted',
  unclassified: 'needs_reconciliation',
} as const;
type CaseName = keyof typeof CASES;

const receiptFor = (): Receipt => ({
  action_id: ACTION_ID,
  connection_id: CONNECTION_ID,
  external_ref: ACTION_ID,
  detail: {},
  received_at: new Date().toISOString(),
  late: false,
});

/**
 * A destination that fails on purpose and always the same way. Every effect it
 * accepts is appended, so a duplicate is a length, not an interpretation.
 */
class Destination {
  readonly effects: JsonObject[] = [];
  calls = 0;
  refreshed = false;
  constructor(readonly name: CaseName) {}

  async execute(input: RepairExecution): Promise<DispatchResult> {
    this.calls += 1;
    const fail = (
      kind: ConnectorFault['kind'],
      detail: string,
      extra: { may_have_committed?: boolean; retry_after?: number } = {},
    ): never => {
      throw new ConnectorFaultError({ kind, detail, ...extra });
    };
    switch (this.name) {
      case 'revoked_credential':
        fail('revoked_credential', 'the owner revoked this connection');
        break;
      case 'expired_credential':
        if (!this.refreshed) fail('expired_credential', 'the access token has expired');
        break;
      case 'schema_drift':
        if (!('content' in input.payload)) fail('schema_drift', 'body is no longer accepted');
        break;
      case 'rate_limited':
        if (this.calls === 1) fail('rate_limited', 'slow down', { retry_after: 30 });
        break;
      case 'unsupported_route':
        if (input.route !== FALLBACK_ROUTE)
          fail('unsupported_route', 'this route cannot carry the send and did not try');
        break;
      case 'transient_before_dispatch':
        if (this.calls === 1) fail('transient_before_dispatch', 'the socket closed');
        break;
      case 'persistent_transient':
        fail('transient_before_dispatch', 'the socket closed, again');
        break;
      case 'bad_output':
        fail('bad_output', 'the file it wrote does not pass its own validation');
        break;
      case 'unclassified':
        throw new Error('the destination failed in a way it does not describe');
      default:
        break;
    }
    this.effects.push({ ...input.payload });
    if (this.name === 'lost_ack_verifiable' || this.name === 'lost_ack_unverifiable') {
      throw new ConnectorFaultError({
        kind: 'uncertain_outcome',
        detail: 'the acknowledgement was lost',
        may_have_committed: true,
      });
    }
    return { outcome: 'succeeded', receipt: receiptFor() };
  }

  async verify(): Promise<VerifyResult> {
    if (this.name === 'lost_ack_unverifiable')
      return { decision: 'undecided', reason: 'the destination cannot confirm this send' };
    return this.effects.length > 0
      ? { decision: 'succeeded', evidence: {}, receipt: receiptFor() }
      : { decision: 'failed', evidence: {} };
  }

  async describe(): Promise<ConnectorDescription> {
    const drifted = this.name === 'schema_drift';
    return { required: [drifted ? 'content' : 'body'], optional: ['note'] };
  }

  async refreshCredential(): Promise<boolean> {
    if (this.name === 'revoked_credential') return false;
    this.refreshed = true;
    return true;
  }

  async routes(): Promise<string[]> {
    return this.name === 'unsupported_route' ? [FALLBACK_ROUTE] : [];
  }
}

const classify = (error: unknown): ConnectorFault =>
  asConnectorFault(error) ?? unclassifiedFault(error);

const payloadFor = (): JsonObject => ({ body: 'Pilot worksheet ready', note: 'for Tuesday' });

async function runCase(name: CaseName, options: { blind?: boolean } = {}) {
  const destination = new Destination(name);
  const payload = payloadFor();
  const candidates: { id: string; safe: boolean; passed: boolean }[] = [];
  const ports: RepairPorts = {
    execute: (input) => destination.execute(input),
    verify: () => destination.verify(),
    describe: () => destination.describe(),
    refreshCredential: () => destination.refreshCredential(),
    routes: () => destination.routes(),
    async recordCandidate({ proposal, evaluation }) {
      const id = `rpc_0000000000000000000000000${candidates.length}`;
      candidates.push({ id, safe: proposal.safe, passed: evaluation.passed });
      return { id };
    },
  };
  if (options.blind) {
    // The control: retry whatever happened, three times, and see what it costs.
    let last: DispatchResult = { outcome: 'unknown', reason: 'never ran' };
    for (let i = 0; i < 3; i++) {
      try {
        last = await destination.execute({ payload, route: null, mapping: null, attempt: i + 1 });
        break;
      } catch (error) {
        last = { outcome: 'failed', reason: String(error), retryable: true };
      }
    }
    return { destination, candidates, run: null, last };
  }
  const run = await runRepair(payload, ports, {
    classify,
    sleep: async () => {},
    random: () => 0.5,
  });
  return { destination, candidates, run, last: run.result };
}

describe('the typed repair policy fixes causes and never duplicates an effect', () => {
  const names = Object.keys(CASES) as CaseName[];

  for (const name of names) {
    test(`${name} rests at ${CASES[name]} with one effect at most`, async () => {
      const { destination, run } = await runCase(name);
      if (!run) throw new Error('the policy did not run');
      expect(run.disposition).toBe(CASES[name]);
      // A duplicate is a length, not an interpretation.
      expect(Math.max(0, destination.effects.length - 1)).toBe(0);
      const approved = canonicalizePayload(payloadFor()).hash;
      for (const entry of run.trace) {
        if (entry.payload_hash === approved) continue;
        // The only line allowed to carry different bytes is one that follows an
        // applied mapping, and a mapping only ever renames.
        expect(run.trace.some((step) => step.decision === 'apply_safe_mapping')).toBe(true);
      }
      // Whatever was finally sent carries every approved value, unchanged.
      const before = Object.values(payloadFor())
        .map((v) => JSON.stringify(v))
        .sort();
      const after = Object.values(run.payload)
        .map((v) => JSON.stringify(v))
        .sort();
      expect(after).toEqual(before);
    });
  }

  test('completions and safe stops are counted apart, never summed', async () => {
    const rows = await Promise.all(names.map(async (name) => (await runCase(name)).run));
    const completed = rows.filter((run) => run && isCompletion(run.disposition)).length;
    const safeStops = rows.filter((run) => run && isSafeStop(run.disposition)).length;
    expect(completed).toBe(6);
    expect(safeStops).toBe(names.length - 6);
    expect(completed + safeStops).toBe(names.length);
  });

  test('every fault the policy met is counted under its own class', async () => {
    const { run } = await runCase('persistent_transient');
    expect(run?.counters).toEqual({ transient_before_dispatch: 3 });
    expect(run?.executions).toBe(3);
  });

  test('a blind retry duplicates the send the policy reconciles instead', async () => {
    const blind = await runCase('lost_ack_verifiable', { blind: true });
    expect(blind.destination.effects.length).toBe(3);
    const classified = await runCase('lost_ack_verifiable');
    expect(classified.destination.effects.length).toBe(1);
    expect(classified.run?.disposition).toBe('completed');
    expect(classified.destination.calls).toBe(1);
  });

  test('an unverifiable lost acknowledgement stays unknown rather than being resent', async () => {
    const { destination, run } = await runCase('lost_ack_unverifiable');
    expect(run?.disposition).toBe('needs_reconciliation');
    expect(run?.result).toEqual({
      outcome: 'unknown',
      reason: 'the acknowledgement was lost',
    });
    expect(destination.effects.length).toBe(1);
    expect(destination.calls).toBe(1);
  });
});

describe('rate limiting parks rather than spins', () => {
  test('the worker is released and the destination is not approached again', async () => {
    const started = Date.parse('2026-09-12T10:00:00.000Z');
    const destination = new Destination('rate_limited');
    const run = await runRepair(
      payloadFor(),
      {
        execute: (input) => destination.execute(input),
        verify: () => destination.verify(),
      },
      { classify, now: () => started, sleep: async () => {} },
    );
    expect(run.disposition).toBe('parked_until_retry');
    // Exactly one execution: parking is the opposite of a tight retry loop.
    expect(destination.calls).toBe(1);
    expect(run.result).toBeNull();
    expect(run.retry_after_at).toBe(new Date(started + 30_000).toISOString());
    expect(run.trace.at(-1)?.decision).toBe('park_until_retry_after');
  });

  test('a destination that names no delay still gets the whole default wait', () => {
    const choice = decideRepair(
      { kind: 'rate_limited', may_have_committed: false, retry_after: null, detail: 'slow down' },
      state(),
    );
    expect(choice.act).toBe('park');
    if (choice.act !== 'park') throw new Error('unreachable');
    expect(choice.retry_after_ms).toBe(DEFAULT_REPAIR_LIMITS.defaultRetryAfterSeconds * 1000);
  });
});

const state = (over: Partial<RepairState> = {}): RepairState => ({
  attempt: 1,
  refreshed: false,
  rediscovered: false,
  routesChanged: 0,
  revisions: 0,
  safeMapping: false,
  canRefresh: true,
  canRediscover: true,
  canReroute: true,
  canRevise: true,
  now: 1_000,
  deadlineAt: null,
  ...over,
});

describe('what a repair is never allowed to do', () => {
  test('an uncertain outcome is verified whatever class the connector named', () => {
    for (const kind of [
      'transient_before_dispatch',
      'unsupported_route',
      'rate_limited',
    ] as const) {
      const choice = decideRepair(
        { kind, may_have_committed: true, retry_after: null, detail: 'the answer was lost' },
        state(),
      );
      expect(choice.act).toBe('reconcile');
    }
  });

  test('a revoked credential stops and never reaches for another identity', () => {
    const choice = decideRepair(
      {
        kind: 'revoked_credential',
        may_have_committed: false,
        retry_after: null,
        detail: 'revoked',
      },
      state({ canRefresh: true }),
    );
    expect(choice).toMatchObject({ act: 'stop', disposition: 'needs_reconnect' });
  });

  test('a credential is refreshed once and only once', () => {
    const fault = {
      kind: 'expired_credential' as const,
      may_have_committed: false,
      retry_after: null,
      detail: 'expired',
    };
    expect(decideRepair(fault, state()).act).toBe('refresh');
    expect(decideRepair(fault, state({ refreshed: true }))).toMatchObject({
      act: 'stop',
      disposition: 'repair_exhausted',
    });
  });

  test('a route changes once, for the same operation, and never twice', () => {
    const fault = {
      kind: 'unsupported_route' as const,
      may_have_committed: false,
      retry_after: null,
      detail: 'unsupported',
    };
    expect(decideRepair(fault, state()).act).toBe('reroute');
    expect(decideRepair(fault, state({ routesChanged: 1 }))).toMatchObject({
      act: 'stop',
      disposition: 'repair_exhausted',
    });
    expect(decideRepair(fault, state({ canReroute: false }))).toMatchObject({ act: 'stop' });
  });

  test('a transient retry stops when the deadline leaves no room', () => {
    const fault = {
      kind: 'transient_before_dispatch' as const,
      may_have_committed: false,
      retry_after: null,
      detail: 'closed',
    };
    expect(
      decideRepair(fault, state({ deadlineAt: 10_000 }), DEFAULT_REPAIR_LIMITS, () => 0).act,
    ).toBe('retry');
    expect(
      decideRepair(fault, state({ deadlineAt: 1_050 }), DEFAULT_REPAIR_LIMITS, () => 1),
    ).toMatchObject({ act: 'stop', disposition: 'repair_exhausted' });
  });

  test('a bad output is revised once and is never called delivered on a second failure', async () => {
    const destination = new Destination('bad_output');
    let revisions = 0;
    const run = await runRepair(
      payloadFor(),
      {
        execute: (input) => destination.execute(input),
        verify: () => destination.verify(),
        async revise() {
          revisions += 1;
          return payloadFor();
        },
      },
      { classify, sleep: async () => {} },
    );
    expect(revisions).toBe(1);
    expect(run.disposition).toBe('needs_input');
    expect(run.result).toEqual({
      outcome: 'failed',
      reason: 'output_validation_failed',
      retryable: false,
    });
    expect(destination.effects.length).toBe(0);
  });
});

describe('drift mappings are proposals with a test, not live changes', () => {
  const sent = { body: 'Pilot worksheet ready', note: 'for Tuesday' };

  test('an unambiguous rename that carries every value is safe and passes its test', () => {
    const proposal = proposeMapping(sent, { required: ['content'], optional: ['note'] });
    expect(proposal.mapping).toEqual({ body: 'content' });
    expect(proposal.safe).toBe(true);
    expect(evaluateMapping(proposal).passed).toBe(true);
    expect(isSafeFieldMapping(sent, proposal.mapping)).toBe(true);
  });

  test('two missing fields is a guess and is recorded rather than applied', () => {
    const proposal = proposeMapping(sent, { required: ['content', 'subject'], optional: ['note'] });
    expect(proposal.safe).toBe(false);
    expect(evaluateMapping(proposal).passed).toBe(false);
  });

  test('a mapping that would drop a value is refused', () => {
    expect(isSafeFieldMapping(sent, { body: 'note' })).toBe(false);
    expect(isSafeFieldMapping(sent, { missing: 'content' })).toBe(false);
    expect(isSafeFieldMapping(sent, {})).toBe(false);
  });

  test('drift is repaired only after a candidate has been recorded and has passed', async () => {
    const { candidates, destination, run } = await runCase('schema_drift');
    expect(candidates).toEqual([
      { id: 'rpc_00000000000000000000000000', safe: true, passed: true },
    ]);
    expect(run?.disposition).toBe('completed');
    expect(destination.effects).toEqual([
      { content: 'Pilot worksheet ready', note: 'for Tuesday' },
    ]);
    // The renamed send carries the same values, so the same send happened once.
    expect(destination.calls).toBe(2);
    expect(run?.trace.map((entry) => entry.decision)).toEqual([
      'rediscover_schema',
      'record_repair_candidate',
      'apply_safe_mapping',
      'verified_completion',
    ]);
  });

  test('a connector that cannot describe itself stops instead of guessing', async () => {
    const destination = new Destination('schema_drift');
    const run = await runRepair(
      payloadFor(),
      {
        execute: (input) => destination.execute(input),
        verify: () => destination.verify(),
      },
      { classify, sleep: async () => {} },
    );
    expect(run.disposition).toBe('needs_input');
    expect(destination.effects.length).toBe(0);
  });
});
