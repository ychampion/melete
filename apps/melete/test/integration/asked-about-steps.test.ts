/**
 * Which steps an earlier turn left open still hold a finishing turn: those
 * nobody has been asked about since they were sent. A still-running question
 * covers a step when the step's own attempt asked it, or when it was raised at
 * or after the step was last sent, whichever attempt raised it; its answers
 * settle every step of the job still open.
 *
 * Each case is set up row by row, with the times written out, and read back
 * through `completionFacts` as the finishing attempt would.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql as dsql, eq } from 'drizzle-orm';
import { recordId } from '../../src/broker/records.ts';
import { job as jobTable } from '../../src/db/schema.ts';
import { completionFacts } from '../../src/jobs/bundle.ts';
import { resolveQuestions } from '../../src/jobs/questions.ts';
import { UNSETTLED_OPTIONS, unsettledQuestion } from '../../src/jobs/unsettled.ts';
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

/** A moment, `seconds` after a fixed start. */
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds));

/** A conversation with attempts at epochs 1 to `attempts`, in order. */
async function conversation(attempts = 4) {
  const { sql } = database();
  const seed = await seedJob(sql);
  const ids = [seed.claims.attempt_id];
  for (let epoch = 2; epoch <= attempts; epoch++) {
    const id = recordId('att');
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${id}, ${seed.claims.job_id}, ${epoch}, 'fake', 'fake', 'scripted')`;
    ids.push(id);
  }
  return {
    jobId: seed.claims.job_id,
    connectionId: seed.connectionId,
    /** The attempt at `epoch`. */
    attempt: (epoch: number) => ids[epoch - 1] as string,
  };
}

type Conversation = Awaited<ReturnType<typeof conversation>>;

/** A step on the job, still out unless said otherwise. */
async function step(
  chat: Conversation,
  input: { epoch: number; created: Date; sent?: Date | null; status?: string },
) {
  const { sql } = database();
  const id = recordId('act');
  const sent = input.sent === undefined ? input.created : input.sent;
  await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, idempotency_key, status, dispatched_at, created_at)
    values (${id}, ${chat.jobId}, ${chat.attempt(input.epoch)}, ${chat.connectionId}, 'test.send',
      'write_external', ${JSON.stringify({ to: 'someone' })}::jsonb, ${'a'.repeat(64)}, ${id},
      ${input.status ?? 'unknown'}, ${sent?.toISOString() ?? null}::timestamptz,
      ${input.created.toISOString()}::timestamptz)`;
  return id;
}

/** A question put to the person, answered in their own words unless said otherwise. */
async function asked(
  jobId: string,
  attemptId: string,
  created: Date,
  options: { id: string; label: string }[] = UNSETTLED_OPTIONS,
) {
  const { sql } = database();
  await sql`insert into question (id, source, job_id, attempt_id, text, because, if_ignored,
      blocks_external_effect, options, state, answer, created_at)
    values (${recordId('qst')}, 'job', ${jobId}, ${attemptId}, 'Something has not reported back.',
      ${JSON.stringify([`attempt:${attemptId}`])}::jsonb, 'It waits.', true,
      ${JSON.stringify(options)}::jsonb, 'answered', 'Go ahead.', ${created.toISOString()}::timestamptz)`;
}

/** Whether a step still holds the attempt at `epoch` from finishing. */
async function holds(chat: Conversation, epoch: number, timeZone?: string) {
  const { db } = database();
  return db.transaction(async (tx) => {
    if (timeZone) await tx.execute(dsql.raw(`set local time zone '${timeZone}'`));
    const [row] = await tx
      .select({ id: jobTable.id, spaceId: jobTable.spaceId, constraints: jobTable.constraints })
      .from(jobTable)
      .where(eq(jobTable.id, chat.jobId));
    if (!row) throw new Error('no job row');
    const facts = await completionFacts(
      tx,
      row as never,
      { kind: 'completed', summary: 'Done.', evidence: [] },
      undefined,
      chat.attempt(epoch),
    );
    return !facts.all_actions_terminal;
  });
}

