import { afterAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { taskObjective } from '../../../../conformance/learning/records.ts';
import { ScriptedRecordRuntime } from '../../../../conformance/learning/scripted-runtime.ts';
import { openDatabase } from '../../src/db/client.ts';
import { job } from '../../src/db/schema.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import { JobService } from '../../src/jobs/service.ts';
import { learningEvaluationLease, learningTrial } from '../../src/learning/evaluation-schema.ts';
import {
  assertEvaluationBudget,
  EVALUATION_LEASE_MS,
  ProcedureEvaluator,
} from '../../src/learning/evaluator.ts';
import { ProcedureService } from '../../src/learning/procedures.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { procedureCandidate, procedureEvaluation } from '../../src/learning/schema.ts';
import { recordsFixtureSuite } from '../../src/learning/suites/records.ts';
import type { EvaluationSuite } from '../../src/learning/suites/types.ts';
import { newId } from '../../src/memory/db.ts';
import { learningFixture, learningScope, rejectsWith, wake } from './learning-fixtures.ts';

const runtime = new ScriptedRecordRuntime();
const fixture = await learningFixture(runtime);
let steps = ['sort-typed-values', 'keep-header-and-rows'];
const gateway = fixture
  ? await openProposalGateway({
      db: fixture.handle.db,
      provider: 'fake',
      model: 'scripted-proposer-v1',
      providers: [fakeProvider],
      fake: (body, id, protocol) =>
        createScriptedProvider([
          { text: JSON.stringify({ target: 'skill_body', steps, test: 'ordering-and-shape' }) },
        ])(body, id, protocol),
    })
  : null;
const proposer = fixture && gateway ? new ProcedureProposer(fixture.jobs, gateway) : null;
const evaluator = fixture
  ? new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options)
  : null;
const procedures = fixture ? new ProcedureService(fixture.jobs) : null;
afterAll(async () => {
  await gateway?.close();
  await fixture?.close();
}, 30000);

async function candidate(template: string, selected: string[]) {
  if (!fixture || !proposer) throw new Error('No fixture');
  steps = selected;
  const job = await fixture.create(template);
  await fixture.runner.claim(wake(job));
  const source = await fixture.episodes.intervene(fixture.ownerId, job.id, {
    idempotency_key: template,
    kind: 'correction',
    text: 'PRIVATE-EVALUATION-TRAINING: use typed ordering.',
    signal: 'typed_ordering',
  });
  const claimed = await fixture.runner.claim(wake(await fixture.jobs.get(job.id)));
  if (!claimed) throw new Error('No corrected claim');
  await fixture.runner.commitOutcome(claimed.claims, {
    kind: 'completed',
    summary: 'Corrected training example',
    evidence: [],
  });
  return proposer.generate(fixture.ownerId, fixture.spaceId, source.id);
}

