/**
 * Extraction as a person meets it: saying something again keeps one copy and
 * loses nothing said beside it, and an update to something said long ago
 * reaches the claim it updates.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { commitExtraction } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { buildViews } from '../../src/memory/views.ts';
import { claimWork } from '../../src/memory/work.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

withDb('extraction keeps what matters once', () => {
  /** Ingest one message and hand back its work, the way the extraction worker would. */
  const said = async (
    db2: NonNullable<typeof db>,
    scope: MemoryScope,
    name: string,
    text: string,
  ) => {
    await ingest(db2.sql, scope, {
      stream: 'chat',
      source_identity: name,
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: '2026-08-10T09:00:00Z',
      text,
    });
    const batch = await claimWork(db2.sql, scope);
    if (!batch) throw new Error(`no work for ${name}`);
    return batch;
  };
  const unkeyed = (
    batch: NonNullable<Awaited<ReturnType<typeof claimWork>>>,
    domain: string,
    quote: string,
  ): ExtractionProposal => {
    const start = batch.work.segment_start + batch.text.indexOf(quote);
    return {
      op: 'add',
      expected_revision: null,
      domain_key: domain,
      content: quote,
      kind: 'user_statement',
      factual_status: 'attributed',
      valid_from: '2026-08-10T09:00:00Z',
      valid_until: null,
      sources: [
        {
          source_id: batch.source.source_id,
          source_version: '1',
          start,
          end: start + quote.length,
          quote,
        },
      ],
    } as ExtractionProposal;
  };

  test('repeating a fact keeps one copy and loses nothing said alongside it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const first = await said(db, scope, 'owner', 'Priya owns the Atlas project.');
    await commitExtraction(db.sql, scope, first, {
      proposals: [unkeyed(first, 'project.atlas.owner', 'Priya owns the Atlas project')],
    });
    const second = await said(
      db,
      scope,
      'again',
      'Priya owns the Atlas project. Atlas ships in October.',
    );
    const result = await commitExtraction(db.sql, scope, second, {
      proposals: [
        unkeyed(second, 'project.atlas.owner', 'Priya owns the Atlas project'),
        unkeyed(second, 'project.atlas.ship', 'Atlas ships in October'),
      ],
    });
    expect(result.status).toBe('committed');
    const claims = await db.sql`select c.domain_key, count(r.*)::int as active from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.status = 'active'
      where c.space_id = ${scope.spaceId} and not c.hidden group by c.domain_key order by c.domain_key`;
    expect(claims.map((row) => [row.domain_key, row.active])).toEqual([
      ['project.atlas.owner', 1],
      ['project.atlas.ship', 1],
    ]);
  });

  test('extraction sees the claim a message is about even when it was said long ago', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await record(
      db,
      scope,
      {
        identity: 'ana',
        text: "Ana's email is ana@studio.example.",
        eventAt: '2026-08-01T09:00:00Z',
      },
      [
        {
          key: 'contact.ana.email',
          content: 'ana@studio.example',
          quote: 'ana@studio.example',
          kind: 'user_statement',
        },
      ],
    );
    for (let i = 0; i < 40; i++) {
      const batch = await said(
        db,
        scope,
        `errand-${i}`,
        `Errand number ${i}: collect parcel ${i}.`,
      );
      await commitExtraction(db.sql, scope, batch, {
        proposals: [unkeyed(batch, `errand.n${i}`, `collect parcel ${i}`)],
      });
    }
    await buildViews(db.sql, scope);
    const update = await said(
      db,
      scope,
      'ana-new',
      'Ana changed jobs, her email is now ana@atlas.example.',
    );
    // The claim the message is about leads the snapshot, ahead of newer ones.
    expect(update.claims[0]?.key).toBe('contact.ana.email');
  });
});
