/**
 * A finishing turn reads only the steps that can change what its completion
 * facts say: those not yet at rest, and those its outcome cites, whose
 * receipts are the only ones looked at. A long chat has thousands of steps at
 * rest, each with its receipt, and reading them all made every answer of a
 * long chat slower to commit than the one before.
 *
 * The narrowed read must say exactly what reading every step did. Random jobs
 * of steps in every status, with receipts that hold and receipts that do not,
 * steps on another space's connection, steps an earlier turn's question
 * covers, and outcomes citing some of them, are read both ways.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { ACTION_STATUSES, type AttemptOutcome, type JobConstraints } from '@melete/contracts';
import { and, sql as dsql, eq } from 'drizzle-orm';
import { recordId } from '../../src/broker/records.ts';
import { action, connection, job as jobTable, question } from '../../src/db/schema.ts';
import { completionFacts, evaluateCompletion } from '../../src/jobs/bundle.ts';
import { UNSETTLED_WAIT } from '../../src/jobs/unsettled.ts';
import { closedComputerStepColumn } from '../../src/sandbox/closed-step.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const withDb = fixture ? describe : describe.skip;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

function database() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture;
}

/** A small seeded generator, so a failing case can be run again. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    of: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

type Completed = Extract<AttemptOutcome, { kind: 'completed' }>;

/**
 * The facts as the finishing turn read them before: every step of the job,
 * receipts included (the statement as it was), then the same evaluation.
 */
async function everyStep(
  jobId: string,
  outcome: Completed,
  attemptId: string | undefined,
): Promise<ReturnType<typeof evaluateCompletion>> {
  const { db } = database();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: jobTable.id, spaceId: jobTable.spaceId, constraints: jobTable.constraints })
      .from(jobTable)
      .where(eq(jobTable.id, jobId));
    if (!row) throw new Error('no job row');
    const askedAbout = dsql`exists (select 1 from ${question} q
      where q.job_id = ${action.jobId}
        and (q.attempt_id = ${action.attemptId}
          or q.created_at >= coalesce(${action.dispatchedAt}, ${action.createdAt}))
        and q.options @> ${JSON.stringify([{ id: UNSETTLED_WAIT }])}::jsonb)`;
    const actions = await tx
      .select({
        id: action.id,
        jobId: action.jobId,
        connectionId: action.connectionId,
        kind: action.kind,
        effectClass: action.effectClass,
        status: action.status,
        receipt: action.receipt,
        spaceId: connection.spaceId,
        closedStep: closedComputerStepColumn,
        provider: connection.provider,
      })
      .from(action)
      .leftJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(
          eq(action.jobId, row.id),
          attemptId ? dsql`(${action.attemptId} = ${attemptId} or not ${askedAbout})` : undefined,
        ),
      );
    return evaluateCompletion(row, outcome, { actions, artifacts: [], knowledge: [] });
  });
}

/** The facts as the finishing turn reads them now. */
async function narrowed(jobId: string, outcome: Completed, attemptId: string | undefined) {
  const { db } = database();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(jobTable).where(eq(jobTable.id, jobId));
    if (!row) throw new Error('no job row');
    const facts = await completionFacts(tx, row, outcome, undefined, attemptId);
    return {
      all_actions_terminal: facts.all_actions_terminal,
      has_unknown_action: facts.has_unknown_action,
      deliverable_declared: facts.deliverable_declared,
      deliverable_satisfied: facts.deliverable_satisfied,
      artifact_validations_passed: true,
      artifact_failures: [] as string[],
    };
  });
}

