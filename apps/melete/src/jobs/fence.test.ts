import { describe, expect, mock, test } from 'bun:test';
import type { CapabilityClaims } from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import { attempt, connection, job, space, spaceMembership } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { FenceReads, requireCurrentAttemptFrom } from './fence.ts';

const instant = new Date('2026-10-24T04:00:00.000Z');
const claims = {
  job_id: 'job_test',
  attempt_id: 'att_test',
  space_id: 'sp_test',
  principal_id: 'own_test',
  membership_generation: 0,
  epoch: 1,
  revision: 2,
} as CapabilityClaims;

function fixture(kind = 'personal') {
  const row = {
    id: claims.job_id,
    spaceId: claims.space_id,
    principalId: claims.principal_id,
    state: 'running',
    leaseEpoch: claims.epoch,
    revision: claims.revision,
  } as typeof job.$inferSelect;
  const execution = {
    id: claims.attempt_id,
    jobId: claims.job_id,
    epoch: claims.epoch,
    revision: claims.revision,
    endedAt: null,
    leaseExpiresAt: new Date(instant.getTime() + 60_000),
    leaseStatus: 'active',
    principalId: claims.principal_id,
    membershipGeneration: 0,
    policyGeneration: 3,
    connectionGenerations: { cnn_test: 4 },
  } as unknown as typeof attempt.$inferSelect;
  const parent = {
    id: claims.space_id,
    kind,
    ownerPrincipalId: claims.principal_id as string | null,
    removedAt: null,
    policyGeneration: 3,
  };
  const membership = { role: 'member', generation: 0 };
  const connections = [{ id: 'cnn_test', generation: 4 }];
  const execute = mock(async () => [{ now: instant }]);
  const select = mock(() => ({
    from(table: unknown) {
      // The caller already read these rows after locking the job. A second
      // read would add a loop round trip while every event writer waits.
      if (table === job || table === attempt) throw new Error('Repeated locked row read');
      const result = Promise.resolve(
        table === space
          ? [{ parent, ownerId: parent.ownerPrincipalId }]
          : table === spaceMembership
            ? [membership]
            : connections,
      );
      if (table !== space && table !== spaceMembership && table !== connection)
        throw new Error('Unexpected authority table');
      return Object.assign(result, {
        where: () => result,
        for: () => result,
      });
    },
  }));
  const tx = { execute, select } as unknown as Transaction;
  const records = { job: row, attempt: execution };
  return { tx, records, parent, membership, connections, select, execute };
}

