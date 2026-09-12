/**
 * E2. July from the owner, then a document saying June, then the owner saying
 * August, then an old email that arrives last. Exactly one active head at every
 * step, the document never in the slot, the late import never in the slot, and
 * exactly one owner question for the one genuine conflict.
 */
import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { recordId } from '../../src/broker/records.ts';
import { QuestionService } from '../../src/jobs/questions.ts';
import { JobService } from '../../src/jobs/service.ts';
import { correctClaim } from '../../src/memory/claims.ts';
import { createDisputeSettler } from '../../src/memory/disputes.ts';
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

      // E7: the same dispute is in the owner's one queue, naming its space and
      // key, not in a feed of memory's own.
      const queued =
        await db.sql`select * from question where source = 'memory' and space_id = ${scope.spaceId} and state = 'open'`;
      expect(queued).toHaveLength(1);
      expect(queued[0]?.key).toBe(key);
      expect(queued[0]?.job_id).toBeNull();
      expect(queued[0]?.because).toEqual([
        `claim:${contradictions[0]?.head}`,
        `claim:${contradictions[0]?.alternative}`,
      ]);

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
      expect(
        await db.sql`select 1 from question where source = 'memory' and space_id = ${scope.spaceId} and state = 'open'`,
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
      // And the queue entry closes with it: the key stopped being disputed.
      const settled =
        await db.sql`select state, answered_at from question where source = 'memory' and space_id = ${scope.spaceId}`;
      expect(settled).toHaveLength(1);
      expect(settled[0]?.state).toBe('answered');
      expect(settled[0]?.answered_at).not.toBeNull();
      await single('after the correction');
    });

    test('the owner answers the queue entry and the key is settled', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const key = 'event.trip.date';
      await record(
        db,
        scope,
        { identity: 'q1', text: 'The trip is on 2026-07-20.', eventAt: '2026-07-01T00:00:00Z' },
        [{ key, content: '2026-07-20T00:00:00.000Z', quote: '2026-07-20', kind: 'user_statement' }],
      );
      await record(
        db,
        scope,
        {
          identity: 'q2',
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
      );
      await record(
        db,
        scope,
        {
          identity: 'q3',
          text: 'Actually the trip is on 2026-08-10.',
          eventAt: '2026-07-10T00:00:00Z',
        },
        [{ key, content: '2026-08-10T00:00:00.000Z', quote: '2026-08-10', kind: 'user_statement' }],
      );
      const [entry] =
        await db.sql`select * from question where source = 'memory' and space_id = ${scope.spaceId} and state = 'open'`;
      if (!entry) throw new Error('the dispute never reached the queue');

      const jobs = new JobService(drizzle(db.sql), db.boss);
      const questions = new QuestionService(
        jobs,
        undefined,
        createDisputeSettler(async () => scope, db.sql),
      );

      // It is in the one queue, beside whatever the jobs are asking.
      const listed = await questions.list();
      expect(listed.map((q) => q.id)).toContain(entry.id as string);
      const view = listed.find((q) => q.id === entry.id);
      expect(view?.source).toBe('memory');
      expect(view?.job_id).toBeNull();
      expect(view?.key).toBe(key);

      // Prose alone cannot settle it: the owner has to name a revision.
      const vague = await questions
        .answer(entry.id as string, { text: 'the later one' })
        .catch((error: { code?: string }) => error);
      expect((vague as { code?: string }).code).toBe('invalid_choice');
      // And not just any revision: one of the two the question said disagree.
      const foreign = await questions
        .answer(entry.id as string, {
          text: 'this one',
          choice: 'k_01J8ZP3QWABCDEFGHJKMNPQRST@1',
        })
        .catch((error: { code?: string }) => error);
      expect((foreign as { code?: string }).code).toBe('invalid_choice');

      // The owner picks the revision that is NOT the automatic head, which is
      // the whole reason `choice` exists: their answer decides, not the ranking.
      const automatic = await head(db, scope, key);
      expect(automatic?.content).toContain('2026-08-10');
      const chosen = (view?.because ?? [])[1]?.replace(/^claim:/, '') as string;
      const answered = await questions.answer(entry.id as string, {
        text: 'July was right after all.',
        choice: chosen,
      });
      expect(answered.question.state).toBe('answered');
      expect(answered.receipt).toBeNull();
      expect(answered.job).toBeNull();

      // The head is now what the owner chose, recorded as their correction.
      const settledHead = await head(db, scope, key);
      expect(settledHead?.content).toContain('2026-07-20');
      expect(settledHead?.origin_trust).toBe('owner');
      expect(
        await db.sql`select 1 from memory_contradictions where space_id = ${scope.spaceId} and state = 'open'`,
      ).toHaveLength(0);
      expect(await questions.list()).toHaveLength(0);
    });

    test('a disputed key full of SQL punctuation matches itself and nothing else', async () => {
      if (!db) return;
      const scope = await createScope(db);
      // Keys come from extraction proposals, so a key is data. This one carries
      // a quote, a statement separator and a comment marker: if any of it ever
      // reached the parser the lookup would break or over-match.
      const hostile = "contact.o'brien; drop table question--x";
      const innocent = 'contact.other.email';
      const jobId = recordId('job');
      const attemptId = recordId('att');
      const connectionId = recordId('conn');
      await db.sql`insert into connection (id, space_id, provider, label, scopes)
        values (${connectionId}, ${scope.spaceId}, 'test', 'Injection', '[]'::jsonb)`;
      await db.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
        values (${jobId}, ${scope.spaceId}, 'Injection', 'Prove the lookup binds', 'running', 1,
          '{"max_actions":1,"max_output_tokens":10,"max_usd_est":1,"max_wall_ms":1000,"max_turns":1}'::jsonb,
          '{"public_compartment":false,"allowed_domains":[]}'::jsonb)`;
      await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
      // An action already admitted, resting on a claim whose key is hostile.
      await db.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, status, idempotency_key)
        values (${recordId('act')}, ${jobId}, ${attemptId}, ${connectionId}, 'test.send',
          'write_external', '{}'::jsonb, 'hash', 'admitted', ${recordId('idem')})`;
      const claimId = 'k_01J8ZP3QWABCDEFGHJKMNPQRS1';
      await db.sql`insert into memory_claims (id, space_id, domain_key, audience, key, head_revision)
        values (${claimId}, ${scope.spaceId}, ${hostile}, 'private', ${hostile}, 1)`;
      const outputRow = 'mo_injection_fixture';
      await db.sql`insert into memory_outputs (id, space_id, job_id, kind, output_id, output_version)
        values (${outputRow}, ${scope.spaceId}, ${jobId}, 'action', 'send-1', '1')`;
      await db.sql`insert into memory_output_uses (output_row_id, handle, handle_kind, claim_id, revision)
        values (${outputRow}, ${`${claimId}@1`}, 'claim', ${claimId}, 1)`;

      // Two entries in the queue: the hostile key, and one nothing acted on.
      const blocked = recordId('qst');
      const quiet = recordId('qst');
      await db.sql`insert into question (id, source, space_id, key, text, because, if_ignored)
        values (${blocked}, 'memory', ${scope.spaceId}, ${hostile}, 'Which is right?',
          '["claim:k_01J8ZP3QWABCDEFGHJKMNPQRS1@1"]'::jsonb, 'Nothing will be sent.')`;
      await db.sql`insert into question (id, source, space_id, key, text, because, if_ignored)
        values (${quiet}, 'memory', ${scope.spaceId}, ${innocent}, 'And this one?',
          '["claim:k_01J8ZP3QWABCDEFGHJKMNPQRS2@1"]'::jsonb, 'Nothing will be sent.')`;

      const questions = new QuestionService(new JobService(drizzle(db.sql), db.boss));
      const listed = await questions.list();
      const hostileEntry = listed.find((q) => q.id === blocked);
      const quietEntry = listed.find((q) => q.id === quiet);
      expect(hostileEntry?.key).toBe(hostile);
      // Exactly that row: the one an admitted action rests on, and only it.
      expect(hostileEntry?.blocks_external_effect).toBe(true);
      expect(quietEntry?.blocks_external_effect).toBe(false);
      // And the table the key pretended to drop is still there, with both rows.
      expect(
        await db.sql`select 1 from question where space_id = ${scope.spaceId} and source = 'memory'`,
      ).toHaveLength(2);
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
