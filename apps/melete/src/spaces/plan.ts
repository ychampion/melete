/**
 * The sweep itself: which rows go, in which order, and which files go with them.
 *
 * The order is not a preference. Three constraints are `restrict`, which
 * Postgres checks at once and does not satisfy from rows the same statement is
 * deleting, so jobs must precede agents and actions must precede connections.
 * The memory tables hang off the space with no cascade at all, so their
 * children are deleted before their parents. Everything here is safe to run
 * twice: a repeated phase deletes nothing the first pass left.
 */

import { resolve } from 'node:path';
import { initSpace } from '@melete/knowledge';
import type { Sql, TransactionSql } from 'postgres';
import { PostgresSecretRepository } from '../connectors/secrets.ts';
import { PathHeld, removeConfined } from '../paths.ts';
import { LocalWorkspaceFs, type WorkspaceFs } from '../runtime/workspace-fs.ts';

export { PathHeld, PathOutsideRoot, removeConfined } from '../paths.ts';

/**
 * Run first inside each destructive transaction, and throws when the run that
 * asked no longer holds the removal. Holding the removal row for the rest of
 * the transaction is what keeps a second run out until this one commits.
 */
export type LeaseHold = (tx: TransactionSql) => Promise<void>;

export type SpaceRoots = { spacesRoot: string; workRoot: string };

/**
 * Phase 2. Access to the space ends before anything in it is destroyed, so
 * nobody watches a space dissolve under them.
 *
 * Nobody is signed out of their account to achieve it. The session's selection
 * is cleared, so the next request resolves to that person's own space instead;
 * what ends access to this one is the revoked membership, which `spaceAuthority`
 * requires and which a later regrant cannot revive. The person who asked for
 * the removal loses the space along with everyone else, which is why the record
 * of the removal answers for itself rather than through the space.
 *
 * A personal space has no membership rows and is being emptied rather than
 * removed, so clearing the selection is the whole of it: the next request
 * resolves the same space again.
 */
export async function endSpaceAccess(
  raw: Sql,
  spaceId: string,
  emptied: boolean,
  hold?: LeaseHold,
): Promise<void> {
  await raw.begin(async (tx) => {
    await hold?.(tx);
    await tx`update session set space_id = null, membership_generation = null
      where space_id = ${spaceId}`;
    if (!emptied)
      await tx`update space_membership
        set revoked_at = now(), generation = generation + 1
        where space_id = ${spaceId} and revoked_at is null`;
    await tx`delete from magic_link where space_id = ${spaceId}`;
    // An assistant connected over MCP from this space loses it with everyone else.
    await tx`delete from mcp_authorization where space_id = ${spaceId}`;
    await tx`delete from mcp_token where space_id = ${spaceId}`;
  });
}

/**
 * Phase 7. The four tables whose `job_id` is set to null rather than cascaded
 * go first, by the job ids captured at the fence: left alone they would survive
 * the job that made them, receipts and notification content included.
 *
 * Every table that points at the space is named in this phase or a later one
 * rather than left to the cascade: the verification runs before the space row
 * goes, and an emptied space keeps its row, so for it the cascade never fires.
 */
