import { afterAll, describe, expect, test } from 'bun:test';
import { attemptOutcome } from '@melete/contracts';
import { desc, eq } from 'drizzle-orm';
import {
  gradeRecords,
  type RecordCase,
  taskObjective,
} from '../../../../conformance/learning/records.ts';
import { ScriptedRecordRuntime } from '../../../../conformance/learning/scripted-runtime.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { attempt } from '../../src/db/schema.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import { newId } from '../../src/ids.ts';
import type { JobRow } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { ProcedureService } from '../../src/learning/procedures.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { procedureCandidate } from '../../src/learning/schema.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { learningFixture, learningScope, wake } from './learning-fixtures.ts';

const runtime = new ScriptedRecordRuntime();
const fixture = await learningFixture(runtime);
// Exercise product catalog enrichment as well as the learning selector: the
// evaluated body must survive the same final enrichment used by bootstrap().
if (fixture)
  fixture.runner.options.loadCatalog = new RuntimeCatalog(
    fixture.handle.db,
    new ConnectorRegistry(),
    'unused-learning-skill-root',
  ).forAttempt;
const requests: unknown[] = [];
const gateway = fixture
  ? await openProposalGateway({
      db: fixture.handle.db,
      provider: 'fake',
      model: 'scripted-proposer-v1',
      providers: [fakeProvider],
      fake: (body, id, protocol) => {
        requests.push(body);
        return createScriptedProvider([
          {
            text: JSON.stringify({
              target: 'skill_body',
              steps: ['sort-typed-values', 'keep-header-and-rows'],
              test: 'ordering-and-shape',
            }),
          },
        ])(body, id, protocol);
      },
    })
  : null;
const proposer = fixture && gateway ? new ProcedureProposer(fixture.jobs, gateway) : null;
afterAll(async () => {
  await gateway?.close();
  await fixture?.close();
}, 30000);

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
  const output = attemptOutcome.parse(execution?.outcomeDetail);
  if (output.kind !== 'completed') throw new Error('Expected actual completed output');
  return output.summary;
}

(fixture ? describe : describe.skip)('the three-act procedure learning scenario', () => {
  test('completed job, owner correction, then a different job succeeds with fewer interventions and no private details', async () => {
    if (!fixture || !proposer) return;
    const memberId = newId('own');
    await fixture.handle
      .sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await fixture.handle
      .sql`update space set kind = 'shared', audience = 'space', owner_principal_id = ${fixture.ownerId} where id = ${fixture.spaceId}`;
    await fixture.handle.sql`insert into space_membership (space_id, principal_id, role) values
      (${fixture.spaceId}, ${fixture.ownerId}, 'owner'), (${fixture.spaceId}, ${memberId}, 'member')`;
    const training: RecordCase = {
      template: 'owner-dmy-training',
      task: {
        columns: ['id', 'date'],
        rows: [
          { id: 'a', date: '15/12/2026' },
          { id: 'b', date: '02/03/2026' },
          { id: 'c', date: '11/01/2026' },
        ],
        key: 'date',
        type: 'date',
        dateFormat: 'dmy',
        direction: 'ascending',
      },
      expectedIds: ['c', 'b', 'a'],
    };
    // Act 1: the real runner commits a baseline completion whose result needs an owner correction.
    const original = await fixture.create(training.template, taskObjective(training.task));
    const baseline = await run(original);
    expect(gradeRecords(training, baseline)).toBe(false);
    const firstEpisode = (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).find(
      (row) => row.jobId === original.id,
    );
    expect(firstEpisode).toMatchObject({ judgement: 'completed', intervention: null });

    // Act 2: terminal history stays immutable; a linked, zero-action correction completes the same task.
    const input = {
      idempotency_key: 'owner-date-correction',
      kind: 'correction',
      signal: 'typed_ordering',
      text: 'PLANTED-PRIVATE-THREE-ACT-482: compare dates chronologically using the declared date format; preserve all columns and rows.',
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
    expect(gradeRecords(training, await run(corrective))).toBe(true);
    const corrected = (await fixture.episodes.list(fixture.ownerId, fixture.spaceId)).find(
      (row) => row.id === intervention.id,
    );
    expect(corrected?.judgement).toBe('corrected');
    expect(corrected?.versions).toHaveLength(2);
    await proposer.drain();
    const [candidate] = await fixture.handle.db
      .select()
      .from(procedureCandidate)
      .where(eq(procedureCandidate.episodeId, intervention.id));
    if (!candidate) throw new Error('The durable intervention drain did not create a candidate');
    expect(candidate.scope).toEqual(learningScope);
    expect(candidate.state).toBe('candidate');
    expect(candidate.body).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    expect(JSON.stringify(requests)).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options);
    const evaluated = await evaluator.evaluate(fixture.ownerId, fixture.spaceId, candidate.id);
    expect(evaluated.evaluations).toHaveLength(2);
    expect(evaluated.evaluations.every((row) => row.passed)).toBe(true);
    const procedures = new ProcedureService(fixture.jobs);
    await procedures.enableCanary(fixture.ownerId, fixture.spaceId, candidate.id);

    // Act 3: new row count, column, values, dates, and template; only the general procedure transfers.
    const later: RecordCase = {
      template: 'later-renewal-records',
      task: {
        columns: ['id', 'due'],
        rows: [
          { id: 'x', due: '22/11/2028' },
          { id: 'y', due: '01/01/2028' },
          { id: 'z', due: '17/06/2028' },
          { id: 'w', due: '01/04/2028' },
        ],
        key: 'due',
        type: 'date',
        dateFormat: 'dmy',
        direction: 'ascending',
      },
      expectedIds: ['y', 'w', 'z', 'x'],
    };
    const next = await fixture.create(later.template, taskObjective(later.task));
    expect(gradeRecords(later, await run(next))).toBe(true);
    const delivered = runtime.observed.find((bundle) => bundle.attempt.job_id === next.id);
    expect(delivered?.skills.map((skill) => skill.name)).toEqual([`procedure:${candidate.id}`]);
    expect(delivered?.inputs.new_user_messages).toEqual([]);
    expect(JSON.stringify(delivered)).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const memberJob = await principalContext.run(memberId, () =>
      fixture.jobs.create({
        space_id: fixture.spaceId,
        title: 'Member records',
        objective: taskObjective(later.task),
        learning: { scope: learningScope, template_id: 'member-records', input_refs: [] },
      }),
    );
    await run(memberJob);
    const memberBundle = runtime.observed.find((bundle) => bundle.attempt.job_id === memberJob.id);
    expect(memberBundle?.skills).toEqual([]);
    expect(JSON.stringify(memberBundle)).not.toContain('PLANTED-PRIVATE-THREE-ACT-482');
    const episodes = await fixture.episodes.list(fixture.ownerId, fixture.spaceId);
    const firstCorrections = episodes.filter(
      (row) => row.jobId === original.id && row.intervention,
    ).length;
    const laterCorrections = episodes.filter(
      (row) => row.jobId === next.id && row.intervention,
    ).length;
    expect(firstCorrections).toBe(1);
    expect(laterCorrections).toBe(0);
    expect(laterCorrections).toBeLessThan(firstCorrections);
    expect((await procedures.activate(fixture.ownerId, fixture.spaceId, candidate.id)).state).toBe(
      'active',
    );
    expect(
      (
        await procedures.rollback(
          fixture.ownerId,
          fixture.spaceId,
          candidate.id,
          'End the verified canary',
        )
      ).state,
    ).toBe('reverted');
  }, 90000);
});
