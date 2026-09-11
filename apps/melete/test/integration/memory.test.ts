import { afterAll, describe, expect, test } from 'bun:test';
import {
  claimHistory,
  correctClaim,
  listClaims,
  publishRevision,
} from '../../src/memory/claims.ts';
import { lockSpace } from '../../src/memory/db.ts';
import { ingest, loadEvidence } from '../../src/memory/evidence.ts';
import { createScope, createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
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
});
