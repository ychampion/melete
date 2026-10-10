/**
 * Handing the agent's computer to the person, at a check only a person can
 * pass: a bot check on the page in front (`connectors/screen-text.ts` finds
 * it). As the browser's hand-off does (`workers/browser/routes.ts`), the job
 * waits for the person with a card saying what is done, what is left and
 * where to take the computer over, and the attempt that met the check is
 * fenced, so nothing it planned reaches the desktop. Taking the computer
 * over keeps the card (`SandboxComputerService.park` leaves a waiting job as
 * it is); handing it back carries the work on (`BrokerService.handedBack`).
 */
import type { HandOff } from '@melete/contracts';
import type { Sql } from 'postgres';
import { appendEvent } from '../broker/records.ts';
import { lockEventOrderIn } from '../db/transaction.ts';

/** What is left for the person at a check on the computer's screen. */
export const COMPUTER_CHECK_LEFT =
  'The page on the computer wants to check a person is there. Take over the computer, pass the check, then hand it back, and the work goes on from there.';

/**
 * How many times one turn of the work hands the computer to the person at a
 * check. A check still shown after that many hand-backs is one the person
 * could not pass, or a page that only says it checks; handing it over again
 * would stop the work at the same page each time it looked.
 */
export const MAX_CHECK_HAND_OFFS = 2;

/**
 * How many times the job's current turn (the whole job, for work that has no
 * turns) has handed the computer to the person at a check.
 */
export async function checkHandOffs(sql: Sql, jobId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as n from attempt t join job j on j.id = t.job_id
    where t.job_id = ${jobId} and t.outcome = 'fenced'
      and t.outcome_detail->>'kind' = 'handed_to_person'
      and t.outcome_detail->>'reason' = 'captcha'
      and t.turn_id is not distinct from j.current_turn_id`;
  return Number(row?.n ?? 0);
}

/** The card in one paragraph, for anywhere that shows the question alone. */
export function computerHandOffWords(card: HandOff): string {
  const done = card.done.length ? ` Done so far: ${card.done.join('; ')}.` : '';
  return `Over to you at ${card.service}. ${card.left}${done}`.slice(0, 3900);
}

/** One step the agent took on the computer, in plain words, never with what it typed. */
function stepWords(kind: string, payload: Record<string, unknown>): string[] {
  if (kind === 'computer.batch')
    return (Array.isArray(payload.actions) ? payload.actions : []).flatMap((step) =>
      step && typeof step === 'object' && !Array.isArray(step)
        ? stepWords(
            `computer.${String((step as Record<string, unknown>).action)}`,
            step as Record<string, unknown>,
          )
        : [],
    );
  if (kind === 'computer.open') {
    try {
      return [`Opened ${new URL(String(payload.url)).host}`];
    } catch {
      return ['Opened a page'];
    }
  }
  const words: Record<string, string> = {
    'computer.click': 'Clicked on the page',
    'computer.type': 'Typed into the page',
    'computer.key': 'Pressed keys',
    'computer.scroll': 'Scrolled the page',
  };
  return words[kind] ? [words[kind]] : [];
}

/** The steps in order, with a run of the same words said once. */
const told = (steps: string[]) =>
  steps.filter((step, index) => index === 0 || steps[index - 1] !== step).slice(-12);

/**
 * Hand the work to the person: the job waits with the card, and its attempt
 * is fenced. Returns the card, or null when the job has ended or moved to
 * another attempt meanwhile; nothing changes then.
 */
export async function handComputerToPerson(
  sql: Sql,
  input: {
    spaceId: string;
    jobId: string;
    /** The computer whose screen shows the check: the chat's display, or a session without one. */
    sessionId: string;
    /** The attempt that met it; a job already on another attempt is left alone. */
    attemptId: string;
    /** The site or app it is about. */
    service: string;
    /** The step that met the check, not yet recorded as done. */
    current: { kind: string; payload: Record<string, unknown> };
  },
): Promise<HandOff | null> {
  const steps = await sql`select kind, canonical_payload from action
    where job_id = ${input.jobId} and status = 'succeeded'
      and kind like 'computer.%' and kind <> 'computer.screenshot'
      and coalesce(receipt->'detail'->>'computer_id', receipt->'detail'->>'session_id')
        = ${input.sessionId}
    order by created_at desc, id desc limit 12`;
  const done = told([
    ...[...steps]
      .reverse()
      .flatMap((step) =>
        stepWords(String(step.kind), step.canonical_payload as Record<string, unknown>),
      ),
    ...stepWords(input.current.kind, input.current.payload),
  ]);
  const [root] = await sql`select r.id, r.kind from job j
    join job r on r.id = coalesce(
      (select parent_run_id from run_state where job_id = j.id), j.experience_parent_id, j.id)
    where j.id = ${input.jobId}`;
  const rootId = String(root?.id ?? input.jobId);
  const card: HandOff = {
    reason: 'captcha',
    service: input.service,
    done,
    left: COMPUTER_CHECK_LEFT,
    take_over: {
      surface: 'computer',
      session_id: input.sessionId,
      link: root?.kind === 'chat' ? `/chat/${rootId}?computer=1` : `/runs/${rootId}`,
    },
    action_id: null,
  };
  return sql.begin(async (tx) => {
    // Before the job lock, as every event writer does: event order is commit order.
    await lockEventOrderIn(tx);
    const [job] =
      await tx`select id, space_id, state, lease_epoch from job where id = ${input.jobId} for update`;
    if (
      !job ||
      job.space_id !== input.spaceId ||
      ['completed', 'cancelled', 'failed'].includes(job.state)
    )
      return null;
    const [execution] = await tx`select epoch, ended_at from attempt
      where id = ${input.attemptId} and job_id = ${input.jobId}`;
    if (!execution || execution.epoch !== job.lease_epoch || execution.ended_at) return null;
    const wait = { kind: 'user_input', question: computerHandOffWords(card), handoff: card };
    await tx`update job set state = 'waiting_for_input', wait = ${JSON.stringify(wait)}::jsonb,
      lease_epoch = lease_epoch + 1, state_version = state_version + 1,
      next_wake_at = null, updated_at = now() where id = ${input.jobId}`;
    // The conversation's turn waits on the person, as the conversation is read after a reload.
    await tx`update experience_turn set status = 'needs_you'
      where id = (select current_turn_id from job where id = ${input.jobId})
        and status in ('queued', 'working', 'streaming')`;
    const detail = { kind: 'handed_to_person', session_id: input.sessionId, reason: card.reason };
    const attempts = await tx`update attempt set outcome = 'fenced',
      outcome_detail = ${JSON.stringify(detail)}::jsonb,
      ended_at = now(), lease_expires_at = null, lease_status = 'ended'
      where job_id = ${input.jobId} and ended_at is null returning id`;
    for (const attempt of attempts)
      await appendEvent(
        tx,
        input.jobId,
        attempt.id,
        'attempt_ended',
        detail,
        `${attempt.id}:ended`,
      );
    await appendEvent(tx, input.jobId, null, 'job_state_changed', {
      from: job.state,
      to: 'waiting_for_input',
      reason: 'handed_to_person',
      session_id: input.sessionId,
    });
    await appendEvent(tx, input.jobId, null, 'notice', { kind: 'handed_to_person', ...card });
    return card;
  });
}
