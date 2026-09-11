/**
 * E1. Correct one claim among five and assert that only the output which cited
 * it goes stale, that the repair brief names that output and where inside it the
 * old value sat, and that the other four stay current. Before this, the only
 * safe answer was to invalidate everything that had ever seen the claim.
 */
import { describe, expect, test } from 'bun:test';
import { correctClaim } from '../../src/memory/claims.ts';
import { assembleAttemptKnowledge } from '../../src/memory/context.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import { buildViews } from '../../src/memory/views.ts';
import { createJobAttempt } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

export function registerDependenceTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('E1 dependence is declared, not guessed', () => {
    test('a correction marks stale exactly the output that cited it and says what to repair', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const text =
        'Seat aisle. Meal vegetarian. Room quiet. Car none. Gate early. All settled for the trip.';
      const keys = [
        { key: 'pref.travel.seat', content: 'aisle', quote: 'aisle' },
        { key: 'pref.travel.meal', content: 'vegetarian', quote: 'vegetarian' },
        { key: 'pref.hotel.room', content: 'quiet', quote: 'quiet' },
        { key: 'pref.travel.car', content: 'none', quote: 'none' },
        { key: 'pref.travel.gate', content: 'early', quote: 'early' },
      ];
      const committed = await record(
        db,
        scope,
        { identity: 'five', text, eventAt: '2026-09-01T00:00:00Z' },
        keys.map((k) => ({ ...k, kind: 'user_statement' })),
      );
      expect(committed.status).toBe('committed');
      await buildViews(db.sql, scope);

      const heads = [];
      for (const { key } of keys) {
        const row = await head(db, scope, key);
        if (!row) throw new Error(`no head for ${key}`);
        heads.push({ key, id: row.id, revision: row.head_revision });
      }
      expect(heads).toHaveLength(5);

      const { jobId, attemptId } = await createJobAttempt(db, scope);
      const bundle = await assembleAttemptKnowledge(db.sql, scope, attemptId, jobId, 'seat meal');
      // Every delivered item carries the handle an output has to cite.
      expect(bundle.knowledge.every((item) => /@\d+$/.test(item.handle ?? ''))).toBe(true);

      // Five artifacts, each resting on one claim, and one piece of chat prose
      // that rests on nothing it will admit to.
      for (const [index, entry] of heads.entries())
        await recordOutput(db.sql, scope, {
          job_id: jobId,
          attempt_id: attemptId,
          kind: 'artifact',
          output_id: `art_${index}`,
          output_version: '1',
          location: `paragraph ${index + 1}`,
          uses: [`${entry.id}@${entry.revision}`],
        });
      await recordOutput(db.sql, scope, {
        job_id: jobId,
        attempt_id: attemptId,
        kind: 'artifact',
        output_id: 'art_prose',
        output_version: '1',
        location: null,
        uses: [],
      });
      const [context] =
        await db.sql`select unattributed from memory_contexts where attempt_id = ${attemptId}`;
      expect(context?.unattributed).toEqual(['artifact:art_prose@1']);

      const first = heads[0];
      if (!first) throw new Error('no first head');
      await correctClaim(db.sql, scope, {
        claim_id: first.id,
        expected_revision: first.revision,
        text: 'Actually I want a window seat.',
        content: 'window',
        valid_from: '2026-09-05T00:00:00Z',
        valid_until: null,
        idempotency_key: 'seat-correction',
      });

      const stale =
        await db.sql`select output_id, stale from memory_outputs where space_id = ${scope.spaceId} order by output_id`;
      expect(stale.filter((row) => row.stale === true).map((row) => row.output_id)).toEqual([
        'art_0',
      ]);
      expect(stale.filter((row) => row.stale === false)).toHaveLength(5);

      const [brief] =
        await db.sql`select * from memory_repair_briefs where space_id = ${scope.spaceId} and job_id = ${jobId}`;
      expect(brief?.changed_handle).toBe(`${first.id}@${first.revision}`);
      expect(brief?.replacement_handle).toBe(`${first.id}@${first.revision + 1}`);
      expect(brief?.old_value).toBe('aisle');
      expect(brief?.new_value).toBe('window');
      expect(brief?.affected).toEqual([
        { kind: 'artifact', output_id: 'art_0', output_version: '1', location: 'paragraph 1' },
      ]);

      // The other four claims are untouched: still at revision one, still active.
      for (const entry of heads.slice(1)) {
        const row = await head(db, scope, entry.key);
        expect(row?.head_revision).toBe(entry.revision);
        expect(row?.status).toBe('active');
      }
    });

    test('the next attempt is handed the repair brief in its inputs', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const committed = await record(
        db,
        scope,
        { identity: 'one', text: 'Seat aisle for now.', eventAt: '2026-09-01T00:00:00Z' },
        [{ key: 'pref.travel.seat', content: 'aisle', quote: 'aisle', kind: 'user_statement' }],
      );
      expect(committed.status).toBe('committed');
      const seat = await head(db, scope, 'pref.travel.seat');
      if (!seat) throw new Error('no seat claim');
      const { jobId } = await createJobAttempt(db, scope);
      await recordOutput(db.sql, scope, {
        job_id: jobId,
        attempt_id: null,
        kind: 'plan_step',
        output_id: 'step_2',
        output_version: '1',
        location: 'step 2',
        uses: [`${seat.id}@${seat.head_revision}`],
      });
      await correctClaim(db.sql, scope, {
        claim_id: seat.id,
        expected_revision: seat.head_revision,
        text: 'Window, please.',
        content: 'window',
        valid_from: '2026-09-05T00:00:00Z',
        valid_until: null,
        idempotency_key: 'seat-again',
      });
      const briefs =
        await db.sql`select affected, state from memory_repair_briefs where space_id = ${scope.spaceId} and job_id = ${jobId}`;
      expect(briefs).toHaveLength(1);
      expect(briefs[0]?.state).toBe('pending');
      const affected = (briefs[0]?.affected ?? []) as { location: string }[];
      expect(affected[0]?.location).toBe('step 2');
    });
  });
}
