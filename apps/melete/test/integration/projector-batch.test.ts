import { afterAll, describe, expect, test } from 'bun:test';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { onEventOrderHeld } from '../../src/db/lock-guard.ts';
import { event, job, principal, schema, space } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { principalContext, requestPrincipal } from '../../src/principals/authority.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const suite = handle ? describe : describe.skip;

suite('conversation projection batches', () => {
  const { db, sql: query } = handle ?? ({} as NonNullable<typeof handle>);
  afterAll(() => handle?.close());

  async function conversations(count: number, principalId?: string) {
    const spaceId = newId('sp');
    await db
      .insert(space)
      .values({ id: spaceId, name: 'Projection', gitPath: `/spaces/${spaceId}` });
    const rows = await db
      .insert(job)
      .values(
        Array.from({ length: count }, (_, index) => ({
          id: newId('job'),
          spaceId,
          principalId,
          kind: 'chat',
          title: `Conversation ${index}`,
          objective: 'Answer.',
        })),
      )
      .returning();
    return { spaceId, rows };
  }

  async function say(ids: string[]) {
    return serviceTransaction(db, async (tx) => {
      const rows = [];
      for (const id of ids)
        rows.push(
          await appendEvent(tx, {
            jobId: id,
            type: 'notice',
            payload: { kind: 'experience_say', text: 'Ready.' },
            dedupKey: newId('op'),
          }),
        );
      return rows;
    });
  }

  test('space sync projects every changed conversation with one event-order acquisition', async () => {
    const { spaceId, rows } = await conversations(4);
    await say(rows.map((row) => row.id));
    const projection = new ExperienceEvents(db);
    let holds = 0;
    const stop = onEventOrderHeld(() => holds++);
    try {
      await projection.sync(spaceId);
      expect(holds).toBe(1);
      const projected = await db
        .select()
        .from(event)
        .where(
          and(
            inArray(
              event.jobId,
              rows.map((row) => row.id),
            ),
            sql`${event.payload}->>'kind' = 'experience'`,
          ),
        )
        .orderBy(asc(event.seq));
      expect(projected).toHaveLength(4);
      expect(new Set(projected.map((row) => row.jobId)).size).toBe(4);
      expect(required(projected.at(-1)).seq - required(projected[0]).seq).toBe(3);
      await projection.sync(spaceId);
      expect(holds).toBe(1);
    } finally {
      stop();
    }
  });

  test('four conversations share one event insert and one cursor update statement', async () => {
    const { spaceId, rows } = await conversations(4);
    const ids = rows.map((row) => row.id);
    const sources = await say(ids);
    const tableName = `projection_writes_${newId('op')}`;
    const functionName = `projection_count_${newId('op')}`;
    const eventTrigger = `projection_insert_${newId('op')}`;
    const cursorTrigger = `projection_cursor_${newId('op')}`;
    try {
      await query`create table ${query(tableName)} (kind text not null)`;
      await query.unsafe(`create function "${functionName}"() returns trigger language plpgsql as $$
        begin insert into "${tableName}"(kind) values (TG_ARGV[0]); return null; end $$`);
      await query`create trigger ${query(eventTrigger)} after insert on event
        for each statement execute function ${query(functionName)}('event')`;
      await query`create trigger ${query(cursorTrigger)} after update of experience_cursor on job
        for each statement execute function ${query(functionName)}('cursor')`;
      const statements: string[] = [];
      const logged = drizzle(query, {
        schema,
        logger: { logQuery: (statement) => statements.push(statement) },
      });
      await new ExperienceEvents(logged).sync(spaceId);
      const notifications = statements.filter((statement) => statement.includes('pg_notify'));
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('update "job"');
      const counts = await query`select kind, count(*)::int as count from ${query(tableName)}
        group by kind order by kind`;
      expect([...counts]).toEqual([
        { kind: 'cursor', count: 1 },
        { kind: 'event', count: 1 },
      ]);
      const projected = await db
        .select()
        .from(event)
        .where(and(inArray(event.jobId, ids), sql`${event.payload}->>'kind' = 'experience'`));
      expect(projected).toHaveLength(4);
      const cursors = await db
        .select({ id: job.id, cursor: job.experienceCursor, group: job.experienceGroup })
        .from(job)
        .where(inArray(job.id, ids));
      for (const value of sources) {
        const source = required(value);
        expect(cursors.find((row) => row.id === source.jobId)?.cursor).toBe(source.seq);
        expect(cursors.find((row) => row.id === source.jobId)?.group).toEqual([]);
      }
    } finally {
      await query`drop trigger if exists ${query(eventTrigger)} on event`;
      await query`drop trigger if exists ${query(cursorTrigger)} on job`;
      await query`drop function if exists ${query(functionName)}()`;
      await query`drop table if exists ${query(tableName)}`;
    }
  });

  test('a projector wake batches spaces while each lookup keeps its own principal', async () => {
    const people = [newId('own'), newId('own')];
    await db
      .insert(principal)
      .values(people.map((id, index) => ({ id, email: `projection-${id}-${index}@example.test` })));
    const internal = 'internal';
    const chats = [
      ...(await Promise.all(people.map((person) => conversations(1, person)))),
      await conversations(1),
    ];
    let wake = () => {};
    const ready = Promise.withResolvers<void>();
    class Projector extends ExperienceEvents {
      protected override async newest() {
        const head = await super.newest();
        ready.resolve();
        return head;
      }
    }
    const seen: string[] = [];
    const projection = new Projector(
      db,
      {
        permission: async (_spaceId, id) => {
          expect(requestPrincipal()).toBe(id === internal ? undefined : id);
          seen.push(id);
          return undefined;
        },
        question: async () => undefined,
      },
      {
        subscribe(listener) {
          wake = listener;
          return () => {};
        },
      },
    );
    await ready.promise;
    await serviceTransaction(db, async (tx) => {
      for (const [index, chat] of chats.entries())
        await appendEvent(tx, {
          jobId: required(chat.rows[0]).id,
          type: 'approval_requested',
          payload: { approval_id: people[index] ?? internal },
          dedupKey: newId('op'),
        });
    });
    let holds = 0;
    const stop = onEventOrderHeld(() => holds++);
    try {
      // Wake from an unrelated ambient principal; every conversation supplies its own.
      principalContext.run('unrelated', wake);
      await eventually(async () => {
        const rows = await db
          .select({ cursor: job.experienceCursor })
          .from(job)
          .where(
            inArray(
              job.id,
              chats.map((chat) => required(chat.rows[0]).id),
            ),
          );
        return rows.every((row) => row.cursor > 0);
      });
      expect(seen.sort()).toEqual([...people, internal].sort());
      expect(holds).toBe(1);
      // Keep the projector alive through its completed wake.
      expect(projection).toBeInstanceOf(ExperienceEvents);
    } finally {
      stop();
    }
  });

  test('projection cannot commit behind a sequence a reader already passed', async () => {
    const { spaceId, rows } = await conversations(3);
    await say(rows.map((row) => row.id));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let earlier = 0;
    const writer = serviceTransaction(db, async (tx) => {
      earlier = required(
        await appendEvent(tx, { type: 'notice', payload: {}, dedupKey: newId('op') }),
      ).seq;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let complete = false;
    const projecting = new ExperienceEvents(db).sync(spaceId).then(() => {
      complete = true;
    });
    try {
      await Bun.sleep(100);
      expect(complete).toBe(false);
      const [visible] = await db
        .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)` })
        .from(event);
      expect(Number(required(visible).seq)).toBeLessThan(earlier);
    } finally {
      release.resolve();
    }
    await writer;
    await projecting;
    const [head] = await db.select({ seq: sql<number>`max(${event.seq})` }).from(event);
    const passed = Number(required(head).seq);
    const later = await serviceTransaction(db, (tx) =>
      appendEvent(tx, { type: 'notice', payload: {}, dedupKey: newId('op') }),
    );
    expect(required(later).seq).toBeGreaterThan(passed);
    const projected = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(
            event.jobId,
            rows.map((row) => row.id),
          ),
          sql`${event.payload}->>'kind' = 'experience'`,
        ),
      );
    expect(projected).toHaveLength(3);
    expect(projected.every((row) => row.seq > earlier && row.seq <= passed)).toBe(true);
  });

  test('a failed lookup does not leave healthy conversations behind the scan cursor', async () => {
    const { spaceId, rows } = await conversations(2);
    await serviceTransaction(db, async (tx) => {
      await appendEvent(tx, {
        jobId: required(rows[0]).id,
        type: 'approval_requested',
        payload: { approval_id: 'broken' },
        dedupKey: newId('op'),
      });
      await appendEvent(tx, {
        jobId: required(rows[1]).id,
        type: 'notice',
        payload: { kind: 'experience_say', text: 'Healthy.' },
        dedupKey: newId('op'),
      });
    });
    const projection = new ExperienceEvents(db, {
      permission: async () => {
        throw new Error('Lookup unavailable');
      },
      question: async () => undefined,
    });
    const failure = await projection.sync(spaceId).catch((error: unknown) => error);
    expect(String(failure)).toContain('Lookup unavailable');
    const projected = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(
            event.jobId,
            rows.map((row) => row.id),
          ),
          sql`${event.payload}->>'kind' = 'experience'`,
        ),
      );
    expect(projected).toHaveLength(1);
    expect(required(projected[0]).jobId).toBe(required(rows[1]).id);
  });

  test('linked conversations keep independent source windows across full pages', async () => {
    const { spaceId, rows } = await conversations(2);
    const parents = rows.map((row) => row.id);
    const children = parents.map(() => newId('job'));
    await db.insert(job).values(
      children.map((id, index) => ({
        id,
        spaceId,
        experienceParentId: required(parents[index]),
        title: 'Linked work',
        objective: 'Answer.',
      })),
    );
    const opened = await say(parents);
    const sources = await serviceTransaction(db, (tx) =>
      tx
        .insert(event)
        .values(
          Array.from({ length: 1001 }, (_, index) =>
            children.map((id) => ({
              jobId: id,
              type: 'notice',
              payload: { kind: 'experience_say', text: `Step ${index}.` },
              dedupKey: newId('op'),
            })),
          ).flat(),
        )
        .returning(),
    );
    // One parent has already passed its own opening; the other has not.
    await db
      .update(job)
      .set({ experienceCursor: required(opened[0]).seq })
      .where(eq(job.id, required(parents[0])));
    const projection = new ExperienceEvents(db);
    let holds = 0;
    const stop = onEventOrderHeld(() => holds++);
    try {
      await projection.sync(spaceId);
      // Each transaction covers one bounded page of both conversations.
      expect(holds).toBe(2);
      const projected = await db
        .select()
        .from(event)
        .where(
          and(
            inArray(event.jobId, [...parents, ...children]),
            sql`${event.payload}->>'kind' = 'experience'`,
          ),
        )
        .orderBy(asc(event.seq));
      expect(projected).toHaveLength(2003);
      for (const [index, id] of parents.entries()) {
        const expected = sources
          .filter((row) => row.jobId === children[index])
          .map((row) => row.seq);
        if (index === 1) expected.unshift(required(opened[1]).seq);
        expect(
          projected
            .filter((row) => row.jobId === id)
            .map((row) => Number((row.payload as { source_seq: number }).source_seq)),
        ).toEqual(expected);
      }
      expect(projected.every((row) => row.seq > required(sources.at(-1)).seq)).toBe(true);
      const cursors = await db
        .select({ id: job.id, cursor: job.experienceCursor })
        .from(job)
        .where(inArray(job.id, [...parents, ...children]));
      for (const [index, id] of parents.entries())
        expect(cursors.find((row) => row.id === id)?.cursor).toBe(
          required(sources.filter((row) => row.jobId === children[index]).at(-1)).seq,
        );
      for (const id of children) expect(cursors.find((row) => row.id === id)?.cursor).toBe(0);
      await projection.sync(spaceId);
      expect(holds).toBe(2);
    } finally {
      stop();
    }
  });

  test('a failed shared write rolls back before retrying healthy conversations exactly once', async () => {
    const { spaceId, rows } = await conversations(2);
    const healthyId = required(rows[0]).id;
    const failedId = required(rows[1]).id;
    const sequenceName = `projection_seen_${newId('op')}`;
    const functionName = `projection_fault_${newId('op')}`;
    const triggerName = `projection_fault_${newId('op')}`;
    let wake = () => {};
    const ready = Promise.withResolvers<void>();
    class Projector extends ExperienceEvents {
      protected override async newest() {
        const head = await super.newest();
        ready.resolve();
        return head;
      }

      protected override async changedBetween(from: number, through: number) {
        const changed = await super.changedBetween(from, through);
        // Make the healthy insert precede the failing insert in this transaction.
        return changed.sort((left, right) =>
          left.id === healthyId ? -1 : right.id === healthyId ? 1 : 0,
        );
      }
    }
    const projection = new Projector(db, undefined, {
      subscribe(listener) {
        wake = listener;
        return () => {};
      },
    });
    await ready.promise;
    const sources = await say([healthyId, failedId]);
    let holds = 0;
    const stop = onEventOrderHeld(() => holds++);
    try {
      await query`create sequence ${query(sequenceName)}`;
      // All names and ids come from this fixture. A sequence survives rollback,
      // so it records that the first conversation was actually inserted in
      // the failing transaction, rather than merely looked up before it.
      await query.unsafe(`create function "${functionName}"() returns trigger language plpgsql as $$
        begin
          if new.job_id = '${failedId}' and new.payload->>'kind' = 'experience' then
            if exists (select 1 from event where job_id = '${healthyId}'
                and payload->>'kind' = 'experience' and xmin::text::bigint = txid_current()) then
              perform nextval('"${sequenceName}"');
            end if;
            raise exception 'Projection write unavailable';
          end if;
          return new;
        end
      $$`);
      await query`create trigger ${query(triggerName)} before insert on event
        for each row execute function ${query(functionName)}()`;
      wake();
      // The shared rollback, healthy retry and failing retry have all ended.
      await eventually(async () => holds >= 3);
      const [observed] = await query`select is_called from ${query(sequenceName)}`;
      expect(observed?.is_called).toBe(true);
      const projected = await db
        .select()
        .from(event)
        .where(
          and(
            inArray(event.jobId, [healthyId, failedId]),
            sql`${event.payload}->>'kind' = 'experience'`,
          ),
        );
      expect(projected).toHaveLength(1);
      expect(required(projected[0]).jobId).toBe(healthyId);
      const cursors = await db
        .select({ id: job.id, cursor: job.experienceCursor })
        .from(job)
        .where(inArray(job.id, [healthyId, failedId]));
      expect(cursors.find((row) => row.id === healthyId)?.cursor).toBe(required(sources[0]).seq);
      expect(cursors.find((row) => row.id === failedId)?.cursor).toBe(0);

      await query`drop trigger ${query(triggerName)} on event`;
      await projection.sync(spaceId);
      const recovered = await db
        .select({ id: event.jobId })
        .from(event)
        .where(
          and(
            inArray(event.jobId, [healthyId, failedId]),
            sql`${event.payload}->>'kind' = 'experience'`,
          ),
        );
      expect(recovered).toHaveLength(2);
      expect(recovered.filter((row) => row.id === healthyId)).toHaveLength(1);
      expect(recovered.filter((row) => row.id === failedId)).toHaveLength(1);
      const recoveredCursors = await db
        .select({ id: job.id, cursor: job.experienceCursor })
        .from(job)
        .where(inArray(job.id, [healthyId, failedId]));
      expect(recoveredCursors.find((row) => row.id === failedId)?.cursor).toBe(
        required(sources[1]).seq,
      );
    } finally {
      stop();
      await query`drop trigger if exists ${query(triggerName)} on event`;
      await query`drop function if exists ${query(functionName)}()`;
      await query`drop sequence if exists ${query(sequenceName)}`;
    }
  });
});

async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('Projection did not finish');
    await Bun.sleep(10);
  }
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture row');
  return value;
}