export async function sweepOperational(
  raw: Sql,
  spaceId: string,
  jobIds: readonly string[],
  hold?: LeaseHold,
): Promise<void> {
  await raw.begin(async (tx) => {
    await hold?.(tx);
    const ids = [...jobIds];
    if (ids.length) {
      await tx`delete from submission where job_id = any(${ids})`;
      await tx`delete from acceptance_journal where job_id = any(${ids})`;
      await tx`delete from reply_obligation where job_id = any(${ids})`;
      await tx`delete from notification where job_id = any(${ids})`;
    }
    // The companies map: the scans, then the ledger items with the quoted
    // extracts they carry, then the stored message text, then the companies.
    // A scan still reading the mailbox writes only while it holds its own row,
    // so deleting the scans first waits out a write in flight and refuses every
    // one after it.
    await tx`delete from company_scan where space_id = ${spaceId}`;
    await tx`delete from ledger_item where space_id = ${spaceId}`;
    await tx`delete from awaited_reply where space_id = ${spaceId}`;
    await tx`delete from company_message where space_id = ${spaceId}`;
    await tx`delete from company where space_id = ${spaceId}`;
    // One statement takes attempts, actions, approvals, events, triggers, the
    // ledger, background operations, repair candidates, tool contexts, turns,
    // milestones, browser bindings and the learning rows below a job.
    // A room keeps its handoffs, but no result of this space's work: one not
    // yet shared is cleared, and the room is told it is no longer there.
    await tx`update room_handoff set result_text = null, result_hash = null,
        state = case when state in ('running', 'settled') then 'settled' else state end
      where personal_job_id in (select id from job where space_id = ${spaceId})`;
    await tx`delete from job where space_id = ${spaceId}`;
    // What the space's connections reported that no job took in: mail headers,
    // calendar titles and places. A job's own copies went with the job.
    await tx`delete from event
      where job_id is null and payload->>'kind' = 'connector_event'
        and payload->>'connection_id' in (select id from connection where space_id = ${spaceId})`;
    // What the space's model calls cost stays counted against its person, so
    // removing a space does not reset a spending limit; which space and job
    // they came from goes with the space.
    await tx`update model_usage set space_id = null, job_id = null where space_id = ${spaceId}`;
    // Its daily totals likewise: folded into the person's totals with no space.
    await tx`insert into usage_day (day, principal_id, space_id, class, tier, purpose, calls,
        input_tokens, cached_input_tokens, cache_write_tokens, charged_input_tokens,
        output_tokens, cost_usd)
      select day, principal_id, '', class, tier, purpose, sum(calls)::int, sum(input_tokens),
        sum(cached_input_tokens), sum(cache_write_tokens), sum(charged_input_tokens),
        sum(output_tokens), round(sum(cost_usd)::numeric, 6)::float8
      from usage_day where space_id = ${spaceId}
      group by day, principal_id, class, tier, purpose
      on conflict (day, principal_id, space_id, class, tier, purpose) do update set
        calls = usage_day.calls + excluded.calls,
        input_tokens = usage_day.input_tokens + excluded.input_tokens,
        cached_input_tokens = usage_day.cached_input_tokens + excluded.cached_input_tokens,
        cache_write_tokens = usage_day.cache_write_tokens + excluded.cache_write_tokens,
        charged_input_tokens = usage_day.charged_input_tokens + excluded.charged_input_tokens,
        output_tokens = usage_day.output_tokens + excluded.output_tokens,
        cost_usd = round((usage_day.cost_usd + excluded.cost_usd)::numeric, 6)::float8`;
    await tx`delete from usage_day where space_id = ${spaceId}`;
    // Artifacts outlive their job by design: `job_id` is nulled, not cascaded.
    // They belong to the space, and they go with it, taking their validation
    // and publication rows.
    await tx`delete from artifact where space_id = ${spaceId}`;
    // A rule names a connection, so it has to go before phase 8 reaches one.
    await tx`delete from experience_rule where space_id = ${spaceId}`;
    // A sandbox session names its connection too. Its sandbox and snapshot
    // went in the sandboxes phase, which finished on what the provider still
    // held rather than on these rows, so the rows can go now; their command
    // records go with them, as does the record of where each computer connected.
    await tx`delete from egress_record where space_id = ${spaceId}`;
    // Its processes went with its sandboxes; their rows name the sessions.
    await tx`delete from sandbox_process where space_id = ${spaceId}`;
    await tx`delete from sandbox_session where space_id = ${spaceId}`;
    // A paired computer names its connection too, and a pairing code its space.
    await tx`delete from paired_device where space_id = ${spaceId}`;
    await tx`delete from device_pairing where space_id = ${spaceId}`;
    // A memory question belongs to a space rather than to a job.
    await tx`delete from question where space_id = ${spaceId}`;
    // Published apps, with their versions and grants. The versions' blob
    // references went in the files phase, with every blob only they used.
    await tx`delete from app where space_id = ${spaceId}`;
    for (const table of SPACE_KEYED_OPERATIONAL)
      await tx`delete from ${tx(table)} where space_id = ${spaceId}`;
    // A person's "don't do this" is theirs, not the space's: it keeps standing in
    // their other spaces, and only the record of where it was said goes.
    await tx`update engine_skill_prohibition set space_id = null where space_id = ${spaceId}`;
  });
}

