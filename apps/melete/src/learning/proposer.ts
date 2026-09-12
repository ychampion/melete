import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { visibleJob } from '../principals/authority.ts';
import { requireLearningSpace } from './episodes.ts';
import { compileProcedure, definitionHash } from './procedure.ts';
import type { ProposalGateway } from './proposal-gateway.ts';
import { learningModelCall } from './proposal-schema.ts';
import { episode, procedureCandidate, procedureTransition } from './schema.ts';

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
      if (existing) return { existing, saved: null };
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
      return { saved, existing: null };
    });
    if (source.existing) return source.existing;
    const saved = source.saved;
    if (!saved?.intervention) throw new Error('Missing reserved intervention');
    try {
      const raw = await this.gateway.propose(
        { episodeId, spaceId, jobId: saved.jobId },
        generalSignal(saved.intervention),
      );
      const compiled = compileProcedure(raw);
      const compatibleModels = [
        ...new Set(
          saved.versions.map((version) => `${version.provider}/${version.model_requested}`),
        ),
      ];
      if (!compatibleModels.length) throw new Error('proposal_versions_missing');
      const definition = { ...compiled, scope: saved.scope, compatibleModels };
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
            ...definition,
            bodyHash: definitionHash(definition),
          })
          .returning();
        if (!candidate) throw new Error('Candidate insert returned no row');
        await tx.insert(procedureTransition).values({
          id: newId('pt'),
          candidateId: candidate.id,
          fromState: null,
          toState: 'candidate',
          actor: 'proposer',
          reason: 'Completed owner intervention; not evaluated or enabled.',
        });
        await tx
          .update(episode)
          .set({ generationState: 'proposed' })
          .where(eq(episode.id, episodeId));
        return candidate;
      });
    } catch {
      await this.jobs.db
        .update(episode)
        .set({ generationState: 'rejected' })
        .where(and(eq(episode.id, episodeId), eq(episode.restricted, false)));
      await this.jobs.db
        .update(learningModelCall)
        .set({ errorCode: 'proposal_rejected' })
        .where(eq(learningModelCall.episodeId, episodeId));
      throw new ServiceError(
        'proposal_rejected',
        'The proposal failed its bounded generation checks.',
      );
    }
  }

  async drain() {
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
        await this.generate(source.actor, source.spaceId, source.id);
      } catch {
        /* A bounded rejection stays in the episode and call ledger for inspection. */
      }
    }
  }
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
