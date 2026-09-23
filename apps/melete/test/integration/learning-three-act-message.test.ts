import { afterAll, describe, expect, test } from 'bun:test';
import { procedureCheck } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { runChecks } from '../../src/learning/checks.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { at, generalLearningFixture } from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
afterAll(async () => {
  await fixture?.close();
}, 30000);

const OBJECTIVE = 'Draft a follow-up email to the recruiter after the interview';
const CORRECTION =
  'Too formal, and PRIVATE-NOTE-MESSAGE-551 stays between us. Use bullet points, and start with "Hi there," on its own line.';
const CHECKS = [
  { kind: 'output_format', form: 'bullets' },
  { kind: 'required_sections', headings: ['Hi there'] },
] as const;

(fixture ? describe : describe.skip)('the three-act message drafting scenario', () => {
  test('a message-drafting format correction becomes a delivered procedure and the later draft needs no correction', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    // Parsed as admission parses them, so the grading here uses the stored checks' defaults.
    const checks = procedureCheck.array().parse(CHECKS);
    const graded = (output: string) => runChecks(checks, { output });
    // Earlier requests of the same kind, finished without a correction: the held-out history.
    for (const objective of [
      'Draft a follow-up email to the landlord about the heater',
      'Draft a follow-up email to the dentist about the invoice',
    ])
      await fixture.history(spaceId, objective);

    // Act 1: the first draft is a paragraph with no greeting line.
    const original = await fixture.create(spaceId, OBJECTIVE);
    expect(graded(await fixture.run(original)).score).toBe(0);

    // Act 2: the owner corrects it; the corrective job follows the correction.
    const source = await fixture.episodes.intervene(fixture.ownerId, original.id, {
      idempotency_key: 'message-format',
      kind: 'correction',
      text: CORRECTION,
    });
    if (!source.correctiveJobId) throw new Error('No corrective job');
    expect(graded(await fixture.run(await fixture.jobs.get(source.correctiveJobId))).score).toBe(1);
    fixture.propose({
      target: 'skill_body',
      steps: [
        {
          text: 'Use bullet points.',
          evidence: at('intervention', CORRECTION, 'Use bullet points'),
        },
        {
          text: 'Start with "Hi there," on its own line.',
          evidence: at('intervention', CORRECTION, 'start with "Hi there," on its own line'),
        },
      ],
      triggers: [
        { phrase: 'follow-up email', evidence: at('objective', OBJECTIVE, 'follow-up email') },
      ],
      checks: CHECKS,
      variant_objectives: [
        'Write a follow-up email to the plumber about the repair',
        'Send a follow-up email to the bank about the new card',
        'Draft a short follow-up email to the school office',
        'Draft a follow-up email to the gym about the membership',
      ],
    });
    await fixture.proposer.drain();
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.episodeId, source.id));
    if (!candidate) throw new Error('The drain did not create a candidate');
    expect(candidate.body).not.toContain('PRIVATE-NOTE-MESSAGE-551');
    expect(candidate.discrimination?.status).toBe('passed');
    const evaluator = new ProcedureEvaluator(fixture.jobs, fixture.runtime, fixture.runner.options);
    const evaluated = await evaluator.evaluate(fixture.ownerId, spaceId, candidate.id);
    expect(evaluated.candidate.rejectionReason).toBeNull();
    expect(evaluated.evaluations.map((row) => [row.phase, row.passed])).toEqual([
      ['validation', true],
      ['sealed_final', true],
    ]);
    await fixture.procedures.enableCanary(fixture.ownerId, spaceId, candidate.id);

    // Act 3: a different recipient and request; the procedure alone makes the draft right.
    const later = await fixture.create(spaceId, 'Draft a follow-up email to the electrician');
    const draft = await fixture.run(later);
    expect(graded(draft).score).toBe(1);
    expect(draft.split('\n')[0]).toBe('Hi there,');
    const delivered = fixture.runtime.observed.find((bundle) => bundle.attempt.job_id === later.id);
    // The learned procedure leads; built-in skills the request calls for fill the rest.
    expect(delivered?.skills[0]?.name).toBe(`procedure:${candidate.id}`);
    expect(delivered?.skills.filter((skill) => skill.name.startsWith('procedure:'))).toHaveLength(
      1,
    );
    expect(delivered?.inputs.new_user_messages).toEqual([]);
    expect(JSON.stringify(delivered)).not.toContain('PRIVATE-NOTE-MESSAGE-551');
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
