/**
 * Forgetting as a person means it: the text is gone from every stored copy,
 * what was said beside it stays, and nothing quoting it is handed on.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { correctClaim } from '../../src/memory/claims.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { cleanupMemory, forgetMemory } from '../../src/memory/forget.ts';
import { pendingRepairBriefs, recordOutput } from '../../src/memory/outputs.ts';
import { recall } from '../../src/memory/recall.ts';
import { createJobAttempt, createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

withDb('forgetting leaves nothing behind', () => {
  const attemptKeys = async (db2: NonNullable<typeof db>, scope: MemoryScope, query: string) =>
    (await recall(db2.sql, scope, { query, max_tokens: 2000 }, { includeProfile: true })).items.map(
      (item) => item.key,
    );

  const stored = async (db2: NonNullable<typeof db>, scope: MemoryScope, text: string) => {
    const pattern = `%${text}%`;
    const [row] = await db2.sql`select
      (select count(*)::int from memory_source_content b join memory_sources s on s.id = b.source_id
        where s.space_id = ${scope.spaceId} and b.content like ${pattern})
      + (select count(*)::int from memory_revision_content b join memory_claims c on c.id = b.claim_id
        where c.space_id = ${scope.spaceId} and b.content like ${pattern})
      + (select count(*)::int from memory_repair_briefs
        where space_id = ${scope.spaceId} and (old_value like ${pattern} or new_value like ${pattern}))
      + (select count(*)::int from question where space_id = ${scope.spaceId} and text like ${pattern}) as copies`;
    return row?.copies as number;
  };

  test('forgetting a detail erases its text and keeps what was said beside it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    try {
      await record(
        db,
        scope,
        {
          identity: 'two',
          text: 'Ana is at ana@studio.example and my seat is aisle.',
          eventAt: '2026-08-02T09:00:00Z',
        },
        [
          {
            key: 'contact.ana.email',
            content: 'ana@studio.example',
            quote: 'ana@studio.example',
            kind: 'user_statement',
          },
          { key: 'pref.travel.seat', content: 'aisle', quote: 'aisle', kind: 'preference' },
        ],
      );
      const ana = await head(db, scope, 'contact.ana.email');
      if (!ana) throw new Error('no claim');
      await forgetMemory(db.sql, scope, { claim_id: ana.id }, journal.journal);
      await cleanupMemory(db.sql, scope.spaceId);
      expect(await stored(db, scope, 'ana@studio.example')).toBe(0);
      expect(await attemptKeys(db, scope, 'Book my seat')).toContain('pref.travel.seat');
      // Replaying the same message is still recognised as the same evidence.
      const replay = await ingest(db.sql, scope, {
        stream: 'chat',
        source_identity: 'two',
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: '2026-08-02T09:00:00Z',
        text: 'Ana is at ana@studio.example and my seat is aisle.',
      });
      expect(replay.duplicate).toBe(true);
    } finally {
      await journal.close();
    }
  });

  test('forgetting a whole statement erases the statement, and a correction brief goes with it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const journal = await createJournal();
    try {
      await record(
        db,
        scope,
        { identity: 'city', text: 'My home city is Lisbon.', eventAt: '2026-08-01T09:00:00Z' },
        [
          {
            key: 'pref.home.city',
            content: 'Lisbon',
            quote: 'My home city is Lisbon.',
            kind: 'preference',
          },
        ],
      );
      const city = await head(db, scope, 'pref.home.city');
      if (!city) throw new Error('no claim');
      const { jobId, attemptId } = await createJobAttempt(db, scope);
      await recordOutput(db.sql, scope, {
        job_id: jobId,
        attempt_id: attemptId,
        kind: 'artifact',
        output_id: 'art_city',
        output_version: '1',
        location: 'first line',
        uses: [`${city.id}@${city.head_revision}`],
      });
      await correctClaim(db.sql, scope, {
        claim_id: city.id,
        expected_revision: city.head_revision,
        text: 'I moved to Porto.',
        content: 'Porto',
        valid_from: '2026-08-05T09:00:00Z',
        valid_until: null,
        idempotency_key: 'moved',
      });
      expect(await pendingRepairBriefs(db.sql, scope, jobId)).toHaveLength(1);
      await forgetMemory(db.sql, scope, { claim_id: city.id }, journal.journal);
      await cleanupMemory(db.sql, scope.spaceId);
      expect(await pendingRepairBriefs(db.sql, scope, jobId)).toHaveLength(0);
      expect(await stored(db, scope, 'Lisbon')).toBe(0);
      expect(await stored(db, scope, 'Porto')).toBe(0);
    } finally {
      await journal.close();
    }
  });
});
