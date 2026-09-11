/**
 * E1. The output ledger and the repair brief.
 *
 * Before this, a correction knew only what had been *delivered* to an attempt,
 * so the only safe response was to invalidate everything that had ever seen the
 * claim. Here an output says what it used. A correction then does two precise
 * things: it marks stale exactly the outputs that cited the superseded revision,
 * and it writes a repair brief naming the handle that moved, the value before and
 * after, and where in each output the old value sits.
 *
 * Outputs with an empty manifest still exist - chat prose, mostly - and they keep
 * the conservative rule. They are recorded as `unattributed` on the context
 * record so a reader can tell which outputs the precise rule did not cover.
 */
import {
  claimHandleOf,
  type OutputAttribution,
  outputAttribution,
  parseMemoryHandle,
  type RepairBrief,
  repairBrief,
} from '@melete/contracts';
import {
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  stableId,
} from './db.ts';

const outputRowId = (spaceId: string, input: OutputAttribution) =>
  `mo_${stableId(spaceId, input.kind, input.output_id, input.output_version)}`;

export type RecordedOutput = {
  output_id: string;
  output_version: string;
  attributed: boolean;
  unknown_handles: string[];
};

/**
 * Record one output and its manifest. Handles memory has no record of are kept
 * on the row but never turn into a dependency: a manifest is a declaration, and
 * a declaration that names something that does not exist is evidence about the
 * declarer rather than about memory.
 */
export async function recordOutput(
  sql: MemorySql,
  scope: MemoryScope,
  raw: unknown,
): Promise<RecordedOutput> {
  const input = outputAttribution.parse(raw);
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    const [job] =
      await tx`select id from job where id = ${input.job_id} and space_id = ${scope.spaceId}`;
    if (!job) throw new MemoryError('scope_denied');
    const id = outputRowId(scope.spaceId, input);
    const attributed = input.uses.length > 0;
    await tx`insert into memory_outputs (id, space_id, job_id, attempt_id, kind, output_id, output_version, location, attributed)
      values (${id}, ${scope.spaceId}, ${input.job_id}, ${input.attempt_id}, ${input.kind}, ${input.output_id}, ${input.output_version}, ${input.location}, ${attributed})
      on conflict (id) do update set location = excluded.location, attributed = excluded.attributed, attempt_id = excluded.attempt_id, stale = false`;
    await tx`delete from memory_output_uses where output_row_id = ${id}`;
    const unknown: string[] = [];
    for (const handle of new Set(input.uses)) {
      const parsed = parseMemoryHandle(handle);
      if (!parsed) {
        unknown.push(handle);
        continue;
      }
      if (parsed.kind === 'claim') {
        const [known] =
          await tx`select 1 as ok from memory_revisions r join memory_claims c on c.id = r.claim_id
          where r.claim_id = ${parsed.claim_id} and r.revision = ${parsed.revision} and c.space_id = ${scope.spaceId}`;
        if (!known) unknown.push(handle);
        await tx`insert into memory_output_uses (output_row_id, handle, handle_kind, claim_id, revision)
          values (${id}, ${handle}, 'claim', ${parsed.claim_id}, ${parsed.revision}) on conflict do nothing`;
        await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
          values (${scope.spaceId}, 'claim', ${parsed.claim_id}, ${String(parsed.revision)}, ${input.kind}, ${input.output_id}, ${input.output_version}) on conflict do nothing`;
        continue;
      }
      const [known] =
        await tx`select 1 as ok from memory_sources where id = ${parsed.source_id} and space_id = ${scope.spaceId} and source_version = ${parsed.source_version}`;
      if (!known) unknown.push(handle);
      await tx`insert into memory_output_uses (output_row_id, handle, handle_kind, source_id, source_version)
        values (${id}, ${handle}, 'source', ${parsed.source_id}, ${parsed.source_version}) on conflict do nothing`;
      await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'source', ${parsed.source_id}, ${parsed.source_version}, ${input.kind}, ${input.output_id}, ${input.output_version}) on conflict do nothing`;
    }
    if (!attributed && input.attempt_id) {
      // The conservative rule still covers it; the context record says so out loud.
      await tx`update memory_contexts set unattributed = (
        select to_jsonb(array(select distinct value from jsonb_array_elements_text(unattributed || ${JSON.stringify([`${input.kind}:${input.output_id}@${input.output_version}`])}::text::jsonb) as value)))
        where attempt_id = ${input.attempt_id} and space_id = ${scope.spaceId}`;
    }
    return {
      output_id: input.output_id,
      output_version: input.output_version,
      attributed,
      unknown_handles: unknown,
    };
  });
}

