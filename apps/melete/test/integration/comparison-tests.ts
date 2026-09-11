import { describe, expect, test } from 'bun:test';
import type { RecallRequest } from '@melete/contracts';
import { correctClaim, eligibleRevision, getHead } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { lockSpace, type MemoryScope } from '../../src/memory/db.ts';
import { ingest, toSource, visibleSourceText } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { forgetMemory } from '../../src/memory/forget.ts';
import { asKnowledge, effectiveAudience, recall } from '../../src/memory/recall.ts';
import { buildViews, type EmbeddingProvider } from '../../src/memory/views.ts';
import { claimWork } from '../../src/memory/work.ts';
import { fakeProvider, tripProposal } from './fake-provider.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';

/** The comparison baseline is a small profile plus latest scoped sources, with no claim search index. */
async function compactSourceBaseline(db: TestDatabase, scope: MemoryScope, query: string) {
  return db.sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const audience = await effectiveAudience(tx, scope);
    const profile: string[] = [];
    const [stored] =
      await tx`select items from memory_profile where space_id = ${scope.spaceId} and not stale`;
    for (const item of (stored?.items ?? []) as { claim_id: string; revision: number }[]) {
      const head = await getHead(tx, scope, item.claim_id);
      if (
        head &&
        head.head_revision === item.revision &&
        (await eligibleRevision(tx, scope, item.claim_id, item.revision))
      )
        profile.push(`${head.domain_key}: ${head.current.content}`);
    }
    const rows =
      await tx`select s.*, b.content from memory_sources s join memory_source_content b on b.source_id = s.id where s.space_id = ${scope.spaceId}
      and s.state = 'active' and s.audience = any(${audience.audiences}) order by s.event_at desc, s.ingested_at desc limit 8`;
    const sources: string[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(profile));
    for (const row of rows) {
      const text = await visibleSourceText(tx, toSource(row), row.content as string);
      if (!text.toLowerCase().includes(query.toLowerCase())) continue;
      const entry = `${row.id}@${row.source_version}; event ${new Date(row.event_at).toISOString()}; ${text}`;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > 2000) break;
      sources.push(entry);
      bytes += size;
    }
    return { text: [...sources, ...profile].join('\n'), bytes };
  });
}
const pinnedEmbedding: EmbeddingProvider = {
  model: 'scripted-term-vector',
  version: '1.0.0',
  dimensions: 3,
  recipe: 'lowercase-trip-food-v1',
  async embed(texts) {
    return texts.map((text) => [
      Number(/trip/i.test(text)),
      Number(/food|vegan/i.test(text)),
      Number(/calendar/i.test(text)),
    ]);
  },
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(2),
  );
};
export function registerComparisonTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('bounded memory comparison', () => {
    test('compact source baseline, lexical, and pinned dense union report delivery outcomes, latency, and budget', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const journal = await createJournal();
      const timings: Record<string, number[]> = { baseline: [], lexical: [], hybrid: [] };
      const bytes: Record<string, number[]> = { baseline: [], lexical: [], hybrid: [] };
      const outcomes: Record<string, number> = { baseline: 0, lexical: 0, hybrid: 0 };
      const observe = async (
        stage: string,
        query: string,
        expected: string | null,
        readScope = scope,
      ) => {
        for (const strategy of ['baseline', 'lexical', 'hybrid']) {
          const started = performance.now();
          let text: string;
          let size: number;
          if (strategy === 'baseline') {
            const result = await compactSourceBaseline(db, readScope, query);
            text = result.text;
            size = result.bytes;
          } else {
            const result = await recall(
              db.sql,
              readScope,
              { query, max_tokens: 2000 } satisfies Partial<RecallRequest>,
              strategy === 'hybrid'
                ? { embedding: pinnedEmbedding, includeProfile: true }
                : { includeProfile: true },
            );
            expect(result.status, `${strategy} ${stage}`).toBe('complete');
            text = result.items
              .map((item) => `${item.content}\n${JSON.stringify(asKnowledge(item))}`)
              .join('\n');
            size = result.token_budget.used;
          }
          const elapsed = performance.now() - started;
          timings[strategy]?.push(elapsed);
          bytes[strategy]?.push(size);
          expect(size).toBeLessThanOrEqual(2000);
          // A fixed consumer chooses the first supported month. This measures this fixture, not model reasoning.
          const answer = text.match(/July|August|October/)?.[0] ?? null;
          expect(answer, `${strategy} ${stage}`).toBe(expected);
          outcomes[strategy] = (outcomes[strategy] ?? 0) + 1;
        }
      };
      try {
        await ingest(db.sql, scope, {
          stream: 'comparison',
          source_identity: 'trip',
          source_version: '1',
          source_type: 'message',
          event_at: '2026-06-01T00:00:00Z',
          text: 'our trip is in July',
        });
        const batch = await claimWork(db.sql, scope);
        if (!batch) throw new Error('comparison seed missing');
        const provider = fakeProvider(() => [tripProposal(batch)]);
        let claimId = '';
        try {
          const result = await commitExtraction(db.sql, scope, batch, {
            proposals: await proposeExtraction(db.sql, scope, batch, provider.gateway),
          });
          claimId = result.claim_ids[0] ?? '';
        } finally {
          await provider.close();
        }
        await ingest(db.sql, scope, {
          stream: 'comparison',
          source_identity: 'food',
          source_version: '1',
          source_type: 'message',
          event_at: '2026-06-02T00:00:00Z',
          text: 'I prefer vegan food',
        });
        const food = await claimWork(db.sql, scope);
        if (!food) throw new Error('comparison preference missing');
        await commitExtraction(db.sql, scope, food, {
          proposals: [
            {
              op: 'add',
              expected_revision: null,
              domain_key: 'food.preference',
              content: 'vegan',
              kind: 'preference',
              factual_status: 'attributed',
              valid_from: food.source.event_at,
              valid_until: null,
              sources: tripProposal(food).sources,
            },
          ],
        });
        await buildViews(db.sql, scope, pinnedEmbedding);
        await observe('initial plan', 'trip', 'July');
        await correctClaim(db.sql, scope, {
          claim_id: claimId,
          expected_revision: 1,
          content: 'August',
          text: 'our trip is now in August',
          valid_from: '2026-06-10T00:00:00Z',
          idempotency_key: 'comparison-correction',
        });
        await buildViews(db.sql, scope, pinnedEmbedding);
        await observe('corrected plan', 'trip', 'August');
        await ingest(db.sql, scope, {
          stream: 'comparison',
          source_identity: 'old-email',
          source_version: '1',
          source_type: 'document',
          event_at: '2026-05-01T00:00:00Z',
          text: 'trip: see you in July',
        });
        const old = await claimWork(db.sql, scope);
        if (!old) throw new Error('comparison old source missing');
        await commitExtraction(db.sql, scope, old, { proposals: [tripProposal(old)] });
        await buildViews(db.sql, scope, pinnedEmbedding);
        await observe('late old import', 'trip', 'August');
        await observe('unrelated query', 'quasar', null);
        const foreign = await createScope(db);
        await buildViews(db.sql, foreign, pinnedEmbedding);
        await observe('another space', 'trip', null, foreign);
        await forgetMemory(db.sql, scope, { claim_id: claimId }, journal.journal);
        await buildViews(db.sql, scope, pinnedEmbedding);
        await observe('forgotten plan', 'trip', null);
        const [cost] =
          await db.sql`select sum(calls)::int as calls, sum(reserved_usd::numeric)::text as reserved_usd from memory_work where space_id = ${scope.spaceId}`;
        const metrics = Object.fromEntries(
          Object.keys(timings).map((name) => [
            name,
            {
              checks_passed: outcomes[name],
              samples: timings[name]?.length,
              p50_ms: percentile(timings[name] ?? [], 0.5),
              p95_ms: percentile(timings[name] ?? [], 0.95),
              max_context_bytes: Math.max(...(bytes[name] ?? [0])),
            },
          ]),
        );
        process.stdout.write(
          `memory comparison ${JSON.stringify({ fixtures: 6, strategies: metrics, extraction_calls: cost?.calls, reserved_usd: cost?.reserved_usd, charged_usd: 0, provider: 'scripted', embedding: 'scripted-term-vector@1.0.0/3' })}\n`,
        );
      } finally {
        await journal.close();
      }
    });
  });
}
