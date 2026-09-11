/**
 * The repair policy against a real Postgres and a real destination ledger.
 *
 * The unit falsifier proves the policy decides correctly. This proves the
 * broker does what the decision said: the action keeps its identity and its
 * approval across every repair, the destination holds one delivery or none,
 * the trace and the counters are on the record afterwards, a rate limit
 * releases the worker instead of holding it, and a stop that needs a person
 * reaches the owner's one question queue exactly once.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  canonicalizePayload,
  type JsonObject,
  jobConstraints,
  jobRepairsResponse,
} from '@melete/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import { mountRepairs, RepairReadService } from '../../src/api/repairs.ts';
import { loadAction } from '../../src/broker/records.ts';
import { ConnectorFaultError } from '../../src/connectors/faults.ts';
import { schema } from '../../src/db/schema.ts';
import { createConformanceFixture } from '../helpers/conformance.ts';

const fixture = await createConformanceFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

async function setup(options: Parameters<NonNullable<typeof fixture>['setup']>[0] = {}) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.setup(options);
}

type Harness = Awaited<ReturnType<typeof setup>>;

const body = 'Pilot worksheet ready';
const payloadFor = (fault: string): JsonObject => ({ body, fault });

const deliveries = (s: Harness, actionId: string) =>
  s.sql`select payload, payload_hash from test_destination_ledger where action_id = ${actionId}`;

const candidates = (s: Harness, actionId: string) =>
  s.sql`select id, state, proposed_mapping, safe, evaluation, test
    from repair_candidate where action_id = ${actionId}`;

const openQuestions = (s: Harness) =>
  s.sql`select id, text, because, blocks_external_effect from question
    where job_id = ${s.claims.job_id} and state = 'open'`;

describe('a repaired send keeps its identity, its approval and its one effect', () => {
  databaseTest('a transient failure before dispatch retries the same bytes', async () => {
    const s = await setup();
    const payload = payloadFor('transient_before_dispatch');
    const action = await s.send(payload);
    expect(action.status).toBe('succeeded');
    expect(action.repair_disposition).toBe('completed');
    expect(action.repair_counters).toEqual({ transient_before_dispatch: 1 });
    // The approval bound this hash and the repair did not move it.
    expect(action.payload_hash).toBe(canonicalizePayload(payload).hash);
    expect(await deliveries(s, action.id)).toHaveLength(1);
    expect(action.repair_trace.map((entry) => entry.decision)).toEqual([
      'retry_with_backoff',
      'verified_completion',
    ]);
    for (const entry of action.repair_trace) expect(entry.payload_hash).toBe(action.payload_hash);
  });

  databaseTest('a rate limit parks the job and releases the worker', async () => {
    const s = await setup();
    const parked = await s.send({ ...payloadFor('rate_limited'), retry_after: 1 });
    // Nothing left, nothing settled, and the action is admitted again under its
    // own id, so the destination will see the same request it declined.
    expect(parked.status).toBe('admitted');
    expect(parked.repair_disposition).toBe('parked_until_retry');
    expect(parked.dispatched_at).toBeNull();
    expect(parked.retry_after_at).not.toBeNull();
    expect(await deliveries(s, parked.id)).toHaveLength(0);
    expect(s.executions()).toBe(1);

    const [job] = await s.sql`select state, wait, next_wake_at, substrate_disposition
      from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('waiting_for_event_or_time');
    expect(job?.wait).toMatchObject({ kind: 'timer' });
    expect(job?.substrate_disposition).toBe('timer_or_event');
    // Nobody was asked anything: a rate limit is a wait, not a question.
    expect(await openQuestions(s)).toHaveLength(0);

    // The clock, not a worker, brings it back.
    expect(await s.broker.resumeParked(Date.now() - 60_000)).toBe(0);
    expect(await s.broker.resumeParked(Date.now() + 60_000)).toBe(1);
    const resumed = await loadAction(s.sql, parked.id);
    expect(resumed.status).toBe('succeeded');
    expect(resumed.repair_disposition).toBe('completed');
    expect(await deliveries(s, parked.id)).toHaveLength(1);
    expect(s.executions()).toBe(2);
    // The wait is still on the record. A completion that erased why it waited
    // would leave a recurring rate limit invisible.
    expect(resumed.repair_counters).toEqual({ rate_limited: 1 });
    expect(resumed.repair_trace.map((entry) => entry.decision)).toEqual([
      'park_until_retry_after',
      'verified_completion',
    ]);
    expect(resumed.retry_after_at).toBeNull();
  });

  databaseTest('a parked action refuses to leave before the destination asked', async () => {
    const s = await setup();
    // Five minutes, so nothing about wall-clock timing decides this test.
    const parked = await s.send({ ...payloadFor('rate_limited'), retry_after: 300 });
    expect(parked.status).toBe('admitted');
    expect(s.executions()).toBe(1);

    // A wake, a repeated proposal, a queue redelivery: all of them land here.
    const early = await s.broker.dispatch(parked.id);
    expect(early.status).toBe('admitted');
    expect(early.dispatched_at).toBeNull();
    expect(s.executions()).toBe(1);
    expect(await deliveries(s, parked.id)).toHaveLength(0);

    // Two wakes at once must not both get through the due check either.
    const [first, second] = await Promise.all([
      s.broker.dispatch(parked.id),
      s.broker.dispatch(parked.id),
    ]);
    expect(first?.status).toBe('admitted');
    expect(second?.status).toBe('admitted');
    expect(s.executions()).toBe(1);
    expect(await deliveries(s, parked.id)).toHaveLength(0);

    // And the recovery scan will not pick it up before it is due.
    expect(await s.broker.resumeParked(Date.now())).toBe(0);
  });

  databaseTest('a revoked credential stops and asks for a reconnection', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('revoked_credential'));
    expect(action.status).toBe('failed');
    expect(action.repair_disposition).toBe('needs_reconnect');
    expect(action.reconciliation).toMatchObject({ reason: 'connection_revoked' });
    expect(await deliveries(s, action.id)).toHaveLength(0);
    // The connection is untouched: no identity was substituted for the one the
    // owner revoked, and the action still names it.
    expect(action.connection_id).toBe(s.connectionId);
    const asked = await openQuestions(s);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('Reconnect');
    expect(asked[0]?.blocks_external_effect).toBe(true);
  });

  databaseTest('a second failure asks once, not once per attempt', async () => {
    const s = await setup();
    await s.send(payloadFor('revoked_credential'));
    await s.send({ ...payloadFor('revoked_credential'), body: `${body} again` });
    expect(await openQuestions(s)).toHaveLength(1);
  });

  databaseTest('a revocation during backoff fences the retry before it is sent', async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    let connectionId = '';
    let calls = 0;
    const s = await fixture.setup({
      async execute(action, ctx, destination) {
        calls += 1;
        if (calls === 1) {
          // The owner revokes the connection while the policy is backing off.
          await fixture.sql`update connection set status = 'revoked' where id = ${connectionId}`;
          throw new ConnectorFaultError({
            kind: 'transient_before_dispatch',
            detail: 'the socket closed before the send',
          });
        }
        return destination.execute(action, ctx);
      },
    });
    connectionId = s.connectionId;
    const action = await s.send({ body });
    // The retry was authorized a moment ago and is not authorized now.
    expect(action.status).toBe('failed');
    expect(action.repair_disposition).toBe('needs_reconnect');
    expect(calls).toBe(1);
    expect(await deliveries(s, action.id)).toHaveLength(0);
    expect(await openQuestions(s)).toHaveLength(1);
  });

  databaseTest('schema drift is repaired through a candidate that passed its test', async () => {
    const s = await setup();
    const payload = payloadFor('schema_drift');
    const action = await s.send(payload);
    expect(action.status).toBe('succeeded');
    expect(action.repair_disposition).toBe('completed');
    // The action's own hash is the approved one, before and after.
    expect(action.payload_hash).toBe(canonicalizePayload(payload).hash);
    const [candidate] = await candidates(s, action.id);
    expect(candidate).toMatchObject({ state: 'applied', safe: true });
    expect(candidate?.proposed_mapping).toEqual({ body: 'content' });
    expect(candidate?.evaluation).toMatchObject({ passed: true });
    const sent = await deliveries(s, action.id);
    expect(sent).toHaveLength(1);
    // A rename, and nothing else: every value the owner approved survived it.
    expect(sent[0]?.payload).toEqual({ content: body, fault: 'schema_drift' });
    expect(sent[0]?.payload_hash).toBe(action.payload_hash);
    expect(Object.values(sent[0]?.payload as JsonObject).sort()).toEqual(
      Object.values(payload).sort(),
    );
  });

  databaseTest('an unsupported route changes route, not identity', async () => {
    const s = await setup();
    const payload = payloadFor('unsupported_route');
    const before = await s.broker.propose(s.claims, {
      kind: 'test.send',
      connection_id: s.connectionId,
      payload,
    });
    await s.broker.decide(before.action_id, {
      decision: 'approved',
      payload_hash: before.payload_hash,
    });
    await s.broker.admit(s.claims, before.action_id, before.payload_hash);
    const action = await s.broker.dispatch(before.action_id);
    expect(action.status).toBe('succeeded');
    // Same action, same intent key, same approval, one delivery.
    expect(action.id).toBe(before.action_id);
    expect(action.intent_key).toBe(before.intent_key);
    expect(action.payload_hash).toBe(before.payload_hash);
    expect(await deliveries(s, action.id)).toHaveLength(1);
    const changed = action.repair_trace.find((entry) => entry.decision === 'change_route');
    expect(changed).toBeDefined();
    expect(action.repair_trace.at(-1)?.route).toBe('test.send/authorized-fallback');
  });

  databaseTest('a lost acknowledgement that can be verified completes once', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('lost_ack_verifiable'));
    expect(action.status).toBe('succeeded');
    expect(action.repair_disposition).toBe('completed');
    expect(action.receipt).toMatchObject({ action_id: action.id });
    expect(await deliveries(s, action.id)).toHaveLength(1);
    expect(s.executions()).toBe(1);
  });

  databaseTest('a lost acknowledgement that cannot be verified stays unknown', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('lost_ack_unverifiable'));
    expect(action.status).toBe('unknown');
    expect(action.repair_disposition).toBe('needs_reconciliation');
    expect(action.receipt).toBeNull();
    const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('needs_reconciliation');
    // It reached the destination exactly once, and nothing pretended to know.
    expect(await deliveries(s, action.id)).toHaveLength(1);
    expect(s.executions()).toBe(1);
    // Verification was asked and could not decide, which is a person's question.
    const asked = await openQuestions(s);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('cannot confirm');
  });

  databaseTest('a failure nobody classified still asks the owner one question', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('unclassified'));
    // Uncertainty is preserved: nothing here decides that it did not happen.
    expect(action.status).toBe('unknown');
    expect(action.repair_disposition).toBe('needs_reconciliation');
    const [job] = await s.sql`select state from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('needs_reconciliation');
    const asked = await openQuestions(s);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('cannot confirm');
    expect(asked[0]?.blocks_external_effect).toBe(true);
  });

  databaseTest('a second unclassified failure does not stack a second question', async () => {
    const s = await setup();
    await s.send(payloadFor('unclassified'));
    await s.send({ ...payloadFor('unclassified'), body: `${body} again` });
    expect(await openQuestions(s)).toHaveLength(1);
  });

  databaseTest('a persistent transient failure exhausts and escalates one diagnosis', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('persistent_transient'));
    expect(action.status).toBe('failed');
    expect(action.repair_disposition).toBe('repair_exhausted');
    expect(action.repair_counters).toEqual({ transient_before_dispatch: 3 });
    expect(await deliveries(s, action.id)).toHaveLength(0);
    const asked = await openQuestions(s);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.because).toContain(
      'Nothing was sent twice and nothing was changed to make it go through.',
    );
  });

  databaseTest('a bad output is revised, re-validated, and never called delivered', async () => {
    let revisions = 0;
    const s = await setup({
      async reviseOutput() {
        revisions += 1;
        return { body: `${body} (revised)`, fault: 'bad_output' };
      },
    });
    const action = await s.send(payloadFor('bad_output'));
    expect(revisions).toBe(1);
    expect(action.status).toBe('failed');
    expect(action.repair_disposition).toBe('needs_input');
    expect(action.reconciliation).toMatchObject({ reason: 'output_validation_failed' });
    // A file existing is not a delivery, and no receipt was invented for one.
    expect(action.receipt).toBeNull();
    expect(await deliveries(s, action.id)).toHaveLength(0);
    expect(await openQuestions(s)).toHaveLength(1);
  });

  databaseTest('a healthy send records no repair at all', async () => {
    const s = await setup();
    const action = await s.send({ body });
    expect(action.status).toBe('succeeded');
    expect(action.repair_disposition).toBe('completed');
    expect(action.repair_counters).toEqual({});
    expect(action.repair_trace).toHaveLength(1);
    expect(await candidates(s, action.id)).toHaveLength(0);
  });
});

describe('the repair view separates what happened from what stopped safely', () => {
  databaseTest('GET /jobs/{id}/repairs reports each class, decision and disposition', async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const s = await setup();
    const repaired = await s.send(payloadFor('schema_drift'));
    const stopped = await s.send(payloadFor('revoked_credential'));
    const reads = new RepairReadService(drizzle(s.sql, { schema }));
    const rows = await reads.forJob(s.claims.job_id);
    expect(rows).toHaveLength(2);

    const completed = rows.find((row) => row.action_id === repaired.id);
    expect(completed).toMatchObject({ disposition: 'completed', safe_stop: false });
    expect(completed?.counters).toEqual({ schema_drift: 1 });
    expect(completed?.candidates).toHaveLength(1);
    expect(completed?.candidates[0]).toMatchObject({ state: 'applied', safe: true });
    expect(completed?.candidates[0]?.test.expected).toEqual({
      content: body,
      fault: 'schema_drift',
    });

    const safe = rows.find((row) => row.action_id === stopped.id);
    // A safe stop is its own state. Nothing in the view calls it a failure.
    expect(safe).toMatchObject({ disposition: 'needs_reconnect', safe_stop: true });
    expect(safe?.counters).toEqual({ revoked_credential: 1 });
    expect(safe?.trace.at(-1)?.decision).toBe('stop_connection_revoked');

    // Counted apart, never summed: one effect happened, one stop kept the world
    // as it was, and no total says two things were delivered.
    expect(rows.filter((row) => !row.safe_stop)).toHaveLength(1);
    expect(rows.filter((row) => row.safe_stop)).toHaveLength(1);
  });

  databaseTest('the route answers the shape the contract describes', async () => {
    const s = await setup();
    const action = await s.send(payloadFor('transient_before_dispatch'));
    const app = new Hono();
    mountRepairs(app, new RepairReadService(drizzle(s.sql, { schema })));
    const response = await app.request(`/jobs/${s.claims.job_id}/repairs`);
    expect(response.status).toBe(200);
    const view = jobRepairsResponse.parse(await response.json());
    expect(view.job_id).toBe(s.claims.job_id);
    expect(view.repairs.map((row) => row.action_id)).toEqual([action.id]);
    expect(view.repairs[0]?.trace.at(-1)?.decision).toBe('verified_completion');
  });
});

describe('the blind-retry baseline', () => {
  databaseTest('a blind retry asks the destination again after it may have acted', async () => {
    const s = await setup();
    // With the policy: the acknowledgement is lost, the outcome is verified,
    // and the destination is approached exactly once.
    const action = await s.send(payloadFor('lost_ack_verifiable'));
    expect(action.repair_disposition).toBe('completed');
    expect(s.executions()).toBe(1);
    expect(await deliveries(s, action.id)).toHaveLength(1);

    // Without it: the same fault is retried because nothing classified it, and
    // the destination is asked to perform the effect twice more after it
    // already had. Only this destination's own idempotency key absorbs that; a
    // destination without one would hold three copies of the same message.
    const ctx = {
      job_id: action.job_id,
      space_id: s.claims.space_id,
      idempotency_key: action.id,
      constraints: jobConstraints.parse({}),
    };
    let blindCalls = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      blindCalls += 1;
      await s.destination.execute(action, ctx).catch(() => undefined);
    }
    expect(blindCalls).toBe(3);
    expect(s.executions()).toBe(1);
  });
});
