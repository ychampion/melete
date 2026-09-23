import { type Intervention, PROCEDURE_CHECK_KINDS } from '@melete/contracts';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { ServiceError } from '../api/errors.ts';
import { job } from '../db/schema.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { visibleJob } from '../principals/authority.ts';
import {
  AdmissionError,
  admitProposal,
  MAX_CHECKS,
  MAX_STEP_CHARS,
  MAX_STEPS,
  MAX_TRIGGERS,
  MAX_VARIANTS,
} from './admit.ts';
import { discriminate } from './discriminate.ts';
import { discriminationInput } from './discrimination-input.ts';
import { type EpisodeRow, requireLearningSpace } from './episodes.ts';
import { compileProcedure, definitionHash, RECORDS_FAMILY } from './procedure.ts';
import type { Candidate } from './procedures.ts';
import type { ProposalGateway } from './proposal-gateway.ts';
import { learningModelCall } from './proposal-schema.ts';
import { objectiveIsOwnerText } from './provenance.ts';
import { episode, procedureCandidate, procedureTransition } from './schema.ts';

/** Tool names help a model phrase a step; a long catalog would only crowd out the correction. */
const MAX_TOOL_NAMES = 20;

/** The proposer has inference and candidate insertion; it has no evaluation or promotion capability. */
export class ProcedureProposer {
  constructor(
    readonly jobs: JobService,
    readonly gateway: ProposalGateway,
  ) {}

