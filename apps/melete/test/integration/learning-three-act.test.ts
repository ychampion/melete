import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  gradeRecords,
  type RecordCase,
  type RecordTask,
  taskObjective,
} from '../../../../conformance/learning/records.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { newId } from '../../src/ids.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { derivedScope } from '../../src/learning/scope.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { at, generalLearningFixture } from './learning-general-fixtures.ts';

const fixture = await generalLearningFixture();
// Exercise product catalog enrichment as well as the learning selector: the
// evaluated body must survive the same final enrichment used by bootstrap().
if (fixture)
  fixture.runner.options.loadCatalog = new RuntimeCatalog(
    fixture.handle.db,
    new ConnectorRegistry(),
    'unused-learning-skill-root',
  ).forAttempt;
afterAll(async () => {
  await fixture?.close();
}, 30000);

const CORRECTION =
  'PLANTED-PRIVATE-THREE-ACT-482: keep every column, and sort the rows by due as dates ascending.';

/** Earlier tables of the same kind, each accepted as it came back. */
const historyTask = (month: number): RecordTask => ({
  columns: ['id', 'due'],
  rows: [
    { id: 'a', due: `2027-0${month}-20` },
    { id: 'b', due: `2027-0${month}-03` },
    { id: 'c', due: `2027-0${month}-11` },
  ],
  key: 'due',
  type: 'date',
  direction: 'ascending',
  dateFormat: 'iso',
});

