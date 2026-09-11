import { afterAll, describe, expect, test } from 'bun:test';
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
});
