import { createHash } from 'node:crypto';
import { type Action, type StandingRule, standingRule } from '@melete/contracts';
import type { StandingGrantResolver } from '../broker/service.ts';
import { collectOriginFields } from '../broker/trust.ts';
import { numericDate } from '../dates.ts';
import { plainText } from './projectors.ts';

export const ruleKinds: Record<string, StandingRule['kind']> = {
  'email.send': 'send_message',
  'test.send': 'send_message',
  'calendar.create': 'create_event',
  'calendar.update': 'change_event',
  'calendar.delete': 'delete_event',
  'email.discard': 'discard_draft',
  'files.write': 'save_file',
  'files.move': 'restore_file',
};
export const ruleRecipient = (action: Action) => collectOriginFields(action.canonical_payload);
export const permissionVersion = (approval: Record<string, unknown>) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        approval.id,
        approval.payload_hash,
        approval.job_revision,
        approval.origin_warnings,
        approval.expires_at ? new Date(String(approval.expires_at)).toISOString() : null,
      ]),
    )
    .digest('hex');

export function ruleView(row: Record<string, unknown>): StandingRule {
  const kind = ruleKinds[String(row.tool_kind)];
  if (!kind) throw new Error('Permission kind is not supported.');
  const recipient = plainText(row.recipient_class, 'The selected destination');
  return standingRule.parse({
    id: row.id,
    kind,
    connection_id: row.connection_id,
    recipient_class: recipient,
    // A rule scoped to one job is a chase's follow-ups, and says so.
    text: row.job_id
      ? `Follow-ups in one chase to ${recipient}, up to ${row.count_cap}, until ${numericDate(new Date(String(row.expires_at)))}.`
      : `${kind.replaceAll('_', ' ')} for ${recipient}, up to ${row.count_cap} times, until ${numericDate(new Date(String(row.expires_at)))}. Ask again after ${row.reconsent_after_days} days.`,
    bounds: {
      count_cap: row.count_cap,
      expires_at: new Date(String(row.expires_at)).toISOString(),
      reconsent_after_days: row.reconsent_after_days,
    },
    used: row.used,
    created_at: new Date(String(row.created_at)).toISOString(),
  });
}

/** Exact trusted selectors prevent one recipient's permission from authorizing another. */
export const resolveExperienceGrant: StandingGrantResolver = async (tx, input) => {
  const { action, job, phase } = input;
  if (!ruleKinds[action.kind]) return false;
  // A reviewed action retains its original approval binding, including expiry.
  const [review] = await tx`select id from approval where action_id = ${action.id} limit 1`;
  if (review) return false;
  const recipient = JSON.stringify(ruleRecipient(action));
  const [used] = await tx`select rule_id from experience_rule_use where action_id = ${action.id}`;
  const rules = await tx`select * from experience_rule where space_id = ${job.space_id}
    and connection_id = ${action.connection_id} and tool_kind = ${action.kind}
    and recipient = ${recipient}::jsonb and origin_trust in ('owner_stated', 'connector_verified')
    and job_id is null
    and revoked_at is null and expires_at > now()
    and created_at + reconsent_after_days * interval '1 day' > now()
    order by created_at, id for update`;
  const rule = rules.find((row) =>
    used ? row.id === used.rule_id : Number(row.used) < Number(row.count_cap),
  );
  if (!rule || (phase === 'execution' && !used)) return false;
  if (phase === 'admission' && !used) {
    await tx`insert into experience_rule_use (action_id, rule_id) values (${action.id}, ${rule.id})`;
    await tx`update experience_rule set used = used + 1 where id = ${rule.id}`;
  }
  return true;
};
