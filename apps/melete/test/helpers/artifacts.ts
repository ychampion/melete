/**
 * A checked file in a conversation's workspace, as a write with `expect`
 * leaves it: the bytes on disk and the artifact row that records them.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import { recordId } from '../../src/broker/records.ts';

export async function recordFile(
  sql: Sql,
  input: {
    workRoot: string;
    spaceId: string;
    jobId: string;
    path: string;
    content: string | Uint8Array;
    /** Written after the previous version, so it is the newest. */
    at?: Date;
  },
): Promise<string> {
  const bytes =
    typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
  const full = path.join(input.workRoot, input.jobId, ...input.path.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  const id = recordId('art');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const kind = input.path.endsWith('.json') ? 'json' : 'text';
  await sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, kind,
      content_hash, mime, size, expectation, created_at)
    values (${id}, ${input.spaceId}, ${input.jobId}, ${input.jobId}, 'work', ${input.path},
      ${kind}, ${hash}, ${kind === 'json' ? 'application/json' : 'text/plain'}, ${bytes.byteLength},
      ${JSON.stringify({ kind })}::jsonb, ${(input.at ?? new Date()).toISOString()})`;
  return id;
}