export type AffectedOutput = {
  row_id: string;
  job_id: string;
  kind: 'artifact' | 'plan_step' | 'action';
  output_id: string;
  output_version: string;
  location: string | null;
};

/** Exactly the outputs whose manifest cites this revision. Nothing wider. */
export async function outputsCiting(
  tx: MemoryTx,
  spaceId: string,
  claimId: string,
  revision: number,
): Promise<AffectedOutput[]> {
  const rows = await tx`select o.id, o.job_id, o.kind, o.output_id, o.output_version, o.location
    from memory_outputs o join memory_output_uses u on u.output_row_id = o.id
    where o.space_id = ${spaceId} and u.claim_id = ${claimId} and u.revision = ${revision}
    order by o.created_at, o.id`;
  return rows.map((row) => ({
    row_id: row.id as string,
    job_id: row.job_id as string,
    kind: row.kind as AffectedOutput['kind'],
    output_id: row.output_id as string,
    output_version: row.output_version as string,
    location: (row.location as string | null) ?? null,
  }));
}

export type CorrectionFacts = {
  claimId: string;
  key: string | null;
  oldRevision: number;
  newRevision: number | null;
  oldValue: string;
  newValue: string;
};

/**
 * Mark the citing outputs stale and write one brief per responsibility they
 * belong to. Returns the jobs that got a brief, so the caller knows which ones
 * are covered precisely and do not need the conservative sweep.
 */
export async function writeRepairBriefs(
  tx: MemoryTx,
  scope: MemoryScope,
  facts: CorrectionFacts,
): Promise<string[]> {
  const affected = await outputsCiting(tx, scope.spaceId, facts.claimId, facts.oldRevision);
  if (!affected.length) return [];
  const changed = claimHandleOf(facts.claimId, facts.oldRevision);
  const replacement = facts.newRevision ? claimHandleOf(facts.claimId, facts.newRevision) : null;
  for (const output of affected)
    await tx`update memory_outputs set stale = true where id = ${output.row_id}`;
  const jobs = [...new Set(affected.map((output) => output.job_id))];
  for (const jobId of jobs) {
    const targets = affected
      .filter((output) => output.job_id === jobId)
      .map((output) => ({
        kind: output.kind,
        output_id: output.output_id,
        output_version: output.output_version,
        location: output.location,
      }));
    const id = `rb_${stableId(scope.spaceId, jobId, changed, replacement ?? 'retracted')}`;
    await tx`insert into memory_repair_briefs (id, space_id, job_id, key, changed_handle, replacement_handle, old_value, new_value, affected)
      values (${id}, ${scope.spaceId}, ${jobId}, ${facts.key}, ${changed}, ${replacement},
        ${facts.oldValue.slice(0, 4000)}, ${facts.newValue.slice(0, 4000)}, ${JSON.stringify(targets)}::text::jsonb)
      on conflict (id) do nothing`;
  }
  return jobs;
}

const toBrief = (row: Record<string, unknown>): RepairBrief =>
  repairBrief.parse({
    id: row.id,
    job_id: row.job_id,
    key: row.key ?? null,
    changed_handle: row.changed_handle,
    replacement_handle: row.replacement_handle ?? null,
    old_value: row.old_value,
    new_value: row.new_value,
    affected: row.affected,
    created_at: iso(row.created_at as Date),
  });

export async function pendingRepairBriefs(
  sql: MemorySql,
  scope: MemoryScope,
  jobId: string,
): Promise<RepairBrief[]> {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const rows = await tx`select * from memory_repair_briefs
      where space_id = ${scope.spaceId} and job_id = ${jobId} and state = 'pending' order by created_at, id`;
    return rows.map(toBrief);
  });
}

/** Marked delivered only once the next bundle actually carries them. */
export async function markRepairBriefsDelivered(
  sql: MemorySql,
  scope: MemoryScope,
  ids: readonly string[],
) {
  if (!ids.length) return;
  await sql`update memory_repair_briefs set state = 'delivered'
    where space_id = ${scope.spaceId} and id = any(${[...ids]}) and state = 'pending'`;
}
