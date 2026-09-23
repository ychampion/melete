/**
 * The pass that decides whether a removal may be called finished.
 *
 * It re-counts rather than trusts. Every table in the database that keys rows
 * by a space is counted again, every path the sweep claimed to remove is
 * stat-ed again, and every provider the sweep called is asked again what it
 * still holds. The table list comes from the live catalog, not from a list
 * written here, so a table a later migration adds is counted without anyone
 * remembering to add it.
 *
 * A phase that could not be reached is not a zero. It is carried through as an
 * omission, and a removal carrying one can never report success.
 */
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PhaseOmission, RemovalCounts, RemovalPhase } from '@melete/contracts';
import type { Sql } from 'postgres';

export type VerifyOptions = {
  spaceId: string;
  jobIds: readonly string[];
  /** An emptied space keeps its row, its id and its membership. */
  emptied: boolean;
  spacesRoot: string;
  workRoot: string;
  omitted: Partial<Record<RemovalPhase, PhaseOmission>>;
  /**
   * What the provider re-listings already found, carried forward from the
   * phases that asked. They are asked there rather than here because a
   * provider is reached through the connection whose account holds it, and
   * those rows are gone by the time this runs.
   */
  providers: Record<string, number>;
  /** Captured at the fence, because the rows that carried them are gone. */
  connectionIds: readonly string[];
  /** Left out, nothing is serving connectors in this process. */
  connectors?: { get(connectionId: string): unknown };
  /** Carried through untouched; nothing here can stop a removal finishing. */
  cleared: Record<string, number>;
};

/**
 * The record of the removal outlives the space on purpose, so it is never
 * counted as something the sweep failed to clear.
 */
const NEVER_COUNTED = ['space_removal'];

/**
 * The space's own membership is not this pass's business. The verification
 * runs as phase 10 and the space row and its memberships go in phase 11, so
 * counting them here would be counting work that has not happened yet. What
 * proves phase 11 did happen is `verifySpaceGone`, below, which runs after it.
 */
const NOT_YET_DUE = ['space_membership'];

/** The directories a space's content lives in, which an emptied space has empty. */
const CONTENT_DIRECTORIES = ['knowledge', 'raw', 'artifacts', 'skills', 'browser'];

/**
 * Children whose only key is their parent's. Their rows go through the parent,
 * so what proves they went is that none of them is left without one.
 */
const ORPHAN_CHECKS: ReadonlyArray<{ child: string; parent: string; key: string; on: string }> = [
  { child: 'memory_revisions', parent: 'memory_claims', key: 'claim_id', on: 'id' },
  { child: 'memory_revision_content', parent: 'memory_claims', key: 'claim_id', on: 'id' },
  { child: 'memory_references', parent: 'memory_claims', key: 'claim_id', on: 'id' },
  { child: 'memory_source_content', parent: 'memory_sources', key: 'source_id', on: 'id' },
  { child: 'memory_output_uses', parent: 'memory_outputs', key: 'output_row_id', on: 'id' },
];

/** Tables whose `job_id` is nulled rather than cascaded when a job goes. */
const JOB_KEYED_SURVIVORS = [
  'submission',
  'acceptance_journal',
  'reply_obligation',
  'notification',
  'artifact',
];

export async function verifyRemoval(raw: Sql, options: VerifyOptions): Promise<RemovalCounts> {
  const tables: Record<string, number> = {};
  const skip = new Set([...NEVER_COUNTED, ...NOT_YET_DUE]);

  const keyed = await raw<
    { table_name: string }[]
  >`select c.table_name from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'space_id' and t.table_type = 'BASE TABLE'
    order by c.table_name`;
  for (const row of keyed) {
    const name = String(row.table_name);
    if (skip.has(name)) continue;
    tables[name] = await countWhere(raw, name, raw`space_id = ${options.spaceId}`);
  }

  // A job row is gone by now, so its leftovers are found by the ids the fence
  // captured rather than by the space they belonged to.
  const ids = [...options.jobIds];
  if (ids.length)
    for (const name of JOB_KEYED_SURVIVORS)
      tables[name] = (tables[name] ?? 0) + (await countWhere(raw, name, raw`job_id = any(${ids})`));

  for (const check of ORPHAN_CHECKS)
    tables[check.child] =
      (tables[check.child] ?? 0) +
      (await countOrphans(raw, check.child, check.parent, check.key, check.on));

  // The one pointer another space's rows can hold into this one.
  tables.procedure_candidate =
    (tables.procedure_candidate ?? 0) +
    (await countWhere(raw, 'procedure_candidate', raw`canary_space_id = ${options.spaceId}`));

  return {
    tables,
    paths: await remainingPaths(options),
    providers: {
      ...options.providers,
      // Nothing in this process may still answer for a connection of a space
      // that is going. A recreated one is refused separately, by the removal
      // stamp the default-connection query reads.
      connectors_served: options.connectionIds.filter(
        (id) => options.connectors?.get(id) !== undefined,
      ).length,
    },
    omitted: options.omitted,
    cleared: options.cleared,
  };
}

/**
 * The last thing phase 11 does, checked after it has done it. Folded into the
 * same counts, so the one rule that lets a removal finish — every number zero
 * and nothing omitted — covers the space row itself as well as its contents.
 */
export async function verifySpaceGone(
  raw: Sql,
  spaceId: string,
): Promise<{ space: number; space_membership: number }> {
  const [space] = await raw<{ count: number }[]>`select count(*)::int as count
    from space where id = ${spaceId}`;
  const [membership] = await raw<{ count: number }[]>`select count(*)::int as count
    from space_membership where space_id = ${spaceId}`;
  return { space: Number(space?.count ?? 0), space_membership: Number(membership?.count ?? 0) };
}

async function countWhere(raw: Sql, table: string, where: ReturnType<Sql>): Promise<number> {
  const [row] = await raw<{ count: number }[]>`select count(*)::int as count
    from ${raw(table)} where ${where}`;
  return Number(row?.count ?? 0);
}

async function countOrphans(
  raw: Sql,
  child: string,
  parent: string,
  key: string,
  on: string,
): Promise<number> {
  const [row] = await raw<{ count: number }[]>`select count(*)::int as count
    from ${raw(child)} c left join ${raw(parent)} p on p.${raw(on)} = c.${raw(key)}
    where p.${raw(on)} is null`;
  return Number(row?.count ?? 0);
}

/** Every path the sweep claimed to clear, stat-ed again. */
async function remainingPaths(options: VerifyOptions): Promise<string[]> {
  const remaining: string[] = [];
  const spacesRoot = resolve(options.spacesRoot);
  const workRoot = resolve(options.workRoot);
  for (const id of options.jobIds) {
    const workspace = join(workRoot, id);
    if (await exists(workspace)) remaining.push(workspace);
  }
  const directory = join(spacesRoot, options.spaceId);
  if (!options.emptied) {
    if (await exists(directory)) remaining.push(directory);
    return remaining;
  }
  // An emptied space is present and empty: a fresh repository, and nothing of
  // what was in it. The browser profile is gone outright, which is what signs
  // the space out of every site it was signed in to.
  for (const name of CONTENT_DIRECTORIES) {
    const content = join(directory, name);
    if (!(await exists(content))) continue;
    const entries = await readdir(content);
    if (entries.length > 0) remaining.push(content);
  }
  return remaining;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
