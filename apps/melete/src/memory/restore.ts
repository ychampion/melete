import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { prefixedId, timestamp } from '@melete/contracts';
import { z } from 'zod';
import { MemoryError, type MemorySql } from './db.ts';
import { applyRestriction } from './forget.ts';
import { lockEventOrder } from './invalidate.ts';
import { memorySeams } from './seams.ts';

const target = z.strictObject({
  source_id: prefixedId('src'),
  publisher: z.string(),
  stream: z.string(),
  source_identity: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  suppression_id: prefixedId('sup'),
});
export const restrictionRecord = z.strictObject({
  id: prefixedId('sup'),
  owner_id: prefixedId('own'),
  space_id: prefixedId('sp'),
  operation: z.enum(['forget', 'delete', 'revoke', 'clear']),
  all: z.boolean(),
  claim_ids: z.array(prefixedId('k')),
  targets: z.array(target),
  eligibility_cutoff: z.number().int().nonnegative(),
  access_generation: z.number().int().positive(),
  recorded_at: timestamp,
});
export type RestrictionRecord = z.infer<typeof restrictionRecord>;
export interface RestrictionJournal {
  read(): Promise<RestrictionRecord[]>;
  append(record: RestrictionRecord): Promise<void>;
}
const HEADER = 'melete-memory-restrictions-v1';
const digest = (previous: string, record: RestrictionRecord) =>
  createHash('sha256')
    .update(JSON.stringify([previous, record]))
    .digest('hex');

/** This file is retained independently of database snapshots and contains no claim/source text. */
export class FileRestrictionJournal implements RestrictionJournal {
  constructor(readonly path: string) {}
  async initializeNew() {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, 'wx', 0o600);
    try {
      await file.writeFile(`${HEADER}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  private async entries() {
    const text = await readFile(this.path, 'utf8');
    if (!text.endsWith('\n')) throw new MemoryError('restriction_journal_incomplete');
    const lines = text.trimEnd().split('\n');
    if (lines.shift() !== HEADER) throw new MemoryError('restriction_journal_invalid');
    let previous = HEADER;
    const records: RestrictionRecord[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as { previous: string; record: unknown; hash: string };
      const record = restrictionRecord.parse(parsed.record);
      if (parsed.previous !== previous || digest(previous, record) !== parsed.hash)
        throw new MemoryError('restriction_journal_invalid');
      previous = parsed.hash;
      records.push(record);
    }
    return { previous, records };
  }
  async read() {
    return (await this.entries()).records;
  }
  async append(raw: RestrictionRecord) {
    const record = restrictionRecord.parse(raw);
    const { previous, records } = await this.entries();
    if (records.some((item) => item.id === record.id)) return;
    const file = await open(this.path, 'a', 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify({ previous, record, hash: digest(previous, record) })}\n`,
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

/** Startup gate: no serving or extraction resumes until the independently retained journal replays. */
export async function restoreMemory(sql: MemorySql, journal: RestrictionJournal) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    await tx`update memory_spaces set restore_ready = false`;
  });
  return sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    const records = await journal.read();
    // Test-only: the conformance runner's deliberate break skips the replay to
    // prove the scenario that keeps a forgotten fact gone goes red without it.
    if (memorySeams().skipRestrictionReplay) {
      await tx`update memory_spaces set restore_ready = true where not revoked`;
      return 0;
    }
    for (const record of records) {
      const [space] =
        await tx`select * from memory_spaces where space_id = ${record.space_id} and owner_id = ${record.owner_id} for update`;
      if (space) await applyRestriction(tx, record);
    }
    await tx`update memory_spaces set restore_ready = true where not revoked`;
    return records.length;
  });
}
