import {
  type AttemptBundle,
  type CapabilityClaims,
  canonicalizePayload,
  type ToolSpec,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from './errors.ts';
import { appendEvent, checkAttempt, lockJob } from './records.ts';

/** A scoped lifecycle operation, not an external connector effect. */
export const RUNTIME_WAIT_TOOL: ToolSpec = {
  name: 'job.wait',
  description:
    'Persist a wait for a registered event or a future timer, then end this turn. Use an event trigger ID from the current job. This does not send anything or approve an action.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: {
    // The pinned engine strips top-level unions from provider schemas. Keep
    // discoverable fields here; waitSpec enforces the discriminated union.
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['event', 'timer'] },
      wake_at: {
        type: 'string',
        format: 'date-time',
        description: 'Required for timer waits: a future UTC timestamp.',
      },
      trigger_id: {
        type: 'string',
        description:
          'Required for event waits: the enabled trigger ID registered for this job, not its event name.',
      },
      deadline_at: {
        type: ['string', 'null'],
        description: 'Required for event waits: a UTC timestamp, or null for no deadline.',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

export async function requestRuntimeWait(sql: Sql, claims: CapabilityClaims, input: unknown) {
  const wait = waitSpec.parse(input);
  if (!claims.scopes.includes(RUNTIME_WAIT_TOOL.name)) throw new BrokerFault('scope_denied');
  if (wait.kind !== 'timer' && wait.kind !== 'event')
    throw new BrokerFault('payload_invalid', 'Only event and timer waits are allowed.');
  if (wait.kind === 'timer' && Date.parse(wait.wake_at) <= Date.now())
    throw new BrokerFault('payload_invalid', 'The timer must be in the future.');
  return sql.begin(async (tx) => {
    const job = await lockJob(tx, claims.job_id);
    await checkAttempt(tx, job, claims);
    if (wait.kind === 'event') {
      const [registration] =
        await tx`SELECT id FROM trigger WHERE id=${wait.trigger_id} AND job_id=${job.id} AND enabled=true`;
      if (!registration)
        throw new BrokerFault('scope_denied', 'The trigger is not active in this job.');
    }
    const [pending] =
      await tx`SELECT id FROM action WHERE job_id=${job.id} AND status IN ('needs_approval','approved','admitted','dispatched','unknown','unresolved') LIMIT 1`;
    if (pending)
      throw new BrokerFault(
        'payload_invalid',
        'Resolve the pending action before waiting for another event.',
      );
    const key = `${claims.attempt_id}:runtime-wait`;
    const [existing] = await tx`SELECT payload FROM event WHERE dedup_key=${key}`;
    if (
      existing &&
      canonicalizePayload(existing.payload.wait).hash !== canonicalizePayload(wait).hash
    ) {
      throw new BrokerFault('payload_invalid', 'This attempt already requested a different wait.');
    }
    await appendEvent(
      tx,
      job.id,
      claims.attempt_id,
      'notice',
      { kind: 'runtime_wait_requested', wait },
      key,
    );
    return {
      status: 'waiting_for_event_or_time',
      wait,
      instruction:
        'The wait request is recorded. End this turn; do not claim the awaited event happened.',
    };
  });
}

/** The service resolves this record; runtime prose cannot create a wait. */
export async function pendingRuntimeWait(
  sql: Sql,
  bundle: AttemptBundle,
): Promise<WaitSpec | null> {
  const [row] =
    await sql`SELECT e.payload FROM event e JOIN attempt a ON a.id=e.attempt_id JOIN job j ON j.id=a.job_id
    WHERE e.dedup_key=${`${bundle.attempt.id}:runtime-wait`} AND a.job_id=${bundle.attempt.job_id}
      AND j.lease_epoch=${bundle.attempt.epoch} AND j.revision=${bundle.attempt.revision}
      AND a.outcome IS NULL AND j.state='running'
      AND NOT EXISTS (SELECT 1 FROM action x WHERE x.job_id=j.id AND x.status IN ('needs_approval','approved','admitted','dispatched','unknown','unresolved'))`;
  return row ? waitSpec.parse(row.payload.wait) : null;
}
