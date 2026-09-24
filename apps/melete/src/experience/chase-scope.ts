/**
 * What one "Allow once" on a chase covers.
 *
 * A chase is a job handling a ledger item: it writes to one company and waits
 * for the answer. The person is asked once, on the first message. That answer
 * also covers the chase's follow-ups, and only those that could not surprise
 * them: the same job, the same address they approved, the same thread, nothing
 * but a message, no amount they did not see, and no wording that commits them
 * to anything. Anything else is asked again.
 *
 * The scope is a standing rule tied to the job, so it is listed with the
 * person's other rules, capped, and ended by revoking it. Each follow-up it
 * covers is still an action with its own receipt.
 */

import { type Action, hashOriginWarnings, originWarnings } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
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

type Payload = Record<string, unknown>;

const SEND_FIELDS = new Set(['to', 'cc', 'bcc', 'subject', 'body']);

const addressesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .sort();

/** A reply keeps its thread; a forward or a new subject starts another. */
const threadOf = (subject: unknown) => {
  let text = String(subject ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/^re\s*:\s*/, '');
  }
  return text;
};

/** Every money amount in a text, as a plain number: `£1,234.50`, `GBP 1234.5`, `1234.50 GBP`. */
const amountsIn = (text: unknown): Set<string> => {
  const found = new Set<string>();
  const pattern =
    /(?:[£$€¥₹]\s?|\b[A-Z]{3}\s?)(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:[A-Z]{3}\b|pounds\b|euros\b|dollars\b)/g;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? '').replaceAll(',', '');
    const value = Number(raw);
    if (Number.isFinite(value)) found.add(value.toFixed(2));
  }
  return found;
};

/** First-person wording that binds the person to something they did not approve. */
const COMMITMENT =
  /\b(?:i|we) (?:(?:hereby|do) )?(?:agree|accept|consent|authori[sz]e|promise|undertake|waive|withdraw|will pay|shall pay)\b|\b(?:full and final|in full settlement|settle for|sign(?:ed)? (?:the|this|your) (?:agreement|contract))\b/i;

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
  if (threadOf(candidate.subject) !== threadOf(approved.subject)) return 'new_thread';
  const seen = new Set([...amountsIn(approved.body), ...amountsIn(approved.subject)]);
  for (const amount of [...amountsIn(candidate.body), ...amountsIn(candidate.subject)])
    if (!seen.has(amount)) return 'new_amount';
  if (COMMITMENT.test(`${String(candidate.subject ?? '')}\n${String(candidate.body ?? '')}`))
    return 'commitment';
  return null;
}

/**
 * Called when an action succeeds. The first message of a chase that a person
 * approved opens the scope for that chase's follow-ups. One scope per job: a
 * second approved send in the same chase opens nothing new.
 */
export async function recordChaseScope(tx: Query, action: Action): Promise<void> {
  if (ruleKinds[action.kind] !== 'send_message') return;
  const [decision] = await tx`select decision, decided_by from approval
    where action_id = ${action.id} limit 1`;
  if (decision?.decision !== 'approved' || !decision.decided_by) return;
  const [chase] = await tx`select j.space_id from job j where j.id = ${action.job_id}
    and exists (select 1 from ledger_item l where l.job_id = j.id)`;
  if (!chase) return;
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
  const [source] = await tx`select a.canonical_payload, p.id as approval_id, p.origin_warnings
    from action a join approval p on p.action_id = a.id and p.decision = 'approved'
    where a.id = ${rule.source_action_id}`;
  if (!source) return null;
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
