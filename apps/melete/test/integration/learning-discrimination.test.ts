import { afterAll, describe, expect, test } from 'bun:test';
import type { ProcedureDiscrimination } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { admitProposal } from '../../src/learning/admit.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { definitionHash } from '../../src/learning/procedure.ts';
import { procedureCandidate, procedureEvaluation } from '../../src/learning/schema.ts';
import { GENERAL_FAMILY } from '../../src/learning/scope.ts';
import { newId } from '../../src/memory/db.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { learningFixture, rejectsWith, wake } from './learning-fixtures.ts';

const fixture = await learningFixture();
const evaluator = fixture
  ? new ProcedureEvaluator(fixture.jobs, new StubRuntimeAdapter(), fixture.runner.options)
  : null;
afterAll(async () => {
  await fixture?.close();
}, 15000);

const objective = 'Draft a follow-up email to the recruiter';
const correction = 'Use bullet points, and never open with a pleasantry.';

async function storedCandidate(key: string, discrimination: ProcedureDiscrimination) {
  if (!fixture) throw new Error('No fixture');
  const row = await principalContext.run(fixture.ownerId, () =>
    fixture.jobs.create({ space_id: fixture.spaceId, title: 'Follow-up', objective }),
  );
  const first = await fixture.runner.claim(wake(row));
  if (!first) throw new Error('No attempt');
  await fixture.runner.commitOutcome(first.claims, {
    kind: 'completed',
    summary: 'I hope this finds you well. Thank you for the interview.',
    evidence: [],
  });
  const source = await fixture.episodes.intervene(fixture.ownerId, row.id, {
    idempotency_key: key,
    kind: 'correction',
    text: correction,
  });
  expect(source.scope.task_family).toBe(GENERAL_FAMILY);
  const quote = 'Use bullet points';
  const admitted = admitProposal(
    {
      target: 'skill_body',
      steps: [
        {
          text: 'Use bullet points.',
          evidence: { source: 'intervention', start: 0, end: quote.length, quote },
        },
      ],
      triggers: [
        {
          phrase: 'follow-up email',
          evidence: {
            source: 'objective',
            start: objective.indexOf('follow-up email'),
            end: objective.indexOf('follow-up email') + 'follow-up email'.length,
            quote: 'follow-up email',
          },
        },
      ],
      checks: [{ kind: 'output_format', form: 'bullets' }],
      variant_objectives: [],
    },
    {
      sources: [
        { id: 'intervention', offset: 0, text: correction },
        { id: 'objective', offset: 0, text: objective },
      ],
      objective,
    },
  );
  const definition = {
    ...admitted,
    change: admitted.change as unknown as Record<string, unknown>,
    scope: source.scope,
    compatibleModels: ['fake/scripted-learning-v1'],
  };
  const [saved] = await fixture.handle.db
    .insert(procedureCandidate)
    .values({
      ...definition,
      id: newId('pc'),
      episodeId: source.id,
      spaceId: fixture.spaceId,
      bodyHash: definitionHash(definition),
      discrimination,
    })
    .returning();
  if (!saved) throw new Error('No candidate');
  return saved;
}

const verdict = (
  status: ProcedureDiscrimination['status'],
  detail: string,
): ProcedureDiscrimination => ({
  status,
  detail,
  prior_failed: status === 'none' ? null : 0,
  corrected_failed: status === 'none' ? null : 0,
  empty_failed: 1,
  junk_failed: 1,
});

(fixture ? describe : describe.skip)('the discrimination gate', () => {
  test('a non-discriminating candidate cannot be evaluated', async () => {
    if (!fixture || !evaluator) return;
    for (const [status, detail] of [
      ['failed', 'prior_output_passes'],
      ['failed', 'prior_output_unavailable'],
      ['none', 'no_checks'],
    ] as const) {
      const candidate = await storedCandidate(`refused-${detail}`, verdict(status, detail));
      let caught: unknown;
      try {
        await evaluator.evaluate(fixture.ownerId, fixture.spaceId, candidate.id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'checks_do_not_discriminate',
        message: `checks_do_not_discriminate:${detail}`,
      });
      const [after] = await fixture.handle.db
        .select()
        .from(procedureCandidate)
        .where(eq(procedureCandidate.id, candidate.id));
      // It stays a candidate with no rejection: a later corrected output could still make it evaluable.
      expect(after).toMatchObject({ state: 'candidate', rejectionReason: null });
      expect(
        await fixture.handle.db
          .select()
          .from(procedureEvaluation)
          .where(eq(procedureEvaluation.candidateId, candidate.id)),
      ).toEqual([]);
    }
    // A discriminating candidate passes this gate and stops at the next one instead.
    const passing = await storedCandidate('passes-the-gate', verdict('passed', 'discriminates'));
    await rejectsWith(
      () => evaluator.evaluate(fixture.ownerId, fixture.spaceId, passing.id),
      'evaluation_scope_unsupported',
    );
  }, 30000);
});
