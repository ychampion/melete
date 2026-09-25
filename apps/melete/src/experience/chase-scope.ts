/**
 * What one "Allow once" on a chase covers.
 *
 * A chase is a job handling a ledger item: it writes to one company and waits
 * for the answer. The person is asked once, on the first message, and it must
 * be the person the job belongs to. That answer also covers the chase's
 * follow-ups, and only follow-ups that cannot say anything new: the approved
 * message, word for word, under one of a few fixed lines this service writes,
 * to the same address, as a reply in the same thread. Anything else asks again,
 * and so does anything after the job is corrected.
 *
 * The scope is a standing rule tied to the job, so it is listed with the
 * person's other rules, capped, and ended by revoking it. Each follow-up it
 * covers is still an action with its own receipt, and the scope is checked
 * again at the moment of sending.
 */

import {
  type Action,
  hashOriginWarnings,
  type JsonObject,
  originWarnings,
} from '@melete/contracts';
import type { ChaseFollowUpPort } from '../broker/chase.ts';
import type { LockedJob, Query } from '../broker/records.ts';
import type {
  ScopedGrantResolver,
  StandingGrantInput,
  StandingGrantResolver,
} from '../broker/service.ts';
import { recipientText } from './projectors.ts';
import { resolveExperienceGrant, ruleKinds, ruleRecipient } from './rules.ts';

/** How many follow-ups one "Allow once" can cover in a chase. */
export const CHASE_FOLLOW_UP_CAP = 3;
/** How long the scope lasts before the person is asked afresh. */
export const CHASE_SCOPE_DAYS = 30;
/** The standing-rule origin that marks a scope granted by a person's approval in one job. */
export const CHASE_SCOPE_ORIGIN = 'person_approved';

/**
 * The only lines a covered follow-up may add above the approved message, one
 * per follow-up. They are the service's words, not the model's.
 */
export const CHASE_NUDGES = [
  'Following up on my message below.',
  'Following up again on my message below.',
  'A last follow-up on my message below.',
] as const;

type Payload = Record<string, unknown>;

const SEND_FIELDS = new Set(['to', 'cc', 'bcc', 'subject', 'body']);

const addressesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .sort();

/** The approved subject without any `Re:` it already carried. */
const baseSubject = (subject: unknown) => {
  let text = String(subject ?? '').trim();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/^re\s*:\s*/i, '');
  }
  return text;
};

/** The one shape a covered follow-up can take: the nth nudge, then the approved message. */
export function chaseFollowUp(approved: Payload, n: number) {
  const nudge = CHASE_NUDGES[n - 1];
  if (!nudge) throw new Error(`A chase has ${CHASE_NUDGES.length} covered follow-ups`);
  return {
    to: approved.to,
    subject: `Re: ${baseSubject(approved.subject)}`,
    body: `${nudge}\n\n${String(approved.body ?? '')}`,
  };
}

/**
 * Why a follow-up is not covered by the first message's approval, or null
 * when it is. Pure, so every boundary is a plain test.
 */
export function followUpRefusal(approved: Payload, candidate: Payload): string | null {
  if (Object.keys(candidate).some((key) => !SEND_FIELDS.has(key))) return 'unexpected_field';
  if (addressesOf(candidate.cc).length || addressesOf(candidate.bcc).length)
    return 'copied_recipient';
  const to = addressesOf(candidate.to);
  const allowed = addressesOf(approved.to);
  if (!to.length || to.length !== allowed.length || to.some((entry, i) => entry !== allowed[i]))
    return 'new_recipient';
  if (candidate.subject !== `Re: ${baseSubject(approved.subject)}`) return 'new_thread';
  const body = String(candidate.body ?? '');
  const message = String(approved.body ?? '');
  if (!CHASE_NUDGES.some((nudge) => body === `${nudge}\n\n${message}`))
    return 'not_the_approved_message';
  return null;
}

/**
 * Called when an action succeeds. The first message of a chase, approved by
 * the person the chase belongs to, opens the scope for its follow-ups. One
 * scope per job: a second approved send in the same chase opens nothing new.
 */
export async function recordChaseScope(tx: Query, action: Action): Promise<void> {
  if (ruleKinds[action.kind] !== 'send_message') return;
  const [decision] = await tx`select decision, decided_by from approval
    where action_id = ${action.id} limit 1`;
  if (decision?.decision !== 'approved' || !decision.decided_by) return;
  const [chase] = await tx`select j.space_id, coalesce(j.principal_id,
      (select s.owner_principal_id from space s where s.id = j.space_id),
      (select o.id from owner o limit 1)) as principal_id
    from job j where j.id = ${action.job_id}
    and exists (select 1 from ledger_item l where l.job_id = j.id)`;
  if (!chase || chase.principal_id !== decision.decided_by) return;
  await tx`insert into experience_rule (id, space_id, connection_id, tool_kind, recipient,
      recipient_class, origin_trust, count_cap, expires_at, reconsent_after_days, job_id, source_action_id)
    values (${`rule_${action.id}`}, ${chase.space_id}, ${action.connection_id}, ${action.kind},
      ${JSON.stringify(ruleRecipient(action))}::jsonb, ${recipientText(action.canonical_payload)},
      ${CHASE_SCOPE_ORIGIN}, ${CHASE_FOLLOW_UP_CAP}, now() + make_interval(days => ${CHASE_SCOPE_DAYS}),
      ${CHASE_SCOPE_DAYS}, ${action.job_id}, ${action.id})
    on conflict do nothing`;
}

