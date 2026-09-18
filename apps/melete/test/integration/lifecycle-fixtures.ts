import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type MemoryScope, newId } from '../../src/memory/db.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import type { TestDatabase } from './postgres.ts';

export async function createJobAttempt(
  db: TestDatabase,
  scope: MemoryScope,
  publicCompartment = false,
) {
  const jobId = newId('job');
  const attemptId = newId('att');
  await db.sql`insert into job (id, space_id, title, objective, state, revision, lease_epoch, constraints)
    values (${jobId}, ${scope.spaceId}, 'Trip', 'trip', 'running', 1, 1, ${JSON.stringify({ public_compartment: publicCompartment, notes: 'Do not book without a new approval.' })}::text::jsonb)`;
  await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model) values (${attemptId}, ${jobId}, 1, 'scripted-v1', 'fake', 'scripted-memory-v1')`;
  return { jobId, attemptId };
}
export async function createJournal() {
  const directory = await mkdtemp(join(tmpdir(), 'melete-lifecycle-journal-'));
  const journal = new FileRestrictionJournal(join(directory, 'restrictions.jsonl'));
  await journal.initializeNew();
  return {
    journal,
    async close() {
      if (
        resolve(directory).startsWith(
          `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}melete-lifecycle-journal-`,
        )
      )
        await rm(directory, { recursive: true, force: true });
    },
  };
}
/** A real table snapshot in Postgres, isolated from the independently retained restriction journal. */
export async function snapshotMemory(db: TestDatabase) {
  const schema = `snapshot_${newId('test').toLowerCase()}`;
  const tables = (
    await db.sql`select tablename from pg_tables where schemaname = 'public' and tablename like 'memory_%'`
  ).map((row) => row.tablename as string);
  if (!tables.every((table) => /^memory_[a-z_]+$/.test(table)))
    throw new Error('invalid snapshot table');
  await db.sql.unsafe(`create schema "${schema}"`);
  for (const table of tables)
    await db.sql.unsafe(`create table "${schema}"."${table}" as table "public"."${table}"`);
  const first = ['memory_spaces', 'memory_streams', 'memory_sources', 'memory_claims'];
  const order = [...first, ...tables.filter((table) => !first.includes(table))];
  return async () => {
    await db.sql.begin(async (tx) => {
      await tx.unsafe(`truncate ${tables.map((table) => `"public"."${table}"`).join(',')}`);
      for (const table of order)
        await tx.unsafe(`insert into "public"."${table}" select * from "${schema}"."${table}"`);
      await tx`update memory_spaces set restore_ready = false`;
      await tx.unsafe(`drop schema "${schema}" cascade`);
    });
  };
}