/** A job of `steps` steps over two turns' attempts, some on another space's connection. */
async function job(seed: number) {
  const { sql } = database();
  const pick = random(seed);
  const seeded = await seedJob(sql);
  const jobId = seeded.claims.job_id;
  const attempts = [seeded.claims.attempt_id];
  for (let epoch = 2; epoch <= 3; epoch++) {
    const id = recordId('att');
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${id}, ${jobId}, ${epoch}, 'fake', 'fake', 'scripted')`;
    attempts.push(id);
  }
  // A connection of another space: a step through it is no evidence here.
  const elsewhere = await seedJob(sql);
  const connections = [seeded.connectionId, seeded.connectionId, elsewhere.connectionId];
  const ids: string[] = [];
  const steps = pick.int(0, 40);
  for (let n = 0; n < steps; n++) {
    const id = recordId('act');
    const connectionId = pick.of(connections);
    const status = pick.chance(0.6) ? 'succeeded' : pick.of(ACTION_STATUSES);
    const receipt = !pick.chance(0.8)
      ? null
      : pick.chance(0.1)
        ? { not: 'a receipt' }
        : {
            // Now and then a receipt that names another step or connection.
            action_id: pick.chance(0.1) ? recordId('act') : id,
            connection_id: pick.chance(0.1) ? elsewhere.connectionId : connectionId,
            external_ref: null,
            detail: { output: 'x'.repeat(pick.int(0, 2_000)) },
            received_at: new Date().toISOString(),
            late: false,
          };
    const created = new Date(Date.UTC(2026, 0, 1, 12, 0, n));
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, idempotency_key, status, receipt, dispatched_at, created_at)
      values (${id}, ${jobId}, ${pick.of(attempts)}, ${connectionId},
        ${pick.of(['test.send', 'email.send', 'test.read'])},
        ${pick.of(['write_external', 'read', 'write_reversible'])},
        ${JSON.stringify({ to: 'someone' })}::jsonb, ${'a'.repeat(64)}, ${id}, ${status},
        ${receipt === null ? null : JSON.stringify(receipt)}::jsonb,
        ${created.toISOString()}::timestamptz, ${created.toISOString()}::timestamptz)`;
    ids.push(id);
  }
  // A question an earlier attempt put about its open steps, sometimes.
  const asker = pick.of(attempts);
  if (pick.chance(0.4))
    await sql`insert into question (id, source, job_id, attempt_id, text, because, if_ignored,
        blocks_external_effect, options, state, answer, created_at)
      values (${recordId('qst')}, 'job', ${jobId}, ${asker}, 'Did it go?',
        ${JSON.stringify([`attempt:${asker}`])}::jsonb, 'It waits.', true, ${JSON.stringify([{ id: UNSETTLED_WAIT, label: 'It went' }])}::jsonb,
        'answered', 'Go ahead.', ${new Date(Date.UTC(2026, 0, 1, 12, 0, pick.int(0, 40))).toISOString()}::timestamptz)`;
  const deliverable: JobConstraints['deliverable'] = pick.of([
    { kind: 'none' },
    { kind: 'answer' },
    { kind: 'message_sent', connection_id: seeded.connectionId },
    { kind: 'message_sent', connection_id: elsewhere.connectionId },
  ]);
  await sql`update job set constraints = constraints || ${JSON.stringify({ deliverable })}::jsonb
    where id = ${jobId}`;
  return { jobId, attempts, ids, pick };
}

withDb('the steps a finishing turn reads', () => {
  test('say what reading every step said', async () => {
    let cited = 0;
    let unsatisfied = 0;
    let satisfied = 0;
    let open = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { jobId, attempts, ids, pick } = await job(seed);
      for (let outcomeNo = 0; outcomeNo < 4; outcomeNo++) {
        const evidence: Completed['evidence'] = [
          ...ids
            .filter(() => pick.chance(0.15))
            .map((id) => ({ kind: 'action' as const, action_id: id })),
          // A citation of a step that is not this job's.
          ...(pick.chance(0.2) ? [{ kind: 'action' as const, action_id: recordId('act') }] : []),
        ];
        cited += evidence.length;
        const outcome: Completed = {
          kind: 'completed',
          summary: pick.chance(0.9) ? 'Done.' : ' ',
          evidence,
        };
        const finishing = pick.chance(0.7) ? pick.of(attempts) : undefined;
        const whole = await everyStep(jobId, outcome, finishing);
        if (whole.deliverable_declared) {
          if (whole.deliverable_satisfied) satisfied++;
          else unsatisfied++;
        }
        if (!whole.all_actions_terminal) open++;
        expect({ seed, outcomeNo, facts: await narrowed(jobId, outcome, finishing) }).toEqual({
          seed,
          outcomeNo,
          facts: whole,
        });
      }
    }
    // Every way the facts can come out was read both ways.
    expect(cited).toBeGreaterThan(200);
    expect(satisfied).toBeGreaterThan(10);
    expect(unsatisfied).toBeGreaterThan(10);
    expect(open).toBeGreaterThan(20);
  }, 120_000);
});
