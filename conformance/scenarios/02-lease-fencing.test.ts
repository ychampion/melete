import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Receipt } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../apps/melete/src/api/errors.ts';
import { action } from '../../apps/melete/src/db/schema.ts';
import { newId } from '../../apps/melete/src/ids.ts';
import { recordReceipt, withCapability } from '../../apps/melete/src/jobs/fence.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../apps/melete/src/jobs/runner.ts';
import type { JobRow } from '../../apps/melete/src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../apps/melete/src/runtime/stub.ts';
import { fakeTool } from '../helpers/fake-effects.ts';
import { CONFORMANCE_KEY, conformanceFixture, wake } from '../helpers/fixture.ts';
import { scenario } from '../scenarios.ts';

const s = scenario(2);

const fixture = await conformanceFixture();
const withDb = fixture ? describe : describe.skip;

withDb(`conformance 2: ${s.title}`, () => {
  let first: ClaimedAttempt;
  let second: ClaimedAttempt;
  let staleAdmission: unknown;
  let staleOutcome: unknown;
  let gateReached = false;
  let secondAction = '';
  let receipt: Receipt;
  let beforeReceipt: JobRow;
  let afterReceipt: JobRow;
  let release = () => {};
  let firstRun: Promise<unknown> | undefined;
  beforeAll(async () => {
    if (!fixture) return;
    let reached = () => {};
    const stalled = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new StubRuntimeAdapter({
      ignoreAbort: true,
      onStall: async (_key, bundle) => {
        reached();
        await resume;
        try {
          await withCapability(fixture.jobs, bundle.attempt.token, CONFORMANCE_KEY, async () => {
            gateReached = true;
          });
        } catch (error) {
          staleAdmission = error;
        }
      },
    });
    const worker = new AttemptRunner(fixture.jobs, runtime, { key: CONFORMANCE_KEY });
    const row = await fixture.create([
      { type: 'stall', key: 'A', epoch: 1 },
      {
        type: 'outcome',
        epoch: 1,
        outcome: { kind: 'completed', summary: 'Stale result', evidence: [] },
      },
      {
        type: 'outcome',
        epoch: 2,
        outcome: { kind: 'waiting_for_input', question: 'Next step?' },
      },
    ]);
    const admitted = await worker.claim(wake(row));
    if (!admitted) throw new Error('A was not admitted');
    first = admitted;
    firstRun = runtime
      .start(
        first.bundle,
        { emit: (value) => worker.emit(first.claims, value) },
        new AbortController().signal,
      )
      .catch((error: unknown) => {
        staleOutcome = error;
      });
    await stalled;
    const firstAction = newId('act');
    await withCapability(fixture.jobs, first.bundle.attempt.token, CONFORMANCE_KEY, async (tx) => {
      await tx.insert(action).values({
        id: firstAction,
        jobId: row.id,
        attemptId: first.claims.attempt_id,
        connectionId: fixture.connectionId,
        kind: 'test.send',
        effectClass: 'write_external',
        canonicalPayload: {},
        payloadHash: 'a'.repeat(64),
        idempotencyKey: firstAction,
        status: 'dispatched',
        dispatchedAt: new Date(),
      });
    });
    await fixture.handle
      .sql`update attempt set lease_expires_at = now() - interval '1 second' where id = ${first.claims.attempt_id}`;
    await worker.recover();
    const replacement = await worker.claim(wake(await fixture.jobs.get(row.id)));
    if (!replacement) throw new Error('B was not admitted');
    second = replacement;
    const effect = await fakeTool(fixture.jobs, CONFORMANCE_KEY, fixture.connectionId)(
      'B-admission',
      {},
      second.bundle,
    );
    secondAction = effect.action_id;
    release();
    await firstRun;
    beforeReceipt = await fixture.jobs.get(row.id);
    receipt = await recordReceipt(fixture.jobs, first.claims.attempt_id, {
      action_id: firstAction,
      connection_id: fixture.connectionId,
      external_ref: 'accepted-before-fence',
      detail: { accepted: true },
      received_at: new Date().toISOString(),
      late: false,
    });
    expect(await recordReceipt(fixture.jobs, first.claims.attempt_id, receipt)).toEqual(receipt);
    afterReceipt = await fixture.jobs.get(row.id);
    const outcome = await runtime.start(
      second.bundle,
      { emit: (value) => worker.emit(second.claims, value) },
      new AbortController().signal,
    );
    await worker.commitOutcome(second.claims, outcome);
  }, 20_000);
  afterAll(async () => {
    release();
    await firstRun;
    await fixture?.close();
  });

  test(s.assertions[0] ?? '', () => {
    expect(staleAdmission).toBeInstanceOf(ServiceError);
    expect((staleAdmission as ServiceError).code).toBe('stale_epoch');
    expect(gateReached).toBe(false);
    expect((staleOutcome as ServiceError).code).toBe('stale_epoch');
  });
  test(s.assertions[1] ?? '', async () => {
    expect(second.claims.epoch).toBe(first.claims.epoch + 1);
    expect(second.claims.attempt_id).not.toBe(first.claims.attempt_id);
    const [saved] = await (fixture?.handle.db
      .select()
      .from(action)
      .where(eq(action.id, secondAction)) ?? []);
    expect(saved?.attemptId).toBe(second.claims.attempt_id);
    expect(saved?.status).toBe('succeeded');
  });
  test(s.assertions[2] ?? '', async () => {
    expect(receipt.late).toBe(true);
    if (!fixture) return;
    const rows = await fixture.handle
      .sql`select payload from event where attempt_id = ${first.claims.attempt_id} and payload->>'kind' = 'receipt'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ late: true, action_id: receipt.action_id });
  });
  test(s.assertions[3] ?? '', () => {
    expect(afterReceipt.state).toBe('running');
    expect(afterReceipt.state).toBe(beforeReceipt.state);
    expect(afterReceipt.leaseEpoch).toBe(beforeReceipt.leaseEpoch);
    expect(afterReceipt.stateVersion).toBe(beforeReceipt.stateVersion);
  });
});
