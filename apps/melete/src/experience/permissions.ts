import { hashOriginWarnings, permissionDecision, unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import {
  actionReviewView,
  loadApprovalSettings,
  saveApprovalSettings,
} from '../broker/auto-review.ts';
import { appendEvent, loadAction, lockJob } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import { ENDED_NOTE, ENDED_STATES } from '../jobs/withdraw.ts';
import { actionBecause } from '../memory/basis.ts';
import { ownJobClause } from '../principals/authority.ts';
import { actionProjectionRow, type ExperienceEffects } from './effects.ts';
import { explainHandles } from './evidence.ts';
import {
  draftForReview,
  plainText,
  projectPermission,
  recipientText,
  STOPPED_NOTE,
  SUPERSEDED_NOTE,
  senderAddress,
} from './projectors.ts';
import {
  isAssistantCommand,
  permissionVersion,
  ruleKinds,
  ruleRecipient,
  ruleView,
} from './rules.ts';
import { experienceMissing } from './service.ts';

/** What the person is told when they answer a permission whose work has ended. */
const ENDED_MESSAGE = 'This was withdrawn because the work it was for has ended.';

/**
 * Withdraw the permissions still waiting in jobs of this space that have
 * ended. A job withdraws them itself when it ends; this catches any left
 * behind, including ones from before that was so, each time they are read.
 */
export async function withdrawEndedPermissions(sql: Sql, spaceId: string, jobId?: string) {
  const ended = await sql`select distinct a.job_id from approval p
    join action a on a.id = p.action_id join job j on j.id = a.job_id
    where j.space_id = ${spaceId} and p.decision is null and a.status = 'needs_approval'
      and j.state = any(${[...ENDED_STATES]}::text[])
      and (${jobId ?? null}::text is null or j.id = ${jobId ?? null})`;
  for (const row of ended) {
    const id = String(row.job_id);
    await sql.begin(async (tx) => {
      const job = await lockJob(tx, id);
      if (!ENDED_STATES.includes(job.state)) return;
      const pending =
        await tx`select p.id, a.id as action_id, a.attempt_id, a.status, a.payload_hash
        from approval p join action a on a.id = p.action_id
        where a.job_id = ${id} and p.decision is null and a.status = 'needs_approval'
        for update of p, a`;
      for (const stale of pending) {
        await tx`update approval set decision = 'denied', decided_at = now(),
          decided_by = ${ENDED_NOTE} where id = ${stale.id}`;
        await tx`update action set status = 'denied' where id = ${stale.action_id}`;
        await appendEvent(
          tx,
          id,
          stale.attempt_id,
          'action_status_changed',
          { action_id: stale.action_id, from: stale.status, to: 'denied' },
          `${stale.id}:${ENDED_NOTE}:status`,
        );
        await appendEvent(
          tx,
          id,
          stale.attempt_id,
          'approval_decided',
          {
            approval_id: stale.id,
            action_id: stale.action_id,
            decision: 'denied',
            note: ENDED_NOTE,
            payload_hash: stale.payload_hash,
          },
          `${stale.id}:decision`,
        );
      }
    });
  }
}

export class ExperiencePermissions {
  constructor(
    readonly sql: Sql,
    readonly broker: BrokerService,
    readonly effects: ExperienceEffects,
  ) {}

  async find(spaceId: string, id: string) {
    const [row] = await this.sql`select p.*, j.experience_parent_id, j.experience_command_key,
      j.state as job_state,
      c.label, c.provider,
      c.configuration, a.job_id, a.connection_id from approval p join action a on a.id = p.action_id
      join job j on j.id = a.job_id join connection c on c.id = a.connection_id
      where p.id = ${id} and j.space_id = ${spaceId} and c.space_id = ${spaceId}
      ${ownJobClause(this.sql, 'j')}`;
    if (!row) throw experienceMissing();
    return row;
  }

  async card(spaceId: string, id: string) {
    const row = await this.find(spaceId, id);
    const action = await loadAction(this.sql, String(row.action_id));
    const warnings = Array.isArray(row.origin_warnings) ? row.origin_warnings : [];
    const reasons = warnings.length
      ? warnings.map(() => 'This destination has not been confirmed by you or the connected app.')
      : ['This change needs your permission before it happens.'];
    reasons.push(
      ...(await explainHandles(
        this.sql,
        spaceId,
        warnings.flatMap((warning) => (typeof warning.handle === 'string' ? [warning.handle] : [])),
      )),
    );
    const [parent] = await this.sql`select j.title from job j
      where j.id = ${row.experience_parent_id ?? row.job_id} and j.space_id = ${spaceId}
      ${ownJobClause(this.sql, 'j')}`;
    if (parent) reasons.push(`For ${plainText(parent.title, 'your request')}.`);
    return projectPermission({
      id,
      version: permissionVersion(row),
      action: {
        ...actionProjectionRow(action),
        jobId: String(row.experience_parent_id ?? row.job_id),
      },
      connection: {
        id: String(row.connection_id),
        label: String(row.label),
        provider: String(row.provider),
        // Which mailbox this leaves from is part of the question being asked.
        sender: senderAddress(row.configuration),
      },
      reasons,
      // A rule could never cover what an assistant asks for, so none is offered on its card.
      canAlways:
        warnings.length === 0 &&
        Boolean(ruleKinds[action.kind]) &&
        !isAssistantCommand(row.experience_command_key),
      requestedAt: new Date(row.requested_at),
      review: await actionReviewView(this.sql, action.id),
      because: await actionBecause(this.sql, spaceId, action.id),
    });
  }

  async approvalSettings(spaceId: string) {
    return {
      settings: await loadApprovalSettings(this.sql, spaceId),
      reviewer_available: this.broker.reviewerAvailable,
    };
  }

  async saveApprovalSettings(spaceId: string, input: unknown) {
    await saveApprovalSettings(this.sql, spaceId, input);
    return this.approvalSettings(spaceId);
  }

  async list(spaceId: string) {
    // Only what can still be answered: an ended job's permissions are withdrawn first.
    await withdrawEndedPermissions(this.sql, spaceId);
    const rows = await this.sql`select p.id from approval p join action a on a.id = p.action_id
      join job j on j.id = a.job_id where j.space_id = ${spaceId} ${ownJobClause(this.sql, 'j')}
      and p.decision is null and a.status = 'needs_approval'
      and not (j.state = any(${[...ENDED_STATES]}::text[]))
      and (p.expires_at is null or p.expires_at > now()) order by p.requested_at limit 200`;
    return {
      permissions: await Promise.all(rows.map((row) => this.card(spaceId, String(row.id)))),
    };
  }

  async decide(spaceId: string, id: string, raw: unknown) {
    const input = permissionDecision.parse(raw);
    const row = await this.find(spaceId, id);
    const ruleId = `rule_${id}`;
    // The work this was for has ended, so nothing it covered can happen: it is
    // withdrawn, a Deny agrees with that, and an Allow is told why it cannot.
    if (ENDED_STATES.includes(String(row.job_state)) || row.decided_by === ENDED_NOTE) {
      await withdrawEndedPermissions(this.sql, spaceId, String(row.job_id));
      if (input.option === 'deny') return { status: 'ok', option: input.option, rule: null };
      throw new ServiceError('permission_withdrawn', ENDED_MESSAGE, 409);
    }
    await this.broker.decide(
      String(row.action_id),
      {
        decision: input.option === 'deny' ? 'denied' : 'approved',
        payload_hash: String(row.payload_hash),
      },
      async (tx, job, action, approval) => {
        // Checked under the approval's lock, so a message that arrives meanwhile is seen.
        if (approval.decided_by === SUPERSEDED_NOTE)
          throw new ServiceError(
            'permission_replaced',
            'Your new message replaced this request.',
            409,
          );
        if (approval.decided_by === STOPPED_NOTE)
          throw new ServiceError(
            'permission_withdrawn',
            'This was withdrawn when you stopped.',
            409,
          );
        if (approval.decided_by === ENDED_NOTE)
          throw new ServiceError('permission_withdrawn', ENDED_MESSAGE, 409);
        if (job.space_id !== spaceId || permissionVersion(approval) !== input.version)
          throw new ServiceError('stale_permission', 'This request changed. Review it again.', 409);
        if (
          input.option !== 'deny' &&
          action.kind.endsWith('.send') &&
          !draftForReview(actionProjectionRow(action))
        )
          throw new ServiceError(
            'unavailable_preview',
            'Prepare a new draft that can be reviewed in full.',
            409,
          );
        if (input.option !== 'always') return;
        if (!ruleKinds[action.kind])
          throw new ServiceError('invalid_request', 'This permission can only be used once.', 400);
        const warnings = await this.broker.origins(tx, job, action);
        if (
          warnings.length ||
          hashOriginWarnings(warnings) !== hashOriginWarnings(approval.origin_warnings as [])
        )
          throw new ServiceError(
            'unconfirmed_destination',
            'Confirm the destination before saving a rule.',
            409,
          );
        const [existing] = await tx`select id from experience_rule where id = ${ruleId}`;
        if (existing) return;
        if (approval.decision)
          throw new ServiceError('already_decided', 'This request was already answered.', 409);
        if (Date.parse(input.bounds.expires_at) <= Date.now())
          throw new ServiceError('invalid_request', 'Choose a future expiry.', 400);
        const recipient = ruleRecipient(action);
        const label = recipient.length
          ? recipientText(action.canonical_payload)
          : 'this connected app';
        await tx`insert into experience_rule (id, space_id, connection_id, tool_kind, recipient, recipient_class,
        origin_trust, count_cap, expires_at, reconsent_after_days)
        values (${ruleId}, ${spaceId}, ${action.connection_id}, ${action.kind}, ${JSON.stringify(recipient)}::jsonb,
        ${label}, 'connector_verified', ${input.bounds.count_cap}, ${input.bounds.expires_at}, ${input.bounds.reconsent_after_days})`;
      },
    );
    await this.effects.continueCommand(await loadAction(this.sql, String(row.action_id)));
    const [rule] =
      input.option === 'always'
        ? await this.sql`select * from experience_rule where id = ${ruleId}`
        : [];
    return { status: 'ok', option: input.option, rule: rule ? ruleView(rule) : null };
  }

  async rules(spaceId: string) {
    const rows = await this
      .sql`select * from experience_rule where space_id = ${spaceId} and revoked_at is null
      and expires_at > now() and created_at + reconsent_after_days * interval '1 day' > now() order by created_at`;
    return { rules: rows.map(ruleView) };
  }
  async revoke(spaceId: string, id: string) {
    const rows = await this
      .sql`update experience_rule set revoked_at = coalesce(revoked_at, now()) where id = ${id} and space_id = ${spaceId} returning id`;
    if (!rows.length) throw experienceMissing();
    return { status: 'ok' };
  }

  async send(spaceId: string, id: string) {
    const result = await this.effects.send(spaceId, id);
    if ('reason' in result) return result;
    if ('reason' in result.draft) return result.draft;
    const [approval] = await this
      .sql`select id from approval where action_id = ${result.action.id} and decision is null`;
    if (['failed', 'denied', 'unknown', 'unresolved'].includes(result.action.status))
      return unavailable('Sending has not been confirmed. Review this draft before trying again.');
    return {
      draft: result.draft,
      permission: approval ? await this.card(spaceId, String(approval.id)) : null,
      receipt:
        result.action.status === 'succeeded'
          ? await this.effects.receipt(spaceId, result.action)
          : null,
    };
  }
}
