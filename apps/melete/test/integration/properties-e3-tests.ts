/**
 * E3. A scripted extractor returns a date its span does not hold and an address
 * nothing ever said. Both are rejected with reasons, the connector's own date
 * stays the head, and the recipient of an action payload resolves to the contact
 * claim rather than to whatever the model produced.
 */
import { describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { createTrustResolver } from '../../src/memory/trust.ts';
import { claimWork } from '../../src/memory/work.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, type TestDatabase } from './postgres.ts';
import { head } from './properties-fixtures.ts';

export function registerExtractorTests(db: TestDatabase | null) {
  const withDb = db ? describe : describe.skip;
  withDb('E3 deterministic extractors run first', () => {
    test('a wrong span and a hallucinated address are rejected; the connector date is the head', async () => {
      if (!db) return;
      const scope = await createScope(db);
      const { journal, close } = await createJournal();
      // A gateway that fails the test if anything reaches it.
      const gateway = {
        chat: async () => {
          throw new Error('the model must not be called for a connector observation');
        },
      };
      const observe = async (identity: string, observation: Record<string, unknown>) => {
        const evidence = await ingest(db.sql, scope, {
          stream: 'calendar',
          source_identity: identity,
          source_version: '1',
          source_type: 'observation',
          author: 'external',
          event_at: '2026-09-02T00:00:00Z',
          text: JSON.stringify(observation),
        });
        const [work] =
          await db.sql`select id from memory_work where source_id = ${evidence.source.source_id}`;
        await runExtractionWork(
          { sql: db.sql, boss: db.boss, journal, gateway },
          work?.id as string,
        );
      };
      await observe('cal-1', {
        kind: 'calendar_event',
        slug: 'trip',
        summary: 'Trip',
        start: '2026-08-10',
      });
      await observe('contact-1', {
        kind: 'contact',
        slug: 'hotel',
        email: 'desk@hotel.example',
      });

      const trip = await head(db, scope, 'event.trip.date');
      expect(trip?.kind).toBe('checked_fact');
      expect(trip?.origin_trust).toBe('verified_connector');
      expect(trip?.content?.slice(0, 10)).toBe('2026-08-10');
      const hotel = await head(db, scope, 'contact.hotel.email');
      expect(hotel?.content).toBe('desk@hotel.example');

      // Now the model proposes a date its span does not hold, and an address
      // nothing in the evidence ever said.
      const chat = 'I think the trip moved and the hotel replied from somewhere.';
      const evidence = await ingest(db.sql, scope, {
        stream: 'chat',
        source_identity: 'chat-1',
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: '2026-09-03T00:00:00Z',
        text: chat,
      });
      expect(evidence.source.origin_trust).toBe('owner');
      const batch = await claimWork(db.sql, scope);
      if (!batch) throw new Error('no chat work');
      const span = (quote: string) => {
        const at = batch.text.indexOf(quote);
        return {
          source_id: batch.source.source_id,
          source_version: '1',
          start: batch.work.segment_start + at,
          end: batch.work.segment_start + at + quote.length,
          quote,
        };
      };
      const result = await commitExtraction(db.sql, scope, batch, {
        proposals: [
          {
            op: 'add',
            expected_revision: null,
            domain_key: 'event.trip.date',
            key: 'event.trip.date',
            content: '2026-09-20T00:00:00.000Z',
            kind: 'user_statement',
            factual_status: 'attributed',
            confidence: 0.94,
            valid_from: '2026-09-03T00:00:00Z',
            valid_until: null,
            sources: [span('the trip moved')],
          },
          {
            op: 'add',
            expected_revision: null,
            domain_key: 'contact.hotel.email',
            key: 'contact.hotel.email',
            content: 'reservations@totally-different.example',
            kind: 'user_statement',
            factual_status: 'attributed',
            valid_from: '2026-09-03T00:00:00Z',
            valid_until: null,
            sources: [span('the hotel replied')],
          },
        ] as ExtractionProposal[],
      });
      expect(result.status).toBe('committed');

      const rejected =
        await db.sql`select proposal_index, key, reason, detail from memory_rejections where space_id = ${scope.spaceId} order by proposal_index`;
      expect(rejected.map((row) => [row.key, row.reason])).toEqual([
        ['event.trip.date', 'value_not_in_evidence'],
        ['contact.hotel.email', 'value_not_in_evidence'],
      ]);
      expect(rejected.every((row) => (row.detail as string).length > 0)).toBe(true);

      // Neither was attached to anything. The connector's values still stand.
      const after = await head(db, scope, 'event.trip.date');
      expect(after?.head_revision).toBe(trip?.head_revision as number);
      expect(after?.content?.slice(0, 10)).toBe('2026-08-10');
      expect((await head(db, scope, 'contact.hotel.email'))?.content).toBe('desk@hotel.example');

      // An action payload's recipient resolves to the contact claim.
      const resolver = createTrustResolver(db.sql, async () => scope);
      const resolution = await resolver.resolve({
        space_id: scope.spaceId,
        payload: { to: 'desk@hotel.example', subject: 'Booking' },
        handles: [`${hotel?.id}@${hotel?.head_revision}`],
      });
      expect(resolution.fields[0]).toMatchObject({
        field: 'to',
        value: 'desk@hotel.example',
        origin_trust: 'verified_connector',
      });
      expect(resolution.actionable).toBe(true);
      await close();
    });
  });
}
