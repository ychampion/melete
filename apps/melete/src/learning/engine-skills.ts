/**
 * Skills the engine writes for itself.
 *
 * Hermes can write a skill package during a job. The plugin inside that
 * container reads what was written and posts it here over a route authenticated
 * by the attempt capability, so this admission is the only place where such a
 * skill becomes something a later job receives. Two guards decide, and both are
 * decided by trusted code from recorded data rather than from the package text:
 *
 *  - `engine-scan.ts` reads the package. Credential material is refused and its
 *    bytes are never stored; a link or the vocabulary of authority is held.
 *  - `engine-taint.ts` reads what the writing job was given. Anything but the
 *    owner's own words, or a missing record, holds the skill.
 *
 * A held skill waits for its person to read it and approve those exact bytes, by
 * hash, exactly as an owner trial does. A live skill is delivered privately to
 * the person whose job wrote it, in the space it came from, is reverted by an
 * intervention on a job that received it, and is restricted when the inputs of
 * the job that wrote it are forgotten. In a shared space each member's skills
 * are that member's alone: only they see them, and only they control them.
 */
import { createHash } from 'node:crypto';
import { type EngineSkillState, engineSkillIntakeRequest } from '@melete/contracts';
import { estimateTokens, loadSkills } from '@melete/skills';
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { attempt, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { ownJob, spaceAuthority } from '../principals/authority.ts';
import {
  credentialMaterial,
  ENGINE_BASIS,
  ENGINE_ORIGIN,
  engineDefinitionIntact,
  MAX_ENGINE_BODY_BYTES,
  MAX_ENGINE_SKILL_TOKENS,
  MAX_ENGINE_SKILLS_PER_ATTEMPT,
  scanEngineSkill,
} from './engine-scan.ts';
import { originTaint } from './engine-taint.ts';
import { jobInputReferences } from './episodes.ts';
import { definitionHash } from './procedure.ts';
import { type Candidate, transitionProcedure } from './procedures.ts';
import {
  engineSkillProhibition,
  learningJob,
  procedureCandidate,
  procedureTransition,
} from './schema.ts';
import { derivedScope } from './scope.ts';

/** Identity comes from the verified capability claims; only the package is the caller's. */
export type EngineSkillIntake = {
  spaceId: string;
  principalId: string;
  jobId: string;
  attemptId: string;
  name: string;
  description: string;
  body: string;
};
export type EngineSkillAdmission = {
  candidateId: string;
  state: EngineSkillState;
  reason: string | null;
};

/** Jobs written before principals belong to the account that set the service up. */
const setupOwner = sql`(select id from owner limit 1)`;

const engineChange = (name: string, description: string) => ({
  target: 'engine_skill',
  name,
  description,
});

/** The digest a prohibition keeps of a body, so the same bytes are recognised under any name. */
export const bodyDigest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Names the engine may not take. A skill Melete ships, or one the owner added to
 * the space, is the catalog's; an engine skill under that name would replace it in
 * every bundle that selects it. Refused rather than renamed: a renamed copy would
 * be delivered beside the skill it rewrote, and the model would read two
 * versions of the same instructions with nothing to say which one holds.
 */
export const BUILT_IN_SKILL_NAMES: ReadonlySet<string> = new Set(
  loadSkills().skills.map((skill) => skill.frontmatter.name),
);

/** Why an intake refused a package outright. The package itself is not kept. */
const REFUSALS = ['body_too_long', 'reserved_name', 'owner_prohibited'];

export const ENGINE_BENEFIT = 'The engine reuses a way of working it wrote down for itself.';
export const ENGINE_RISK =
  'A skill the engine wrote for itself carries no held-out evidence that it helps.';

/**
 * The attempt, job and space of the capability must be the ones the records
 * describe, and the job must belong to the principal the capability names. A
 * request field could claim any of this, so none of it is read from the request.
 */
async function writingAttempt(tx: Transaction, input: EngineSkillIntake) {
  const [row] = await tx
    .select({
      attemptId: attempt.id,
      provider: attempt.provider,
      model: attempt.model,
      jobId: job.id,
      objective: job.objective,
      spaceId: job.spaceId,
    })
    .from(attempt)
    .innerJoin(job, eq(job.id, attempt.jobId))
    .where(
      and(
        eq(attempt.id, input.attemptId),
        eq(attempt.jobId, input.jobId),
        eq(job.spaceId, input.spaceId),
        ownJob(job.principalId, input.principalId),
      ),
    );
  if (!row) throw new ServiceError('scope_denied', 'This attempt cannot write a skill here.', 403);
  return row;
}

/**
 * One skill package, admitted, held or refused. The whole decision commits in the
 * caller's transaction: a skill is never half-admitted, and the per-attempt count
 * is held by the database rather than by this process.
 */
export async function admitEngineSkill(
  tx: Transaction,
  input: EngineSkillIntake,
  reserved: ReadonlySet<string> = BUILT_IN_SKILL_NAMES,
): Promise<EngineSkillAdmission> {
  const parsed = engineSkillIntakeRequest.safeParse({
    name: input.name,
    description: input.description,
    body: input.body,
  });
  if (!parsed.success)
    throw new ServiceError('skill_package_invalid', 'The skill package is not admissible.', 400);
  const skill = parsed.data;
  if (Buffer.byteLength(skill.body, 'utf8') > MAX_ENGINE_BODY_BYTES)
    throw new ServiceError('skill_body_too_large', 'A skill body is at most 64 KB.', 413);
  const source = await writingAttempt(tx, input);
  // One intake at a time for this attempt, so the count below cannot be raced.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.attemptId}))`);
  const taken = await tx
    .select({ name: procedureCandidate.skillName, ordinal: procedureCandidate.ordinal })
    .from(procedureCandidate)
    .where(eq(procedureCandidate.sourceAttemptId, input.attemptId))
    .for('update');
  if (taken.some((row) => row.name === skill.name))
    throw new ServiceError(
      'skill_name_already_decided',
      'This skill name was already decided in this attempt.',
      409,
    );
  if (taken.length >= MAX_ENGINE_SKILLS_PER_ATTEMPT)
    throw new ServiceError(
      'attempt_skill_limit',
      `An attempt may write at most ${MAX_ENGINE_SKILLS_PER_ATTEMPT} skills.`,
      429,
    );
  const scan = scanEngineSkill(skill);
  const decided: { state: EngineSkillState; reason: string | null } =
    scan.verdict === 'rejected'
      ? { state: 'rejected', reason: scan.reason }
      : reserved.has(skill.name)
        ? { state: 'rejected', reason: 'reserved_name' }
        : (await standingProhibition(tx, input.principalId, skill))
          ? { state: 'rejected', reason: 'owner_prohibited' }
          : scan.verdict === 'held'
            ? { state: 'held', reason: scan.reason }
            : await (async () => {
                const taint = await originTaint(tx, source);
                return taint.tainted
                  ? { state: 'held' as const, reason: taint.reason }
                  : { state: 'live' as const, reason: null };
              })();
  const { state, reason } = decided;
  const refused = state === 'rejected';
  // Credential material may sit in the name as easily as in the body, so a package
  // refused for it keeps nothing of itself: the row is named by its place in the
  // attempt, in a form no skill name can take.
  const name = reason?.startsWith('credential_material')
    ? `refused:${taken.length + 1}`
    : skill.name;
  const [registration] = await tx
    .select()
    .from(learningJob)
    .where(eq(learningJob.jobId, source.jobId));
  // A refused package is recorded by its reason; its bytes are not stored.
  const definition = {
    body: refused ? '' : skill.body,
    scope: registration?.scope ?? derivedScope(source.objective).scope,
    compatibleModels: [`${source.provider}/${source.model}`],
    change: engineChange(name, refused ? '' : skill.description),
    tests: [],
    triggers: [],
    checks: [],
    caseTemplates: {},
  };
  const id = newId('pc');
  const live = state === 'live';
  const hash = definitionHash(definition);
  const [saved] = await tx
    .insert(procedureCandidate)
    .values({
      ...definition,
      id,
      spaceId: input.spaceId,
      episodeId: null,
      origin: ENGINE_ORIGIN,
      sourceJobId: source.jobId,
      sourceAttemptId: input.attemptId,
      ordinal: taken.length + 1,
      skillName: name,
      description: refused ? '' : skill.description,
      inputRefs: refused
        ? []
        : await jobInputReferences(tx, { id: source.jobId, spaceId: source.spaceId }),
      state: live ? 'enabled_canary' : refused ? 'reverted' : 'candidate',
      holdReason: state === 'held' ? reason : null,
      rejectionReason: refused ? reason : null,
      canarySpaceId: live ? input.spaceId : null,
      bodyHash: hash,
      promotion: live
        ? {
            scope: 'private' as const,
            principal_id: input.principalId,
            basis: ENGINE_BASIS,
            definition_hash: hash,
          }
        : { scope: 'private' as const, principal_id: input.principalId },
      predictedBenefit: ENGINE_BENEFIT,
      knownRisk: ENGINE_RISK,
    })
    .returning();
  if (!saved) throw new Error('Engine skill insert returned no row');
  if (live) await supersedeSameName(tx, saved, 'engine');
  await tx.insert(procedureTransition).values({
    id: newId('pt'),
    candidateId: id,
    fromState: null,
    toState: saved.state,
    actor: 'engine',
    reason: live
      ? 'The engine wrote this skill on clean owner input, with no link or authority language.'
      : refused
        ? `Refused without storing the package: ${reason}`
        : `Held for the owner to read: ${reason}`,
  });
  return { candidateId: id, state, reason };
}

/**
 * A prohibition this person placed and has not lifted, on this name or on these
 * exact bytes under any name. It holds in every space they belong to, wherever it
 * was placed: "don't do this" is said about the skill, not about one room.
 */
async function standingProhibition(
  tx: Transaction,
  principalId: string,
  skill: { name: string; body: string },
) {
  const [row] = await tx
    .select({ id: engineSkillProhibition.id })
    .from(engineSkillProhibition)
    .where(
      and(
        eq(engineSkillProhibition.principalId, principalId),
        isNull(engineSkillProhibition.liftedAt),
        or(
          eq(engineSkillProhibition.skillName, skill.name),
          eq(engineSkillProhibition.bodySha256, bodyDigest(skill.body)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every standing prohibition of one person, in any space, for delivery to consult. */
export async function standingProhibitions(tx: Transaction, principalId: string) {
  const rows = await tx
    .select({
      name: engineSkillProhibition.skillName,
      digest: engineSkillProhibition.bodySha256,
    })
    .from(engineSkillProhibition)
    .where(
      and(
        eq(engineSkillProhibition.principalId, principalId),
        isNull(engineSkillProhibition.liftedAt),
      ),
    );
  return {
    names: new Set(rows.map((row) => row.name)),
    digests: new Set(rows.flatMap((row) => (row.digest ? [row.digest] : []))),
  };
}

/**
 * Engine skills are private to the person whose job wrote them, in any space
 * they belong to: a member of a shared space has the same controls over their own
 * as the owner has over theirs. Every read below is then fenced to that person's
 * own jobs, so the space's owner never sees a member's skill, nor a member the
 * owner's.
 */
async function requireSkillSpace(tx: Transaction, principalId: string, spaceId: string) {
  await spaceAuthority(tx, spaceId, principalId, true);
  const state = await tx.execute(
    sql`select revoked, restore_ready from memory_spaces where space_id = ${spaceId}`,
  );
  const memory = state[0];
  if (memory && (memory.revoked || !memory.restore_ready))
    throw new ServiceError('scope_denied', 'Space is unavailable.', 403);
}

/**
 * A name is a skill, and the engine rewrites its own skills. When one goes live,
 * any earlier live skill of the same name for the same owner in the same space
 * steps aside, so a later attempt is given one file under that name, never two.
 */
async function supersedeSameName(tx: Transaction, candidate: Candidate, actor: string) {
  const previous = await tx
    .select()
    .from(procedureCandidate)
    .where(
      and(
        eq(procedureCandidate.spaceId, candidate.spaceId),
        eq(procedureCandidate.origin, ENGINE_ORIGIN),
        eq(procedureCandidate.skillName, candidate.skillName ?? ''),
        eq(procedureCandidate.state, 'enabled_canary'),
        isNull(procedureCandidate.rejectionReason),
        sql`${procedureCandidate.promotion}->>'principal_id'
          = ${candidate.promotion.principal_id ?? ''}`,
      ),
    )
    .for('update');
  for (const old of previous) {
    if (old.id === candidate.id) continue;
    await transitionProcedure(
      tx,
      old,
      'superseded',
      actor,
      `Superseded by ${candidate.id}, written for the same skill name.`,
    );
  }
}

/** What the intake refused outright, as opposed to what the owner later stopped. */
const isRefusal = (reason: string) =>
  reason.startsWith('credential_material') || REFUSALS.includes(reason);

export type EngineSkillView = {
  id: string;
  name: string;
  description: string;
  body: string;
  definition_hash: string;
  state: 'live' | 'held' | 'paused' | 'rejected' | 'reverted';
  reason: string | null;
  source_job_id: string | null;
  created_at: string;
};

export function engineSkillView(candidate: Candidate): EngineSkillView {
  const state: EngineSkillView['state'] = candidate.rejectionReason
    ? isRefusal(candidate.rejectionReason)
      ? 'rejected'
      : 'reverted'
    : candidate.holdReason
      ? 'held'
      : candidate.pausedAt
        ? 'paused'
        : candidate.state === 'enabled_canary'
          ? 'live'
          : 'held';
  return {
    id: candidate.id,
    name: candidate.skillName ?? '',
    description: candidate.description ?? '',
    body: candidate.body,
    definition_hash: candidate.bodyHash,
    state,
    reason: candidate.holdReason ?? candidate.rejectionReason,
    source_job_id: candidate.sourceJobId,
    created_at: candidate.createdAt.toISOString(),
  };
}

export type EngineSkillProhibitionView = {
  id: string;
  space_id: string;
  name: string;
  body_sha256: string | null;
  reason: string;
  source_skill_id: string | null;
  created_at: string;
};

const prohibitionView = (
  row: typeof engineSkillProhibition.$inferSelect,
): EngineSkillProhibitionView => ({
  id: row.id,
  space_id: row.spaceId,
  name: row.skillName,
  body_sha256: row.bodySha256,
  reason: row.reason,
  source_skill_id: row.sourceCandidateId,
  created_at: row.createdAt.toISOString(),
});

export class EngineSkillService {
  /**
   * `catalogNames` adds the names of the skills a space's owner installed to the
   * built-in ones an engine skill may not take.
   */
  constructor(
    readonly jobs: Pick<JobService, 'transaction'>,
    readonly catalogNames?: (spaceId: string) => Promise<Iterable<string>>,
  ) {}

  private async reservedNames(spaceId: string): Promise<ReadonlySet<string>> {
    if (!this.catalogNames) return BUILT_IN_SKILL_NAMES;
    return new Set([...BUILT_IN_SKILL_NAMES, ...(await this.catalogNames(spaceId))]);
  }

  /**
   * What the capability-authenticated route calls. Every identity here comes
   * from the verified claims, or, when a capability names no principal, from the
   * writing job's own recorded principal. None of it comes from the request.
   */
  async intake(
    claims: { space_id: string; job_id: string; attempt_id: string; principal_id?: string },
    skill: { name: string; description: string; body: string },
  ): Promise<EngineSkillAdmission> {
    const reserved = await this.reservedNames(claims.space_id);
    return this.jobs.transaction(async (tx) => {
      const [writer] = await tx
        .select({ principalId: sql<string | null>`coalesce(${job.principalId}, ${setupOwner})` })
        .from(job)
        .where(eq(job.id, claims.job_id));
      const principalId = claims.principal_id ?? writer?.principalId;
      if (!principalId)
        throw new ServiceError('scope_denied', 'This attempt names no principal.', 403);
      return admitEngineSkill(
        tx,
        {
          spaceId: claims.space_id,
          principalId,
          jobId: claims.job_id,
          attemptId: claims.attempt_id,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        },
        reserved,
      );
    });
  }

  /**
   * One engine skill, locked, with the writing job fenced to this principal: a
   * member of a shared space never reads or changes another principal's skill.
   */
  async locked(tx: Transaction, ownerId: string, spaceId: string, id: string) {
    await requireSkillSpace(tx, ownerId, spaceId);
    // The fence first, over the writing job, then the row lock on the skill alone:
    // locking a running job's row here would contend with the attempt that owns it.
    const [visible] = await tx
      .select({ id: procedureCandidate.id })
      .from(procedureCandidate)
      .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
      .where(
        and(
          eq(procedureCandidate.id, id),
          eq(procedureCandidate.spaceId, spaceId),
          eq(procedureCandidate.origin, ENGINE_ORIGIN),
          ownJob(job.principalId, ownerId),
        ),
      );
    if (!visible) throw new ServiceError('not_found', 'Skill not found.', 404);
    const [candidate] = await tx
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, id))
      .for('update');
    if (!candidate) throw new ServiceError('not_found', 'Skill not found.', 404);
    return candidate;
  }

  /** What the owner queue shows: the skills waiting, each with the exact body. */
  async held(ownerId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireSkillSpace(tx, ownerId, spaceId);
      const rows = await tx
        .select({ candidate: procedureCandidate })
        .from(procedureCandidate)
        .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(procedureCandidate.origin, ENGINE_ORIGIN),
            isNotNull(procedureCandidate.holdReason),
            isNull(procedureCandidate.rejectionReason),
            ownJob(job.principalId, ownerId),
          ),
        )
        .orderBy(asc(procedureCandidate.createdAt))
        .limit(50);
      return rows.map((row) => engineSkillView(row.candidate));
    });
  }

  /** Every engine skill this principal has in the space, whatever its state. */
  async list(ownerId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireSkillSpace(tx, ownerId, spaceId);
      const rows = await tx
        .select({ candidate: procedureCandidate })
        .from(procedureCandidate)
        .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(procedureCandidate.origin, ENGINE_ORIGIN),
            ownJob(job.principalId, ownerId),
          ),
        )
        .orderBy(asc(procedureCandidate.createdAt))
        .limit(100);
      return rows.map((row) => engineSkillView(row.candidate));
    });
  }

  /** The owner's one tap: these exact bytes, by hash, become live. */
  async approve(ownerId: string, spaceId: string, id: string, definition: string) {
    return this.jobs.transaction(async (tx) => {
      const candidate = await this.locked(tx, ownerId, spaceId, id);
      if (candidate.rejectionReason || candidate.state !== 'candidate' || !candidate.holdReason)
        throw new ServiceError('invalid_procedure_state', 'This skill is not waiting for you.');
      if (definition !== candidate.bodyHash)
        throw new ServiceError(
          'definition_hash_mismatch',
          'The approved skill is not the current one; read it again.',
        );
      if (!engineDefinitionIntact(candidate))
        throw new ServiceError('definition_changed', 'The skill no longer matches what it was.');
      await this.requireNotProhibited(tx, ownerId, candidate, candidate.body);
      await tx
        .update(procedureCandidate)
        .set({
          holdReason: null,
          canarySpaceId: spaceId,
          promotion: {
            scope: 'private',
            principal_id: ownerId,
            basis: ENGINE_BASIS,
            definition_hash: candidate.bodyHash,
            approved_at: new Date().toISOString(),
          },
        })
        .where(eq(procedureCandidate.id, id));
      const saved = await transitionProcedure(
        tx,
        candidate,
        'enabled_canary',
        ownerId,
        'The owner read this skill and approved these exact bytes.',
      );
      await supersedeSameName(tx, saved, ownerId);
      return engineSkillView(saved);
    });
  }

  /** The owner's other tap. Nothing of the body survives a decline. */
  async decline(ownerId: string, spaceId: string, id: string) {
    return this.erase(ownerId, spaceId, id, 'owner_declined', 'The owner declined this skill.');
  }

  /** Stop delivering it and erase the bytes, whatever state it was in. */
  async remove(ownerId: string, spaceId: string, id: string) {
    return this.erase(ownerId, spaceId, id, 'owner_deleted', 'The owner deleted this skill.');
  }

  private async erase(
    ownerId: string,
    spaceId: string,
    id: string,
    reason: string,
    message: string,
  ) {
    return this.jobs.transaction(async (tx) => {
      const candidate = await this.locked(tx, ownerId, spaceId, id);
      await tx
        .update(procedureCandidate)
        .set({
          body: '',
          description: '',
          change: engineChange(candidate.skillName ?? '', ''),
          inputRefs: [],
          holdReason: null,
          pausedAt: null,
          rejectionReason: reason,
        })
        .where(eq(procedureCandidate.id, id));
      return engineSkillView(
        await transitionProcedure(tx, candidate, 'reverted', ownerId, message),
      );
    });
  }

  /** Paused skills are not delivered; the next attempt sees nothing. */
  async pause(ownerId: string, spaceId: string, id: string) {
    return this.setPaused(ownerId, spaceId, id, new Date(), 'The owner paused this skill.');
  }

  async resume(ownerId: string, spaceId: string, id: string) {
    return this.setPaused(ownerId, spaceId, id, null, 'The owner resumed this skill.');
  }

  private async setPaused(
    ownerId: string,
    spaceId: string,
    id: string,
    pausedAt: Date | null,
    message: string,
  ) {
    return this.jobs.transaction(async (tx) => {
      const candidate = await this.locked(tx, ownerId, spaceId, id);
      if (candidate.rejectionReason || candidate.state !== 'enabled_canary')
        throw new ServiceError('invalid_procedure_state', 'Only a live skill can be paused.');
      await tx.update(procedureCandidate).set({ pausedAt }).where(eq(procedureCandidate.id, id));
      return engineSkillView(
        await transitionProcedure(tx, candidate, candidate.state, ownerId, message),
      );
    });
  }

  /**
   * The owner's own edit. These are the owner's words, so a link or a plain
   * instruction is theirs to write; credential material is still refused, and
   * the edited bytes are a new definition the owner has by definition approved.
   */
  async edit(ownerId: string, spaceId: string, id: string, definition: string, body: string) {
    return this.jobs.transaction(async (tx) => {
      const candidate = await this.locked(tx, ownerId, spaceId, id);
      if (candidate.rejectionReason)
        throw new ServiceError('invalid_procedure_state', 'This skill is no longer available.');
      if (definition !== candidate.bodyHash)
        throw new ServiceError(
          'definition_hash_mismatch',
          'The edited skill is not the current one; read it again.',
        );
      if (Buffer.byteLength(body, 'utf8') > MAX_ENGINE_BODY_BYTES)
        throw new ServiceError('skill_body_too_large', 'A skill body is at most 64 KB.', 413);
      const material = credentialMaterial(`${candidate.skillName ?? ''}\n${body}`);
      if (material)
        throw new ServiceError('skill_body_refused', `credential_material:${material}`, 422);
      // The owner may write a longer skill than the engine may, up to the ceiling that
      // applies to anything read on every attempt.
      if (estimateTokens(body) > MAX_ENGINE_SKILL_TOKENS)
        throw new ServiceError('skill_body_refused', 'body_too_long', 422);
      await this.requireNotProhibited(tx, ownerId, candidate, body);
      const edited = {
        body,
        scope: candidate.scope,
        compatibleModels: candidate.compatibleModels,
        change: engineChange(candidate.skillName ?? '', candidate.description ?? ''),
        tests: candidate.tests,
        triggers: candidate.triggers,
        checks: candidate.checks,
        caseTemplates: candidate.caseTemplates,
      };
      const hash = definitionHash(edited);
      await tx
        .update(procedureCandidate)
        .set({
          body,
          change: edited.change,
          bodyHash: hash,
          holdReason: null,
          pausedAt: null,
          canarySpaceId: spaceId,
          promotion: {
            scope: 'private',
            principal_id: ownerId,
            basis: ENGINE_BASIS,
            definition_hash: hash,
            approved_at: new Date().toISOString(),
          },
        })
        .where(eq(procedureCandidate.id, id));
      const saved = await transitionProcedure(
        tx,
        candidate,
        'enabled_canary',
        ownerId,
        'The owner rewrote this skill; the edited bytes are what is delivered.',
      );
      await supersedeSameName(tx, saved, ownerId);
      return engineSkillView(saved);
    });
  }

  /** Approving or rewriting what this person prohibited waits until they lift it. */
  private async requireNotProhibited(
    tx: Transaction,
    principalId: string,
    candidate: Candidate,
    body: string,
  ) {
    if (
      await standingProhibition(tx, principalId, {
        name: candidate.skillName ?? '',
        body,
      })
    )
      throw new ServiceError(
        'skill_prohibited',
        'You told Melete not to do this; lift that first.',
        409,
      );
  }

  /**
   * "Do not do this": the skill stops, and its name and its exact body are
   * prohibited for this person in every space they belong to. The engine can
   * write neither again, under this name or any other, until the person lifts it.
   */
  async stop(ownerId: string, spaceId: string, id: string, reason: string) {
    return this.jobs.transaction(async (tx) => {
      const candidate = await this.locked(tx, ownerId, spaceId, id);
      const [existing] = await tx
        .select({ id: engineSkillProhibition.id })
        .from(engineSkillProhibition)
        .where(
          and(
            eq(engineSkillProhibition.sourceCandidateId, candidate.id),
            eq(engineSkillProhibition.principalId, ownerId),
            isNull(engineSkillProhibition.liftedAt),
          ),
        );
      if (!existing)
        await tx.insert(engineSkillProhibition).values({
          id: newId('esp'),
          spaceId,
          principalId: ownerId,
          skillName: candidate.skillName ?? '',
          bodySha256: candidate.body ? bodyDigest(candidate.body) : null,
          reason,
          sourceCandidateId: candidate.id,
        });
      if (candidate.state === 'reverted') return engineSkillView(candidate);
      await tx
        .update(procedureCandidate)
        .set({ rejectionReason: `owner_stopped:${reason}`, holdReason: null, pausedAt: null })
        .where(eq(procedureCandidate.id, id));
      return engineSkillView(
        await transitionProcedure(tx, candidate, 'reverted', ownerId, `Owner stopped: ${reason}`),
      );
    });
  }

  /** The prohibitions this person has standing, wherever they placed them, newest first. */
  async prohibitions(principalId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireSkillSpace(tx, principalId, spaceId);
      const rows = await tx
        .select()
        .from(engineSkillProhibition)
        .where(
          and(
            eq(engineSkillProhibition.principalId, principalId),
            isNull(engineSkillProhibition.liftedAt),
          ),
        )
        .orderBy(desc(engineSkillProhibition.createdAt))
        .limit(100);
      return rows.map(prohibitionView);
    });
  }

  /** Only the person who placed a prohibition can lift it, from any of their spaces. */
  async lift(principalId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      await requireSkillSpace(tx, principalId, spaceId);
      const [lifted] = await tx
        .update(engineSkillProhibition)
        .set({ liftedAt: new Date() })
        .where(
          and(
            eq(engineSkillProhibition.id, id),
            eq(engineSkillProhibition.principalId, principalId),
            isNull(engineSkillProhibition.liftedAt),
          ),
        )
        .returning();
      if (!lifted) throw new ServiceError('not_found', 'Prohibition not found.', 404);
      return prohibitionView(lifted);
    });
  }
}
