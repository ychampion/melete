import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { event, schema } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { newId } from '../../src/ids.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

withDb('event append statements', () => {
  afterAll(() => handle?.close());

  test('a known epoch inserts, returns the original row and notifies in one statement', async () => {
    const statements: string[] = [];
    const logged = drizzle(required(handle).sql, {
      schema,
      logger: { logQuery: (statement) => statements.push(statement) },
    });
    const key = newId('op');
    const row = await serviceTransaction(logged, (tx) =>
      appendEvent(tx, { type: 'notice', epoch: 7, dedupKey: key, payload: { value: 'kept' } }),
    );
    const writes = statements.filter((statement) => !statement.includes('pg_advisory'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('pg_notify');
    expect(row).toMatchObject({
      jobId: null,
      attemptId: null,
      type: 'notice',
      epoch: 7,
      dedupKey: key,
      payload: { value: 'kept' },
    });
    expect(required(row).createdAt).toBeInstanceOf(Date);
    const [persisted] = await required(handle)
      .db.select()
      .from(event)
      .where(eq(event.dedupKey, key));
    expect(row).toEqual(persisted);
  });

  test('notifications wait for commit and are absent for duplicates and rollback', async () => {
    const db = required(handle).db;
    const observed: string[] = [];
    const listener = await required(handle).sql.listen('melete_events', (value) =>
      observed.push(value),
    );
    const key = newId('op');
    try {
      const first = await serviceTransaction(db, async (tx) => {
        const row = await appendEvent(tx, { type: 'notice', epoch: null, dedupKey: key });
        await Bun.sleep(20);
        expect(observed).toEqual([]);
        return required(row);
      });
      const duplicate = await serviceTransaction(db, (tx) =>
        appendEvent(tx, { type: 'notice', epoch: null, dedupKey: key }),
      );
      expect(duplicate).toBeUndefined();
      const marker = new Error('Roll back the event');
      const rolledBack = newId('op');
      const failure = await serviceTransaction(db, async (tx) => {
        await appendEvent(tx, { type: 'notice', epoch: null, dedupKey: rolledBack });
        throw marker;
      }).catch((error: unknown) => error);
      expect(failure).toBe(marker);
      const last = required(
        await serviceTransaction(db, (tx) =>
          appendEvent(tx, { type: 'notice', epoch: null, dedupKey: newId('op') }),
        ),
      );
      // Notifications on this channel arrive in commit order. The last one is
      // also a barrier for any spurious duplicate or rolled-back notification.
      const deadline = Date.now() + 2000;
      while (!observed.includes(String(last.seq)) && Date.now() < deadline) await Bun.sleep(5);
      expect(observed).toEqual([String(first.seq), String(last.seq)]);
      expect(await db.select().from(event).where(eq(event.dedupKey, rolledBack))).toEqual([]);
    } finally {
      await listener.unlisten();
    }
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a database fixture');
  return value;
}
