import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { SEEN_PART_LIMIT, sentParts } from '../../src/privacy/seen.ts';
import { PostgresPrivacyStore, type Scope } from '../../src/privacy/store.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
afterAll(async () => handle?.close());

const SPACE = 'sp_01JPRIVACYSEEN00000000000';
const CONVERSATION = 'job_seen';
const OTHER_SPACE = 'sp_01JPRIVACYSEEN00000000001';
const scope: Scope = {
  spaceId: SPACE,
  conversationId: CONVERSATION,
  turnId: 'trn_1',
  jobId: 'job_seen',
  attemptId: 'att_seen',
  agentId: null,
};
const pieces = (count: number, prefix = '') =>
  sentParts(
    {
      messages: Array.from({ length: count }, (_, i) => ({
        role: 'user',
        content: `${prefix} piece ${i}`,
      })),
    },
    'chat/completions',
  );
/** One answer's pieces, as a request in that turn would carry them. */
const turn = (index: number) => pieces(24, `Turn ${index}`);

/** Fails instead of waiting forever when a write is blocked. */
const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms),
    ),
  ]);

describe.if(handle !== null)('bounded history of what the model saw over Postgres', () => {
  if (!handle) return;
  const { sql } = handle;
  const store = () => new PostgresPrivacyStore(sql);
  const live = async (conversationId = CONVERSATION) =>
    (
      await sql`select turn_id from privacy_seen
        where conversation_id = ${conversationId} and text <> '' order by id`
    ).map((row) => String(row.turn_id));

  beforeEach(async () => {
    await resetTestRows(sql);
    await sql`insert into space (id, name, git_path) values
      (${SPACE}, 'Personal', ${`/tmp/${SPACE}`}),
      (${OTHER_SPACE}, 'Shared', ${`/tmp/${OTHER_SPACE}`})`;
  });

  test('the unique index covers duplicate batches, truncated text, retries and resumed turns', async () => {
    const prefix = 'a'.repeat(SEEN_PART_LIMIT);
    const parts = sentParts({ input: `${prefix} first tail` }, 'responses');
    await store().recordSeen(scope, [...parts, ...parts]);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        store().recordSeen({ ...scope, turnId: 'trn_resumed' }, parts),
      ),
    );
    const distinct = sentParts({ input: `${prefix} other tail` }, 'responses');
    await store().recordSeen({ ...scope, turnId: 'trn_resumed' }, distinct);
    const rows = await sql`select turn_id, digest, text, truncated from privacy_seen order by id`;
    expect(rows.map((row) => [row.turn_id, row.text, row.truncated])).toEqual([
      ['trn_1', prefix, true],
      ['trn_resumed', prefix, true],
    ]);
    expect(new Set(rows.map((row) => row.digest)).size).toBe(2);
  });

  test('past the limit whole earlier answers are blanked, and retries do not refresh their age', async () => {
    for (let i = 0; i < 10; i++)
      await store().recordSeen({ ...scope, turnId: `trn_${i}` }, turn(i));
    await store().recordSeen({ ...scope, turnId: 'trn_10' }, [
      ...turn(0).slice(0, 1),
      ...turn(10).slice(0, 12),
    ]);
    const rows = await sql`select turn_id, text, truncated from privacy_seen
      where conversation_id = ${scope.conversationId} order by id`;
    expect(rows).toHaveLength(252);
    const blanked = rows.filter((row) => row.text === '');
    expect(blanked).toHaveLength(24);
    expect(blanked.every((row) => row.turn_id === 'trn_0' && row.truncated === true)).toBe(true);
    expect(await live()).toHaveLength(228);
    expect(await store().seen(CONVERSATION, 'trn_0')).toEqual([]);
    expect(await store().seen(CONVERSATION, 'trn_10')).toHaveLength(12);
  });

  test('re-sending history after the limit does not attach old pieces to the new answer', async () => {
    for (let i = 0; i < 11; i++)
      await store().recordSeen({ ...scope, turnId: `trn_${i}` }, turn(i));
    const [fresh] = pieces(1, 'A new question');
    if (!fresh) throw new Error('no piece');
    await store().recordSeen({ ...scope, turnId: 'trn_11' }, [...turn(0).slice(1), fresh]);
    expect((await store().seen(CONVERSATION, 'trn_11')).map((part) => part.text)).toEqual([
      fresh.text,
    ]);
    const counts = await sql`select count(*)::int as count from privacy_seen
      where conversation_id = ${scope.conversationId} and turn_id = 'trn_11'`;
    expect(counts[0]?.count).toBe(1);
  });

  test('a conversation keeps at most 2400 rows, deleting the oldest blanked ones', async () => {
    for (let i = 0; i < 110; i++)
      await store().recordSeen({ ...scope, turnId: `trn_${i}` }, turn(i));
    const rows = await sql`select turn_id, text from privacy_seen order by id`;
    expect(rows).toHaveLength(2400);
    expect(rows[0]?.turn_id).toBe('trn_10');
    expect(await live()).toHaveLength(240);
    expect(new Set(await live())).toEqual(
      new Set(Array.from({ length: 10 }, (_, i) => `trn_${100 + i}`)),
    );
  });

  test('concurrent turns in one conversation finish while the space row is in use, and the limit holds', async () => {
    for (let i = 0; i < 10; i++)
      await store().recordSeen({ ...scope, turnId: `trn_${i}` }, turn(i));
    // Another write in the space holds the key-share lock a foreign key check takes.
    const other = postgres(handle.url, { max: 1, onnotice: () => {} });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = other.begin(async (tx) => {
      await tx`select id from space where id = ${SPACE} for key share`;
      ready();
      await held;
    });
    try {
      await locked;
      // Each turn re-sends the same pieces, in either order, and adds its own.
      // Writers that did not wait for each other could deadlock on the shared
      // pieces, or each blank only what it saw and leave more than the limit.
      const shared = pieces(24, 'Shared');
      await within(
        10_000,
        Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            store().recordSeen({ ...scope, turnId: `trn_new_${i}` }, [
              ...(i % 2 ? [...shared].reverse() : shared),
              ...turn(100 + i),
            ]),
          ),
        ),
      );
    } finally {
      release();
      await holder;
      await other.end();
    }
    const rows = await sql`select digest, text from privacy_seen
      where conversation_id = ${scope.conversationId}`;
    expect(rows).toHaveLength(408);
    expect(new Set(rows.map((row) => row.digest)).size).toBe(408);
    expect(await live()).toHaveLength(240);
  });

  test('concurrent conversations respect the space text cap and leave other spaces alone', async () => {
    const watched = postgres(handle.url, { max: 4, onnotice: () => {} });
    try {
      const watchedStore = new PostgresPrivacyStore(watched);
      const parts = pieces(240);
      await watchedStore.recordSeen(
        { ...scope, spaceId: OTHER_SPACE, conversationId: 'other' },
        parts,
      );
      await watchedStore.recordSeen({ ...scope, conversationId: 'oldest' }, parts);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          watchedStore.recordSeen({ ...scope, conversationId: `chat_${i}` }, parts),
        ),
      );
      expect(await watchedStore.seen('oldest', 'trn_1')).toEqual([]);
      // Blanked digests still prevent a retry from becoming a later answer.
      await watchedStore.recordSeen(
        { ...scope, conversationId: 'oldest', turnId: 'resumed' },
        parts,
      );
      expect(await watchedStore.seen('oldest', 'resumed')).toEqual([]);
    } finally {
      await watched.end();
    }
    const rows = await sql`select space_id, count(*)::int as count from privacy_seen
      where text <> '' group by space_id`;
    expect(rows.find((row) => row.space_id === SPACE)?.count).toBe(2400);
    expect(rows.find((row) => row.space_id === OTHER_SPACE)?.count).toBe(240);
    const [retained] =
      await sql`select count(*)::int as count from privacy_seen where space_id = ${SPACE}`;
    expect(retained?.count).toBe(2640);
  });

  test('space retention bounds blanked rows and removes the oldest without touching another space', async () => {
    await sql`insert into privacy_seen (space_id, conversation_id, turn_id, source, digest, text, truncated)
      select ${SPACE}, 'old_' || n, 'old', 'you', md5(n::text), '', true
      from generate_series(0, 23999) n order by n`;
    await sql`insert into privacy_seen (space_id, conversation_id, turn_id, source, digest, text, truncated)
      values (${OTHER_SPACE}, 'other', 'old', 'you', 'other', '', true)`;
    await store().recordSeen(scope, turn(1));
    const rows =
      await sql`select space_id, count(*)::int as count from privacy_seen group by space_id`;
    expect(rows.find((row) => row.space_id === SPACE)?.count).toBe(24000);
    expect(rows.find((row) => row.space_id === OTHER_SPACE)?.count).toBe(1);
    const expired = await sql`select conversation_id from privacy_seen
      where space_id = ${SPACE} and conversation_id in ('old_0', 'old_23', 'old_24')`;
    expect(expired.map((row) => row.conversation_id)).toEqual(['old_24']);
    expect(await store().seen(CONVERSATION, scope.turnId ?? '')).toHaveLength(24);
  });
});