  async generate(ownerId: string, spaceId: string, episodeId: string) {
    const source = await this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, ownerId, spaceId);
      const [saved] = await tx
        .select()
        .from(episode)
        .where(
          and(
            eq(episode.id, episodeId),
            visibleJob(episode.jobId, ownerId),
            eq(episode.spaceId, spaceId),
            eq(episode.restricted, false),
            gt(episode.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!saved) throw new ServiceError('not_found', 'Episode not found.', 404);
      const [existing] = await tx
        .select()
        .from(procedureCandidate)
        .where(eq(procedureCandidate.episodeId, episodeId));
      if (existing) return { existing, saved: null, objective: '', quotable: false };
      if (
        saved.judgement !== 'corrected' ||
        !saved.intervention ||
        saved.scope.task_family === 'unclassified'
      )
        throw new ServiceError(
          'not_procedural',
          'A completed correction with a general procedure signal is required.',
        );
      if (saved.generationState !== 'pending')
        throw new ServiceError(
          'proposal_already_attempted',
          'The proposal call is already reserved or recorded.',
        );
      await tx
        .update(episode)
        .set({ generationState: 'generating', generationStartedAt: new Date() })
        .where(eq(episode.id, episodeId));
      const [origin] = await tx
        .select({
          objective: job.objective,
          objectiveOrigin: job.objectiveOrigin,
          principalId: job.principalId,
        })
        .from(job)
        .where(eq(job.id, saved.jobId));
      return {
        saved,
        existing: null,
        objective: origin?.objective ?? '',
        quotable: !!origin && objectiveIsOwnerText(origin, saved.actor),
      };
    });
    if (source.existing) return source.existing;
    const saved = source.saved;
    if (!saved?.intervention) throw new Error('Missing reserved intervention');
    try {
      // The records family keeps its audited vocabulary; every other family proposes in words.
      const proposed =
        saved.scope.task_family === RECORDS_FAMILY
          ? await this.recordsDefinition(saved, saved.intervention)
          : await this.generalDefinition(
              saved,
              saved.intervention,
              source.objective,
              source.quotable,
            );
      return await this.jobs.transaction(async (tx) => {
        await requireLearningSpace(tx, ownerId, spaceId);
        const [current] = await tx
          .select()
          .from(episode)
          .where(
            and(
              eq(episode.id, episodeId),
              visibleJob(episode.jobId, ownerId),
              eq(episode.restricted, false),
              gt(episode.expiresAt, new Date()),
            ),
          )
          .for('update');
        if (current?.generationState !== 'generating')
          throw new Error('proposal_evidence_unavailable');
        const [candidate] = await tx
          .insert(procedureCandidate)
          .values({
            id: newId('pc'),
            episodeId,
            spaceId,
            ...proposed.definition,
            bodyHash: definitionHash(proposed.definition),
          })
          .returning();
        if (!candidate) throw new Error('Candidate insert returned no row');
        await tx.insert(procedureTransition).values({
          id: newId('pt'),
          candidateId: candidate.id,
          fromState: null,
          toState: 'candidate',
          actor: 'proposer',
          reason: proposed.reason,
        });
        await tx
          .update(episode)
          .set({ generationState: 'proposed' })
          .where(eq(episode.id, episodeId));
        return candidate;
      });
    } catch (error) {
      // The refusal and its reason are one record: a crash between them would leave
      // a rejected episode with nothing saying why.
      await this.jobs.transaction(async (tx) => {
        await tx
          .update(episode)
          .set({ generationState: 'rejected' })
          .where(and(eq(episode.id, episodeId), eq(episode.restricted, false)));
        await tx
          .update(learningModelCall)
          .set({ errorCode: 'proposal_rejected', errorDetail: refusalCode(error) })
          .where(eq(learningModelCall.episodeId, episodeId));
      });
      throw new ServiceError(
        'proposal_rejected',
        'The proposal failed its bounded generation checks.',
      );
    }
  }

  private async recordsDefinition(saved: EpisodeRow, intervention: Intervention) {
    const raw = await this.gateway.propose(
      { episodeId: saved.id, spaceId: saved.spaceId, jobId: saved.jobId },
      generalSignal(intervention),
    );
    const compiled = compileProcedure(raw);
    const compatibleModels = modelsOf(saved);
    return {
      definition: { ...compiled, scope: saved.scope, compatibleModels },
      reason: 'Completed owner intervention; not evaluated or enabled.',
    };
  }

  /**
   * Only the correction, the objective, the scope, tool names and the closed
   * check vocabulary cross. Receipts, artifacts, recorded outputs, memory
   * handles and identifiers stay here, where the discrimination gate reads them.
   * An objective the owner did not write stays here too: triggers are then
   * quoted from the correction, and still have to occur in the objective.
   */
  private async generalDefinition(
    saved: EpisodeRow,
    intervention: Intervention,
    objective: string,
    quotable: boolean,
  ) {
    const { raw, sources } = await this.gateway.proposeGeneral(
      { episodeId: saved.id, spaceId: saved.spaceId, jobId: saved.jobId },
      {
        task: 'propose_procedure',
        scope: {
          task_family: saved.scope.task_family,
          app: saved.scope.app,
          app_version: saved.scope.app_version,
        },
        signal: null,
        sources: [
          { id: 'intervention', offset: 0, text: intervention.text },
          ...(quotable ? [{ id: 'objective' as const, offset: 0, text: objective }] : []),
        ],
        tools_used: [
          ...new Set(saved.versions.flatMap((version) => version.tools.map((tool) => tool.name))),
        ].slice(0, MAX_TOOL_NAMES),
        check_kinds: PROCEDURE_CHECK_KINDS.filter((kind) => kind !== 'records_expected_order'),
        limits: {
          max_steps: MAX_STEPS,
          max_step_chars: MAX_STEP_CHARS,
          max_triggers: MAX_TRIGGERS,
          max_checks: MAX_CHECKS,
          max_variants: MAX_VARIANTS,
        },
      },
    );
    const admitted = admitProposal(raw, { sources, objective });
    const compatibleModels = modelsOf(saved);
    const discrimination = discriminate(
      admitted.checks,
      await discriminationInput(this.jobs.db, saved),
    );
    return {
      definition: {
        change: admitted.change as unknown as Record<string, unknown>,
        body: admitted.body,
        tests: admitted.tests,
        predictedBenefit: admitted.predictedBenefit,
        knownRisk: admitted.knownRisk,
        triggers: admitted.triggers,
        checks: admitted.checks,
        evidence: admitted.evidence,
        discrimination,
        scope: saved.scope,
        compatibleModels,
      },
      // A candidate whose checks do not discriminate is kept, not rejected: a later
      // corrected output can still make it evaluable, and the call is already spent.
      reason: `Completed owner intervention; not evaluated or enabled. Checks: ${discrimination.detail}.`,
    };
  }

  /** Proposes from waiting corrections; returns what it proposed, for whoever applies it. */
  async drain() {
    const proposed: { ownerId: string; spaceId: string; candidate: Candidate }[] = [];
    // A timed-out reservation is history, never an invitation to silently spend a second call.
    await this.jobs.db.execute(sql`
      update episode set generation_state = 'rejected'
      where generation_state = 'generating' and generation_started_at < now() - interval '2 minutes'`);
    const pending = await this.jobs.db
      .select()
      .from(episode)
      .where(
        and(
          eq(episode.generationState, 'pending'),
          eq(episode.judgement, 'corrected'),
          isNotNull(episode.intervention),
          sql`${episode.scope}->>'task_family' <> 'unclassified'`,
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
        ),
      )
      .limit(2);
    for (const source of pending) {
      try {
        const candidate = await this.generate(source.actor, source.spaceId, source.id);
        proposed.push({ ownerId: source.actor, spaceId: source.spaceId, candidate });
      } catch {
        /* A bounded rejection stays in the episode and call ledger for inspection. */
      }
    }
    return proposed;
  }
}

/**
 * A reason code for the ledger, never the refused text. Admission reasons name a
 * rule and, at most, a term from a fixed list; anything that is not a bare
 * snake_case code is recorded as a generic failure rather than risk copying content.
 */
export function refusalCode(error: unknown): string {
  if (error instanceof AdmissionError) return error.reason;
  if (error instanceof ZodError) return 'proposal_schema_invalid';
  if (error instanceof Error && /^[a-z][a-z_]{2,60}$/.test(error.message)) return error.message;
  return 'proposal_failed';
}

function modelsOf(saved: EpisodeRow) {
  const compatibleModels = [
    ...new Set(saved.versions.map((version) => `${version.provider}/${version.model_requested}`)),
  ];
  if (!compatibleModels.length) throw new Error('proposal_versions_missing');
  return compatibleModels;
}

function generalSignal(change: { signal: string; text: string }) {
  if (change.signal !== 'unspecified') return change.signal;
  // Only a finite category crosses the gateway. Private words, names and values cannot follow it.
  if (
    /\b(number|numeric|numerically|date|chronological|chronologically|type|typed)\b/i.test(
      change.text,
    )
  )
    return 'typed_ordering';
  if (/\b(lexical|lexically|alphabetical|alphabetically)\b/i.test(change.text))
    return 'text_ordering';
  return 'preserve_structure';
}
