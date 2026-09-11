import { afterAll, describe, expect, test } from 'bun:test';
import {
  claimHistory,
  correctClaim,
  listClaims,
  publishRevision,
} from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { lockSpace } from '../../src/memory/db.ts';
import { ingest, loadEvidence } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { recall } from '../../src/memory/recall.ts';
import { buildViews, type EmbeddingProvider } from '../../src/memory/views.ts';
import { claimWork, MEMORY_EXTRACT_QUEUE, repairQueue } from '../../src/memory/work.ts';
import { fakeProvider, tripProposal } from './fake-provider.ts';
import { registerLifecycleTests } from './lifecycle-tests.ts';
import { createScope, createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
registerLifecycleTests(db);
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;
const source = (identity = 'm1', text = 'our trip is in July') => ({
  stream: 'chat',
  source_identity: identity,
  source_version: '1',
  source_type: 'message',
  event_at: '2026-07-01T00:00:00Z',
  text,
});
withDb('memory evidence ledger', () => {
  test('persist before acknowledgment, dedup, immutable versions, separate streams', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const accepted = await ingest(db.sql, scope, source());
    expect(accepted.committed_sequence).toBe(1);
    expect((await loadEvidence(db.sql, scope, accepted.source.source_id))?.text).toContain('July');
    expect((await ingest(db.sql, scope, source())).duplicate).toBe(true);
    const conflict = await ingest(db.sql, scope, source('m1', 'August')).catch(
      (error: Error) => error.message,
    );
    expect(conflict).toBe('source_version_conflict');
    const other = await ingest(db.sql, scope, { ...source(), stream: 'email' });
    expect(other.committed_sequence).toBe(1);
    const work =
      await db.sql`select * from memory_work where source_id = ${accepted.source.source_id}`;
    expect(work).toHaveLength(1);
    const outbox = await db.sql`select * from memory_outbox where target_id = ${work[0]?.id}`;
    expect(outbox).toHaveLength(1);
  });
  test('concurrent inputs commit contiguous stream sequences and reject cross-space metadata', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const rows = await Promise.all([
      ingest(db.sql, scope, source('a')),
      ingest(db.sql, scope, source('b')),
    ]);
    expect(rows.map((r) => r.committed_sequence).sort()).toEqual([1, 2]);
    const other = await createScope(db);
    expect(await loadEvidence(db.sql, other, rows[0]?.source.source_id as string)).toBeNull();
    const invalid = await ingest(db.sql, scope, {
      ...source('bad'),
      space_id: other.spaceId,
    }).catch(() => 'invalid');
    expect(invalid).toBe('invalid');
    const denied = await ingest(db.sql, { ...scope, spaceId: other.spaceId }, source('bad')).catch(
      (error: Error) => error.message,
    );
    expect(denied).toBe('scope_denied');
  });
  test('pg-boss uses the embedded database', async () => {
    if (!db) return;
    await db.boss.createQueue('w7.probe');
    await db.boss.send('w7.probe', { marker: 'durable' });
    const jobs = await db.boss.fetch<{ marker: string }>('w7.probe');
    expect(jobs[0]?.data.marker).toBe('durable');
    await db.boss.complete(
      'w7.probe',
      jobs.map((j) => j.id),
    );
  });
  test('claim revisions retain exact support and direct corrections are immediate and idempotent', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const evidence = await ingest(db.sql, scope, source());
    const first = await db.sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return publishRevision(tx, scope, 'trip.month', null, {
        content: 'July',
        kind: 'user_statement',
        factual_status: 'attributed',
        protected: false,
        valid_from: '2026-07-01T00:00:00Z',
        valid_until: null,
        sources: [
          {
            source_id: evidence.source.source_id,
            source_version: '1',
            start: 0,
            end: source().text.length,
          },
        ],
      });
    });
    const correction = {
      claim_id: first.claim_id,
      expected_revision: 1,
      text: 'move our trip from July to August',
      content: 'August',
      valid_from: '2026-08-01T00:00:00Z',
      idempotency_key: 'correction1',
    };
    const revised = await correctClaim(db.sql, scope, correction);
    expect(revised.protected).toBe(true);
    expect(revised.revision).toBe(2);
    expect((await correctClaim(db.sql, scope, correction)).revision).toBe(2);
    const freshSession = { ...scope };
    expect((await listClaims(db.sql, freshSession)).claims[0]?.current.content).toBe('August');
    const history = await claimHistory(db.sql, freshSession, first.claim_id);
    expect(history.revisions.map((r) => r.content)).toEqual(['July', 'August']);
    expect(history.revisions[0]?.status).toBe('superseded');
    expect(history.revisions[0]?.superseded_at).not.toBeNull();
    expect(history.revisions[0]?.valid_until).toBe('2026-08-01T00:00:00.000Z');
    expect(history.revisions[0]?.sources[0]?.source_id).toBe(evidence.source.source_id);
    const stale = await correctClaim(db.sql, scope, {
      ...correction,
      idempotency_key: 'stale',
    }).catch((error: Error) => error.message);
    expect(stale).toBe('stale_revision');
    const rolledBack =
      await db.sql`select id from memory_sources where space_id = ${scope.spaceId} and source_identity = 'stale'`;
    expect(rolledBack).toHaveLength(0);
    const heads =
      await db.sql`select revision from memory_revisions where claim_id = ${first.claim_id} and status = 'active'`;
    expect(heads).toHaveLength(1);
  });
  test('HTTP extraction racing a correction retries from a fresh fenced snapshot', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await ingest(db.sql, scope, source('initial'));
    const first = await claimWork(db.sql, scope);
    if (!first) throw new Error('missing initial work');
    const provider = fakeProvider(() => [tripProposal(first)]);
    try {
      const proposals = await proposeExtraction(db.sql, scope, first, provider.gateway);
      expect((await commitExtraction(db.sql, scope, first, { proposals })).status).toBe(
        'committed',
      );
      expect((await commitExtraction(db.sql, scope, first, { proposals })).status).toBe(
        'duplicate',
      );
      expect(provider.requests).toHaveLength(1);
      expect(JSON.stringify(provider.requests)).not.toContain('postgres://');
    } finally {
      await provider.close();
    }
    const id = (await listClaims(db.sql, scope)).claims[0]?.id;
    if (!id) throw new Error('missing trip');
    await ingest(db.sql, scope, {
      ...source('race', 'trip in September'),
      event_at: '2026-08-02T00:00:00Z',
    });
    const racing = await claimWork(db.sql, scope);
    if (!racing) throw new Error('missing racing work');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inference = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = fakeProvider(async () => {
      entered();
      await inference;
      return [tripProposal(racing, 'September')];
    });
    try {
      const pending = proposeExtraction(db.sql, scope, racing, slow.gateway);
      await started;
      await correctClaim(db.sql, scope, {
        claim_id: id,
        expected_revision: 1,
        content: 'August',
        text: 'move our trip from July to August',
        valid_from: '2026-08-01T00:00:00Z',
        idempotency_key: 'race-correction',
      });
      release();
      const result = await commitExtraction(db.sql, scope, racing, { proposals: await pending });
      expect(result).toEqual({ status: 'retry', claim_ids: [], reason: 'stale_revision' });
      const retry = await claimWork(db.sql, scope, { workId: racing.work.id });
      if (!retry) throw new Error('missing retry');
      expect(retry.work.fence).toBeGreaterThan(racing.work.fence);
      expect(retry.claims[0]?.current.content).toBe('August');
      expect(
        (
          await commitExtraction(db.sql, scope, retry, {
            proposals: [tripProposal(retry, 'September')],
          })
        ).status,
      ).toBe('committed');
      expect((await listClaims(db.sql, scope)).claims[0]?.current.content).toBe('August');
      const active =
        await db.sql`select * from memory_revisions where claim_id = ${id} and status in ('active','disputed')`;
      expect(active).toHaveLength(1);
    } finally {
      release();
      await slow.close();
    }
  });
  test('whole-set validation rejects wrong spans, spoofed attribution, and conflicting creates', async () => {
    if (!db) return;
    for (const failure of ['span', 'attribution', 'authority', 'conflict']) {
      const scope = await createScope(db);
      await ingest(db.sql, scope, {
        ...source(failure),
        source_type: failure === 'attribution' ? 'assistant' : 'message',
      });
      const batch = await claimWork(db.sql, scope);
      if (!batch) throw new Error('missing work');
      const good = tripProposal(batch);
      const bad = {
        ...good,
        ...(failure === 'authority' ? { domain_key: 'approval.granted' } : {}),
        ...(failure === 'span'
          ? { sources: [{ ...good.sources[0], quote: 'a convenient nearby message' }] }
          : {}),
      };
      const proposals = failure === 'conflict' || failure === 'span' ? [good, bad] : [bad];
      const result = await commitExtraction(db.sql, scope, batch, { proposals });
      expect(result.status).toBe('rejected');
      expect((await listClaims(db.sql, scope)).claims).toHaveLength(0);
      expect(await loadEvidence(db.sql, scope, batch.source.source_id)).not.toBeNull();
    }
  });
  test('continuation cursors and queue repair survive lost delivery and an obsolete lease holder', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const accepted = await ingest(db.sql, scope, source('long', 'x'.repeat(16020)));
    expect(await repairQueue(db.sql, db.boss)).toBeGreaterThan(0);
    const deliveries = await db.boss.fetch<{ work_id: string }>(MEMORY_EXTRACT_QUEUE, {
      batchSize: 100,
    });
    expect(deliveries.length).toBeGreaterThan(0);
    const old = await claimWork(db.sql, scope);
    if (!old) throw new Error('missing long work');
    expect(old.text.length).toBe(16000);
    expect(old.work.continuation).toBe(16000);
    await db.sql`update memory_work set lease_until = clock_timestamp() - interval '1 second' where id = ${old.work.id}`;
    const replacement = await claimWork(db.sql, scope);
    if (!replacement) throw new Error('missing replacement');
    expect((await commitExtraction(db.sql, scope, old, { proposals: [] })).reason).toBe(
      'stale_lease',
    );
    expect((await commitExtraction(db.sql, scope, replacement, { proposals: [] })).status).toBe(
      'committed',
    );
    const [partial] =
      await db.sql`select consumed_sequence from memory_streams where space_id = ${scope.spaceId}`;
    expect(partial?.consumed_sequence).toBe(0);
    const continuation = await claimWork(db.sql, scope);
    if (!continuation) throw new Error('missing continuation');
    expect(continuation.text.length).toBe(20);
    await commitExtraction(db.sql, scope, continuation, { proposals: [] });
    const [finished] =
      await db.sql`select consumed_sequence from memory_streams where space_id = ${scope.spaceId}`;
    expect(finished?.consumed_sequence).toBe(accepted.committed_sequence);
    await db.boss.complete(
      MEMORY_EXTRACT_QUEUE,
      deliveries.map((job) => job.id),
    );
  });
  test('recall supplements a lagging lexical index and dates historical revisions', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await ingest(db.sql, scope, source('trip'));
    const batch = await claimWork(db.sql, scope);
    if (!batch) throw new Error('missing work');
    const commit = await commitExtraction(db.sql, scope, batch, {
      proposals: [tripProposal(batch)],
    });
    const id = commit.claim_ids[0];
    if (!id) throw new Error('missing claim');
    const initial = await recall(db.sql, scope, { query: 'trip' });
    expect(initial.status).toBe('degraded');
    expect(initial.items[0]?.content).toBe('July');
    await buildViews(db.sql, scope);
    expect((await recall(db.sql, scope, { query: 'trip' })).status).toBe('complete');
    await correctClaim(db.sql, scope, {
      claim_id: id,
      expected_revision: 1,
      content: 'August',
      text: 'move our trip from July to August',
      valid_from: '2026-08-01T00:00:00Z',
      idempotency_key: 'recall-correction',
    });
    const current = await recall(db.sql, scope, { query: 'trip' });
    expect(current.status).toBe('degraded');
    expect(current.items.map((item) => item.content)).toEqual(['August']);
    expect(current.coverage.supplemented).toBe(1);
    await buildViews(db.sql, scope);
    const historical = await recall(db.sql, scope, {
      query: 'trip',
      mode: 'historical',
      at: '2026-07-15T00:00:00Z',
    });
    expect(historical.items.map((item) => item.content)).toEqual(['July']);
    expect(historical.items[0]?.superseded_at).not.toBeNull();
    const empty = await recall(db.sql, scope, { query: 'aardvark' });
    expect(empty.status).toBe('complete');
    expect(empty.items).toHaveLength(0);
    const unavailable = await recall(
      db.sql,
      scope,
      { query: 'trip' },
      {
        lexical: async () => {
          throw new Error('forced index failure');
        },
      },
    );
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.coverage.reason).toBe('index_failure');
    expect(unavailable.items).toHaveLength(0);
    const budget = await recall(db.sql, scope, { query: 'trip', max_tokens: 10 });
    expect(budget.status).toBe('degraded');
    expect(budget.coverage.reason).toBe('budget');
    expect(budget.token_budget.used).toBeLessThanOrEqual(10);
    const other = await createScope(db);
    expect((await recall(db.sql, other, { query: 'trip' })).items).toHaveLength(0);
    const poisoned = await recall(
      db.sql,
      other,
      { query: 'trip' },
      { lexical: async () => [{ claim_id: id, revision: 2, score: 1000 }] },
    );
    expect(poisoned.items).toHaveLength(0);
    const stale = await recall(
      db.sql,
      scope,
      { query: 'trip' },
      { lexical: async () => [{ claim_id: id, revision: 1, score: 1000 }] },
    );
    expect(stale.items).toHaveLength(0);
    await db.sql`update memory_sources set state = 'revoked' where id = ${(await claimHistory(db.sql, scope, id)).revisions[1]?.sources[0]?.source_id as string}`;
    expect((await recall(db.sql, scope, { query: 'trip' })).items).toHaveLength(0);
  });
  test('lexical and dense candidates are independent and incompatible embeddings fail closed', async () => {
    if (!db) return;
    const scope = await createScope(db);
    for (const word of ['July', 'August']) {
      await ingest(db.sql, scope, source(word, `trip ${word}`));
      const batch = await claimWork(db.sql, scope);
      if (!batch) throw new Error('missing work');
      const base = tripProposal(batch, word);
      const proposal = { ...base, op: 'add', expected_revision: null, domain_key: `plan.${word}` };
      expect((await commitExtraction(db.sql, scope, batch, { proposals: [proposal] })).status).toBe(
        'committed',
      );
    }
    const embedding: EmbeddingProvider = {
      model: 'scripted-comparison',
      version: '1',
      dimensions: 2,
      recipe: 'scripted-v1',
      async embed(texts) {
        return texts.map((text) => (text.includes('plan July') ? [0, 1] : [1, 0]));
      },
    };
    await buildViews(db.sql, scope, embedding);
    const result = await recall(db.sql, scope, { query: 'July' }, { embedding, deadlineMs: 1500 });
    expect(result.items.map((item) => item.content).sort()).toEqual(['August', 'July']);
    const incompatible = await recall(
      db.sql,
      scope,
      { query: 'trip' },
      { embedding: { ...embedding, version: '2' } },
    );
    expect(incompatible.status).toBe('unavailable');
    const [before] =
      await db.sql`select generation from memory_index_manifest where space_id = ${scope.spaceId}`;
    const invalid = await buildViews(db.sql, scope, {
      ...embedding,
      async embed(texts) {
        return texts.map(() => [1]);
      },
    }).catch((error: Error) => error.message);
    expect(invalid).toBe('embedding_space_mismatch');
    const [after] =
      await db.sql`select generation from memory_index_manifest where space_id = ${scope.spaceId}`;
    expect(after?.generation).toBe(before?.generation);
  });
});