(fixture ? describe : describe.skip)('real jobs and unchanged memory conformance promotion', () => {
  test('independent evaluators exclude the same space and release its lock after failure', async () => {
    if (!fixture) return;
    const proposed = await candidate('replica-exclusion', [
      'sort-typed-values',
      'keep-header-and-rows',
    ]);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    class HeldRuntime extends ScriptedRecordRuntime {
      override async capabilities(): Promise<never> {
        entered();
        await held;
        throw new Error('Intentional evaluation failure');
      }
    }
    class FailingRuntime extends ScriptedRecordRuntime {
      override async capabilities(): Promise<never> {
        throw new Error('Replica reached evaluation');
      }
    }
    const first = new ProcedureEvaluator(fixture.jobs, new HeldRuntime(), fixture.runner.options);
    const replicaDb = openDatabase(fixture.handle.url, 3);
    const replica = new ProcedureEvaluator(
      new JobService(replicaDb.db, fixture.queue.boss),
      new FailingRuntime(),
      fixture.runner.options,
    );
    const pending = first.evaluate(fixture.ownerId, fixture.spaceId, proposed.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error('First evaluator did not reach the barrier');
        }),
      ]);
      await rejectsWith(
        () => replica.evaluate(fixture.ownerId, fixture.spaceId, proposed.id),
        'evaluation_busy',
      );
      // The exclusion is a row with a bound, not a transaction held open for the run.
      const [lease] = await fixture.handle.db
        .select()
        .from(learningEvaluationLease)
        .where(eq(learningEvaluationLease.spaceId, fixture.spaceId));
      expect(lease).toMatchObject({ candidateId: proposed.id });
      expect(lease?.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(lease?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + EVALUATION_LEASE_MS);
      expect(
        await fixture.handle.db
          .select()
          .from(procedureEvaluation)
          .where(eq(procedureEvaluation.candidateId, proposed.id)),
      ).toEqual([]);
      release();
      expect(await pending).toMatchObject({ message: 'Intentional evaluation failure' });
      const retry = await replica.evaluate(fixture.ownerId, fixture.spaceId, proposed.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(retry).toMatchObject({ message: 'Replica reached evaluation' });
      expect(
        await fixture.handle.db
          .select()
          .from(learningEvaluationLease)
          .where(eq(learningEvaluationLease.spaceId, fixture.spaceId)),
      ).toEqual([]);
    } finally {
      release();
      await pending;
      await replicaDb.close();
    }
  }, 90000);

  test('selected validation cannot enable canary without passing final evidence bound to and after selection', async () => {
    if (!fixture || !evaluator || !procedures) return;
    const proposed = await candidate('sealed-final-falsifier', [
      'sort-typed-values',
      'keep-header-and-rows',
    ]);
    await evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id);
    const rows = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(eq(procedureEvaluation.candidateId, proposed.id));
    const validation = rows.find((row) => row.phase === 'validation');
    const final = rows.find((row) => row.phase === 'sealed_final');
    if (!validation?.selectedAt || !validation.passed || !final?.passed)
      throw new Error('Expected real selected validation and passing final evidence');
    const errors: (string | undefined)[] = [];
    for (const changed of [
      null,
      { ...final, passed: false },
      { ...final, evidence: { ...final.evidence, selection_evaluation_id: 'another-selection' } },
      { ...final, createdAt: new Date(validation.selectedAt.getTime() - 1000) },
    ]) {
      await fixture.handle.db
        .delete(procedureEvaluation)
        .where(eq(procedureEvaluation.id, final.id));
      if (changed) await fixture.handle.db.insert(procedureEvaluation).values(changed);
      let code: string | undefined;
      try {
        await procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      errors.push(code);
      // Reset even under the mutation, so every corrupted final has the same valid selection.
      await fixture.handle.db
        .update(procedureCandidate)
        .set({ state: 'evaluated', canarySpaceId: null })
        .where(eq(procedureCandidate.id, proposed.id));
    }
    expect(errors).toEqual([
      'promotion_denied',
      'promotion_denied',
      'promotion_denied',
      'promotion_denied',
    ]);
    await fixture.handle.db.delete(procedureEvaluation).where(eq(procedureEvaluation.id, final.id));
    await fixture.handle.db.insert(procedureEvaluation).values(final);
    expect(
      (await procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id)).state,
    ).toBe('enabled_canary');
    await procedures.rollback(
      fixture.ownerId,
      fixture.spaceId,
      proposed.id,
      'End falsifier canary',
    );
  }, 90000);

  test('an evaluation abandoned by a crash is recorded as failed, not left running', async () => {
    if (!fixture || !evaluator) return;
    const proposed = await candidate('abandoned-evaluation', [
      'sort-typed-values',
      'keep-header-and-rows',
    ]);
    const id = newId('pe');
    await fixture.handle.db.insert(procedureEvaluation).values({
      id,
      candidateId: proposed.id,
      bodyHash: proposed.bodyHash,
      phase: 'validation',
      suiteId: 'records-fixtures/1',
      suiteHash: 'c'.repeat(64),
      evidence: { status: 'running', selection_evaluation_id: null },
      budget: {},
      passed: false,
    });
    // While it could still be running, the call is answered with the inspection.
    const observed = runtime.observed.length;
    expect(
      (await evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id)).evaluations,
    ).toHaveLength(1);
    expect(runtime.observed).toHaveLength(observed);
    // Past the bound, nothing else will ever close it, so this does.
    await fixture.handle.db
      .update(procedureEvaluation)
      .set({ createdAt: new Date(Date.now() - EVALUATION_LEASE_MS - 1000) })
      .where(eq(procedureEvaluation.id, id));
    await rejectsWith(
      () => evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id),
      'evaluation_abandoned',
    );
    const [closed] = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(eq(procedureEvaluation.id, id));
    expect(closed).toMatchObject({
      passed: false,
      evidence: { status: 'failed', reason: 'evaluation_abandoned' },
    });
    const [after] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, proposed.id));
    expect(after).toMatchObject({ state: 'evaluated', rejectionReason: 'evaluation_abandoned' });
    // The lease it was holding is not left behind either.
    expect(
      await fixture.handle.db
        .select()
        .from(learningEvaluationLease)
        .where(eq(learningEvaluationLease.spaceId, fixture.spaceId)),
    ).toEqual([]);
  }, 60000);

  test('validation selects before final; one-space canary and one-call rollback fence delivery', async () => {
    if (!fixture || !evaluator || !procedures) return;
    const proposed = await candidate('evaluation-training-positive', [
      'sort-typed-values',
      'keep-header-and-rows',
    ]);
    await rejectsWith(
      () => procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id),
      'promotion_denied',
    );
    let evaluated: Awaited<ReturnType<ProcedureEvaluator['evaluate']>>;
    try {
      evaluated = await evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id);
    } catch (error) {
      console.error('evaluation cause', (error as Error).cause);
      throw error;
    }
    expect(evaluated.candidate.state).toBe('evaluated');
    expect(evaluated.candidate.rejectionReason).toBeNull();
    expect(evaluated.evaluations).toHaveLength(2);
    const validation = evaluated.evaluations.find((row) => row.phase === 'validation');
    const final = evaluated.evaluations.find((row) => row.phase === 'sealed_final');
    if (!validation?.selectedAt || !final)
      throw new Error('Expected selected validation and final');
    expect(validation.passed).toBe(true);
    expect(final.passed).toBe(true);
    expect(final.createdAt.getTime()).toBeGreaterThanOrEqual(validation.selectedAt.getTime());
    expect(final.budget).toMatchObject({ jobs: 6, reservedTokens: 49152 });
    // An arm runs held-out history or a model-authored variant under the owner's own
    // principal; its objective is recorded as text the owner did not type.
    const arms = await fixture.handle.db
      .select({ origin: job.objectiveOrigin })
      .from(job)
      .innerJoin(learningTrial, eq(learningTrial.jobId, job.id));
    expect(arms.length).toBeGreaterThan(0);
    expect([...new Set(arms.map((row) => row.origin))]).toEqual(['derived']);
    const before = runtime.observed.length;
    expect(
      (await evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id)).evaluations,
    ).toHaveLength(2);
    expect(runtime.observed).toHaveLength(before);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ body: 'Changed after selection' })
      .where(eq(procedureCandidate.id, proposed.id));
    await rejectsWith(
      () => procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id),
      'definition_changed',
    );
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ body: proposed.body })
      .where(eq(procedureCandidate.id, proposed.id));
    const enabled = await procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id);
    expect(enabled.state).toBe('enabled_canary');
    expect(enabled.canarySpaceId).toBe(fixture.spaceId);
    const task = taskObjective({
      columns: ['id', 'date'],
      rows: [
        { id: 'a', date: '2026-12-01' },
        { id: 'b', date: '2026-10-01' },
      ],
      key: 'date',
      type: 'date',
      direction: 'ascending',
      dateFormat: 'iso',
    });
    const own = await fixture.create('canary-different-instance', task);
    const claim = await fixture.runner.claim(wake(own));
    expect(claim?.bundle.skills.map((skill) => skill.name)).toEqual([`procedure:${proposed.id}`]);
    expect(JSON.stringify(claim?.bundle)).not.toContain('PRIVATE-EVALUATION-TRAINING');
    const otherSpace = await fixture.createSpace();
    const other = await fixture.jobs.create({
      space_id: otherSpace,
      title: 'Other space',
      objective: task,
      learning: { scope: learningScope, template_id: 'other-space-instance', input_refs: [] },
    });
    const otherClaim = await fixture.runner.claim(wake(other));
    expect(otherClaim?.bundle.skills).toEqual([]);
    await fixture.jobs.cancel(own.id);
    await fixture.jobs.cancel(other.id);
    expect(
      (
        await procedures.rollback(
          fixture.ownerId,
          fixture.spaceId,
          proposed.id,
          'Owner observed a concern',
        )
      ).state,
    ).toBe('reverted');
    const later = await fixture.create('after-rollback', task);
    const laterClaim = await fixture.runner.claim(wake(later));
    expect(laterClaim?.bundle.skills).toEqual([]);
    await fixture.jobs.cancel(later.id);
    expect(
      (await procedures.inspect(fixture.ownerId, fixture.spaceId, proposed.id)).history.at(-1)
        ?.reason,
    ).toContain('Owner observed a concern');
  }, 90000);
  test('text sorting improves two templates but harms numeric ordering and is kept as rejected history', async () => {
    if (!fixture || !evaluator || !procedures) return;
    const proposed = await candidate('evaluation-training-negative', [
      'sort-text-values',
      'keep-header-and-rows',
    ]);
    let result: Awaited<ReturnType<ProcedureEvaluator['evaluate']>>;
    try {
      result = await evaluator.evaluate(fixture.ownerId, fixture.spaceId, proposed.id);
    } catch (error) {
      console.error('negative evaluation cause', (error as Error).cause);
      throw error;
    }
    expect(result.candidate.state).toBe('evaluated');
    expect(result.candidate.rejectionReason).toStartWith('negative_transfer:');
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]?.passed).toBe(false);
    const [evidence] = await fixture.handle.db
      .select()
      .from(procedureEvaluation)
      .where(
        and(
          eq(procedureEvaluation.candidateId, proposed.id),
          eq(procedureEvaluation.phase, 'validation'),
        ),
      );
    if (!evidence) throw new Error('Missing retained validation evidence');
    const rows = evidence.evidence.rows as {
      family: string;
      baseline: number;
      candidate: number;
    }[];
    expect(
      rows
        .filter((row) => row.family === learningScope.task_family)
        .reduce((sum, row) => sum + row.candidate - row.baseline, 0),
    ).toBeGreaterThan(0);
    await rejectsWith(
      () => procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id),
      'promotion_denied',
    );
    expect(
      (await procedures.inspect(fixture.ownerId, fixture.spaceId, proposed.id)).history.at(-1)
        ?.reason,
    ).toStartWith('validation: negative_transfer:');
  }, 60000);
  test('an altered candidate definition cannot enter canary', async () => {
    if (!fixture || !procedures) return;
    const proposed = await candidate('evaluation-tamper-target', ['sort-typed-values']);
    await fixture.handle.db
      .update(procedureCandidate)
      .set({ body: 'Altered unreviewed behavior', state: 'evaluated' })
      .where(eq(procedureCandidate.id, proposed.id));
    await rejectsWith(
      () => procedures.enableCanary(fixture.ownerId, fixture.spaceId, proposed.id),
      'definition_changed',
    );
  }, 15000);

  test('an over-cap suite fails with evaluation_budget_exceeded', async () => {
    if (!fixture) return;
    const proposed = await candidate('evaluation-over-cap', [
      'sort-typed-values',
      'keep-header-and-rows',
    ]);
    // Five cases is ten jobs and 81,920 reserved tokens: past what a promotion decision may rest on.
    const oversized: EvaluationSuite = {
      ...recordsFixtureSuite,
      async plan(input) {
        const planned = await recordsFixtureSuite.plan(input);
        const [first] = planned.validation.cases;
        if (!first) throw new Error('No fixture case');
        return {
          ...planned,
          validation: {
            ...planned.validation,
            cases: Array.from({ length: 5 }, (_, index) => ({
              ...first,
              template: `${first.template}-${index}`,
            })),
          },
        };
      },
    };
    const capped = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options, [
      oversized,
    ]);
    const observed = runtime.observed.length;
    await rejectsWith(
      () => capped.evaluate(fixture.ownerId, fixture.spaceId, proposed.id),
      'evaluation_budget_exceeded',
    );
    // Refused before a job ran or an evaluation row was reserved.
    expect(runtime.observed).toHaveLength(observed);
    expect(
      await fixture.handle.db
        .select()
        .from(procedureEvaluation)
        .where(eq(procedureEvaluation.candidateId, proposed.id)),
    ).toEqual([]);
    const [unchanged] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.id, proposed.id));
    expect(unchanged).toMatchObject({ state: 'candidate', rejectionReason: null });
    // Four cases is exactly at the cap and is not refused for its size.
    expect(() =>
      assertEvaluationBudget(
        Array.from({ length: 4 }, (_, index) => ({
          template: `case-${index}`,
          objective: 'o',
          origin: 'fixture' as const,
        })),
      ),
    ).not.toThrow();
  }, 30000);
});