/**
 * The approval that covers this action under its job's chase scope, or null.
 * Doubts about the payload are allowed only on the recipient, and only the
 * very doubts the person saw and approved on the chase's first message; the
 * rest of the check is `followUpRefusal`.
 */
async function chaseCover(tx: Query, input: StandingGrantInput): Promise<string | null> {
  const { action, job, phase } = input;
  const warnings = input.warnings ?? [];
  if (ruleKinds[action.kind] !== 'send_message') return null;
  if (warnings.some((warning) => !/^to(?:\[\d+\])?$/.test(warning.field))) return null;
  // A reviewed action keeps the approval it was reviewed under.
  const [review] = await tx`select id from approval where action_id = ${action.id} limit 1`;
  if (review) return null;
  const [rule] = await tx`select * from experience_rule where job_id = ${job.id}
    and origin_trust = ${CHASE_SCOPE_ORIGIN} and connection_id = ${action.connection_id}
    and tool_kind = ${action.kind} and source_action_id <> ${action.id}
    and revoked_at is null and expires_at > now()
    and created_at + reconsent_after_days * interval '1 day' > now()
    for update`;
  if (!rule) return null;
  const [used] = await tx`select rule_id from experience_rule_use where action_id = ${action.id}`;
  if (used ? used.rule_id !== rule.id : Number(rule.used) >= Number(rule.count_cap)) return null;
  const [source] = await tx`select a.canonical_payload, p.id as approval_id, p.origin_warnings,
      p.job_revision
    from action a join approval p on p.action_id = a.id and p.decision = 'approved'
    where a.id = ${rule.source_action_id}`;
  if (!source) return null;
  // A correction changes what the chase is for; the approval was for the old one.
  if (Number(source.job_revision) !== Number(job.revision)) return null;
  if (followUpRefusal(source.canonical_payload, action.canonical_payload) !== null) return null;
  if (
    warnings.length > 0 &&
    hashOriginWarnings(originWarnings.parse(source.origin_warnings ?? [])) !==
      hashOriginWarnings(warnings)
  )
    return null;
  if (phase === 'execution' && !used) return null;
  if (phase === 'admission' && !used) {
    await tx`insert into experience_rule_use (action_id, rule_id) values (${action.id}, ${rule.id})`;
    await tx`update experience_rule set used = used + 1 where id = ${rule.id}`;
  }
  return String(source.approval_id);
}

/** Whether the chase scope covers an action nothing is in doubt about. */
export const resolveChaseGrant: StandingGrantResolver = async (tx, input) =>
  (await chaseCover(tx, input)) !== null;

/** The chase scope asked about a payload with doubts: the approval it rests on, or null. */
export const resolveChaseScopedGrant: ScopedGrantResolver = chaseCover;

/** A person's standing rules first, then the chase scope of the job. */
export const resolvePersonGrant: StandingGrantResolver = async (tx, input) =>
  (await resolveExperienceGrant(tx, input)) || resolveChaseGrant(tx, input);

/** The job's open chase scope and the approved message it rests on, or null. */
async function openScope(tx: Query, job: LockedJob) {
  const [scope] = await tx`select r.connection_id, r.tool_kind, r.used, a.canonical_payload
    from experience_rule r
    join action a on a.id = r.source_action_id
    join approval p on p.action_id = a.id and p.decision = 'approved'
    where r.job_id = ${job.id} and r.origin_trust = ${CHASE_SCOPE_ORIGIN}
    and r.revoked_at is null and r.expires_at > now()
    and r.created_at + r.reconsent_after_days * interval '1 day' > now()
    and r.used < r.count_cap and p.job_revision = ${job.revision}
    and exists (select 1 from ledger_item l where l.job_id = r.job_id)`;
  return scope && Number(scope.used) < CHASE_NUDGES.length ? scope : null;
}

/**
 * The `chase.follow_up` tool's side: whether a job has a follow-up its scope
 * covers, and that follow-up, written here from the approved message. The
 * broker still admits it like any other send, so the scope is checked again.
 */
export const chaseFollowUpPort: ChaseFollowUpPort = {
  available: async (tx, job) => (await openScope(tx, job)) !== null,
  next: async (tx, job) => {
    const scope = await openScope(tx, job);
    if (!scope) return null;
    return {
      connection_id: String(scope.connection_id),
      kind: String(scope.tool_kind),
      // The approved payload is stored JSON, so its recipient is JSON too.
      payload: chaseFollowUp(scope.canonical_payload, Number(scope.used) + 1) as JsonObject,
    };
  },
};