(fixture ? describe : describe.skip)('the three-act procedure learning scenario', () => {
  test('completed job, owner correction, then a different job succeeds with fewer interventions and no private details', async () => {
    if (!fixture) return;
    const spaceId = await fixture.createSpace();
    const memberId = newId('own');
    await fixture.handle
      .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await fixture.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${spaceId}`;
    await fixture.handle.sql`insert into space_membership (space_id, principal_id, role) values
      (${spaceId}, ${fixture.ownerId}, 'owner'), (${spaceId}, ${memberId}, 'member')`;
    for (let month = 1; month <= 6; month += 1)
      await fixture.history(spaceId, taskObjective(historyTask(month)));
    const training: RecordCase = {
      template: 'owner-training',
      task: {
        columns: ['id', 'due'],
        rows: [
          { id: 'a', due: '2026-12-15' },
          { id: 'b', due: '2026-03-02' },
          { id: 'c', due: '2026-01-11' },
        ],
        key: 'due',
        type: 'date',
        dateFormat: 'iso',
        direction: 'ascending',
      },
      expectedIds: ['c', 'b', 'a'],
    };
    const objective = taskObjective(training.task);
    // Act 1: the real runner commits a baseline completion whose result needs an owner correction.
    const original = await fixture.create(spaceId, objective);
    expect(gradeRecords(training, await fixture.run(original))).toBe(false);
    const firstEpisode = (await fixture.episodes.list(fixture.ownerId, spaceId)).find(
      (row) => row.jobId === original.id,
    );
    expect(firstEpisode).toMatchObject({ judgement: 'completed', intervention: null });

    // Act 2: terminal history stays immutable; a linked, zero-action correction completes the same task.
    const input = {
      idempotency_key: 'owner-date-correction',
      kind: 'correction',
      text: CORRECTION,
    };
    const intervention = await fixture.episodes.intervene(fixture.ownerId, original.id, input);
    expect(intervention.correctiveJobId).toBeString();
    if (!intervention.correctiveJobId) throw new Error('Expected a linked corrective job');
    const repeated = await fixture.episodes.intervene(fixture.ownerId, original.id, input);
    expect(repeated.id).toBe(intervention.id);
    expect(repeated.correctiveJobId).toBe(intervention.correctiveJobId);
    const corrective = await fixture.jobs.get(intervention.correctiveJobId);
    expect(corrective.budget).toMatchObject({ max_actions: 0 });
    expect((await fixture.jobs.get(original.id)).state).toBe('completed');
    expect(gradeRecords(training, await fixture.run(corrective))).toBe(true);
    const corrected = (await fixture.episodes.list(fixture.ownerId, spaceId)).find(
      (row) => row.id === intervention.id,
    );
    expect(corrected?.judgement).toBe('corrected');
    expect(corrected?.versions).toHaveLength(2);
    fixture.propose({
      target: 'skill_body',
      steps: [
        {
          text: 'Sort the rows by due as dates ascending.',
          evidence: at('intervention', CORRECTION, 'sort the rows by due as dates ascending'),
        },
      ],
      triggers: [
        { phrase: 'supplied records', evidence: at('objective', objective, 'supplied records') },
      ],
      // A held-out history case carries only its objective, so there are no input rows to preserve.
      checks: [
        {
          kind: 'records_sorted',
          key: 'due',
          type: 'date',
          direction: 'ascending',
          preserve_rows: false,
        },
      ],
      variant_objectives: [],
    });
    await fixture.proposer.drain();
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.episodeId, intervention.id));
    if (!candidate) throw new Error('The durable intervention drain did not create a candidate');
    expect(candidate.scope).toEqual(derivedScope(objective).scope);
    expect(candidate.state).toBe('candidate');
    expect(candidate.discrimination?.status).toBe('passed');
    // The owner's correction is what the proposal model reads; none of its other words become the body.
    expect(candidate.body).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const evaluator = new ProcedureEvaluator(fixture.jobs, fixture.runtime, fixture.runner.options);
    const evaluated = await evaluator.evaluate(fixture.ownerId, spaceId, candidate.id);
    expect(evaluated.candidate.rejectionReason).toBeNull();
    expect(evaluated.evaluations.map((row) => [row.phase, row.passed])).toEqual([
      ['validation', true],
      ['sealed_final', true],
    ]);
    await fixture.procedures.enableCanary(fixture.ownerId, spaceId, candidate.id);

    // Act 3: new row count, column, values, dates, and template; only the general procedure transfers.
    const later: RecordCase = {
      template: 'later-renewal-records',
      task: {
        columns: ['id', 'due', 'amount'],
        rows: [
          { id: 'x', due: '2028-11-22', amount: 40 },
          { id: 'y', due: '2028-01-01', amount: 15 },
          { id: 'z', due: '2028-06-17', amount: 90 },
          { id: 'w', due: '2028-04-01', amount: 25 },
        ],
        key: 'due',
        type: 'date',
        dateFormat: 'iso',
        direction: 'ascending',
      },
      expectedIds: ['y', 'w', 'z', 'x'],
    };
    const next = await fixture.create(spaceId, taskObjective(later.task));
    expect(gradeRecords(later, await fixture.run(next))).toBe(true);
    const delivered = fixture.runtime.observed.find((bundle) => bundle.attempt.job_id === next.id);
    expect(delivered?.skills.map((skill) => skill.name)).toEqual([`procedure:${candidate.id}`]);
    expect(delivered?.inputs.new_user_messages).toEqual([]);
    expect(JSON.stringify(delivered)).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const memberJob = await principalContext.run(memberId, () =>
      fixture.jobs.create({
        space_id: spaceId,
        title: 'Member records',
        objective: taskObjective(later.task),
      }),
    );
    await fixture.run(memberJob);
    const memberBundle = fixture.runtime.observed.find(
      (bundle) => bundle.attempt.job_id === memberJob.id,
    );
    expect(memberBundle?.skills).toEqual([]);
    expect(JSON.stringify(memberBundle)).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const episodes = await fixture.episodes.list(fixture.ownerId, spaceId);
    const firstCorrections = episodes.filter(
      (row) => row.jobId === original.id && row.intervention,
    ).length;
    const laterCorrections = episodes.filter(
      (row) => row.jobId === next.id && row.intervention,
    ).length;
    expect(firstCorrections).toBe(1);
    expect(laterCorrections).toBe(0);
    expect(laterCorrections).toBeLessThan(firstCorrections);
    expect((await fixture.procedures.activate(fixture.ownerId, spaceId, candidate.id)).state).toBe(
      'active',
    );
    expect(
      (
        await fixture.procedures.rollback(
          fixture.ownerId,
          spaceId,
          candidate.id,
          'End the verified canary',
        )
      ).state,
    ).toBe('reverted');
  }, 180000);
});
