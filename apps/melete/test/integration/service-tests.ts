import { describe, expect, test } from 'bun:test';
import type { SourceEvent } from '@melete/contracts';
import { listClaims } from '../../src/memory/claims.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { recall } from '../../src/memory/recall.ts';
import { startMemoryService } from '../../src/memory/service.ts';
import { MEMORY_EXTRACT_QUEUE } from '../../src/memory/work.ts';
import { fakeProvider } from './fake-provider.ts';
import { createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';

export function registerServiceTests(parent: TestDatabase | null) {
  const withDb = parent ? describe : describe.skip;
  withDb('memory service worker', () => {
    test('startup gates serving, pg-boss derives scope from work, and background indexing catches up', async () => {
      if (!parent) return;
      const db = await createTestDatabase(parent.url);
      if (!db) throw new Error('existing Postgres unavailable');
      const journal = await createJournal();
      const scope = await createScope(db);
      const foreign = await createScope(db);
      const errors: string[] = [];
      let service: Awaited<ReturnType<typeof startMemoryService>> | undefined;
      let observedGate = false;
      const provider = fakeProvider(() => {
        const request = provider.requests.at(-1) as {
          messages: { role: string; content: string }[];
        };
        const data = JSON.parse(
          request.messages.find((message) => message.role === 'user')?.content ?? '',
        ) as { evidence: { source: SourceEvent; start: number; end: number; text: string } };
        expect(observedGate).toBe(true);
        return [
          {
            op: 'add',
            expected_revision: null,
            domain_key: 'trip.month',
            content: 'July',
            kind: 'user_statement',
            factual_status: 'attributed',
            valid_from: data.evidence.source.event_at,
            valid_until: null,
            sources: [
              {
                source_id: data.evidence.source.source_id,
                source_version: data.evidence.source.source_version,
                start: data.evidence.start,
                end: data.evidence.end,
                quote: data.evidence.text,
              },
            ],
          },
        ];
      });
      try {
        await ingest(db.sql, scope, {
          stream: 'worker',
          source_identity: 'initial',
          source_version: '1',
          source_type: 'message',
          event_at: '2026-06-01T00:00:00Z',
          text: 'our trip is in July',
        });
        const [work] = await db.sql`select id from memory_work where space_id = ${scope.spaceId}`;
        await db.boss.createQueue(MEMORY_EXTRACT_QUEUE);
        await db.boss.send(MEMORY_EXTRACT_QUEUE, { work_id: work?.id, space_id: foreign.spaceId });
        service = await startMemoryService({
          sql: db.sql,
          boss: db.boss,
          gateway: provider.gateway,
          onError: (code) => errors.push(code),
          journal: {
            append: (record) => journal.journal.append(record),
            async read() {
              observedGate =
                (await recall(db.sql, scope, { query: 'trip' })).coverage.reason ===
                'restore_pending';
              expect(provider.requests).toHaveLength(0);
              return journal.journal.read();
            },
          },
        });
        const deadline = Date.now() + 7000;
        let complete = false;
        while (Date.now() < deadline) {
          const result = await recall(db.sql, scope, { query: 'trip' });
          if (result.status === 'complete' && result.items[0]?.content === 'July') {
            complete = true;
            break;
          }
          await Bun.sleep(50);
        }
        expect(complete).toBe(true);
        expect(provider.requests).toHaveLength(1);
        expect((await listClaims(db.sql, foreign)).claims).toHaveLength(0);
        const [finished] =
          await db.sql`select status, calls from memory_work where id = ${work?.id}`;
        expect(finished?.status).toBe('done');
        expect(finished?.calls).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await service?.stop();
        await provider.close();
        await journal.close();
        await db.close();
      }
    }, 20000);

    test('stopping without an extraction gateway stops taking extraction work', async () => {
      if (!parent) return;
      const db = await createTestDatabase(parent.url);
      if (!db) throw new Error('existing Postgres unavailable');
      const journal = await createJournal();
      try {
        const service = await startMemoryService({
          sql: db.sql,
          boss: db.boss,
          journal: journal.journal,
        });
        await service.stop();
        // The database closes after this; a worker still polling would take
        // this job and run it against a closed pool.
        const id = await db.boss.send(MEMORY_EXTRACT_QUEUE, { work_id: 'work-after-stop' });
        await Bun.sleep(3000);
        const [row] = await db.sql`select state from pgboss.job where id = ${id}`;
        expect(row?.state).toBe('created');
      } finally {
        await journal.close();
        await db.close();
      }
    }, 20000);
  });
}
