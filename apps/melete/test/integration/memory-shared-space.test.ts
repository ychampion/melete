/**
 * Automatic memory in a shared space, through the service's own scope
 * resolution: the space owner's messages are kept in the space's memory, and a
 * member's messages are kept nowhere, whichever conversation they were typed in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../../src/ids.ts';
import { captureChat } from '../../src/memory/capture.ts';
import { startServiceMemory } from '../../src/memory/start.ts';
import { createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

withDb('automatic memory in a shared space', () => {
  test("only the space owner's own messages are kept; a member's are kept nowhere", async () => {
    if (!db) return;
    const root = await mkdtemp(join(tmpdir(), 'melete-shared-memory-'));
    const memory = await startServiceMemory(db.sql, db.boss, join(root, 'spaces'));
    try {
      const ownerId = newId('own');
      const memberId = newId('own');
      await db.sql`insert into owner (id, email) values (${ownerId}, ${`${ownerId}@example.test`}) on conflict do nothing`;
      const [installed] = await db.sql`select id from owner limit 1`;
      const owner = installed?.id as string;
      await db.sql`insert into principal (id, email) values (${owner}, ${`${owner}@example.test`}) on conflict do nothing`;
      await db.sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
      const spaceId = newId('sp');
      await db.sql`insert into space (id, name, git_path, kind, owner_principal_id)
        values (${spaceId}, 'Household', ${`test/${spaceId}`}, 'shared', ${owner})`;
      // As createShared makes it: the owner holds an owner membership, the member a member one.
      await db.sql`insert into space_membership (principal_id, space_id, role) values (${owner}, ${spaceId}, 'owner')`;
      await db.sql`insert into space_membership (principal_id, space_id, role) values (${memberId}, ${spaceId}, 'member')`;
      const job = async (principal: string) => {
        const id = newId('job');
        await db.sql`insert into job (id, space_id, principal_id, title, objective, kind, state, revision, lease_epoch)
          values (${id}, ${spaceId}, ${principal}, 'New chat', 'New chat', 'chat', 'completed', 1, 1)`;
        return id;
      };
      const say = (jobId: string, speaker: string, text: string) =>
        db.sql`insert into event (job_id, type, payload, dedup_key) values (${jobId}, 'notice',
          ${JSON.stringify({ kind: 'user_message', text, principal_id: speaker })}::text::jsonb, ${`evt:${newId('turn')}`})`;
      const ownersChat = await job(owner);
      const membersChat = await job(memberId);
      await say(ownersChat, owner, 'Our bins go out on Tuesdays.');
      await say(membersChat, memberId, 'My passport number is X1234567.');
      await say(ownersChat, memberId, 'My bank PIN is 4921.');
      await captureChat({ sql: db.sql, journal: memory.journal, scopeForJob: memory.scopeForJob });
      const kept = await db.sql`select b.content from memory_sources s
        join memory_source_content b on b.source_id = s.id where s.space_id = ${spaceId}`;
      expect(kept.map((row) => row.content)).toEqual(['Our bins go out on Tuesdays.']);
      const anywhere = await db.sql`select count(*)::int as n from memory_source_content
        where content like '%X1234567%' or content like '%4921%'`;
      expect(anywhere[0]?.n).toBe(0);
      const outcomes = await db.sql`select c.outcome from memory_capture c
        join event e on e.seq = c.event_seq where e.job_id in (${ownersChat}, ${membersChat}) order by c.event_seq`;
      expect(outcomes.map((row) => row.outcome)).toEqual([
        'remembered',
        'skipped:member',
        'skipped:member',
      ]);
    } finally {
      await memory.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
