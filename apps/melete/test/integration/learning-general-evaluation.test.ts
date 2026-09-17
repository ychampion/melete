import { afterAll, describe, expect, test } from 'bun:test';
import { attemptOutcome } from '@melete/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { ScriptedRecordRuntime } from '../../../../conformance/learning/scripted-runtime.ts';
import { attempt } from '../../src/db/schema.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import type { JobRow } from '../../src/jobs/service.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { ProcedureService, verifyDefinition } from '../../src/learning/procedures.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { episode, procedureCandidate, procedureEvaluation } from '../../src/learning/schema.ts';
import { episodeDerivedSuite } from '../../src/learning/suites/episode-derived.ts';
import { recordsFixtureSuite } from '../../src/learning/suites/records.ts';
import type { EvaluationSuite } from '../../src/learning/suites/types.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { learningFixture, rejectsWith, wake } from './learning-fixtures.ts';

const runtime = new ScriptedRecordRuntime();
const fixture = await learningFixture(runtime);
let output: unknown = null;
const gateway = fixture
  ? await openProposalGateway({
      db: fixture.handle.db,
      provider: 'fake',
      model: 'scripted-proposer-v1',
      providers: [fakeProvider],
      fake: (body, id, protocol) =>
        createScriptedProvider([{ text: JSON.stringify(output) }])(body, id, protocol),
    })
  : null;
const proposer = fixture && gateway ? new ProcedureProposer(fixture.jobs, gateway) : null;
const procedures = fixture ? new ProcedureService(fixture.jobs) : null;
afterAll(async () => {
  await gateway?.close();
  await fixture?.close();
}, 30000);

const CORRECTION = 'Too formal. Use bullet points, and start with "Hi there," on its own line.';
const SOURCE = 'Draft a follow-up email to the recruiter after the interview';
const VARIANTS = [
  'Write a follow-up email to the plumber about the repair',
  'Send a follow-up email to the bank about the new card',
  'Draft a short follow-up email to the school office',
  'Draft a follow-up email to the gym about the membership',
];

const at = (source: 'intervention' | 'objective', text: string, quote: string) => {
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`The fixture quote is not in its source: ${quote}`);
  return { source, start, end: start + quote.length, quote };
};

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

const create = (spaceId: string, objective: string) => {
  if (!fixture) throw new Error('No fixture');
  return principalContext.run(fixture.ownerId, () =>
    fixture.jobs.create({ space_id: spaceId, title: 'Owner request', objective }),
  );
};

async function history(spaceId: string, objective: string) {
  const row = await create(spaceId, objective);
  await run(row);
  return row;
}

/** A completed job, the owner's correction, and the corrective job's answer. */
async function corrected(
  spaceId: string,
  key: string,
  objective: string,
  correction: string,
  answer?: string,
) {
  if (!fixture) throw new Error('No fixture');
  const row = await create(spaceId, objective);
  await run(row);
  const source = await fixture.episodes.intervene(fixture.ownerId, row.id, {
    idempotency_key: key,
    kind: 'correction',
    text: correction,
  });
  if (!source.correctiveJobId) throw new Error('No corrective job');
  const corrective = await fixture.jobs.get(source.correctiveJobId);
  if (answer) {
    const claim = await fixture.runner.claim(wake(corrective));
    if (!claim) throw new Error('No corrective attempt');
    await fixture.runner.commitOutcome(claim.claims, {
      kind: 'completed',
      summary: answer,
      evidence: [],
    });
  } else await run(corrective);
  const [saved] = await fixture.handle.db.select().from(episode).where(eq(episode.id, source.id));
  if (!saved) throw new Error('No episode');
  return saved;
}

const messageProposal = (variants: readonly string[]) => ({
  target: 'skill_body',
  steps: [
    { text: 'Use bullet points.', evidence: at('intervention', CORRECTION, 'Use bullet points') },
    {
      text: 'Start with "Hi there," on its own line.',
      evidence: at('intervention', CORRECTION, 'start with "Hi there," on its own line'),
    },
  ],
  triggers: [{ phrase: 'follow-up email', evidence: at('objective', SOURCE, 'follow-up email') }],
  checks: [
    { kind: 'output_format', form: 'bullets' },
    { kind: 'required_sections', headings: ['Hi there'] },
  ],
  variant_objectives: variants,
});

async function messageCandidate(
  spaceId: string,
  key: string,
  histories: readonly string[],
  variants: readonly string[],
) {
  if (!fixture || !proposer) throw new Error('No fixture');
  for (const objective of histories) await history(spaceId, objective);
  const source = await corrected(spaceId, key, SOURCE, CORRECTION);
  output = messageProposal(variants);
  const candidate = await proposer.generate(fixture.ownerId, spaceId, source.id);
  expect(candidate.discrimination?.status).toBe('passed');
  return { candidate, source };
}

