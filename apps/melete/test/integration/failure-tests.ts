import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { attemptBundle, type RuntimeAdapter } from '@melete/contracts';
import { claimHistory, correctClaim, listClaims } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import {
  assembleAttemptKnowledge,
  assertContextCurrent,
  withMemoryRuntime,
} from '../../src/memory/context.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest, loadEvidence } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { cleanupMemory, deleteMemorySource, forgetMemory } from '../../src/memory/forget.ts';
import { recall } from '../../src/memory/recall.ts';
import { restoreMemory } from '../../src/memory/restore.ts';
import { buildViews, runViewWork } from '../../src/memory/views.ts';
import { claimWork, EXTRACTION_LIMITS, repairQueue } from '../../src/memory/work.ts';
import { fakeProvider, tripProposal } from './fake-provider.ts';
import { type FaultPhase, killAt } from './fault-fixtures.ts';
import { createJobAttempt, createJournal, snapshotMemory } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';

const input = (
  identity = 'seed',
  text = 'our trip is in July',
  eventAt = '2026-06-01T00:00:00Z',
) => ({
  stream: 'failure-tests',
  source_identity: identity,
  source_version: '1',
  source_type: 'message',
  event_at: eventAt,
  text,
});
async function seed(db: TestDatabase, scope: MemoryScope) {
  const source = await ingest(db.sql, scope, input());
  const batch = await claimWork(db.sql, scope);
  if (!batch) throw new Error('missing seed');
  const committed = await commitExtraction(db.sql, scope, batch, {
    proposals: [tripProposal(batch)],
  });
  const id = committed.claim_ids[0];
  if (!id) throw new Error('seed failed');
  return { id, sourceId: source.source.source_id };
}
export function registerFailureTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('memory failure schedules', () => {
    for (const phase of [
      'after-input',
      'after-claim',
      'after-proposal',
      'before-publication',
      'after-publication',
    ] as FaultPhase[]) {
      test(`process killed ${phase}: committed cursors recover and obsolete fences cannot publish`, async () => {
        if (!db) return;
        const scope = await createScope(db);
        const journal = await createJournal();
        try {
          const checkpoint = await killAt(db, scope, phase);
          await restoreMemory(db.sql, journal.journal);
          const [source] =
            await db.sql`select id from memory_sources where space_id = ${scope.spaceId}`;
          expect(source).toBeDefined();
          expect((await loadEvidence(db.sql, scope, source?.id))?.text).toBe('our trip is in July');
          const [cursor] =
            await db.sql`select consumed_sequence, committed_sequence from memory_streams where space_id = ${scope.spaceId}`;
          expect(cursor?.committed_sequence).toBe(1);
          expect(cursor?.consumed_sequence).toBe(phase === 'after-publication' ? 1 : 0);
          expect((await listClaims(db.sql, scope)).claims).toHaveLength(
            phase === 'after-publication' ? 1 : 0,
          );
          if (phase !== 'after-publication') {
            await db.sql`update memory_work set lease_until = clock_timestamp() - interval '1 second' where space_id = ${scope.spaceId} and status = 'leased'`;
            await repairQueue(db.sql, db.boss);
            const [work] =
              await db.sql`select id from memory_work where space_id = ${scope.spaceId}`;
            const jobs =
              await db.sql`select id from pgboss.job where data->>'work_id' = ${work?.id}`;
            expect(jobs.length).toBeGreaterThan(0);
            const replacement = await claimWork(db.sql, scope);
            if (!replacement) throw new Error('replacement missing');
            if (checkpoint.batch) {
              expect(replacement.work.fence).toBe(checkpoint.batch.work.fence + 1);
              const obsolete = await commitExtraction(db.sql, scope, checkpoint.batch, {
                proposals: checkpoint.proposals ?? [tripProposal(checkpoint.batch)],
              });
              expect(obsolete.status).toBe('retry');
              expect(obsolete.reason).toBe('stale_lease');
              const [leased] =
                await db.sql`select status, fence from memory_work where id = ${replacement.work.id}`;
              expect(leased?.status).toBe('leased');
              expect(leased?.fence).toBe(replacement.work.fence);
            }
            const published = await commitExtraction(db.sql, scope, replacement, {
              proposals: [tripProposal(replacement)],
            });
            expect(published.status).toBe('committed');
            expect(
              (
                await commitExtraction(db.sql, scope, replacement, {
                  proposals: [tripProposal(replacement)],
                })
              ).status,
            ).toBe('duplicate');
          }
          const lag = await recall(db.sql, scope, { query: 'trip' });
          expect(lag.status).toBe('degraded');
          expect(lag.items[0]?.content).toBe('July');
          expect(await runViewWork(db.sql, scope)).toBe(true);
          expect(await runViewWork(db.sql, scope)).toBe(false);
          expect((await recall(db.sql, scope, { query: 'trip' })).status).toBe('complete');
          const heads =
            await db.sql`select r.revision from memory_revisions r join memory_claims c on c.id = r.claim_id where c.space_id = ${scope.spaceId} and r.status = 'active'`;
          expect(heads).toHaveLength(1);
        } finally {
          await journal.close();
        }
      }, 20000);
    }
    test('duplicate delivery and reversed extraction order preserve contiguous cursors and event-time meaning', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const old = await ingest(db.sql, scope, input('old'));
      const later = await ingest(
        db.sql,
        scope,
        input('new', 'our trip is in August', '2026-06-10T00:00:00Z'),
      );
      expect((await ingest(db.sql, scope, input('old'))).duplicate).toBe(true);
      const [secondWork] =
        await db.sql`select id from memory_work where source_id = ${later.source.source_id}`;
      const second = await claimWork(db.sql, scope, { workId: secondWork?.id });
      if (!second) throw new Error('missing second');
      expect(
        (
          await commitExtraction(db.sql, scope, second, {
            proposals: [tripProposal(second, 'August')],
          })
        ).status,
      ).toBe('committed');
      const [gap] =
        await db.sql`select consumed_sequence from memory_streams where space_id = ${scope.spaceId}`;
      expect(gap?.consumed_sequence).toBe(0);
      const first = await claimWork(db.sql, scope);
      if (!first) throw new Error('missing first');
      expect(first.source.source_id).toBe(old.source.source_id);
      const historical = await commitExtraction(db.sql, scope, first, {
        proposals: [tripProposal(first)],
      });
      expect(historical.status).toBe('committed');
      expect((await listClaims(db.sql, scope)).claims[0]?.current.content).toBe('August');
      const history = await claimHistory(db.sql, scope, historical.claim_ids[0] ?? '');
      expect(history.revisions.some((r) => r.content === 'July' && r.status === 'historical')).toBe(
        true,
      );
      const [cursor] =
        await db.sql`select consumed_sequence, committed_sequence from memory_streams where space_id = ${scope.spaceId}`;
      expect(cursor?.consumed_sequence).toBe(2);
      expect(cursor?.committed_sequence).toBe(2);
    });
    test('kill during cleanup and restore from a pre-deletion backup never reopen serving', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      try {
        const original = await seed(db, scope);
        await buildViews(db.sql, scope);
        const restoreSnapshot = await snapshotMemory(db);
        await deleteMemorySource(db.sql, scope, original.sourceId, journal.journal);
        const log = await readFile(journal.journal.path, 'utf8');
        expect(log).not.toContain('our trip is in July');
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
        await killAt(db, scope, 'during-cleanup');
        const [cleanup] =
          await db.sql`select completed_at from memory_outbox where space_id = ${scope.spaceId} and kind = 'cleanup'`;
        expect(cleanup?.completed_at).toBeNull();
        await restoreMemory(db.sql, journal.journal);
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
        expect(await cleanupMemory(db.sql, scope.spaceId)).toBe(1);
        expect(await loadEvidence(db.sql, scope, original.sourceId)).toBeNull();
        await restoreSnapshot();
        expect((await recall(db.sql, scope, { query: 'trip' })).coverage.reason).toBe(
          'restore_pending',
        );
        await restoreMemory(db.sql, journal.journal);
        expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
        expect(await claimWork(db.sql, scope)).toBeNull();
        expect((await ingest(db.sql, scope, input())).source.state).toBe('deleted');
        expect(
          (await ingest(db.sql, scope, { ...input(), source_version: 'replayed-version' })).source
            .state,
        ).toBe('suppressed');
      } finally {
        await journal.close();
      }
    }, 20000);
    test('extraction calls and source segments are bounded before inference', async () => {
      if (!db) return;
      const scope = await createScope(db);
      await ingest(db.sql, scope, input('large', 'x'.repeat(17000)));
      const batch = await claimWork(db.sql, scope);
      if (!batch) throw new Error('missing bounded work');
      expect(batch.text.length).toBe(EXTRACTION_LIMITS.source_characters);
      expect(batch.work.continuation).toBe(EXTRACTION_LIMITS.source_characters);
      const provider = fakeProvider(() => []);
      try {
        for (let i = 0; i < EXTRACTION_LIMITS.calls; i++)
          await proposeExtraction(db.sql, scope, batch, provider.gateway);
        expect(
          await proposeExtraction(db.sql, scope, batch, provider.gateway).catch(
            (error: Error) => error.message,
          ),
        ).toBe('extraction_budget');
        expect(provider.requests).toHaveLength(EXTRACTION_LIMITS.calls);
        const [work] =
          await db.sql`select calls, reserved_usd from memory_work where id = ${batch.work.id}`;
        expect(work?.calls).toBe(EXTRACTION_LIMITS.calls);
        expect(Number(work?.reserved_usd)).toBeCloseTo(EXTRACTION_LIMITS.usd);
      } finally {
        await provider.close();
      }
    });
    test('Unicode spans and partial suppression retain only independently supported text', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      try {
        const text = '🧭 Trip July. Food vegan.';
        const source = await ingest(db.sql, scope, input('unicode', text));
        const batch = await claimWork(db.sql, scope);
        if (!batch) throw new Error('missing Unicode source');
        const tripEnd = text.indexOf(' Food');
        const foodStart = text.indexOf('Food');
        const base = {
          expected_revision: null,
          op: 'add',
          factual_status: 'attributed',
          valid_from: batch.source.event_at,
          valid_until: null,
        };
        const result = await commitExtraction(db.sql, scope, batch, {
          proposals: [
            {
              ...base,
              domain_key: 'trip.month',
              content: 'July',
              kind: 'user_statement',
              sources: [
                {
                  source_id: source.source.source_id,
                  source_version: '1',
                  start: 0,
                  end: tripEnd,
                  quote: text.slice(0, tripEnd),
                },
              ],
            },
            {
              ...base,
              domain_key: 'food.preference',
              content: 'vegan',
              kind: 'preference',
              sources: [
                {
                  source_id: source.source.source_id,
                  source_version: '1',
                  start: foodStart,
                  end: text.length,
                  quote: text.slice(foodStart),
                },
              ],
            },
          ],
        });
        expect(result.status).toBe('committed');
        const heads = (await listClaims(db.sql, scope)).claims;
        const trip = heads.find((claim) => claim.domain_key === 'trip.month');
        if (!trip) throw new Error('missing trip span');
        await buildViews(db.sql, scope);
        expect((await recall(db.sql, scope, { query: 'trip' })).items[0]?.excerpts).toEqual([
          '🧭 Trip July.',
        ]);
        await forgetMemory(db.sql, scope, { claim_id: trip.id }, journal.journal);
        const masked = await loadEvidence(db.sql, scope, source.source.source_id);
        expect(masked?.text.length).toBe(text.length);
        expect(masked?.text).not.toContain('July');
        expect(masked?.text.slice(foodStart)).toBe('Food vegan.');
        const remaining = await recall(db.sql, scope, { query: 'vegan' });
        expect(remaining.items.map((item) => item.content)).toEqual(['vegan']);
        expect(remaining.items[0]?.excerpts).toEqual(['Food vegan.']);
      } finally {
        await journal.close();
      }
    });
    test('failed index publication keeps its old manifest and retries after a correction', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const seeded = await seed(db, scope);
      const before = await buildViews(db.sql, scope);
      const failed = await buildViews(db.sql, scope, {
        model: 'scripted-vector',
        version: '1',
        dimensions: 2,
        recipe: 'test-v1',
        async embed(texts) {
          await correctClaim(db.sql, scope, {
            claim_id: seeded.id,
            expected_revision: 1,
            content: 'August',
            text: 'move to August',
            valid_from: '2026-06-10T00:00:00Z',
            idempotency_key: 'during-index',
          });
          return texts.map(() => [1, 0]);
        },
      }).catch((error: Error) => error.message);
      expect(failed).toBe('stale_index_build');
      const [manifest] =
        await db.sql`select generation from memory_index_manifest where space_id = ${scope.spaceId}`;
      expect(manifest?.generation).toBe(before.generation);
      const lag = await recall(db.sql, scope, { query: 'trip' });
      expect(lag.status).toBe('degraded');
      expect(lag.items[0]?.content).toBe('August');
      await runViewWork(db.sql, scope);
      expect((await recall(db.sql, scope, { query: 'trip' })).status).toBe('complete');
    });
    test('database timeout is unavailable and a successful empty search is complete', async () => {
      if (!db) return;
      const scope = await createScope(db);
      await seed(db, scope);
      await buildViews(db.sql, scope);
      const timed = await recall(
        db.sql,
        scope,
        { query: 'trip' },
        {
          deadlineMs: 20,
          lexical: async (tx) => {
            await tx`select pg_sleep(0.1)`;
            return [];
          },
        },
      );
      expect(timed.status).toBe('unavailable');
      expect(timed.coverage.reason).toBe('timeout');
      const empty = await recall(db.sql, scope, { query: 'missingword' });
      expect(empty.status).toBe('complete');
      expect(empty.items).toHaveLength(0);
    });
    test('runtime adapter discards delivered context and rejects events after an owner correction', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const { id } = await seed(db, scope);
      await buildViews(db.sql, scope);
      const job = await createJobAttempt(db, scope);
      let forwarded = 0;
      const runtime: RuntimeAdapter = {
        async capabilities() {
          return { version: 'scripted-v1', tools: false, streaming: true, interrupt: true };
        },
        async start(bundle, sink, signal) {
          expect(bundle.knowledge[0]?.excerpt).toContain('July');
          expect(bundle.job.constraints.notes).toBe('Do not book without a new approval.');
          await correctClaim(db.sql, scope, {
            claim_id: id,
            expected_revision: 1,
            text: 'move to August',
            content: 'August',
            valid_from: '2026-06-10T00:00:00Z',
            idempotency_key: 'live-runtime',
          });
          expect(signal.aborted).toBe(true);
          expect(bundle.knowledge).toHaveLength(0);
          const rejected = await sink
            .emit({
              type: 'text_delta',
              attempt_id: job.attemptId,
              local_seq: 1,
              dedup_key: `${job.attemptId}:1`,
              at: new Date().toISOString(),
              text: 'stale July answer',
            })
            .catch((error: Error) => error.message);
          expect(rejected).toBe('context_invalidated');
          return { kind: 'completed', summary: 'discard this completion', evidence: [] };
        },
      };
      const adapter = withMemoryRuntime(runtime, db.sql, async () => scope);
      const bundle = attemptBundle.parse({
        attempt: {
          id: job.attemptId,
          job_id: job.jobId,
          epoch: 1,
          revision: 1,
          token: 'fixture-only',
        },
        job: {
          title: 'Trip',
          objective: 'trip',
          constraints: { notes: 'untrusted stale caller field' },
          progress_summary: '',
          unresolved_questions: [],
          deliverable: {},
        },
        inputs: { new_user_messages: [], approval_results: [], trigger_events: [] },
        transcript: [],
        tools: [],
        skills: [],
        knowledge: [],
        workspace: { mount: '/work', files: [] },
        budget: { max_turns: 1, max_output_tokens: 100, max_wall_ms: 1000, max_actions: 0 },
        model: { provider: 'fake', model: 'scripted-memory-v1', fallback: null },
      });
      expect(
        await adapter
          .start(
            bundle,
            {
              async emit() {
                forwarded++;
              },
            },
            new AbortController().signal,
          )
          .catch((error: Error) => error.message),
      ).toBe('context_invalidated');
      expect(forwarded).toBe(0);
      expect(
        await assertContextCurrent(db.sql, scope, job.attemptId).catch(
          (error: Error) => error.message,
        ),
      ).toBe('context_invalidated');
      const [record] =
        await db.sql`select token_budget, items from memory_contexts where attempt_id = ${job.attemptId}`;
      expect(record?.items).toHaveLength(1);
      expect(record?.token_budget.used).toBeLessThanOrEqual(record?.token_budget.limit);
    });
    test('automatic retraction invalidates attempts that already received its text', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const { id } = await seed(db, scope);
      await buildViews(db.sql, scope);
      const job = await createJobAttempt(db, scope);
      await assembleAttemptKnowledge(db.sql, scope, job.attemptId, job.jobId, 'trip');
      await ingest(db.sql, scope, input('retraction', 'the July plan is incorrect'));
      const batch = await claimWork(db.sql, scope);
      if (!batch) throw new Error('missing retraction');
      const result = await commitExtraction(db.sql, scope, batch, {
        proposals: [
          {
            op: 'retract',
            claim_id: id,
            expected_revision: 1,
            sources: tripProposal(batch).sources,
          },
        ],
      });
      expect(result.status).toBe('committed');
      expect(
        await assertContextCurrent(db.sql, scope, job.attemptId).catch(
          (error: Error) => error.message,
        ),
      ).toBe('context_invalidated');
      const [invalidated] =
        await db.sql`select invalidated_at from memory_contexts where attempt_id = ${job.attemptId}`;
      expect(invalidated?.invalidated_at).not.toBeNull();
    });
  });
}
