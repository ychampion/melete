import { hashOriginWarnings, permissionDecision, unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { loadAction } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import { actionProjectionRow, type ExperienceEffects } from './effects.ts';
import { explainHandles } from './evidence.ts';
import { plainText, projectPermission, recipientText } from './projectors.ts';
import { permissionVersion, ruleKinds, ruleRecipient, ruleView } from './rules.ts';
import { experienceMissing } from './service.ts';

export class ExperiencePermissions {
  constructor(
    readonly sql: Sql,
    readonly broker: BrokerService,
    readonly effects: ExperienceEffects,
  ) {}

  async find(spaceId: string, id: string) {
    const [row] = await this.sql`select p.*, j.experience_parent_id, c.label, c.provider,
      a.job_id, a.connection_id from approval p join action a on a.id = p.action_id
      join job j on j.id = a.job_id join connection c on c.id = a.connection_id
      where p.id = ${id} and j.space_id = ${spaceId} and c.space_id = ${spaceId}`;
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
    const [parent] = await this
      .sql`select title from job where id = ${row.experience_parent_id ?? row.job_id} and space_id = ${spaceId}`;
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
      },
      reasons,
      canAlways: warnings.length === 0 && Boolean(ruleKinds[action.kind]),
    });
  }

  async list(spaceId: string) {
    const rows = await this.sql`select p.id from approval p join action a on a.id = p.action_id
      join job j on j.id = a.job_id where j.space_id = ${spaceId} and p.decision is null
      and a.status = 'needs_approval' and (p.expires_at is null or p.expires_at > now()) order by p.requested_at limit 200`;
    return {
      permissions: await Promise.all(rows.map((row) => this.card(spaceId, String(row.id)))),
    };
  }

  async decide(spaceId: string, id: string, raw: unknown) {
    const input = permissionDecision.parse(raw);
    const row = await this.find(spaceId, id);
    const ruleId = `rule_${id}`;
    await this.broker.decide(
      String(row.action_id),
      {
        decision: input.option === 'deny' ? 'denied' : 'approved',
        payload_hash: String(row.payload_hash),
      },
      async (tx, job, action, approval) => {
        if (job.space_id !== spaceId || permissionVersion(approval) !== input.version)
          throw new ServiceError('stale_permission', 'This request changed. Review it again.', 409);
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
