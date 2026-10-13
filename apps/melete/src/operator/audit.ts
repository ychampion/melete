/**
 * What the installation's owner did to people's accounts, kept as events in
 * the service's own event log: one notice per action, outside any job, so no
 * conversation shows it and no pruning takes it. The operator console lists
 * them, newest first, and so does nothing else.
 *
 * An entry says who did what to whom and when, in words. It never holds a
 * link, a code, a password or anything else that would let someone in: the
 * caller passes only the action and, for a cap change, the amounts.
 */
import { randomUUID } from 'node:crypto';
import type { OperatorAction, OperatorAuditEntry } from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';

export const OPERATOR_ACTION_KIND = 'operator_action';

/** Whoever acted: an account, or the operator's command on the host. */
export type OperatorActor = { id: string; email: string } | null;

export type OperatorRecord = {
  actor: OperatorActor;
  action: OperatorAction;
  target: { id: string; email: string | null };
  /** A plain sentence about the change, such as the caps before and after. Never a secret. */
  detail?: string;
};

/** Anything that looks like a link or a long token is never kept, whatever the caller passed. */
const SECRET_SHAPED = /https?:\/\/\S+|[A-Za-z0-9_-]{32,}/g;

export async function recordOperatorAction(
  q: Sql | TransactionSql,
  record: OperatorRecord,
): Promise<void> {
  const payload = {
    kind: OPERATOR_ACTION_KIND,
    action: record.action,
    actor_id: record.actor?.id ?? null,
    actor_email: record.actor?.email ?? null,
    target_id: record.target.id,
    target_email: record.target.email,
    detail: (record.detail ?? '').replace(SECRET_SHAPED, '…').slice(0, 400),
  };
  await q`insert into event (type, payload, dedup_key)
    values ('notice', ${JSON.stringify(payload)}::text::jsonb, ${`operator:${randomUUID()}`})`;
}

/** The newest operator actions, newest first. */
export async function listOperatorActions(sql: Sql, limit = 100): Promise<OperatorAuditEntry[]> {
  const rows = await sql<
    { seq: string; created_at: Date | string; payload: Record<string, unknown> }[]
  >`
    select seq::text as seq, created_at, payload from event
    where job_id is null and type = 'notice' and payload->>'kind' = ${OPERATOR_ACTION_KIND}
    order by seq desc limit ${limit}`;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return rows.map((row) => ({
    id: row.seq,
    at: new Date(row.created_at).toISOString(),
    action: row.payload.action as OperatorAction,
    actor: { id: text(row.payload.actor_id), email: text(row.payload.actor_email) },
    target: { id: text(row.payload.target_id), email: text(row.payload.target_email) },
    detail: text(row.payload.detail),
  }));
}
