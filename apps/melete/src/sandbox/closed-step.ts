/**
 * Whether a step ran on an agent's computer that could reach nothing outside.
 *
 * Only such a step keeps everything it did inside that computer, so an open
 * outcome there is the agent's to check and never a question for the person.
 * A step on a computer with network access may have sent or uploaded
 * something, and is reconciled like any outside effect. The session is the
 * one its command was recorded against, or for a desktop step, the session
 * its attempt held on that connection.
 */
import { sql as drizzleSql } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { action } from '../db/schema.ts';

/** The step's computer, as SQL over an action row aliased `a`. */
const SESSION_OF_STEP = `coalesce(
  (select c.session_id from sandbox_command c where c.action_id = a.id),
  (select s2.id from sandbox_session s2
    where s2.attempt_id = a.attempt_id and s2.connection_id = a.connection_id
    order by s2.opened_at desc limit 1))`;

const CLOSED_STEP = `exists (select 1 from sandbox_session s
  where s.id = ${SESSION_OF_STEP} and s.egress_policy->>'kind' = 'deny_all')`;

export async function closedComputerStep(
  q: Sql | TransactionSql,
  actionId: string,
): Promise<boolean> {
  const [row] = await q.unsafe(`select ${CLOSED_STEP} as closed from action a where a.id = $1`, [
    actionId,
  ]);
  return row?.closed === true;
}

/** The same, as a column of a Drizzle select over the `action` table. */
export const closedComputerStepColumn = drizzleSql<boolean>`(select ${drizzleSql.raw(
  CLOSED_STEP,
)} from action a where a.id = ${action.id})`;