async function denied(operation: Promise<unknown>, code: string) {
  const error = await operation.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

describe('attempt fence from locked records', () => {
  test('reuses the job and attempt while still checking authority and generations', async () => {
    const { tx, records, select, execute } = fixture();
    expect(await requireCurrentAttemptFrom(tx, claims, records)).toEqual(records);
    // The locked authority row also supplies policy; connections are still read.
    expect(select).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('runtime records reuse locked authority but read nonempty connection snapshots each time', async () => {
    const { tx, records, select, execute } = fixture();
    const reads = new FenceReads(tx);
    await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
    await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
    expect(select).toHaveBeenCalledTimes(3); // One authority read, two connection reads.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('an empty saved connection set ignores added active connections without reading them', async () => {
    const { tx, records, connections, select } = fixture();
    records.attempt.connectionGenerations = {};
    const reads = new FenceReads(tx);
    await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
    connections.push({ id: 'cnn_added', generation: 8 });
    expect(await requireCurrentAttemptFrom(tx, claims, records, {}, reads)).toEqual(records);
    expect(select).toHaveBeenCalledTimes(1);
  });

  test.each(['policy', 'schema'] as const)(
    'an empty connection set still checks each expected %s with reused authority',
    async (change) => {
      const { tx, records, select } = fixture();
      records.attempt.connectionGenerations = {};
      const reads = new FenceReads(tx);
      await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
      if (change === 'policy') records.attempt.policyGeneration++;
      else records.attempt.connectionGenerations = { cnn_invalid: -1 };
      await denied(
        requireCurrentAttemptFrom(tx, claims, records, {}, reads),
        'context_invalidated',
      );
      expect(select).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['changed', 'removed'] as const)(
    'a nonempty connection set sees a %s connection in the next runtime record',
    async (change) => {
      const { tx, records, connections, select } = fixture();
      const reads = new FenceReads(tx);
      await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
      if (change === 'changed') required(connections[0]).generation++;
      else connections.splice(0);
      await denied(
        requireCurrentAttemptFrom(tx, claims, records, {}, reads),
        'context_invalidated',
      );
      expect(select).toHaveBeenCalledTimes(3);
    },
  );

  test.each(['principal', 'membership'] as const)(
    'different claimed %s cannot reuse another authority identity',
    async (change) => {
      const { tx, records, select } = fixture('shared');
      records.attempt.connectionGenerations = {};
      const reads = new FenceReads(tx);
      await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
      const other = {
        ...claims,
        ...(change === 'principal'
          ? { principal_id: 'own_other' }
          : { membership_generation: (claims.membership_generation ?? 0) + 1 }),
      };
      await denied(requireCurrentAttemptFrom(tx, other, records, {}, reads), 'scope_denied');
      // Each identity checked the space and its actual membership again.
      expect(select).toHaveBeenCalledTimes(4);
      expect(await requireCurrentAttemptFrom(tx, claims, records, {}, reads)).toEqual(records);
      expect(select).toHaveBeenCalledTimes(4);
    },
  );

  test('records recheck their lease and revision even after authority was reused', async () => {
    const { tx, records } = fixture();
    records.attempt.connectionGenerations = {};
    const reads = new FenceReads(tx);
    await requireCurrentAttemptFrom(tx, claims, records, {}, reads);
    records.attempt.leaseStatus = 'lost';
    await denied(requireCurrentAttemptFrom(tx, claims, records, {}, reads), 'stale_epoch');
    records.attempt.leaseStatus = 'active';
    records.job.revision++;
    await denied(requireCurrentAttemptFrom(tx, claims, records, {}, reads), 'revision_mismatch');
  });

  test('a null installation-owner fallback is not reused before setup', async () => {
    const { tx, records, parent, select } = fixture();
    parent.ownerPrincipalId = null;
    records.job.principalId = null;
    records.attempt.principalId = null;
    records.attempt.connectionGenerations = {};
    const { principal_id: _principal, membership_generation: _generation, ...legacy } = claims;
    const reads = new FenceReads(tx);
    await requireCurrentAttemptFrom(tx, legacy, records, {}, reads);
    await requireCurrentAttemptFrom(tx, legacy, records, {}, reads);
    expect(select).toHaveBeenCalledTimes(2);
  });

  test('authority reads cannot cross a transaction boundary', async () => {
    const first = fixture();
    const second = fixture();
    const reads = new FenceReads(first.tx);
    await requireCurrentAttemptFrom(first.tx, claims, first.records, {}, reads);
    let caught: unknown;
    try {
      await requireCurrentAttemptFrom(second.tx, claims, second.records, {}, reads);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('another transaction');
    expect(second.select).not.toHaveBeenCalled();
  });

  test.each(['job', 'space', 'epoch', 'state'] as const)(
    'refuses a stale job %s before any further lookup',
    async (change) => {
      const { tx, records, select, execute } = fixture();
      if (change === 'job') records.job.id = 'job_other';
      if (change === 'space') records.job.spaceId = 'sp_other';
      if (change === 'epoch') records.job.leaseEpoch++;
      if (change === 'state') records.job.state = 'completed';
      await denied(requireCurrentAttemptFrom(tx, claims, records), 'stale_epoch');
      expect(select).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test.each(['id', 'job', 'epoch', 'ended', 'expired', 'lost'] as const)(
    'refuses an attempt whose %s no longer matches',
    async (change) => {
      const { tx, records } = fixture();
      if (change === 'id') records.attempt.id = 'att_other';
      if (change === 'job') records.attempt.jobId = 'job_other';
      if (change === 'epoch') records.attempt.epoch++;
      if (change === 'ended') records.attempt.endedAt = instant;
      if (change === 'expired') records.attempt.leaseExpiresAt = instant;
      if (change === 'lost') records.attempt.leaseStatus = 'lost';
      await denied(requireCurrentAttemptFrom(tx, claims, records), 'stale_epoch');
    },
  );

  test.each(['job', 'attempt'] as const)('refuses a changed %s revision', async (change) => {
    const { tx, records } = fixture();
    records[change].revision++;
    await denied(requireCurrentAttemptFrom(tx, claims, records), 'revision_mismatch');
  });

  test.each(['principal', 'membership', 'policy', 'connection'] as const)(
    'retains the %s authority fence',
    async (change) => {
      const { tx, records, parent, connections } = fixture();
      if (change === 'principal') records.attempt.principalId = 'own_other';
      if (change === 'membership')
        records.attempt.membershipGeneration = (records.attempt.membershipGeneration ?? 0) + 1;
      if (change === 'policy') parent.policyGeneration++;
      if (change === 'connection') {
        const connected = connections[0];
        if (connected) connected.generation++;
      }
      await denied(
        requireCurrentAttemptFrom(tx, claims, records),
        change === 'principal' || change === 'membership' ? 'scope_denied' : 'context_invalidated',
      );
    },
  );

  test('only settlement can drain an approval wait with the same current lease', async () => {
    const { tx, records } = fixture();
    records.job.state = 'waiting_for_approval';
    await denied(requireCurrentAttemptFrom(tx, claims, records), 'stale_epoch');
    expect(await requireCurrentAttemptFrom(tx, claims, records, { settling: true })).toEqual(
      records,
    );
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a test connection');
  return value;
}
