import { describe, expect, test } from 'bun:test';
import { claimHistory, correctClaim, listClaims } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { assembleAttemptKnowledge } from '../../src/memory/context.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest, loadEvidence } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import { recall } from '../../src/memory/recall.ts';
import { restoreMemory } from '../../src/memory/restore.ts';
import { runViewWork } from '../../src/memory/views.ts';
import { claimWork } from '../../src/memory/work.ts';
import { fakeProvider, tripProposal } from './fake-provider.ts';
import { killAt } from './fault-fixtures.ts';
import { createJobAttempt, createJournal, snapshotMemory } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';

export function registerTripTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('trip acceptance scenario', () => {
    test('July to August survives sessions, an old import, correction races, process kills, scope, forget, and restore', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      let calls = 0;
      try {
        const statement = {
          stream: 'chat',
          source_identity: 'july-trip',
          source_version: '1',
          source_type: 'message',
          event_at: '2026-06-01T09:00:00Z',
          text: 'our trip is in July',
        };
        const firstSource = await ingest(db.sql, scope, statement);
        const first = await claimWork(db.sql, scope);
        if (!first) throw new Error('missing July extraction');
        const gateway = fakeProvider(() => [tripProposal(first)]);
        let id: string;
        try {
          const proposals = await proposeExtraction(db.sql, scope, first, gateway.gateway);
          const result = await commitExtraction(db.sql, scope, first, { proposals });
          id = result.claim_ids[0] ?? '';
          expect(result.status).toBe('committed');
          expect(id).not.toBe('');
          calls += gateway.requests.length;
        } finally {
          await gateway.close();
        }
        await runViewWork(db.sql, scope);
        const job = await createJobAttempt(db, scope);
        const oldContext = await assembleAttemptKnowledge(
          db.sql,
          scope,
          job.attemptId,
          job.jobId,
          'trip',
        );
        expect(oldContext.knowledge[0]?.excerpt).toContain('July');

        const session = JSON.parse(JSON.stringify(scope)) as MemoryScope;
        const correction = await correctClaim(db.sql, session, {
          claim_id: id,
          expected_revision: 1,
          text: 'move our trip from July to August',
          content: 'August',
          valid_from: '2026-06-10T09:00:00Z',
          idempotency_key: 'move-trip',
        });
        expect(correction.protected).toBe(true);
        const current = await recall(db.sql, session, { query: 'trip', mode: 'current' });
        expect(current.items.map((item) => item.content)).toEqual(['August']);
        const history = await recall(db.sql, session, {
          query: 'trip',
          mode: 'historical',
          at: '2026-06-05T09:00:00Z',
        });
        expect(history.items.map((item) => item.content)).toEqual(['July']);
        expect(history.items[0]?.superseded_at).not.toBeNull();
        expect(history.items[0]?.valid_until).toBe('2026-06-10T09:00:00.000Z');
        const invalidations =
          await db.sql`select type from memory_invalidations where job_id = ${job.jobId}`;
        expect(invalidations.some((event) => event.type === 'dependencies_invalidated')).toBe(true);

        const emailInput = {
          stream: 'email',
          source_identity: 'old-email',
          source_version: 'original',
          source_type: 'document',
          event_at: '2026-05-25T09:00:00Z',
          text: 'see you in July',
        };
        const email = await ingest(db.sql, session, emailInput);
        const imported = await claimWork(db.sql, session);
        if (!imported) throw new Error('missing old email work');
        expect(
          (
            await commitExtraction(db.sql, session, imported, {
              proposals: [tripProposal(imported)],
            })
          ).status,
        ).toBe('committed');
        expect((await listClaims(db.sql, session)).claims[0]?.current.content).toBe('August');
        const dated = await claimHistory(db.sql, session, id);
        expect(
          dated.revisions[0]?.sources.some((ref) => ref.source_id === email.source.source_id),
        ).toBe(true);
        expect(
          dated.revisions[0]?.sources.some((ref) => ref.source_id === firstSource.source.source_id),
        ).toBe(true);

        await ingest(db.sql, session, {
          ...statement,
          source_identity: 'during-inference',
          text: 'make that September',
          event_at: '2026-06-12T09:00:00Z',
        });
        const racing = await claimWork(db.sql, session);
        if (!racing) throw new Error('missing racing work');
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const finish = new Promise<void>((resolve) => {
          release = resolve;
        });
        const slow = fakeProvider(async () => {
          entered();
          await finish;
          return [tripProposal(racing, 'September')];
        });
        try {
          const inference = proposeExtraction(db.sql, session, racing, slow.gateway);
          await started;
          await correctClaim(db.sql, session, {
            claim_id: id,
            expected_revision: 2,
            text: 'August is confirmed; keep August',
            content: 'August',
            valid_from: '2026-06-13T09:00:00Z',
            idempotency_key: 'confirm-august',
          });
          release();
          const rejected = await commitExtraction(db.sql, session, racing, {
            proposals: await inference,
          });
          expect(rejected.status).toBe('retry');
          expect(rejected.reason).toBe('stale_revision');
          calls += slow.requests.length;
        } finally {
          release();
          await slow.close();
        }
        const retried = await claimWork(db.sql, session, { workId: racing.work.id });
        if (!retried) throw new Error('missing fresh extraction');
        expect(retried.claims[0]?.head_revision).toBe(3);
        expect(
          (
            await commitExtraction(db.sql, session, retried, {
              proposals: [tripProposal(retried, 'September')],
            })
          ).status,
        ).toBe('committed');
        const heads =
          await db.sql`select revision from memory_revisions where claim_id = ${id} and status in ('active','disputed')`;
        expect(heads).toHaveLength(1);

        const killedProposal = await killAt(db, session, 'after-proposal');
        const [unconsumed] =
          await db.sql`select consumed_sequence from memory_streams where space_id = ${session.spaceId} and stream = 'faults'`;
        expect(unconsumed?.consumed_sequence).toBe(0);
        await restoreMemory(db.sql, journal.journal);
        await db.sql`update memory_work set lease_until = clock_timestamp() - interval '1 second' where id = ${killedProposal.batch?.work.id ?? ''}`;
        const resumed = await claimWork(db.sql, session, { workId: killedProposal.batch?.work.id });
        if (!resumed) throw new Error('restart lost evidence');
        expect(resumed.work.fence).toBe((killedProposal.batch?.work.fence ?? 0) + 1);
        expect(
          (await commitExtraction(db.sql, session, resumed, { proposals: [tripProposal(resumed)] }))
            .status,
        ).toBe('committed');
        const killedIndex = await killAt(db, session, 'after-publication');
        expect(killedIndex.result?.status).toBe('committed');
        await restoreMemory(db.sql, journal.journal);
        expect((await recall(db.sql, session, { query: 'trip' })).status).toBe('degraded');
        expect((await loadEvidence(db.sql, session, firstSource.source.source_id))?.text).toBe(
          statement.text,
        );
        await runViewWork(db.sql, session);
        const caughtUp = await recall(db.sql, session, { query: 'trip' });
        expect(caughtUp.status).toBe('complete');
        expect(caughtUp.items.map((item) => item.content)).toEqual(['August']);

        const secondSpace = await createScope(db);
        const isolated = await recall(db.sql, secondSpace, { query: 'trip' });
        expect(isolated.status).toBe('complete');
        expect(isolated.items).toHaveLength(0);
        const empty = await recall(db.sql, session, { query: 'nebula-unique-query' });
        expect(empty.status).toBe('complete');
        expect(empty.items).toHaveLength(0);
        const unavailable = await recall(
          db.sql,
          session,
          { query: 'trip' },
          {
            lexical: async () => {
              throw new Error('scripted index failure');
            },
          },
        );
        expect(unavailable.status).toBe('unavailable');
        expect(unavailable.coverage.reason).toBe('index_failure');

        const restoreSnapshot = await snapshotMemory(db);
        await forgetMemory(db.sql, session, { claim_id: id }, journal.journal);
        expect((await recall(db.sql, session, { query: 'trip' })).items).toHaveLength(0);
        expect((await ingest(db.sql, session, emailInput)).source.state).toBe('suppressed');
        await ingest(db.sql, session, {
          ...statement,
          source_identity: 'fresh-explicit',
          text: 'our next trip is in October',
          event_at: '2026-09-10T09:00:00Z',
        });
        const fresh = await claimWork(db.sql, session);
        if (!fresh) throw new Error('fresh instruction was blocked');
        expect(
          (
            await commitExtraction(db.sql, session, fresh, {
              proposals: [tripProposal(fresh, 'October')],
            })
          ).status,
        ).toBe('committed');
        expect(
          (await recall(db.sql, session, { query: 'trip' })).items.map((item) => item.content),
        ).toEqual(['October']);
        await restoreSnapshot();
        expect((await recall(db.sql, session, { query: 'trip' })).coverage.reason).toBe(
          'restore_pending',
        );
        await restoreMemory(db.sql, journal.journal);
        expect((await recall(db.sql, session, { query: 'trip' })).items).toHaveLength(0);
        expect((await ingest(db.sql, session, emailInput)).source.state).toBe('suppressed');
        process.stdout.write(
          `trip acceptance: current August, dated July, 2 process kills, stale proposal rejected, no cross-space delivery, suppression replayed; parent scripted calls=${calls}\n`,
        );
      } finally {
        await journal.close();
      }
    }, 60000);
  });
}
