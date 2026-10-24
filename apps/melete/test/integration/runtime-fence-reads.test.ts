/** Runtime commits reuse locked authority while preserving every attempt's own fence. */
import { afterAll, describe, expect, test } from 'bun:test';
import { type CapabilityClaims, dedupKey, type RuntimeEvent } from '@melete/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ServiceError } from '../../src/api/errors.ts';
import {
  attempt,
  connection,
  event,
  principal,
  schema,
  space,
  spaceMembership,
} from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const statements: string[] = [];
const logged = handle
  ? drizzle(handle.sql, { schema, logger: { logQuery: (statement) => statements.push(statement) } })
  : null;
const jobs = logged && queue ? new JobService(logged, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'runtime-fence-test-capability-key-at-least-32-bytes',
    })
  : null;
const withDb = handle ? describe : describe.skip;

async function fixture(name: string, connected = false) {
  const db = required(handle).db;
  const principalId = newId('own');
  const spaceId = newId('sp');
  const connectionId = connected ? newId('conn') : null;
  await db.insert(principal).values({ id: principalId, email: `${principalId}@example.test` });
  await db.insert(space).values({
    id: spaceId,
    name,
    kind: 'shared',
    ownerPrincipalId: principalId,
    gitPath: `/spaces/${spaceId}`,
  });
  await db.insert(spaceMembership).values({ spaceId, principalId, role: 'owner' });
  if (connectionId)
    await db.insert(connection).values({
      id: connectionId,
      spaceId,
      provider: 'test',
      label: 'Existing connection',
      status: 'active',
    });
  const claims: CapabilityClaims[] = [];
  for (const suffix of ['first', 'second']) {
    const row = await required(jobs).create({
      space_id: spaceId,
      title: `${name} ${suffix}`,
      objective: 'Record an answer.',
    });
    const admitted = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      }),
    );
    claims.push(admitted.claims);
  }
  return { spaceId, connectionId, first: required(claims[0]), second: required(claims[1]) };
}

function text(claims: CapabilityClaims, localSeq = 0): RuntimeEvent {
  return {
    type: 'text_delta',
    attempt_id: claims.attempt_id,
    local_seq: localSeq,
    dedup_key: dedupKey(claims.attempt_id, localSeq),
    at: '2026-10-24T04:00:00.000Z',
    text: `Words ${localSeq}.`,
  };
}

async function saved(claims: CapabilityClaims[]) {
  const ids = claims.map((claim) => claim.attempt_id);
  const db = required(handle).db;
  const executions = await db.select().from(attempt).where(inArray(attempt.id, ids));
  const words = await db
    .select()
    .from(event)
    .where(
      inArray(
        event.dedupKey,
        claims.map((claim) => text(claim).dedup_key),
      ),
    )
    .orderBy(asc(event.seq));
  return { executions, words };
}

async function refusal(operation: Promise<unknown>) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
}

