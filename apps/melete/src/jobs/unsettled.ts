/**
 * A turn that ended while something it started was still unsettled: sent and
 * not back yet, or back with nobody able to say whether it went through.
 *
 * Such a turn used to rest on a sentence with nothing to press. It now asks
 * one question with four answers the service carries out itself: keep
 * waiting; check again (the destination is asked, as `verify` asks it); or
 * the person says it went through, or did not, which settles every step still
 * open as theirs to call (`resolveByOwner`). Only once nothing is left open
 * is the question answered, and the conversation carries on.
 */
import type { QuestionSpec } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { OfferedChoice } from './questions.ts';

export const UNSETTLED_WAIT = 'unsettled_wait';
export const UNSETTLED_CHECK = 'unsettled_check';
export const UNSETTLED_DONE = 'unsettled_done';
export const UNSETTLED_NOT_DONE = 'unsettled_not_done';

/** The four answers, in the order they are offered. */
export const UNSETTLED_OPTIONS: OfferedChoice[] = [
  { id: UNSETTLED_WAIT, label: 'Keep waiting' },
  { id: UNSETTLED_CHECK, label: 'Check again' },
  { id: UNSETTLED_DONE, label: 'It went through' },
  { id: UNSETTLED_NOT_DONE, label: 'It did not go through' },
];

/** What the person is asked when something a turn sent has not been confirmed. */
export const UNCONFIRMED_NOTE =
  'Melete could not confirm whether something this turn sent went through. Check where it went, then say which, or have Melete check again.';

/** The question, with its answers, for an attempt that left something unsettled. */
export function unsettledQuestion(attemptId: string, text: string): QuestionSpec {
  return {
    text,
    because: [`attempt:${attemptId}`],
    if_ignored: 'It stays open and nothing is sent again until it is settled.',
    blocks_external_effect: true,
    deadline_at: null,
    options: UNSETTLED_OPTIONS,
  };
}

/** Whether a question is this one: it offers exactly these four answers. */
export function isUnsettledQuestion(options: readonly { id: string }[]): boolean {
  const offered = options.map((option) => option.id).sort();
  const expected = UNSETTLED_OPTIONS.map((option) => option.id).sort();
  return offered.length === expected.length && offered.every((id, at) => id === expected[at]);
}

/** What answering it can do, given the broker this process runs. */
export type UnsettledSteps = {
  /** Ask the destination again about each step still open. */
  check(jobId: string): Promise<void>;
  /** Settle each step still open as the person says, as theirs to call. */
  mark(jobId: string, actorId: string, resolution: 'succeeded' | 'failed'): Promise<void>;
  /** How many of the job's steps are still open: sent and not back, or back unknown. */
  open(jobId: string): Promise<number>;
};

/** The minimum of the broker an answer needs. */
type Settler = {
  /** Calls a sent step whose sender is gone unknown, so it can be checked or answered. */
  settleAbandoned(attemptId: string): Promise<unknown>;
  verify(id: string): Promise<unknown>;
  resolveByOwner(
    actorId: string,
    id: string,
    input: { resolution: 'succeeded' | 'failed' | 'unresolved'; note?: string },
  ): Promise<unknown>;
};

/** The steps a job left unsettled, by the broker's records. */
export function unsettledSteps(sql: Sql, broker: () => Settler | undefined): UnsettledSteps {
  const uncertain = async (jobId: string) =>
    (
      await sql`select id from action where job_id = ${jobId}
        and status in ('unknown', 'unresolved') order by created_at`
    ).map((row) => String(row.id));
  const required = () => {
    const settler = broker();
    if (!settler) throw new Error('no broker in this process');
    return settler;
  };
  // A step still marked as sent whose sender has stopped waiting becomes
  // unknown first; one this process is still sending is left to finish.
  const abandoned = async (settler: Settler, jobId: string) => {
    const attempts = await sql`select distinct attempt_id from action
      where job_id = ${jobId} and status = 'dispatched'`;
    for (const row of attempts) await settler.settleAbandoned(String(row.attempt_id));
  };
  return {
    async check(jobId) {
      const settler = required();
      await abandoned(settler, jobId);
      for (const id of await uncertain(jobId)) await settler.verify(id);
    },
    async mark(jobId, actorId, resolution) {
      const settler = required();
      await abandoned(settler, jobId);
      for (const id of await uncertain(jobId))
        await settler.resolveByOwner(actorId, id, {
          resolution,
          note: 'Answered from the conversation.',
        });
    },
    async open(jobId) {
      const [row] = await sql`select count(*)::int as count from action where job_id = ${jobId}
        and status in ('dispatched', 'unknown', 'unresolved')`;
      return Number(row?.count ?? 0);
    },
  };
}