/** Keyed to the space rather than to a job, and independent of each other. */
const SPACE_KEYED_OPERATIONAL = [
  'browser_recipe_candidate',
  'experience_profile',
  // How the person lets auto-review answer for them, and what it decided.
  // The decisions went with their jobs; named again so the phase is whole.
  'approval_review_policy',
  'action_review',
  // What was done in the person's name, kept past the chats that did it.
  'activity_record',
  'knowledge_record',
  'skill',
  'task',
  // Already gone with their jobs; named again so a row that outlived its job
  // is still removed and the phase reads as the whole of what it clears.
  'procedure_candidate',
  'episode',
  'learning_job',
  // What learning told the person about a procedure, and the changes they made to it.
  'learning_notice',
  'learned_change',
  // Held while a procedure is evaluated in the space; a removal ends it.
  'learning_evaluation_lease',
  // How long the space's computers were kept running by their processes, by day.
  'sandbox_awake_day',
  // The privacy router's sealed vaults, its settings and its audit rows.
  'privacy_vault',
  'privacy_settings',
  'privacy_conversation',
  'privacy_request',
  // The browser phase deletes these with the profile they describe. A
  // deployment with no browser worker has no profile, and any rows an earlier
  // configuration left go here, since an emptied space keeps its row and the
  // cascade from it never fires.
  'browser_site_profile',
  // A room's threads, the messages said in them and who was looking. An
  // emptied room keeps its space row, so the cascade from it never fires.
  'room_presence',
  // What a room handed one of its people, its guest invites, used or not, and
  // how the room works. The handoffs point at the room's own rows, which go next.
  'room_handoff',
  'room_invite',
  'room_policy',
  'room_message',
  'room_thread',
  // Files people sent in chat went with their chats; one uploaded and never
  // sent has no chat. Their bytes go in the blobs phase, by reference.
  'attachment',
  // Where each connected account's changes were last read, and the few fields
  // kept about each calendar occurrence. They name connections, which go next.
  'source_cursor',
  'subject_state',
  // What Melete noticed in the space, the times it keeps to look again, and
  // which work cares about what. Clocks and situations name connections.
  'subject_link',
  'situation',
  'clock',
] as const;

/**
 * Phase 8. This order is what satisfies the two `restrict` constraints: jobs
 * and actions are already gone, so an agent and a connection can finally go.
 * A secret goes last because a connection points at one. Secrets are removed
 * by the one role that may touch them (connectors/secrets.ts), after the
 * connections; a pass interrupted between the two finds the connections gone
 * and removes the secrets on its next run.
 */
export async function sweepPrincipals(raw: Sql, spaceId: string, hold?: LeaseHold): Promise<void> {
  await raw.begin(async (tx) => {
    await hold?.(tx);
    await tx`delete from agent where space_id = ${spaceId}`;
    await tx`delete from connection where space_id = ${spaceId}`;
  });
  await new PostgresSecretRepository(raw).forgetSpace(spaceId);
}

/**
 * Phase 9. Memory is not attached to the space by cascade at all, so every
 * table is named. Tables whose only key is their parent's are deleted through
 * it, before the parent.
 */