withDb('a step an earlier turn left open', () => {
  test('a step of the finishing attempt holds it, asked about or not', async () => {
    const chat = await conversation(1);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(1), at(5));
    expect(await holds(chat, 1)).toBe(true);
  });

  test('asked about by its own attempt, it no longer holds a later one', async () => {
    const chat = await conversation(2);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(1), at(5));
    expect(await holds(chat, 2)).toBe(false);
  });

  test('asked about by a retry of its turn, it no longer holds a later one', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(2), at(5));
    expect(await holds(chat, 3)).toBe(false);
  });

  test('asked about by a later turn, after waiting behind another question', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    // Raised as its own attempt ended, kept back, and asked by the next turn:
    // it keeps the moment it was first raised and carries the later attempt.
    await asked(chat.jobId, chat.attempt(2), at(1));
    expect(await holds(chat, 3)).toBe(false);
  });

  test('raised at the very moment the step was sent, the question covers it', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0), sent: at(3) });
    await asked(chat.jobId, chat.attempt(2), at(3));
    expect(await holds(chat, 3)).toBe(false);
  });

  test('the time zone the database speaks in changes nothing', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(2), at(1));
    expect(await holds(chat, 3, 'Pacific/Kiritimati')).toBe(false);
    expect(await holds(chat, 3, 'America/Adak')).toBe(false);
  });
});

withDb('a question that does not cover the step', () => {
  test('a different step this attempt left out still holds it', async () => {
    const chat = await conversation(2);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(1), at(5));
    const second = await step(chat, { epoch: 2, created: at(20) });
    expect(await holds(chat, 2)).toBe(true);
    await database().sql`update action set status = 'succeeded' where id = ${second}`;
    expect(await holds(chat, 2)).toBe(false);
  });

  test('a step a later turn started after the question holds the next turn', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(1), at(5));
    await step(chat, { epoch: 2, created: at(20) });
    expect(await holds(chat, 3)).toBe(true);
  });

  test('a step first sent after the question, by a later attempt, holds the next turn', async () => {
    // Proposed early and waiting for approval while another turn's question
    // was asked and answered, then let through and sent by a later attempt.
    const chat = await conversation(4);
    await step(chat, { epoch: 3, created: at(0), sent: at(30) });
    await asked(chat.jobId, chat.attempt(2), at(10));
    expect(await holds(chat, 4)).toBe(true);
  });

  test('a step sent again after the question holds the next turn', async () => {
    const chat = await conversation(3);
    // Sent, asked about by a retry of its turn, then sent again (a rate limit
    // parked it and it went out once the wait was over).
    await step(chat, { epoch: 1, created: at(0), sent: at(40) });
    await asked(chat.jobId, chat.attempt(2), at(10));
    expect(await holds(chat, 3)).toBe(true);
  });

  test('a still-running question in another conversation', async () => {
    const chat = await conversation(3);
    const other = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(other.jobId, other.attempt(2), at(10));
    expect(await holds(chat, 3)).toBe(true);
  });

  test('a later question that is not the still-running one', async () => {
    const chat = await conversation(3);
    await step(chat, { epoch: 1, created: at(0) });
    await asked(chat.jobId, chat.attempt(2), at(10), []);
    expect(await holds(chat, 3)).toBe(true);
  });
});

withDb('when a turn raises a question', () => {
  test('it is stamped by the database clock, the clock steps are stamped by', async () => {
    const { db, sql } = database();
    const seed = await seedJob(sql);
    const attemptId = seed.claims.attempt_id;
    const stamped = await db.transaction(async (tx) => {
      // Time passes inside the transaction, so this process's clock and the
      // transaction's own clock read differently.
      await tx.execute(dsql`select pg_sleep(0.05)`);
      const [row] = await tx.select().from(jobTable).where(eq(jobTable.id, seed.claims.job_id));
      if (!row) throw new Error('no job row');
      const resolution = await resolveQuestions(tx, row, {
        attemptId,
        carried: [unsettledQuestion(attemptId, 'Step: Send. Something has not reported back.')],
        askable: true,
      });
      const [clock] = await tx.execute<{ now: Date | string }>(dsql`select now() as now`);
      return { asked: resolution.asked?.created_at, now: new Date(String(clock?.now)) };
    });
    expect(stamped.asked).toBe(stamped.now.toISOString());
  });
});