const plan = async (spaceId: string, candidateId: string) => {
  if (!fixture || !procedures) throw new Error('No fixture');
  return fixture.jobs.transaction(async (tx) => {
    const { candidate, source } = await procedures.locked(
      tx,
      fixture.ownerId,
      spaceId,
      candidateId,
    );
    return episodeDerivedSuite.plan({ tx, ownerId: fixture.ownerId, candidate, source });
  });
};

let evaluated: { spaceId: string; candidateId: string } | null = null;

(fixture ? describe : describe.skip)('evaluation from the owner’s own work', () => {
  test('held-out history supplies validation cases and the source job is excluded', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const matching = [
      'Draft a follow-up email to the landlord about the heater',
      'Draft a follow-up email to the dentist about the invoice',
      'Draft a follow-up email to the council about the permit',
    ];
    const unrelated = 'Summarise the weekly project status report';
    const alsoCorrected = 'Draft a follow-up email to the accountant about the taxes';
    const { candidate, source } = await messageCandidate(
      spaceId,
      'history-source',
      matching,
      VARIANTS,
    );
    await history(spaceId, unrelated);
    await corrected(spaceId, 'other-correction', alsoCorrected, 'Keep it under 30 words.');
    const planned = await plan(spaceId, candidate.id);
    const final = await planned.sealedFinal('any-selection-id');
    const cases = [...planned.validation.cases, ...final.cases];
    const pooled = planned.candidate.caseTemplates;
    const objectives = cases.map((value) => value.objective);
    for (const excluded of [SOURCE, unrelated, alsoCorrected])
      expect(objectives).not.toContain(excluded);
    expect(cases.map((value) => value.template)).not.toContain(source.templateId);
    for (const value of cases)
      expect(value.origin === 'history' ? matching : VARIANTS).toContain(value.objective);
    expect(planned.validation.cases.some((value) => value.origin === 'history')).toBe(true);
    expect(final.cases.some((value) => value.origin === 'history')).toBe(true);
    // Disjoint, bound into the definition, and reused rather than redrawn.
    const validation = new Set(pooled.validation);
    expect((pooled.final_pool ?? []).some((template) => validation.has(template))).toBe(false);
    expect(planned.validation.cases.map((value) => value.template)).toEqual(
      pooled.validation ?? [],
    );
    expect(planned.candidate.bodyHash).not.toBe(candidate.bodyHash);
    expect(() => verifyDefinition(planned.candidate)).not.toThrow();
    const again = await plan(spaceId, candidate.id);
    expect(again.candidate.caseTemplates).toEqual(pooled);
    expect(again.candidate.bodyHash).toBe(planned.candidate.bodyHash);
  }, 120000);

  test('a run with fewer than three cases is refused', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options);
    const { candidate } = await messageCandidate(
      spaceId,
      'too-few',
      ['Draft a follow-up email to the landlord about the heater'],
      [],
    );
    const observed = runtime.observed.length;
    await rejectsWith(
      () => evaluator.evaluate(fixture.ownerId, spaceId, candidate.id),
      'evaluation_cases_insufficient',
    );
    expect(runtime.observed).toHaveLength(observed);
    const [unchanged] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidate.id));
    expect(unchanged).toMatchObject({ state: 'candidate', caseTemplates: {} });
    expect(
      await fixture.handle.db
        .select()
        .from(procedureEvaluation)
        .where(eq(procedureEvaluation.candidateId, candidate.id)),
    ).toEqual([]);
  }, 120000);

  test('a newly created flattering job cannot displace held-out history', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const older = Array.from(
      { length: 7 },
      (_, index) => `Draft a follow-up email to supplier number ${index + 1} about the order`,
    );
    const { candidate } = await messageCandidate(spaceId, 'flattering', older, []);
    // Created after the correction, shaped to match the trigger, and newest of all.
    await history(spaceId, 'Draft a follow-up email that already uses bullet points throughout');
    const planned = await plan(spaceId, candidate.id);
    const chosen = new Set(planned.validation.cases.map((value) => value.objective));
    for (const seed of ['selection', 'another'])
      for (const value of (await planned.sealedFinal(seed)).cases) chosen.add(value.objective);
    const pool = [
      ...(planned.candidate.caseTemplates.validation ?? []),
      ...(planned.candidate.caseTemplates.final_pool ?? []),
    ];
    expect(pool).toHaveLength(6);
    for (const objective of chosen) expect(older.slice(0, 6)).toContain(objective);
    expect([...chosen]).not.toContain(older[6]);
    expect([...chosen]).not.toContain(
      'Draft a follow-up email that already uses bullet points throughout',
    );
  }, 180000);

  test('final cases are chosen only after selection commits', async () => {
    if (!fixture || !procedures) return;
    const spaceId = await fixture.createSpace();
    const { candidate } = await messageCandidate(
      spaceId,
      'sealed-final',
      [
        'Draft a follow-up email to the landlord about the heater',
        'Draft a follow-up email to the dentist about the invoice',
      ],
      VARIANTS,
    );
    const calls: { seed: string; selected: boolean; bound: boolean }[] = [];
    const db = fixture.handle.db;
    const watched: EvaluationSuite = {
      ...episodeDerivedSuite,
      async plan(input) {
        const planned = await episodeDerivedSuite.plan(input);
        return {
          ...planned,
          async sealedFinal(seed) {
            const [validation] = await db
              .select()
              .from(procedureEvaluation)
              .where(
                and(
                  eq(procedureEvaluation.candidateId, candidate.id),
                  eq(procedureEvaluation.phase, 'validation'),
                ),
              );
            const [current] = await db
              .select()
              .from(procedureCandidate)
              .where(eq(procedureCandidate.id, candidate.id));
            calls.push({
              seed,
              selected: !!validation?.selectedAt && validation.id === seed,
              bound: current?.selectedEvaluationId === seed,
            });
            return planned.sealedFinal(seed);
          },
        };
      },
    };
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options, [
      recordsFixtureSuite,
      watched,
    ]);
    let result: Awaited<ReturnType<ProcedureEvaluator['evaluate']>>;
    try {
      result = await evaluator.evaluate(fixture.ownerId, spaceId, candidate.id);
    } catch (error) {
      console.error('general evaluation cause', (error as Error).cause);
      throw error;
    }
    expect(result.candidate.rejectionReason).toBeNull();
    expect(result.evaluations.map((row) => [row.phase, row.passed])).toEqual([
      ['validation', true],
      ['sealed_final', true],
    ]);
    expect(calls).toEqual([
      { seed: result.candidate.selectedEvaluationId ?? '', selected: true, bound: true },
    ]);
    const rows = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(eq(procedureEvaluation.candidateId, candidate.id));
    const templates = (phase: string) =>
      (
        (rows.find((row) => row.phase === phase)?.evidence.runs ?? []) as { template?: string }[]
      ).flatMap((run) => (run.template ? [run.template] : []));
    const pool = result.candidate.caseTemplates;
    for (const template of templates('sealed_final')) expect(pool.final_pool).toContain(template);
    for (const template of templates('validation')) expect(pool.validation).toContain(template);
    expect(rows.every((row) => row.suiteId === 'episode-derived/1')).toBe(true);
    evaluated = { spaceId, candidateId: candidate.id };
  }, 180000);

  test('corrections count failed checks, not one minus the score', async () => {
    if (!fixture || !evaluated) throw new Error('Needs the evaluated candidate');
    const [validation] = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(
        and(
          eq(procedureEvaluation.candidateId, evaluated.candidateId),
          eq(procedureEvaluation.phase, 'validation'),
        ),
      );
    const rows = (
      (validation?.evidence.rows ?? []) as {
        family: string;
        baseline: number;
        candidate: number;
        baselineCorrections: number;
        candidateCorrections: number;
      }[]
    ).filter((row) => row.family === 'general');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      // The default draft fails both checks: two corrections, where one minus its score is one.
      expect(row).toMatchObject({
        baseline: 0,
        candidate: 1,
        baselineCorrections: 2,
        candidateCorrections: 0,
      });
      expect(row.baselineCorrections).not.toBe(1 - row.baseline);
    }
  });

  test('swapping a case template after selection fails definition_changed', async () => {
    if (!fixture || !procedures || !evaluated) throw new Error('Needs the evaluated candidate');
    const { spaceId, candidateId } = evaluated;
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidateId));
    if (!candidate) throw new Error('No candidate');
    const original = candidate.caseTemplates;
    const [validationFirst, ...validationRest] = original.validation ?? [];
    const [finalFirst, ...finalRest] = original.final_pool ?? [];
    if (!validationFirst || !finalFirst) throw new Error('No planned templates');
    await fixture.handle.db
      .update(procedureCandidate)
      .set({
        caseTemplates: {
          validation: [finalFirst, ...validationRest],
          final_pool: [validationFirst, ...finalRest],
        },
      })
      .where(eq(procedureCandidate.id, candidateId));
    await rejectsWith(
      () => procedures.enableCanary(fixture.ownerId, spaceId, candidateId),
      'definition_changed',
    );
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ caseTemplates: original })
      .where(eq(procedureCandidate.id, candidateId));
    expect((await procedures.enableCanary(fixture.ownerId, spaceId, candidateId)).state).toBe(
      'enabled_canary',
    );
  });

  test('an altered trigger, check or case template cannot enter canary', async () => {
    if (!fixture || !procedures || !evaluated) throw new Error('Needs the evaluated candidate');
    const { spaceId, candidateId } = evaluated;
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, candidateId));
    if (!candidate) throw new Error('No candidate');
    for (const altered of [
      { triggers: candidate.triggers.map((trigger) => ({ ...trigger, phrase: 'email' })) },
      { checks: [{ kind: 'output_format' as const, form: 'numbered' as const }] },
      { caseTemplates: { ...candidate.caseTemplates, final_pool: [] } },
    ]) {
      await fixture.handle.db
        .update(procedureCandidate)
        .set(altered as Partial<typeof candidate>)
        .where(eq(procedureCandidate.id, candidateId));
      await rejectsWith(
        () => procedures.activate(fixture.ownerId, spaceId, candidateId),
        'definition_changed',
      );
      await fixture.handle.db
        .update(procedureCandidate)
        .set({
          triggers: candidate.triggers,
          checks: candidate.checks,
          caseTemplates: candidate.caseTemplates,
        })
        .where(eq(procedureCandidate.id, candidateId));
    }
    await procedures.rollback(fixture.ownerId, spaceId, candidateId, 'End the evaluation fixture');
  });

  test('an all-variant suite is refused when history exists', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options);
    // There is history in the space, but none of it is work the procedure applies to.
    const { candidate } = await messageCandidate(
      spaceId,
      'all-variants',
      ['Summarise the weekly project status report', 'Plan the team offsite agenda'],
      VARIANTS,
    );
    await rejectsWith(
      () => evaluator.evaluate(fixture.ownerId, spaceId, candidate.id),
      'evaluation_cases_insufficient',
    );
    // Once two held-out jobs qualify, every phase carries one of them beside the variants.
    await history(spaceId, 'Draft a follow-up email to the landlord about the heater');
    await history(spaceId, 'Draft a follow-up email to the dentist about the invoice');
    const planned = await plan(spaceId, candidate.id);
    expect(planned.validation.cases.some((value) => value.origin === 'history')).toBe(true);
    expect(
      (await planned.sealedFinal('seed')).cases.some((value) => value.origin === 'history'),
    ).toBe(true);
  }, 180000);

  test('a variant both arms pass contributes no improvement and the gate rejects', async () => {
    if (!fixture || !proposer) return;
    const spaceId = await fixture.createSpace();
    const objective = 'Draft a follow-up email to the recruiter';
    const correction = 'Mention the invoice.';
    const invoice = [
      'Draft a follow-up email about the invoice to the landlord',
      'Draft a follow-up email about the invoice to the bank',
    ];
    for (const value of invoice) await history(spaceId, value);
    const source = await corrected(
      spaceId,
      'both-arms-pass',
      objective,
      correction,
      'Thank you for your time. The invoice is attached.',
    );
    output = {
      target: 'skill_body',
      steps: [
        {
          text: 'Mention the invoice.',
          evidence: at('intervention', correction, 'Mention the invoice'),
        },
      ],
      triggers: [
        { phrase: 'follow-up email', evidence: at('objective', objective, 'follow-up email') },
      ],
      checks: [{ kind: 'required_phrase', phrase: 'invoice' }],
      variant_objectives: [
        'Write a follow-up email about the invoice to the plumber',
        'Send a follow-up email about the invoice to the school',
        'Draft a short follow-up email about the invoice to the gym',
        'Draft a follow-up email about the overdue invoice to the club',
      ],
    };
    const candidate = await proposer.generate(fixture.ownerId, spaceId, source.id);
    expect(candidate.discrimination?.status).toBe('passed');
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options);
    const result = await evaluator.evaluate(fixture.ownerId, spaceId, candidate.id);
    expect(result.candidate.rejectionReason).toBe('no_family_improvement');
    expect(result.evaluations.map((row) => [row.phase, row.passed])).toEqual([
      ['validation', false],
    ]);
    const [validation] = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(eq(procedureEvaluation.candidateId, candidate.id));
    const rows = (
      (validation?.evidence.rows ?? []) as { family: string; baseline: number; candidate: number }[]
    ).filter((row) => row.family === 'general');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Every case already reads the invoice back, so the procedure changes nothing.
    for (const row of rows) expect(row).toMatchObject({ baseline: 1, candidate: 1 });
  }, 180000);
});
