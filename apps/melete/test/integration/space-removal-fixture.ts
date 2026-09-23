/**
 * A space with something in every table that keys rows to one, and something
 * on disk in every directory a space uses. The removal tests need this: an
 * assertion that nothing is left is only worth making against a space that
 * had something everywhere to begin with.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
// The memory module's id helper takes any prefix, which a fixture that seeds
// every table needs; the service's own helper names only the entities it makes.
import { newId, provisionMemorySpace } from '../../src/memory/db.ts';

export type SeededSpace = {
  spaceId: string;
  ownerId: string;
  principalId: string;
  memberId: string;
  jobId: string;
  attemptId: string;
  actionId: string;
  connectionId: string;
  secretId: string;
  agentId: string;
  artifactId: string;
  claimId: string;
  sourceId: string;
  episodeId: string;
  candidateId: string;
  submissionId: string;
  notificationId: string;
  sessionToken: string;
  memberSessionToken: string;
};

const json = (value: unknown) => JSON.stringify(value);

/** One owner row per database: the singleton index allows no more. */
export async function installationOwner(sql: Sql): Promise<string> {
  const candidate = newId('own');
  await sql`insert into owner (id, email) values (${candidate}, ${`${candidate}@example.test`})
    on conflict do nothing`;
  const [row] = await sql<{ id: string }[]>`select id from owner limit 1`;
  const ownerId = row?.id ?? candidate;
  await sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}
    on conflict do nothing`;
  return ownerId;
}

export async function seedSpace(
  sql: Sql,
  options: { kind: 'shared' | 'personal'; name: string; spacesRoot: string; workRoot: string },
): Promise<SeededSpace> {
  const ownerId = await installationOwner(sql);
  const principalId = options.kind === 'personal' ? ownerId : newId('own');
  if (principalId !== ownerId)
    await sql`insert into principal (id, email)
      values (${principalId}, ${`${principalId}@example.test`})`;
  const memberId = newId('own');
  await sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;

  const spaceId = newId('sp');
  const gitPath = join(options.spacesRoot, spaceId);
  await sql`insert into space (id, name, kind, audience, owner_principal_id, git_path)
    values (${spaceId}, ${options.name}, ${options.kind},
      ${options.kind === 'personal' ? 'owner' : 'space'}, ${principalId}, ${gitPath})`;
  if (options.kind === 'shared') {
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${principalId}, ${spaceId}, 'owner')`;
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${memberId}, ${spaceId}, 'member')`;
  }

  // The shape the session middleware accepts: 43 base64url characters and
  // only a digest of it in the database.
  const sessionToken = randomBytes(32).toString('base64url');
  const memberSessionToken = randomBytes(32).toString('base64url');
  await sql`insert into session
    (token_hash, principal_id, space_id, membership_generation, owner_id, expires_at)
    values (${hash(sessionToken)}, ${principalId}, ${spaceId}, 0, ${ownerId}, now() + interval '1 day')`;
  await sql`insert into session
    (token_hash, principal_id, space_id, membership_generation, owner_id, expires_at)
    values (${hash(memberSessionToken)}, ${memberId}, ${spaceId}, 0, ${ownerId}, now() + interval '1 day')`;

  const secretId = newId('sec');
  await sql`insert into secret (id, space_id, ciphertext) values (${secretId}, ${spaceId}, 'sealed')`;
  const connectionId = newId('conn');
  await sql`insert into connection (id, space_id, provider, label, secret_ref, scopes)
    values (${connectionId}, ${spaceId}, 'email', 'Mailbox', ${secretId}, ${json(['email.send'])}::text::jsonb)`;
  await sql`insert into magic_link
    (token_hash, owner_id, space_id, connection_id, connection_generation, expires_at)
    values (${hash(newId('tok'))}, ${ownerId}, ${spaceId}, ${connectionId}, 0, now() + interval '1 hour')`;

  const agentId = newId('agent');
  await sql`insert into agent
    (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
    values (${agentId}, ${spaceId}, 'Aide', 'assistant', 'blue', 'matte', 'grey', 'plain', 'Help.')`;

  const jobId = newId('job');
  await sql`insert into job (id, space_id, title, principal_id, objective, agent_id, state, next_wake_at)
    values (${jobId}, ${spaceId}, 'Draft the note', ${principalId}, 'Write it', ${agentId},
      'waiting_for_event_or_time', now() + interval '1 hour')`;
  const attemptId = newId('att');
  await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, 0, '0.1', 'fake', 'script')`;
  const actionId = newId('act');
  await sql`insert into action
    (id, job_id, attempt_id, connection_id, kind, effect_class, canonical_payload, payload_hash, idempotency_key)
    values (${actionId}, ${jobId}, ${attemptId}, ${connectionId}, 'email.send', 'external',
      ${json({ to: 'someone@example.test' })}::text::jsonb, 'hash', ${newId('idem')})`;
  await sql`insert into approval (id, action_id, job_revision, payload_hash)
    values (${newId('apr')}, ${actionId}, 0, 'hash')`;
  await sql`insert into event (job_id, attempt_id, type, payload, dedup_key)
    values (${jobId}, ${attemptId}, 'notice', '{}'::jsonb, ${newId('dedup')})`;
  await sql`insert into trigger (id, job_id, kind, spec)
    values (${newId('trg')}, ${jobId}, 'timer', ${json({ every: '1h' })}::text::jsonb)`;
  await sql`insert into budget_ledger (id, job_id, kind, reserved)
    values (${newId('led')}, ${jobId}, 'model', 0.1)`;
  await sql`insert into background_operation
    (id, job_id, operation_key, input_digest, kind, substrate_disposition)
    values (${newId('op')}, ${jobId}, 'watch', 'digest', 'poll', 'timer_or_event')`;
  await sql`insert into attempt_tool_context (attempt_id, job_id, core)
    values (${attemptId}, ${jobId}, ${json(['react'])}::text::jsonb)`;
  await sql`insert into experience_turn (id, job_id, agent_id, submission_id, text)
    values (${newId('turn')}, ${jobId}, ${agentId}, ${newId('sub')}, 'Hello')`;
  await sql`insert into plan_milestone (id, plan_id, title, ordinal, agent_id)
    values (${newId('mile')}, ${jobId}, 'Step one', 0, ${agentId})`;
  await sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
    values (${newId('bind')}, ${spaceId}, ${jobId}, 0, 'automation')`;

  // The four whose job_id is nulled rather than cascaded: without the sweep
  // these outlive the job, receipts and notification content included.
  const submissionId = newId('sub');
  await sql`insert into submission (submission_id, input_digest, principal_id, job_id, state, http_status)
    values (${submissionId}, 'digest', ${principalId}, ${jobId}, 'accepted', 202)`;
  await sql`insert into acceptance_journal (submission_id, principal_id, job_id, receipt, receipt_hash)
    values (${submissionId}, ${principalId}, ${jobId}, ${json({ accepted: true })}::text::jsonb, 'rhash')`;
  await sql`insert into reply_obligation
    (id, submission_id, job_id, kind, coalesce_key, event_cursor, content)
    values (${newId('obl')}, ${submissionId}, ${jobId}, 'reply', 'key', 1,
      ${json({ text: 'the answer' })}::text::jsonb)`;
  const notificationId = newId('ntf');
  await sql`insert into notification
    (id, job_id, coalesce_key, delivery_key, obligation_ids, content, content_hash, because, delivery_attempt)
    values (${notificationId}, ${jobId}, 'key', ${newId('dk')}, '[]'::jsonb,
      ${json({ text: 'private content' })}::text::jsonb, 'chash',
      ${json(['a reply was owed'])}::text::jsonb, 1)`;

  const artifactId = newId('art');
  await sql`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, content_hash, mime, size)
    values (${artifactId}, ${spaceId}, ${jobId}, ${jobId}, 'artifacts', 'note.md', 'ahash', 'text/markdown', 12)`;
  await sql`insert into artifact_validation (artifact_id, class, name, status)
    values (${artifactId}, 'structure', 'headings', 'passed')`;
  await sql`insert into artifact_publication
    (artifact_id, action_id, destination, content_hash)
    values (${artifactId}, ${actionId}, 'space_artifacts', 'ahash')`;

  await sql`insert into knowledge_record (id, space_id, path, frontmatter, content_hash)
    values (${newId('k')}, ${spaceId}, 'notes/one.md', '{}'::jsonb, 'khash')`;
  await sql`insert into skill (id, space_id, name, path, frontmatter)
    values (${newId('skl')}, ${spaceId}, 'summarize', 'skills/summarize.md', '{}'::jsonb)`;
  await sql`insert into task (id, space_id, title) values (${newId('task')}, ${spaceId}, 'Do it')`;
  await sql`insert into experience_profile (space_id, name) values (${spaceId}, 'Profile')`;
  await sql`insert into experience_rule
    (id, space_id, connection_id, tool_kind, recipient, recipient_class, origin_trust,
     count_cap, expires_at, reconsent_after_days)
    values (${newId('rule')}, ${spaceId}, ${connectionId}, 'email.send',
      ${json({ address: 'someone@example.test' })}::text::jsonb, 'known', 'owner',
      5, now() + interval '7 days', 7)`;
  await sql`insert into experience_rule_use (action_id, rule_id)
    select ${actionId}, id from experience_rule where space_id = ${spaceId} limit 1`;
  await sql`insert into experience_undo (action_id, handle, valid_until)
    values (${actionId}, ${newId('undo')}, now() + interval '1 hour')`;
  await sql`insert into experience_draft_send (draft_action_id) values (${actionId})`;
  await sql`insert into question (id, source, space_id, key, text, because, if_ignored)
    values (${newId('qst')}, 'memory', ${spaceId}, 'home.address', 'Which address is current?',
      ${json(['two revisions disagree'])}::text::jsonb, 'The key stays disputed.')`;
  await sql`insert into browser_recipe_candidate
    (id, space_id, version, state, schema, steps, safe_aliases, reason)
    values (${newId('rec')}, ${spaceId}, 1, 'candidate', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'learned')`;

  const episodeId = newId('epi');
  await sql`insert into learning_job (job_id, space_id, scope, template_id)
    values (${jobId}, ${spaceId}, ${json({ kind: 'private' })}::text::jsonb, 'template')`;
  await sql`insert into learning_attempt (attempt_id, versions)
    values (${attemptId}, ${json({ runtime: '0.1' })}::text::jsonb)`;
  await sql`insert into episode
    (id, space_id, job_id, segment_key, input_digest, scope, template_id, actor)
    values (${episodeId}, ${spaceId}, ${jobId}, 'segment', 'digest',
      ${json({ kind: 'private' })}::text::jsonb, 'template', 'owner')`;
  const candidateId = newId('prc');
  await sql`insert into procedure_candidate
    (id, space_id, episode_id, scope, body, body_hash, change, predicted_benefit, known_risk,
     tests, compatible_models)
    values (${candidateId}, ${spaceId}, ${episodeId}, ${json({ kind: 'private' })}::text::jsonb,
      'Do it this way', 'bhash', ${json({ step: 'one' })}::text::jsonb, 'faster', 'none',
      '[]'::jsonb, '[]'::jsonb)`;
  await sql`insert into procedure_transition (id, candidate_id, to_state, actor, reason)
    values (${newId('ptr')}, ${candidateId}, 'evaluated', 'owner', 'ran the suite')`;
  await sql`insert into procedure_evaluation
    (id, candidate_id, body_hash, phase, suite_hash, evidence, budget, passed)
    values (${newId('pev')}, ${candidateId}, 'bhash', 'offline', 'shash', '{}'::jsonb, '{}'::jsonb, true)`;
  await sql`insert into learning_model_call
    (id, episode_id, provider, model, reserved_tokens, max_output_tokens)
    values (${newId('lmc')}, ${episodeId}, 'fake', 'script', 100, 50)`;
  // A trial grant is written against its own synthetic job, in the same space.
  const trialJobId = newId('job');
  await sql`insert into job (id, space_id, title, principal_id, objective, state)
    values (${trialJobId}, ${spaceId}, 'Trial', ${principalId}, 'Evaluate', 'queued')`;
  await sql`insert into learning_trial
    (job_id, candidate_id, evaluation_id, body_hash, use_candidate, expires_at)
    select ${trialJobId}, ${candidateId}, id, 'bhash', true, now() + interval '1 hour'
    from procedure_evaluation where candidate_id = ${candidateId} limit 1`;
  await sql`insert into browser_site_profile (space_id, domain, label)
    values (${spaceId}, 'example.test', 'example.test')`;
  await sql`insert into learning_evaluation_lease (space_id, candidate_id, holder, expires_at)
    values (${spaceId}, ${candidateId}, 'evaluator', now() + interval '1 minute')`;

  // The companies map: a scan, the message text it stored, the company it
  // found and a ledger item quoting that text. `job_id` and `scan_id` on the
  // item are plain text with no constraint, so nothing but the sweep takes it.
  const scanId = newId('scn');
  await sql`insert into company_scan (id, space_id, principal_id, status)
    values (${scanId}, ${spaceId}, ${principalId}, 'done')`;
  await sql`insert into company_message
    (id, space_id, principal_id, message_id, subject, from_address, received_at, body)
    values (${newId('msg')}, ${spaceId}, ${principalId}, '<m1@example.test>', 'Invoice',
      'billing@example.test', now(), 'Your invoice for 148.00 is due on the first.')`;
  const companyId = newId('co');
  await sql`insert into company (id, space_id, principal_id, name, domain, first_seen_at, last_seen_at)
    values (${companyId}, ${spaceId}, ${principalId}, 'Example', 'example.test', now(), now())`;
  await sql`insert into ledger_item
    (id, space_id, principal_id, company_id, kind, direction, confidence, evidence, job_id,
     summary, scan_id, dedupe_key)
    values (${newId('li')}, ${spaceId}, ${principalId}, ${companyId}, 'invoice', 'you_pay', 'high',
      ${json([{ message_id: '<m1@example.test>', quote: 'Your invoice for 148.00' }])}::text::jsonb,
      ${jobId}, 'Invoice due', ${scanId}, 'invoice:example.test')`;

  await seedMemory(sql, { spaceId, ownerId, jobId, attemptId });
  const claim = await sql<
    { id: string }[]
  >`select id from memory_claims where space_id = ${spaceId}`;
  const source = await sql<
    { id: string }[]
  >`select id from memory_sources where space_id = ${spaceId}`;

  await seedFiles(options.spacesRoot, options.workRoot, spaceId, jobId);

  return {
    spaceId,
    ownerId,
    principalId,
    memberId,
    jobId,
    attemptId,
    actionId,
    connectionId,
    secretId,
    agentId,
    artifactId,
    claimId: claim[0]?.id ?? '',
    sourceId: source[0]?.id ?? '',
    episodeId,
    candidateId,
    submissionId,
    notificationId,
    sessionToken,
    memberSessionToken,
  };
}

/** A claim with its source, its revision and the reference that binds them. */
async function seedMemory(
  sql: Sql,
  ids: { spaceId: string; ownerId: string; jobId: string; attemptId: string },
): Promise<void> {
  const { spaceId, ownerId, jobId, attemptId } = ids;
  await provisionMemorySpace(sql, ownerId, spaceId);
  await sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  await sql`insert into memory_streams (space_id, publisher, stream)
    values (${spaceId}, 'authenticated-owner', 'notes')`;
  const sourceId = newId('src');
  await sql`insert into memory_sources
    (id, space_id, owner_id, publisher, stream, source_identity, source_version, stream_sequence,
     source_type, event_at, audience, eligibility_generation, content_length)
    values (${sourceId}, ${spaceId}, ${ownerId}, 'authenticated-owner', 'notes', 'note-1', 'v1', 1,
      'note', now(), 'private', 1, 24)`;
  await sql`insert into memory_source_content (source_id, content)
    values (${sourceId}, 'I live at 12 Bridge Row')`;
  const claimId = newId('k');
  await sql`insert into memory_claims (id, space_id, domain_key, key, audience)
    values (${claimId}, ${spaceId}, 'home.address', 'home.address', 'private')`;
  await sql`insert into memory_revisions
    (claim_id, revision, kind, factual_status, status, valid_from, data_revision)
    values (${claimId}, 1, 'fact', 'asserted', 'active', now(), 1)`;
  await sql`insert into memory_revision_content (claim_id, revision, content)
    values (${claimId}, 1, '12 Bridge Row')`;
  await sql`insert into memory_references (claim_id, revision, source_id, source_version, start, "end")
    values (${claimId}, 1, ${sourceId}, 'v1', 0, 24)`;
  await sql`insert into memory_derivations
    (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
    values (${spaceId}, 'source', ${sourceId}, 'v1', 'claim', ${claimId}, '1')`;
  await sql`insert into memory_work (id, space_id, source_id, policy_version, segment_start, segment_end)
    values (${newId('mw')}, ${spaceId}, ${sourceId}, 'v1', 0, 24)`;
  await sql`insert into memory_outbox (id, space_id, kind, target_id)
    values (${newId('mob')}, ${spaceId}, 'extract', ${sourceId})`;
  await sql`insert into memory_suppressions (id, space_id, eligibility_cutoff, operation)
    values (${newId('sup')}, ${spaceId}, 1, 'forget')`;
  await sql`insert into memory_index_entries (space_id, generation, claim_id, revision, tokens)
    values (${spaceId}, 0, ${claimId}, 1, to_tsvector('simple', '12 Bridge Row'))`;
  await sql`insert into memory_dense_entries
    (space_id, generation, claim_id, revision, model, version, dimensions, recipe, vector)
    values (${spaceId}, 0, ${claimId}, 1, 'fake', 'v1', 2, 'simple', ${json([0.1, 0.2])}::text::jsonb)`;
  await sql`insert into memory_contexts
    (id, space_id, job_id, attempt_id, job_revision, policy_generation, data_revision,
     access_generation, audience, purpose, items, recipe, token_budget, recall_status)
    values (${newId('mc')}, ${spaceId}, ${jobId}, ${attemptId}, 0, 1, 1, 1,
      ${json(['private'])}::text::jsonb, 'answer', ${json([])}::text::jsonb, 'simple',
      ${json({ max: 100 })}::text::jsonb, 'ok')`;
  await sql`insert into memory_prepared (id, space_id, job_id, kind, items, data_revision)
    values (${newId('mp')}, ${spaceId}, ${jobId}, 'profile', ${json([])}::text::jsonb, 1)`;
  await sql`insert into memory_invalidations
    (id, space_id, type, job_id, claim_ids, data_revision)
    values (${newId('mi')}, ${spaceId}, 'correction', ${jobId}, ${json([claimId])}::text::jsonb, 1)`;
  await sql`insert into memory_proposals (id, space_id, work_id, fence)
    values (${newId('mpr')}, ${spaceId}, ${newId('mw')}, 0)`;
  await sql`insert into memory_profile (space_id, data_revision, items)
    values (${spaceId}, 1, ${json([])}::text::jsonb)`;
  const outputId = newId('mo');
  await sql`insert into memory_outputs
    (id, space_id, job_id, attempt_id, kind, output_id, output_version, attributed)
    values (${outputId}, ${spaceId}, ${jobId}, ${attemptId}, 'artifact', 'note.md', 'v1', true)`;
  await sql`insert into memory_output_uses (output_row_id, handle, handle_kind, claim_id, revision)
    values (${outputId}, 'h1', 'claim', ${claimId}, 1)`;
  await sql`insert into memory_repair_briefs
    (id, space_id, job_id, changed_handle, old_value, new_value, affected)
    values (${newId('mrb')}, ${spaceId}, ${jobId}, 'h1', 'old', 'new', ${json([])}::text::jsonb)`;
  await sql`insert into memory_contradictions
    (id, space_id, key, audience, claim_id, head, alternative)
    values (${newId('mcd')}, ${spaceId}, 'home.address', 'private', ${claimId}, '1', '2')`;
  await sql`insert into memory_questions (id, space_id, key, question, because, if_ignored)
    values (${newId('mq')}, ${spaceId}, 'home.address', 'Which one is current?',
      ${json(['two revisions disagree'])}::text::jsonb, 'The key stays disputed.')`;
  await sql`insert into memory_rejections
    (id, space_id, work_id, proposal_index, reason, detail)
    values (${newId('mrj')}, ${spaceId}, ${newId('mw')}, 0, 'malformed', 'no key')`;
}

/** The directories a space uses, each with something in it, and one job workspace. */
export async function seedFiles(
  spacesRoot: string,
  workRoot: string,
  spaceId: string,
  jobId: string,
): Promise<void> {
  const root = join(spacesRoot, spaceId);
  for (const name of ['knowledge', 'raw', 'artifacts', 'skills', '.git']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'kept.txt'), 'content', 'utf8');
  }
  await mkdir(join(root, 'browser', 'chromium'), { recursive: true });
  await writeFile(join(root, 'browser', 'chromium', 'Cookies'), 'signed in', 'utf8');
  await mkdir(join(workRoot, jobId), { recursive: true });
  await writeFile(join(workRoot, jobId, 'out.txt'), 'work', 'utf8');
}

function hash(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}