withDb('runtime fence reads within one commit', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test.each([false, true])(
    'two jobs reuse authority and retain connection checks with connected=%s',
    async (connected) => {
      const { first, second } = await fixture('Shared authority', connected);
      for (const localSeq of [0, 1]) {
        statements.length = 0;
        await Promise.all([
          required(runner).emit(first, text(first, localSeq)),
          required(runner).emit(second, text(second, localSeq)),
        ]);
        const reads = (table: string) =>
          statements.filter(
            (statement) => /^\s*select\b/i.test(statement) && statement.includes(`from "${table}"`),
          );
        // Each commit checks its authority anew; only records sharing that
        // commit reuse it. Nonempty connection snapshots are always fresh.
        expect(reads('space')).toHaveLength(1);
        expect(reads('space_membership')).toHaveLength(1);
        expect(reads('connection')).toHaveLength(connected ? 2 : 0);
        // Per record: the job row lock, then its attempt read after that lock.
        expect(reads('job')).toHaveLength(4);
        expect(
          statements.filter(
            (statement) =>
              /^\s*select\b/i.test(statement) && !statement.includes('pg_advisory_xact_lock'),
          ),
        ).toHaveLength(connected ? 8 : 6);
        const result = await saved([first, second]);
        expect(result.executions.map((row) => row.runtimeCursor)).toEqual([localSeq, localSeq]);
        if (localSeq === 0) {
          expect(result.words.map((row) => row.attemptId)).toEqual([
            first.attempt_id,
            second.attempt_id,
          ]);
          expect(required(result.words[1]).seq).toBe(required(result.words[0]).seq + 1);
        }
      }
    },
  );

  test('an empty snapshot still ignores a connection activated after admission', async () => {
    const { spaceId, first, second } = await fixture('A new connection');
    await required(handle)
      .db.insert(connection)
      .values({
        id: newId('conn'),
        spaceId,
        provider: 'test',
        label: 'Added after admission',
        status: 'active',
      });
    statements.length = 0;
    await Promise.all([
      required(runner).emit(first, text(first)),
      required(runner).emit(second, text(second)),
    ]);
    expect(statements.some((statement) => statement.includes('from "connection"'))).toBe(false);
    const result = await saved([first, second]);
    expect(result.executions.map((row) => row.runtimeCursor)).toEqual([0, 0]);
    expect(result.words).toHaveLength(2);
  });

  test.each(['principal', 'membership'] as const)(
    'a different claimed %s cannot inherit another queued writer authority',
    async (change) => {
      const { first, second } = await fixture('Independent claim identities');
      const wrong = {
        ...second,
        ...(change === 'principal'
          ? { principal_id: newId('own') }
          : { membership_generation: (second.membership_generation ?? 0) + 1 }),
      };
      const [, error] = await Promise.all([
        required(runner).emit(first, text(first)),
        refusal(required(runner).emit(wrong, text(second))),
      ]);
      expect(error.code).toBe('scope_denied');
      const before = await saved([first, second]);
      expect(before.words.map((row) => row.attemptId)).toEqual([first.attempt_id]);
      expect(before.executions.find((row) => row.id === second.attempt_id)?.runtimeCursor).toBe(-1);
      await required(runner).emit(second, text(second));
      expect((await saved([first, second])).words).toHaveLength(2);
    },
  );

  test.each(['missing', 'another job'] as const)(
    'a runtime load refuses an attempt that belongs to %s',
    async (kind) => {
      const { first, second } = await fixture('An unrelated attempt');
      const wrong = {
        ...first,
        attempt_id: kind === 'missing' ? newId('att') : second.attempt_id,
      };
      const error = await refusal(required(runner).emit(wrong, text(wrong)));
      expect(error.code).toBe('stale_epoch');
      const result = await saved([first, second]);
      expect(result.words).toHaveLength(0);
      expect(result.executions.map((row) => row.runtimeCursor)).toEqual([-1, -1]);
    },
  );

  test.each(['generation', 'revocation'] as const)(
    'a raw connection %s between queued records remains visible',
    async (change) => {
      const { connectionId, first, second } = await fixture('Fresh connection context', true);
      const service = required(jobs);
      const original = service.lockRuntime;
      const entered = Promise.withResolvers<void>();
      const changed = Promise.withResolvers<void>();
      let held = false;
      service.lockRuntime = async (tx, id, attemptId, dedupKeys) => {
        const row = await original.call(service, tx, id, attemptId, dedupKeys);
        if (id === second.job_id && !held) {
          held = true;
          entered.resolve();
          await changed.promise;
        }
        return row;
      };
      const writing = [
        refusal(required(runner).emit(first, text(first))),
        refusal(required(runner).emit(second, text(second))),
      ];
      try {
        await Promise.race([
          entered.promise,
          Promise.all(writing).then(() => {
            throw new Error('Writes ended before the second fence');
          }),
        ]);
        // The invalidation intentionally uses no event-order lock. These paths
        // exist for account/device removal and connection startup failures.
        await required(handle)
          .db.update(connection)
          .set(change === 'generation' ? { generation: 1 } : { status: 'revoked' })
          .where(eq(connection.id, required(connectionId)));
        changed.resolve();
        const errors = await Promise.all(writing);
        expect(errors.map((error) => error.code)).toEqual([
          'context_invalidated',
          'context_invalidated',
        ]);
        const result = await saved([first, second]);
        expect(result.words).toHaveLength(0);
        expect(result.executions.map((row) => row.runtimeCursor)).toEqual([-1, -1]);
      } finally {
        changed.resolve();
        service.lockRuntime = original;
        await Promise.allSettled(writing);
      }
    },
  );

  test("an attempt ended by the job row's holder is read after that holder commits", async () => {
    const { first } = await fixture('Ended under the job row');
    const { sql } = required(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // Holds the job row, not the event order, and ends the attempt alone.
    const ender = sql.begin(async (tx) => {
      await tx`select id from job where id = ${first.job_id} for update`;
      await tx`update attempt set ended_at = now(), lease_status = 'ended',
        lease_expires_at = null, outcome = 'fenced' where id = ${first.attempt_id}`;
      holding();
      await gate;
    });
    await held;
    const writing = required(runner).emit(first, text(first));
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await ender;
    expect((await refusal(writing)).code).toBe('stale_epoch');
    const result = await saved([first]);
    expect(result.words).toHaveLength(0);
    expect(result.executions.map((row) => row.runtimeCursor)).toEqual([-1]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
