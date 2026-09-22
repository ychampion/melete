import { expect } from 'bun:test';
import { attemptOutcome } from '@melete/contracts';
import { desc, eq } from 'drizzle-orm';
import { ScriptedRecordRuntime } from '../../../../conformance/learning/scripted-runtime.ts';
import { attempt } from '../../src/db/schema.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import type { JobRow } from '../../src/jobs/service.ts';
import { type Candidate, ProcedureService } from '../../src/learning/procedures.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { episode, procedureCandidate, procedureEvaluation } from '../../src/learning/schema.ts';
import { newId } from '../../src/memory/db.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { learningFixture, wake } from './learning-fixtures.ts';

export const at = (source: 'intervention' | 'objective', text: string, quote: string) => {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`The fixture quote is not in its source: ${quote}`);
  return { source, start, end: start + quote.length, quote };
};

/** A general-family learning fixture: the step-interpreting runtime and a scripted proposer. */
export async function generalLearningFixture() {
  const runtime = new ScriptedRecordRuntime();
  const fixture = await learningFixture(runtime);
  if (!fixture) return null;
  let output: unknown = null;
  const requests: unknown[] = [];
  const gateway = await openProposalGateway({
    db: fixture.handle.db,
    provider: 'fake',
    model: 'scripted-proposer-v1',
    providers: [fakeProvider],
    fake: (body, id, protocol) => {
      requests.push(body);
      return createScriptedProvider([{ text: JSON.stringify(output) }])(body, id, protocol);
    },
  });
  const proposer = new ProcedureProposer(fixture.jobs, gateway);
  const procedures = new ProcedureService(fixture.jobs);

  async function run(row: JobRow) {
    if (!fixture) throw new Error('No fixture');
    await fixture.runner.handleWake(wake(row));
    let current = await fixture.jobs.get(row.id);
    const deadline = Date.now() + 15000;
    while (!['completed', 'failed', 'cancelled'].includes(current.state) && Date.now() < deadline) {
      await Bun.sleep(20);
      current = await fixture.jobs.get(row.id);
    }
    expect(current.state).toBe('completed');
    const [execution] = await fixture.handle.db
      .select()
      .from(attempt)
      .where(eq(attempt.jobId, row.id))
      .orderBy(desc(attempt.epoch))
      .limit(1);
    const outcome = attemptOutcome.parse(execution?.outcomeDetail);
    if (outcome.kind !== 'completed') throw new Error('Expected a completed output');
    return outcome.summary;
  }

  const create = (spaceId: string, objective: string, principal = fixture.ownerId) =>
    principalContext.run(principal, () =>
      fixture.jobs.create(
        { space_id: spaceId, title: 'Owner request', objective },
        'owner_request',
      ),
    );

  return {
    ...fixture,
    runtime,
    gateway,
    proposer,
    procedures,
    requests,
    propose(value: unknown) {
      output = value;
    },
    run,
    create,
    async history(spaceId: string, objective: string) {
      const row = await create(spaceId, objective);
      await run(row);
      return row;
    },
    /** A completed job, the owner's correction, and the corrective job's own answer. */
    async corrected(spaceId: string, key: string, objective: string, correction: string) {
      const row = await create(spaceId, objective);
      await run(row);
      const source = await fixture.episodes.intervene(fixture.ownerId, row.id, {
        idempotency_key: key,
        kind: 'correction',
        text: correction,
      });
      if (!source.correctiveJobId) throw new Error('No corrective job');
      await run(await fixture.jobs.get(source.correctiveJobId));
      const [saved] = await fixture.handle.db
        .select()
        .from(episode)
        .where(eq(episode.id, source.id));
      if (!saved) throw new Error('No episode');
      return { episode: saved, jobId: row.id };
    },
    /**
     * Evaluation evidence written directly, for tests about what happens after a
     * candidate has earned it: a selected validation and a passing sealed final
     * bound to that selection, then a private one-space canary.
     */
    async evaluatedCanary(candidate: Candidate) {
      const validationId = newId('pe');
      const selectedAt = new Date(Date.now() - 1000);
      await fixture.handle.db.insert(procedureEvaluation).values([
        {
          id: validationId,
          candidateId: candidate.id,
          bodyHash: candidate.bodyHash,
          phase: 'validation',
          suiteId: 'episode-derived/1',
          suiteHash: 'a'.repeat(64),
          evidence: { status: 'complete', selection_evaluation_id: null },
          budget: {},
          passed: true,
          selectedAt,
        },
        {
          id: newId('pe'),
          candidateId: candidate.id,
          bodyHash: candidate.bodyHash,
          phase: 'sealed_final',
          suiteId: 'episode-derived/1',
          suiteHash: 'b'.repeat(64),
          evidence: { status: 'complete', selection_evaluation_id: validationId },
          budget: {},
          passed: true,
        },
      ]);
      const [saved] = await fixture.handle.db
        .update(procedureCandidate)
        .set({
          state: 'enabled_canary',
          selectedEvaluationId: validationId,
          canarySpaceId: candidate.spaceId,
          promotion: { scope: 'private', principal_id: fixture.ownerId },
        })
        .where(eq(procedureCandidate.id, candidate.id))
        .returning();
      if (!saved) throw new Error('No canary');
      return saved;
    },
    async close() {
      await gateway.close();
      await fixture.close();
    },
  };
}

export const CORRECTION =
  'Too formal. Use bullet points, and start with "Hi there," on its own line.';
export const SOURCE = 'Draft a follow-up email to the recruiter after the interview';

export const messageProposal = (
  correction = CORRECTION,
  greeting = 'Hi there,',
  variants: readonly string[] = [],
) => ({
  target: 'skill_body',
  steps: [
    { text: 'Use bullet points.', evidence: at('intervention', correction, 'Use bullet points') },
    {
      text: `Start with "${greeting}" on its own line.`,
      evidence: at('intervention', correction, `start with "${greeting}" on its own line`),
    },
  ],
  triggers: [{ phrase: 'follow-up email', evidence: at('objective', SOURCE, 'follow-up email') }],
  checks: [
    { kind: 'output_format', form: 'bullets' },
    { kind: 'required_sections', headings: [greeting.replace(/,$/, '')] },
  ],
  variant_objectives: variants,
});