export async function sweepMemory(raw: Sql, spaceId: string, hold?: LeaseHold): Promise<void> {
  await raw.begin(async (tx) => {
    await hold?.(tx);
    await tx`delete from memory_output_uses where output_row_id in
      (select id from memory_outputs where space_id = ${spaceId})`;
    await tx`delete from memory_references where claim_id in
      (select id from memory_claims where space_id = ${spaceId})`;
    await tx`delete from memory_references where source_id in
      (select id from memory_sources where space_id = ${spaceId})`;
    await tx`delete from memory_revision_content where claim_id in
      (select id from memory_claims where space_id = ${spaceId})`;
    await tx`delete from memory_revisions where claim_id in
      (select id from memory_claims where space_id = ${spaceId})`;
    await tx`delete from memory_source_content where source_id in
      (select id from memory_sources where space_id = ${spaceId})`;
    // A share names two spaces: the room it was shared into and the personal
    // space the detail lives in. Either one going takes the share with it.
    await tx`delete from memory_room_grant
      where room_space_id = ${spaceId} or source_space_id = ${spaceId}`;
    for (const table of MEMORY_TABLES)
      await tx`delete from ${tx(table)} where space_id = ${spaceId}`;
    // The one pointer from another space's rows into this one, with no
    // constraint behind it to notice that this space has gone.
    await tx`update procedure_candidate set canary_space_id = null
      where canary_space_id = ${spaceId}`;
  });
}

/**
 * Every memory table keyed by `space_id`, children before parents:
 * work before sources, claims and outputs before the space row itself.
 */
const MEMORY_TABLES = [
  'memory_outputs',
  'memory_claims',
  'memory_index_entries',
  'memory_dense_entries',
  'memory_agent_notes',
  'memory_work',
  'memory_sources',
  'memory_streams',
  'memory_outbox',
  'memory_derivations',
  'memory_suppressions',
  'memory_index_manifest',
  'memory_contexts',
  'memory_prepared',
  'memory_invalidations',
  'memory_proposals',
  'memory_profile',
  'memory_repair_briefs',
  'memory_contradictions',
  'memory_questions',
  'memory_rejections',
  'memory_capture',
  'memory_room_capture',
  'memory_model_calls',
  'memory_action_basis',
  'memory_blocks',
  'memory_rewinds',
  'memory_digests',
  'memory_spaces',
] as const;

/**
 * Phase 6. Job workspaces first, by the ids captured at the fence, then the
 * whole space directory: the git tree and its history, `knowledge/`, `raw/`,
 * `artifacts/`, `skills/`, the index database and the Chromium profile in one
 * move. An emptied space gets a fresh repository in place of the old one.
 *
 * Each path is resolved before it is removed and asserted to sit under its own
 * root, so a catalog row that names somewhere else removes nothing.
 *
 * A job workspace still held open after its retries does not stop the rest:
 * it is returned, the space directory still goes, and the verification counts
 * what is left. A held space directory does stop the phase.
 */
export async function clearSpaceFiles(
  roots: SpaceRoots,
  spaceId: string,
  jobIds: readonly string[],
  emptied: boolean,
  beforeRetry?: () => Promise<void>,
): Promise<string[]> {
  const held = await clearJobWorkspaces(new LocalWorkspaceFs(roots.workRoot), jobIds, beforeRetry);
  await removeConfined(roots.spacesRoot, spaceId, beforeRetry);
  if (emptied) await initSpace(resolve(roots.spacesRoot), spaceId);
  return held;
}

/** Each job's workspace, and the ones still held open once their retries are spent. */
export async function clearJobWorkspaces(
  workspaces: WorkspaceFs,
  jobIds: readonly string[],
  beforeRetry?: () => Promise<void>,
): Promise<string[]> {
  const held: string[] = [];
  for (const id of jobIds) {
    try {
      await workspaces.remove(id, beforeRetry);
    } catch (error) {
      if (!(error instanceof PathHeld)) throw error;
      held.push(error.path);
    }
  }
  return held;
}
