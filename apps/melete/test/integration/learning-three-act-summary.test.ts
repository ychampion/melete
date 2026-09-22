import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runChecks } from '../../src/learning/checks.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { at, generalLearningFixture } from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
afterAll(async () => {
  await fixture?.close();
}, 30000);

const OBJECTIVE = 'Summarise the weekly status report for the leadership team';
const CORRECTION = 'Far too long: leave out the background and keep the summary under 40 words.';
// An upper bound alone passes an empty answer, so the check also asks for a summary at all.
const CHECKS = [{ kind: 'word_count', min: 10, max: 40 }] as const;

(fixture ? describe : describe.skip)('the three-act summary length scenario', () => {
  test('a summary length correction becomes a delivered procedure and the later summary needs no correction', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const graded = (output: string) => runChecks([...CHECKS], { output });
    for (const objective of [
      'Summarise the monthly status report for the investors',
      'Summarise the status report from the design review',
    ])
      await fixture.history(spaceId, objective);

    // Act 1: the default summary runs to several paragraphs' worth of sentences.
    const original = await fixture.create(spaceId, OBJECTIVE);
    const first = await fixture.run(original);
    expect(graded(first).score).toBe(0);

    // Act 2: the owner asks for a shorter one; the corrective job keeps under the limit.
    const source = await fixture.episodes.intervene(fixture.ownerId, original.id, {
      idempotency_key: 'summary-length',
      kind: 'correction',
      text: CORRECTION,
    });
    if (!source.correctiveJobId) throw new Error('No corrective job');
    expect(graded(await fixture.run(await fixture.jobs.get(source.correctiveJobId))).score).toBe(1);
    fixture.propose({
      target: 'skill_body',
      steps: [
        {
          text: 'Keep the summary under 40 words.',
          evidence: at('intervention', CORRECTION, 'keep the summary under 40 words'),
        },
      ],
      triggers: [
        { phrase: 'status report', evidence: at('objective', OBJECTIVE, 'status report') },
      ],
      checks: CHECKS,
      variant_objectives: [
        'Summarise the quarterly status report for the board',
        'Write a status report summary for the finance team',
        'Summarise the status report on the office move',
        'Give me the gist of the hiring status report',
      ],
    });
    await fixture.proposer.drain();
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.episodeId, source.id));
    if (!candidate) throw new Error('The drain did not create a candidate');
    expect(candidate.discrimination?.status).toBe('passed');
    const evaluator = new ProcedureEvaluator(fixture.jobs, fixture.runtime, fixture.runner.options);
    const evaluated = await evaluator.evaluate(fixture.ownerId, spaceId, candidate.id);
    expect(evaluated.candidate.rejectionReason).toBeNull();
    expect(evaluated.evaluations.map((row) => [row.phase, row.passed])).toEqual([
      ['validation', true],
      ['sealed_final', true],
    ]);
    await fixture.procedures.enableCanary(fixture.ownerId, spaceId, candidate.id);

    // Act 3: a different report; the delivered limit alone keeps it short.
    const later = await fixture.create(
      spaceId,
      'Summarise the status report on the supplier contracts',
    );
    const summary = await fixture.run(later);
    expect(graded(summary).score).toBe(1);
    expect(summary.length).toBeLessThan(first.length);
    const delivered = fixture.runtime.observed.find((bundle) => bundle.attempt.job_id === later.id);
    expect(delivered?.skills.map((skill) => skill.name)).toEqual([`procedure:${candidate.id}`]);
    expect(delivered?.inputs.new_user_messages).toEqual([]);
    // A request the triggers do not name gets the default answer, not the limit.
    const unrelated = await fixture.create(spaceId, 'Draft a follow-up email to the landlord');
    expect(graded(await fixture.run(unrelated)).score).toBe(0);
    const episodes = await fixture.episodes.list(fixture.ownerId, spaceId);
    const corrections = (jobId: string) =>
      episodes.filter((row) => row.jobId === jobId && row.intervention).length;
    expect(corrections(original.id)).toBe(1);
    expect(corrections(later.id)).toBe(0);
    expect((await fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id)).state).toBe(
      'active',
    );
    await fixture.procedures.rollback(fixture.ownerId, spaceId, candidate.id, 'End the scenario');
  }, 180000);
});
