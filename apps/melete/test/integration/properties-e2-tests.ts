/**
 * E2. July from the owner, then a document saying June, then the owner saying
 * August, then an old email that arrives last. Exactly one active head at every
 * step, the document never in the slot, the late import never in the slot, and
 * exactly one owner question for the one genuine conflict.
 */
import { describe, expect, test } from 'bun:test';
import { correctClaim } from '../../src/memory/claims.ts';
import { recall } from '../../src/memory/recall.ts';
import { buildViews } from '../../src/memory/views.ts';
import { createScope, type TestDatabase } from './postgres.ts';
import { activeHeads, head, record } from './properties-fixtures.ts';

export function registerKeyTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('E2 one active head per key', () => {
    test('July, then a document, then August, then a late email: one head, one question', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const key = 'event.trip.date';
      const single = async (label: string) => {
        const rows = await activeHeads(db, scope, key);
        expect(rows.length, `${label}: exactly one active head`).toBe(1);
        return rows[0] as { claim_id: string; revision: number; status: string };
      };

      // Day 3: the owner says July.
      expect(
        (
          await record(
            db,
            scope,
            { identity: 'd3', text: 'The trip is on 2026-07-20.', eventAt: '2026-07-03T00:00:00Z' },
            [
              {
                key,
                content: '2026-07-20T00:00:00.000Z',
                quote: '2026-07-20',
                kind: 'user_statement',
              },
            ],
          )
        ).status,
      ).toBe('committed');
      await single('after the owner said July');
      expect((await head(db, scope, key))?.content).toContain('2026-07-20');

      // Day 5: a document says June. A document never takes the slot from the owner.
      expect(
        (
          await record(
            db,
            scope,
            {
              identity: 'd5',
              text: 'Itinerary: departure 2026-06-15.',
              eventAt: '2026-07-05T00:00:00Z',
              sourceType: 'document',
              author: 'external',
              stream: 'documents',
            },
            [
              {
                key,
                content: '2026-06-15T00:00:00.000Z',
                quote: '2026-06-15',
                kind: 'document_assertion',
              },
            ],
          )
        ).status,
      ).toBe('committed');
      await single('after the document said June');
      expect((await head(db, scope, key))?.content).toContain('2026-07-20');
      expect((await head(db, scope, key))?.origin_trust).toBe('owner');
      expect(
        await db.sql`select 1 from memory_questions where space_id = ${scope.spaceId}`,
      ).toHaveLength(0);

      // Day 10: the owner says August, without saying they are replacing July.
      expect(
        (
          await record(
            db,
            scope,
            {
              identity: 'd10',
              text: 'Actually the trip is on 2026-08-10.',
              eventAt: '2026-07-10T00:00:00Z',
            },
            [
              {
                key,
                content: '2026-08-10T00:00:00.000Z',
                quote: '2026-08-10',
                kind: 'user_statement',
              },
            ],
          )
        ).status,
      ).toBe('committed');
      const disputed = await single('after the owner said August');
      expect(disputed.status).toBe('disputed');
      expect((await head(db, scope, key))?.content).toContain('2026-08-10');

      const contradictions =
        await db.sql`select * from memory_contradictions where space_id = ${scope.spaceId} and state = 'open'`;
      expect(contradictions).toHaveLength(1);
      const questions =
        await db.sql`select * from memory_questions where space_id = ${scope.spaceId} and state = 'queued'`;
      expect(questions).toHaveLength(1);
      // `because` is the two revision handles that disagree, and nothing else.
      expect(questions[0]?.because).toEqual([
        contradictions[0]?.head,
        contradictions[0]?.alternative,
      ]);
      expect(questions[0]?.if_ignored).toContain('will not act externally');

      // Day 12: an old email, written on day 1, arrives. It is an older fact.
      expect(
        (
          await record(
            db,
            scope,
            {
              identity: 'd12',
              text: 'See you on 2026-07-20 as planned.',
              eventAt: '2026-07-01T00:00:00Z',
              author: 'external',
              stream: 'mail',
            },
            [
              {
                key,
                content: '2026-07-20T00:00:00.000Z',
                quote: '2026-07-20',
                kind: 'document_assertion',
              },
            ],
          )
        ).status,
      ).toBe('committed');
      await single('after the late import');
      expect((await head(db, scope, key))?.content).toContain('2026-08-10');
      // Still exactly one question: three contradictory statements, one genuine conflict.
      expect(
        await db.sql`select 1 from memory_questions where space_id = ${scope.spaceId} and state = 'queued'`,
      ).toHaveLength(1);

      // Recall serves the winning head and says the key is disputed.
      await buildViews(db.sql, scope);
      const result = await recall(db.sql, scope, { query: 'trip' });
      expect(result.disputed_keys).toEqual([key]);
      const item = result.items.find((entry) => entry.key === key);
      expect(item?.disputed).toBe(true);
      expect(item?.content).toContain('2026-08-10');

      // An owner correction settles it: the contradiction closes, the question is answered.
      const current = await head(db, scope, key);
      if (!current) throw new Error('no head');
      await correctClaim(db.sql, scope, {
        claim_id: current.id,
        expected_revision: current.head_revision,
        text: 'It is definitely 2026-08-10.',
        content: '2026-08-10T00:00:00.000Z',
        valid_from: '2026-07-11T00:00:00Z',
        valid_until: null,
        idempotency_key: 'trip-settled',
      });
      expect(
        await db.sql`select 1 from memory_contradictions where space_id = ${scope.spaceId} and state = 'open'`,
      ).toHaveLength(0);
      expect(
        await db.sql`select 1 from memory_questions where space_id = ${scope.spaceId} and state = 'queued'`,
      ).toHaveLength(0);
      await single('after the correction');
    });

    test('the database refuses a second claim on one key', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const key = 'event.retreat.date';
      await record(
        db,
        scope,
        { identity: 'r1', text: 'Retreat on 2026-10-01.', eventAt: '2026-09-01T00:00:00Z' },
        [
          {
            key,
            content: '2026-10-01T00:00:00.000Z',
            quote: '2026-10-01',
            kind: 'user_statement',
          },
        ],
      );
      const existing = await head(db, scope, key);
      const duplicate =
        await db.sql`insert into memory_claims (id, space_id, domain_key, key, audience) values ('k_01ARZ3NDEKTSV4RRFFQ69G5FAV', ${scope.spaceId}, ${key}, ${key}, ${scope.audience})`.catch(
          (error: { code?: string }) => error.code,
        );
      expect(duplicate).toBe('23505');
      expect((await head(db, scope, key))?.id).toBe(existing?.id as string);
    });
  });
}
