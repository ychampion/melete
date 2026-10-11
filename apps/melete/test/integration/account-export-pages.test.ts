/**
 * A download of everything an account holds, read slowly, holds no database
 * connection while it waits for the reader, and still carries every record
 * once, in order, without the columns an export leaves out.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountExport } from '../../src/account/export.ts';
import type { ZipEntry } from '../../src/account/zip.ts';
import { recordId } from '../../src/broker/records.ts';
import { openDatabase } from '../../src/db/client.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const databaseTest = handle ? test : test.skip;
const spacesRoot = await mkdtemp(join(tmpdir(), 'melete-export-pages-'));
afterAll(async () => {
  await handle?.close();
  await rm(spacesRoot, { recursive: true, force: true });
});

const TASKS = 450;
const DAYS = 430;
const CODES = 230;

async function seed() {
  if (!handle) throw new Error('Postgres unavailable');
  const { sql } = handle;
  const principal = recordId('prn');
  const space = recordId('sp');
  await sql`insert into principal (id, email, kind)
    values (${principal}, ${`${principal.toLowerCase()}@example.test`}, 'person')`;
  await sql`insert into space (id, name, kind, owner_principal_id, git_path)
    values (${space}, 'Personal', 'personal', ${principal}, ${join(spacesRoot, space)})`;
  await sql`insert into task (id, space_id, title)
    select 'task_' || ${space} || '_' || lpad(n::text, 5, '0'), ${space}, 'Errand ' || n
    from generate_series(1, ${TASKS}) n`;
  // A record keyed by six columns.
  await sql`insert into usage_day (day, principal_id, space_id, class, tier, purpose, calls,
      input_tokens, cached_input_tokens, cache_write_tokens, charged_input_tokens, output_tokens,
      cost_usd)
    select '2026-10-' || lpad((n % 28 + 1)::text, 2, '0'), ${principal}, ${space},
      'class-' || (n % 3), 'tier-' || (n % 5), 'purpose-' || n, n, 0, 0, 0, 0, 0, 0
    from generate_series(1, ${DAYS}) n`;
  // A record keyed by a column the export leaves out.
  const client = recordId('mcpc');
  await sql`insert into mcp_client (id, name, redirect_uris)
    values (${client}, 'Client', '[]'::jsonb)`;
  await sql`insert into mcp_authorization (code_hash, client_id, principal_id, space_id,
      redirect_uri, code_challenge, resource, scope, expires_at)
    select md5(${space} || n::text), ${client}, ${principal}, ${space}, 'https://example.test/',
      'challenge', 'resource', 'scope', now() + interval '1 day'
    from generate_series(1, ${CODES}) n`;
  return { principal, space };
}

async function text(data: ZipEntry['data']): Promise<string> {
  if (typeof data === 'string') return data;
  let out = '';
  for await (const chunk of data as AsyncIterable<string | Uint8Array>)
    out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  return out;
}

databaseTest(
  'a records file half read holds no connection: the only one in the pool stays free',
  async () => {
    if (!handle) return;
    const { principal } = await seed();
    const one = openDatabase(handle.url, 1);
    try {
      let checked = false;
      for await (const entry of accountExport({ sql: one.sql, spacesRoot }, principal)) {
        if (!entry.name.endsWith('/records/task.json')) continue;
        const reader = (entry.data as AsyncIterable<string>)[Symbol.asyncIterator]();
        // The reader takes the first rows, then stops for a while.
        await reader.next();
        await reader.next();
        const free = await Promise.race([
          one.sql`select 1 as free`.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
        ]);
        expect(free).toBe(true);
        let rest = '';
        for (let next = await reader.next(); !next.done; next = await reader.next())
          rest += next.value;
        expect(rest.endsWith('\n]\n')).toBe(true);
        checked = true;
      }
      expect(checked).toBe(true);
    } finally {
      await one.close();
    }
  },
  30_000,
);

databaseTest(
  'every record comes through once, in key order, without the columns left out',
  async () => {
    if (!handle) return;
    const { principal, space } = await seed();
    const files = new Map<string, string>();
    for await (const entry of accountExport({ sql: handle.sql, spacesRoot }, principal))
      if (entry.name.includes('/records/'))
        files.set(entry.name.split('/').at(-1) ?? '', await text(entry.data));
    const tasks = JSON.parse(files.get('task.json') ?? '[]') as { id: string; space_id: string }[];
    expect(tasks).toHaveLength(TASKS);
    expect(new Set(tasks.map((row) => row.id)).size).toBe(TASKS);
    expect(tasks.map((row) => row.id)).toEqual([...tasks.map((row) => row.id)].sort());
    expect(tasks.every((row) => row.space_id === space)).toBe(true);
    const days = JSON.parse(files.get('usage_day.json') ?? '[]') as Record<string, unknown>[];
    expect(days).toHaveLength(DAYS);
    expect(new Set(days.map((row) => row.purpose)).size).toBe(DAYS);
    const codes = JSON.parse(files.get('mcp_authorization.json') ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(codes).toHaveLength(CODES);
    for (const row of [...days, ...codes, ...tasks]) {
      expect(Object.keys(row)).not.toContain('code_hash');
      expect(Object.keys(row).some((name) => name.startsWith('__'))).toBe(false);
    }
  },
);
