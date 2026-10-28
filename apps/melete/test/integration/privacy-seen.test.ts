import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { SEEN_PART_LIMIT, sentParts } from '../../src/privacy/seen.ts';
import { PostgresPrivacyStore, type Scope } from '../../src/privacy/store.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
afterAll(async () => handle?.close());

const SPACE = 'sp_01JPRIVACYSEEN00000000000';
const OTHER_SPACE = 'sp_01JPRIVACYSEEN00000000001';
const scope: Scope = {
  spaceId: SPACE,
  conversationId: 'job_seen',
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

describe.if(handle !== null)('bounded history of what the model saw over Postgres', () => {
  if (!handle) return;
  const { sql } = handle;
  const store = () => new PostgresPrivacyStore(sql);

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

  test('conversation pruning removes the oldest pieces and retries do not refresh their age', async () => {
    const parts = pieces(242);
    await store().recordSeen(scope, parts.slice(0, 240));
    await store().recordSeen({ ...scope, turnId: 'trn_2' }, [
      ...parts.slice(0, 1),
      ...parts.slice(240),
    ]);
    const rows =
      await sql`select digest from privacy_seen where conversation_id = ${scope.conversationId} order by id`;
    expect(rows).toHaveLength(240);
    expect(rows.map((row) => row.digest)).toEqual(parts.slice(2).map((part) => part.digest));
  });

  test('concurrent conversations respect the space cap and leave other spaces alone', async () => {
    const parts = pieces(240);
    await store().recordSeen({ ...scope, spaceId: OTHER_SPACE, conversationId: 'other' }, parts);
    await store().recordSeen({ ...scope, conversationId: 'oldest' }, parts);
    await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        store().recordSeen({ ...scope, conversationId: `chat_${i}` }, parts),
      ),
    );
    const rows = await sql`select space_id, conversation_id, count(*)::int as count
      from privacy_seen group by space_id, conversation_id`;
    expect(
      rows.filter((row) => row.space_id === SPACE).reduce((sum, row) => sum + Number(row.count), 0),
    ).toBe(2400);
    expect(rows.some((row) => row.conversation_id === 'oldest')).toBe(false);
    expect(rows.find((row) => row.conversation_id === 'other')?.count).toBe(240);
    expect(rows.every((row) => Number(row.count) <= 240)).toBe(true);
  });
});
