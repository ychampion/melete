import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { type ContextRecord, recallResult } from '@melete/contracts';
import { correctClaim, listClaims } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { assembleAttemptKnowledge, assertContextCurrent } from '../../src/memory/context.ts';
import { type MemoryScope, newId } from '../../src/memory/db.ts';
import { ingest, loadEvidence } from '../../src/memory/evidence.ts';
import {
  cleanupMemory,
  deleteMemorySource,
  forgetMemory,
  revokeMemorySource,
  revokeMemorySpace,
} from '../../src/memory/forget.ts';
import { registerMemoryAttempt } from '../../src/memory/invalidate.ts';
import { recall } from '../../src/memory/recall.ts';
import { restoreMemory } from '../../src/memory/restore.ts';
import { buildViews } from '../../src/memory/views.ts';
import { claimWork } from '../../src/memory/work.ts';
import { tripProposal } from './fake-provider.ts';
import { createJobAttempt, createJournal, snapshotMemory } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';

const input = (identity = 'seed', text = 'our trip is in July') => ({
  stream: 'chat',
  source_identity: identity,
  source_version: '1',
  source_type: 'message',
  event_at: '2026-07-01T00:00:00Z',
  text,
});
async function seed(db: TestDatabase, scope: MemoryScope, identity = 'seed') {
  const evidence = await ingest(db.sql, scope, input(identity));
  const batch = await claimWork(db.sql, scope);
  if (!batch) throw new Error('missing seed work');
  const result = await commitExtraction(db.sql, scope, batch, { proposals: [tripProposal(batch)] });
  const claimId = result.claim_ids[0];
  if (!claimId) throw new Error(`seed failed: ${result.reason}`);
  await buildViews(db.sql, scope);
  return { claimId, sourceId: evidence.source.source_id };
}
export function registerLifecycleTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('memory lifecycle', () => {
    test('correction fences dependent attempts, clears drafts, and preserves action receipts', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const { claimId } = await seed(db, scope);
      const { jobId, attemptId } = await createJobAttempt(db, scope);
      const bundle = await assembleAttemptKnowledge(db.sql, scope, attemptId, jobId, 'trip');
      expect(bundle.knowledge[0]?.excerpt).toContain('July');
      expect((await assertContextCurrent(db.sql, scope, attemptId)).id).toBe(bundle.context.id);
      await db.sql`insert into memory_prepared (id, space_id, job_id, kind, items, content, data_revision) values ('draft-' || ${jobId}, ${scope.spaceId}, ${jobId}, 'draft',
        ${JSON.stringify(bundle.context.items)}::text::jsonb, 'July draft', ${bundle.context.data_revision})`;
      const connectionId = newId('conn');
      const actionId = newId('act');
      const approvalId = newId('apr');
      await db.sql`insert into connection (id, space_id, provider, label) values (${connectionId}, ${scope.spaceId}, 'test', 'test')`;
      await db.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class, canonical_payload, payload_hash, status, idempotency_key, receipt)
        values (${actionId}, ${jobId}, ${attemptId}, ${connectionId}, 'test.book', 'write_external', '{}'::jsonb, ${'a'.repeat(64)}, 'succeeded', ${actionId}, '{"external_ref":"recorded-booking"}'::jsonb)`;
      await db.sql`insert into approval (id, action_id, job_revision, payload_hash, decision) values (${approvalId}, ${actionId}, 1, ${'a'.repeat(64)}, 'approved')`;
      const controller = new AbortController();
      let delivered = bundle.knowledge;
      const unregister = registerMemoryAttempt(attemptId, controller, () => {
        delivered = [];
      });
      try {
        await correctClaim(db.sql, scope, {
          claim_id: claimId,
          expected_revision: 1,
          content: 'August',
          text: 'move our trip from July to August',
          valid_from: '2026-08-01T00:00:00Z',
          idempotency_key: 'context-correction',
        });
        expect(controller.signal.aborted).toBe(true);
        expect(delivered).toHaveLength(0);
      } finally {
        unregister();
      }
      expect(
        await assertContextCurrent(db.sql, scope, attemptId).catch((error: Error) => error.message),
      ).toBe('context_invalidated');
      const [context] =
        await db.sql`select invalidated_at from memory_contexts where attempt_id = ${attemptId}`;
      expect(context?.invalidated_at).not.toBeNull();
      const [draft] =
        await db.sql`select stale, content from memory_prepared where job_id = ${jobId}`;
      expect(draft?.stale).toBe(true);
      expect(draft?.content).toBeNull();
      const [binding] =
        await db.sql`select j.revision, j.lease_epoch, apr.job_revision = j.revision as matches from job j join action a on a.job_id = j.id join approval apr on apr.action_id = a.id where j.id = ${jobId}`;
      expect(binding?.revision).toBe(2);
      expect(binding?.lease_epoch).toBe(2);
      expect(binding?.matches).toBe(false);
      const [receipt] = await db.sql`select status, receipt from action where id = ${actionId}`;
      expect(receipt?.status).toBe('succeeded');
      expect(receipt?.receipt.external_ref).toBe('recorded-booking');
      const events =
        await db.sql`select type from memory_invalidations where job_id = ${jobId} order by type`;
      expect(events.map((event) => event.type)).toEqual([
        'context_invalidated',
        'dependencies_invalidated',
      ]);
    });
    test('approved shared context and public compartments are assembled before delivery', async () => {
      if (!db) return;
      const scope = await createScope(db);
      await seed(db, scope, 'private');
      const shared = { ...scope, audience: 'space' as const };
      await ingest(db.sql, shared, input('shared', 'shared trip in August'));
      const batch = await claimWork(db.sql, shared);
      if (!batch) throw new Error('missing shared work');
      await commitExtraction(db.sql, shared, batch, { proposals: [tripProposal(batch, 'August')] });
      await buildViews(db.sql, scope);
      const companion = { ...scope, role: 'reader' as const };
      const job = await createJobAttempt(db, scope);
      const result = await assembleAttemptKnowledge(
        db.sql,
        companion,
        job.attemptId,
        job.jobId,
        'trip',
      );
      expect(result.knowledge).toHaveLength(1);
      expect(result.knowledge[0]?.excerpt).toContain('August');
      expect(JSON.stringify(result.knowledge)).not.toContain('July');
      expect(result.context.audience).toEqual(['space', 'public']);
      const publicJob = await createJobAttempt(db, scope, true);
      const publicBundle = await assembleAttemptKnowledge(
        db.sql,
        scope,
        publicJob.attemptId,
        publicJob.jobId,
        'trip',
      );
      expect(publicBundle.knowledge).toHaveLength(0);
      expect(publicBundle.context.items).toHaveLength(0);
      expect(publicBundle.recall.coverage.reason).toBe('public_compartment');
      const [stored] = await db.sql`select constraints from job where id = ${publicJob.jobId}`;
      expect(stored?.constraints.notes).toBe('Do not book without a new approval.');
    });
    test('forget suppresses old replay, allows fresh explicit evidence, and survives an old database snapshot', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      try {
        const original = await seed(db, scope);
        const restoreSnapshot = await snapshotMemory(db);
        const operation = await forgetMemory(
          db.sql,
          scope,
          { claim_id: original.claimId },
          journal.journal,
        );
        expect(operation.cleanup).toBe('pending');
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
        expect((await ingest(db.sql, scope, input())).source.state).toBe('suppressed');
        expect(
          (await ingest(db.sql, scope, { ...input(), source_version: 'old-replay-copy' })).source
            .state,
        ).toBe('suppressed');
        expect(await loadEvidence(db.sql, scope, original.sourceId)).toBeNull();
        await ingest(db.sql, scope, {
          ...input('fresh', 'our trip is in September'),
          event_at: '2026-09-01T00:00:00Z',
        });
        const fresh = await claimWork(db.sql, scope);
        if (!fresh) throw new Error('missing fresh work');
        expect(
          (
            await commitExtraction(db.sql, scope, fresh, {
              proposals: [tripProposal(fresh, 'September')],
            })
          ).status,
        ).toBe('committed');
        expect((await listClaims(db.sql, scope)).claims[0]?.id).not.toBe(original.claimId);
        expect((await recall(db.sql, scope, { query: 'trip' })).items[0]?.content).toBe(
          'September',
        );
        await restoreSnapshot();
        expect((await recall(db.sql, scope, { query: 'trip' })).coverage.reason).toBe(
          'restore_pending',
        );
        expect(await claimWork(db.sql, scope).catch((error: Error) => error.message)).toBe(
          'restore_pending',
        );
        expect(await restoreMemory(db.sql, journal.journal)).toBe(1);
        await buildViews(db.sql, scope);
        const restored = await recall(db.sql, scope, { query: 'trip' });
        expect(restored.status).toBe('complete');
        expect(restored.items).toHaveLength(0);
        expect((await ingest(db.sql, scope, input())).source.state).toBe('suppressed');
        const journalText = await readFile(journal.journal.path, 'utf8');
        expect(journalText).not.toContain('July');
        expect(journalText).not.toContain('September');
      } finally {
        await journal.close();
      }
    });
    test('deletion hides synchronously, cleanup failures retry, and startup refuses a missing journal', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      try {
        const original = await seed(db, scope);
        await deleteMemorySource(db.sql, scope, original.sourceId, journal.journal);
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
        const failed = await cleanupMemory(db.sql, scope.spaceId, async () => {
          throw new Error('interrupted cleanup');
        }).catch((error: Error) => error.message);
        expect(failed).toBe('interrupted cleanup');
        const [pending] =
          await db.sql`select failures, completed_at from memory_outbox where space_id = ${scope.spaceId} and kind = 'cleanup'`;
        expect(pending?.failures).toBe(1);
        expect(pending?.completed_at).toBeNull();
        expect(await cleanupMemory(db.sql, scope.spaceId)).toBe(1);
        expect(
          await db.sql`select * from memory_source_content where source_id = ${original.sourceId}`,
        ).toHaveLength(0);
        expect(
          await db.sql`select * from memory_revision_content where claim_id = ${original.claimId}`,
        ).toHaveLength(0);
        const failedStart = await restoreMemory(db.sql, {
          async read() {
            throw new Error('journal unavailable');
          },
          async append() {},
        }).catch((error: Error) => error.message);
        expect(failedStart).toBe('journal unavailable');
        expect((await recall(db.sql, scope, { query: 'trip' })).coverage.reason).toBe(
          'restore_pending',
        );
        await restoreMemory(db.sql, journal.journal);
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
      } finally {
        await journal.close();
      }
    });
    test('source and space revocation invalidate delivered context and block stale serving', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      try {
        const original = await seed(db, scope);
        const job = await createJobAttempt(db, scope);
        await assembleAttemptKnowledge(db.sql, scope, job.attemptId, job.jobId, 'trip');
        await revokeMemorySource(db.sql, scope, original.sourceId, journal.journal);
        expect(
          await assertContextCurrent(db.sql, scope, job.attemptId).catch(
            (error: Error) => error.message,
          ),
        ).toBe('context_invalidated');
        expect(
          recallResult.parse(await recall(db.sql, scope, { query: 'trip' })).items,
        ).toHaveLength(0);
        await revokeMemorySpace(db.sql, scope, journal.journal);
        expect(
          await recall(db.sql, scope, { query: 'trip' }).catch((error: Error) => error.message),
        ).toBe('scope_denied');
        await restoreMemory(db.sql, journal.journal);
        expect(
          await ingest(db.sql, scope, input('after-revoke')).catch((error: Error) => error.message),
        ).toBe('scope_denied');
        const [context] =
          await db.sql`select items, invalidated_at from memory_contexts where attempt_id = ${job.attemptId}`;
        expect(((context?.items ?? []) as ContextRecord['items'])[0]?.claim_id).toBe(
          original.claimId,
        );
        expect(context?.invalidated_at).not.toBeNull();
      } finally {
        await journal.close();
      }
    });
  });
}
