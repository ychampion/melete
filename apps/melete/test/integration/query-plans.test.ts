/**
 * Reads the operator console and Home make on every load, held to plans that
 * stay small as the installation grows: each is served by an index rather
 * than by reading a whole table. The statements are the code's own, caught
 * as they are sent, so a rewrite that loses its index fails here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Sql, TransactionSql } from 'postgres';
import { ownChats } from '../../src/experience/starters.ts';
import { newestBackupAt } from '../../src/operator/backup-note.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
afterAll(async () => handle?.close());
const withDb = handle ? describe : describe.skip;

type Sent = { text: string; values: unknown[] };

/** The statements `run` sends, as Postgres receives them, with `$1`, `$2` for the values. */
async function sentBy(run: (sql: Sql) => Promise<unknown>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const recorder = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sent.push({ text: strings.reduce((text, part, i) => `${text}$${i}${part}`), values });
    return Promise.resolve([]);
  };
  await run(recorder as unknown as Sql);
  return sent;
}

/** Runs `body` in a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: TransactionSql) => Promise<T>): Promise<T> {
  if (!handle) throw new Error('Postgres unavailable');
  const undo = new Error('undo');
  let result: T | undefined;
  await handle.sql
    .begin(async (tx) => {
      result = await body(tx);
      throw undo;
    })
    .catch((error: unknown) => {
      if (error !== undo) throw error;
    });
  return result as T;
}

/** The plan as a prepared statement gets it, whatever the values. */
async function genericPlan(tx: TransactionSql, text: string): Promise<string> {
  const rows = await tx.unsafe(`explain (generic_plan, costs off) ${text}`);
  return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
}

withDb('query plans', () => {
  test('Home counts a new person’s chats without reading every job', async () => {
    const [statement] = await sentBy((sql) => ownChats(sql, 'person'));
    if (!statement) throw new Error('no statement sent');
    await rolledBack(async (tx) => {
      // An installation whose owner has many chats from before accounts, which
      // carry no principal: the case that made Postgres read the whole table.
      await tx`set local session_replication_role = replica`;
      await tx`insert into owner (id, email) values ('the-owner', 'owner@example.test')`;
      await tx`insert into job (id, space_id, title, objective, kind)
        select 'chat-' || n, 'space', 'Chat', 'Talk', 'chat' from generate_series(1, 20000) n`;
      await tx`insert into job (id, space_id, title, objective, kind, principal_id)
        select 'mine-' || n, 'space', 'Chat', 'Talk', 'chat', 'regular' from generate_series(1, 2) n`;
      await tx`analyze job`;
      const ran = async (person: string) => {
        const rows = await tx.unsafe(
          `explain (analyze, buffers, costs off, timing off, summary off) ${statement.text}`,
          statement.values.map((value) => (value === 'person' ? person : value)) as never[],
        );
        return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
      };
      const buffers = (plan: string) => {
        const top = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(plan);
        return Number(top?.[1] ?? 0) + Number(top?.[2] ?? 0);
      };
      // A new person with no chats, and one with a couple: a few index pages
      // each, where reading the job table is hundreds.
      for (const person of ['newcomer', 'regular']) {
        const plan = await ran(person);
        expect([person, plan.includes('job_chat_principal_idx'), buffers(plan) < 40, plan]).toEqual(
          [person, true, true, plan],
        );
      }
      // A prepared statement's generic plan reads the person's arm by index too.
      const generic = await genericPlan(tx, statement.text);
      const personArm = generic.split('\n').find((line) => / on job\b/.test(line)) ?? '';
      expect([personArm.includes('job_chat_principal_idx'), generic]).toEqual([true, generic]);
      // The counts themselves: the owner's unattributed chats are theirs.
      expect(await ownChats(tx as unknown as Sql, 'newcomer')).toBe(0);
      expect(await ownChats(tx as unknown as Sql, 'regular')).toBe(2);
      expect(await ownChats(tx as unknown as Sql, 'the-owner')).toBe(3);
    });
  });

  test('the newest backup is found among the backup notes alone', async () => {
    const [statement] = await sentBy((sql) => newestBackupAt(sql));
    if (!statement) throw new Error('no statement sent');
    expect(statement.values).toEqual([]);
    const plan = await rolledBack(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return genericPlan(tx, statement.text);
    });
    expect(plan).toContain('event_backup_note_idx');
  });

  test('a person’s sessions and a space’s sign-in uses are found by index', async () => {
    const plans = await rolledBack(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return Promise.all(
        [
          // The operator console's per-person reads, and signing a person out.
          'select max(s.created_at) from session s where coalesce(s.principal_id, s.owner_id) = $1',
          `select count(*) from session s
            where coalesce(s.principal_id, s.owner_id) = $1 and s.expires_at > now()`,
          `delete from session where coalesce(principal_id, owner_id) = $1
            and token_hash is distinct from $2`,
          // Removing a space.
          'delete from saved_sign_in_use where space_id = $1',
        ].map((text) => genericPlan(tx, text)),
      );
    });
    const [last, live, signOut, removal] = plans;
    expect(last).toContain('session_person_idx');
    expect(live).toContain('session_person_idx');
    expect(signOut).toContain('session_person_idx');
    expect(removal).toContain('saved_sign_in_use_space_idx');
  });
});
