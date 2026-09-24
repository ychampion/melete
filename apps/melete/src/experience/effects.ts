import {
  type Action,
  type CapabilityClaims,
  type ExperienceReceipt,
  type JsonObject,
  jobBudget,
  type NotAvailable,
  unavailable,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { appendEvent, loadAction, recordId } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { DEFAULT_BUDGET } from '../jobs/service.ts';
import { ownJobClause, requestPrincipal } from '../principals/authority.ts';
import { type ActionRow, draftForReview, object, projectReceipt } from './projectors.ts';
import { experienceMissing } from './service.ts';

export const actionProjectionRow = (value: Action): ActionRow => ({
  id: value.id,
  jobId: value.job_id,
  attemptId: value.attempt_id,
  connectionId: value.connection_id,
  kind: value.kind,
  effectClass: value.effect_class,
  canonicalPayload: value.canonical_payload,
  receipt: value.receipt,
  status: value.status,
  createdAt: new Date(value.created_at),
  resolvedAt: value.resolved_at ? new Date(value.resolved_at) : null,
});

/**
 * Owner commands get a private durable attempt; the runtime never receives its
 * capability. Every lookup is fenced twice: by the session's space and by the
 * signed-in principal, because an action belongs to a job and a job is private.
 */
export class ExperienceEffects {
  constructor(
    readonly sql: Sql,
    readonly broker: BrokerService,
    readonly registry: ConnectorRegistry,
  ) {}

  async source(spaceId: string, id: string) {
    const [row] = await this.sql`select a.id, j.id as parent_id, c.id as connection_id,
      c.label, c.provider, c.scopes from action a join job j on j.id = a.job_id
      join connection c on c.id = a.connection_id where a.id = ${id}
      and j.space_id = ${spaceId} and c.space_id = ${spaceId} ${ownJobClause(this.sql, 'j')}`;
    if (!row) throw experienceMissing();
    return { action: await loadAction(this.sql, id), row };
  }

  async supports(spaceId: string, connectionId: string, kind: string) {
    const tool = this.registry.get(connectionId)?.manifest.tools.find((item) => item.name === kind);
    const [connection] = await this.sql`select scopes from connection where id = ${connectionId}
      and space_id = ${spaceId} and status = 'active'`;
    return Boolean(
      tool &&
        connection &&
        [tool.name, ...tool.required_scopes].every((scope) => connection.scopes.includes(scope)),
    );
  }

  /** A home refresh can only read; its private command is never available to the runtime. */
  async read(spaceId: string, connectionId: string, kind: string, payload: JsonObject) {
    const tool = this.registry.get(connectionId)?.manifest.tools.find((item) => item.name === kind);
    if (tool?.effect_class !== 'read' || !(await this.supports(spaceId, connectionId, kind)))
      return unavailable('This connection cannot provide that information.');
    const key = `home:${spaceId}:${connectionId}:${kind}:${Math.floor(Date.now() / 60000)}`;
    // Owner reads must expire without becoming a queued runtime task after recovery.
    const budget = { ...DEFAULT_BUDGET, max_attempts: 1 };
    const principalId = requestPrincipal() ?? null;
    const jobId = await this.sql.begin(async (tx) => {
      await tx`select id from space where id = ${spaceId} for update`;
      const [existing] = await tx`select id from job where experience_command_key = ${key}`;
      if (existing) return String(existing.id);
      const id = recordId('job');
      await tx`insert into job (id, space_id, principal_id, title, objective, kind, state, lease_epoch, experience_command_key, constraints, budget)
        values (${id}, ${spaceId}, ${principalId}, 'Read upcoming events', 'Read upcoming events', 'command', 'running', 1, ${key}, '{}'::jsonb, ${JSON.stringify(budget)}::jsonb)`;
      await tx`insert into attempt (id, job_id, epoch, runtime_version, provider, model, lease_expires_at)
        values (${recordId('att')}, ${id}, 1, 'experience-v1', 'owner', 'explicit-command', now() + interval '5 minutes')`;
      return id;
    });
    try {
      const [existing] = await this
        .sql`select id from action where job_id = ${jobId} order by created_at limit 1`;
      const id = existing
        ? String(existing.id)
        : (
            await this.broker.propose(await this.claims(jobId, connectionId), {
              connection_id: connectionId,
              kind,
              payload,
              client_ref: 'home',
            })
          ).action_id;
      const effect = await loadAction(this.sql, id);
      if (['succeeded', 'failed', 'denied'].includes(effect.status))
        await this.finishRead(jobId, effect.status === 'succeeded');
      return effect;
    } catch (error) {
      await this.finishRead(jobId, false);
      throw error;
    }
  }

  private async finishRead(jobId: string, succeeded: boolean) {
    await this.sql.begin(async (tx) => {
      const [row] = await tx`select * from job where id = ${jobId} for update`;
      if (row?.state !== 'running') return;
      const outcome = succeeded
        ? { kind: 'completed', summary: 'Read upcoming events.' }
        : { kind: 'failed', reason: 'Could not read upcoming events.', retryable: false };
      const [execution] = await tx`update attempt set outcome = ${outcome.kind},
        outcome_detail = ${JSON.stringify(outcome)}::jsonb, ended_at = now(),
        lease_status = 'ended', lease_expires_at = null
        where job_id = ${jobId} and epoch = ${row.lease_epoch} and ended_at is null returning id`;
      if (!execution) return;
      await tx`update job set state = ${outcome.kind}, state_version = state_version + 1,
        next_wake_at = null, updated_at = now() where id = ${jobId}`;
      await appendEvent(
        tx,
        jobId,
        String(execution.id),
        'attempt_ended',
        { outcome },
        `${execution.id}:ended`,
      );
    });
  }

  private async command(spaceId: string, source: Action, verb: string, retry?: string) {
    return this.sql.begin(async (tx) => {
      const [parent] = await tx`select j.* from job j where j.id = ${source.job_id}
        and j.space_id = ${spaceId} ${ownJobClause(tx, 'j')} for update`;
      if (!parent) throw experienceMissing();
      // A retry after a refusal is a new request, keyed by the action it follows.
      const key = retry ? `${source.id}:${verb}:${retry}` : `${source.id}:${verb}`;
      const [existing] = await tx`select id from job where experience_command_key = ${key}`;
      if (existing) return String(existing.id);
      if (source.kind === 'email.draft') {
        const opposite = `${source.id}:${verb === 'send' ? 'undo' : 'send'}`;
        // Sends the owner refused leave the draft free to discard.
        const [other] =
          await tx`select j.id from job j where (j.experience_command_key = ${opposite}
          or j.experience_command_key like ${`${opposite}:%`}) and not (
            exists (select 1 from action a where a.job_id = j.id)
            and not exists (select 1 from action a where a.job_id = j.id and a.status <> 'denied'))`;
        if (other)
          throw new ServiceError(
            'draft_changed',
            'A send or discard was already requested for this draft.',
            409,
          );
      }
      const [turn] =
        await tx`select t.agent_id from attempt a join experience_turn t on t.id = a.turn_id where a.id = ${source.attempt_id}`;
      const id = recordId('job');
      // The command acts for whoever owns the job it came from, never for the space at large.
      await tx`insert into job (id, space_id, principal_id, title, objective, kind, state, lease_epoch, agent_id,
        experience_parent_id, experience_command_key, constraints, budget)
        values (${id}, ${spaceId}, ${parent.principal_id ?? null}, ${verb === 'send' ? 'Send the reviewed draft' : 'Undo the selected change'},
        ${verb === 'send' ? 'Send the reviewed draft' : 'Undo the selected change'}, 'command', 'running', 1,
        ${turn?.agent_id ?? parent.agent_id}, ${parent.id}, ${key}, ${JSON.stringify(parent.constraints)}::jsonb,
        ${JSON.stringify(parent.budget)}::jsonb)`;
      await tx`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${recordId('att')}, ${id}, 1, 'experience-v1', 'owner', 'explicit-command')`;
      return id;
    });
  }

  async claims(jobId: string, connectionId: string): Promise<CapabilityClaims> {
    const [row] = await this.sql`select j.*, a.id as attempt_id, c.scopes,
      (select m.generation from space_membership m where m.space_id = j.space_id
        and m.principal_id = j.principal_id and m.revoked_at is null) as membership_generation
      from job j
      join attempt a on a.job_id = j.id and a.epoch = j.lease_epoch
      join connection c on c.id = ${connectionId} and c.space_id = j.space_id
      where j.id = ${jobId} and j.kind = 'command'`;
    if (!row) throw experienceMissing();
    return {
      // A command that names its principal is admitted only as that principal.
      ...(row.principal_id
        ? {
            principal_id: String(row.principal_id),
            membership_generation: Number(row.membership_generation ?? 0),
          }
        : {}),
      job_id: jobId,
      attempt_id: String(row.attempt_id),
      space_id: String(row.space_id),
      epoch: Number(row.lease_epoch),
      revision: Number(row.revision),
      scopes: row.scopes as string[],
      budget: jobBudget.parse(row.budget),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
  }

  async execute(
    spaceId: string,
    source: Action,
    verb: string,
    kind: string,
    payload: JsonObject,
    retry?: string,
  ) {
    if (!(await this.supports(spaceId, source.connection_id, kind)))
      return unavailable('This connection does not support that change with its current access.');
    const jobId = await this.command(spaceId, source, verb, retry);
    const claims = await this.claims(jobId, source.connection_id);
    const proposed = await this.broker.propose(claims, {
      connection_id: source.connection_id,
      kind,
      payload,
      client_ref: verb,
    });
    return loadAction(this.sql, proposed.action_id);
  }

  async receipt(spaceId: string, source: Action) {
    const { row } = await this.source(spaceId, source.id);
    const undo = await this.undoHandle(spaceId, source);
    return projectReceipt(
      actionProjectionRow(source),
      { id: String(row.connection_id), label: String(row.label), provider: String(row.provider) },
      undo,
    );
  }

  private reversal(source: Action): { kind: string; payload: JsonObject } | null {
    const detail = object(source.receipt?.detail);
    if (
      source.kind === 'calendar.create' &&
      typeof detail.uid === 'string' &&
      typeof detail.etag === 'string'
    )
      return { kind: 'calendar.delete', payload: { uid: detail.uid, etag: detail.etag } };
    if (source.kind === 'email.draft')
      return { kind: 'email.discard', payload: { draft_id: source.id } };
    return null;
  }

  async undoHandle(spaceId: string, source: Action) {
    const reversal = this.reversal(source);
    if (
      source.status !== 'succeeded' ||
      !reversal ||
      !(await this.supports(spaceId, source.connection_id, reversal.kind))
    )
      return undefined;
    const validUntil = new Date(
      Date.parse(source.resolved_at ?? source.created_at) + 24 * 3600000,
    ).toISOString();
    await this.sql`insert into experience_undo (action_id, handle, valid_until)
      values (${source.id}, ${recordId('undo')}, ${validUntil}) on conflict (action_id) do nothing`;
    const [row] = await this.sql`select * from experience_undo where action_id = ${source.id}
      and valid_until > now() and reversal_action_id is null`;
    return row
      ? { handle: String(row.handle), valid_until: new Date(String(row.valid_until)).toISOString() }
      : undefined;
  }

  async undo(
    spaceId: string,
    id: string,
  ): Promise<{ receipt: ExperienceReceipt | null } | NotAvailable> {
    const [lookup] = await this
      .sql`select u.* from experience_undo u join action a on a.id = u.action_id
      join job j on j.id = a.job_id where (u.action_id = ${id} or u.handle = ${id})
      and j.space_id = ${spaceId} ${ownJobClause(this.sql, 'j')}`;
    const { action: source } = await this.source(spaceId, lookup ? String(lookup.action_id) : id);
    const reversal = this.reversal(source);
    if (!reversal)
      return unavailable(
        source.kind === 'email.send'
          ? 'A sent message cannot be recalled.'
          : 'This change has no saved reversal.',
      );
    if (!lookup) {
      if (!(await this.undoHandle(spaceId, source)))
        return unavailable('Undo is not available with this connection or its current access.');
      return this.undo(spaceId, id);
    }
    if (lookup.reversal_action_id) {
      const previous = await loadAction(this.sql, String(lookup.reversal_action_id));
      return previous.status === 'succeeded'
        ? { receipt: await this.receipt(spaceId, previous) }
        : unavailable('The reversal is still awaiting confirmation.');
    }
    if (Date.parse(String(lookup.valid_until)) <= Date.now())
      return unavailable('The time to undo this change has passed.');
    let effect = await this.execute(spaceId, source, 'undo', reversal.kind, reversal.payload);
    if ('reason' in effect) return effect;
    if (effect.status === 'needs_approval') {
      // This route is the explicit owner decision for these exact reversal bytes.
      await this.broker.decide(effect.id, {
        decision: 'approved',
        payload_hash: effect.payload_hash,
      });
      await this.broker.admit(
        await this.claims(effect.job_id, effect.connection_id),
        effect.id,
        effect.payload_hash,
      );
      effect = await this.broker.dispatch(effect.id);
    }
    await this
      .sql`update experience_undo set reversal_action_id = ${effect.id} where action_id = ${source.id}`;
    if (effect.status !== 'succeeded')
      return unavailable('The reversal could not be confirmed. It has not been repeated.');
    if (source.kind === 'email.draft')
      await this.sql`insert into experience_draft_send (draft_action_id, discarded_at)
      values (${source.id}, now()) on conflict (draft_action_id) do update set discarded_at = now()`;
    return { receipt: await this.receipt(spaceId, effect) };
  }

  async draft(spaceId: string, id: string) {
    const { action: source } = await this.source(spaceId, id);
    if (source.kind !== 'email.draft' || source.status !== 'succeeded') throw experienceMissing();
    const [sent] = await this
      .sql`select s.*, a.status from experience_draft_send s left join action a on a.id = s.send_action_id where draft_action_id = ${id}`;
    const preview = draftForReview(actionProjectionRow(source));
    if (!preview)
      return unavailable(
        'The full message cannot be shown safely. Prepare a new draft before sending.',
      );
    return {
      ...preview,
      status: sent?.discarded_at
        ? ('discarded' as const)
        : sent?.status === 'succeeded'
          ? ('sent' as const)
          : sent?.status === 'denied'
            ? ('denied' as const)
            : sent?.send_action_id
              ? ('awaiting_permission' as const)
              : ('draft' as const),
    };
  }

  async send(spaceId: string, id: string) {
    const { action: source } = await this.source(spaceId, id);
    const draft = await this.draft(spaceId, id);
    if ('reason' in draft) return draft;
    if (draft.status === 'discarded')
      throw new ServiceError('invalid_request', 'This draft was discarded.', 409);
    // Sending continues the request on record; after a refusal it starts a new one.
    const [recorded] = await this.sql`select s.send_action_id, a.status, j.experience_command_key
      from experience_draft_send s join action a on a.id = s.send_action_id join job j on j.id = a.job_id
      where s.draft_action_id = ${id}`;
    const retried = `${id}:send:`;
    const retry = !recorded
      ? undefined
      : recorded.status === 'denied'
        ? String(recorded.send_action_id)
        : String(recorded.experience_command_key).startsWith(retried)
          ? String(recorded.experience_command_key).slice(retried.length)
          : undefined;
    const effect = await this.execute(
      spaceId,
      source,
      'send',
      'email.send',
      source.canonical_payload,
      retry,
    );
    if ('reason' in effect) return effect;
    await this.sql`insert into experience_draft_send (draft_action_id, send_action_id)
      values (${id}, ${effect.id}) on conflict (draft_action_id) do update set send_action_id = excluded.send_action_id`;
    return { action: effect, draft: await this.draft(spaceId, id) };
  }

  async continueCommand(effect: Action) {
    const [row] = await this.sql`select kind from job where id = ${effect.job_id}`;
    if (row?.kind !== 'command') return;
    if (effect.status === 'approved') {
      await this.broker.admit(
        await this.claims(effect.job_id, effect.connection_id),
        effect.id,
        effect.payload_hash,
      );
      await this.broker.dispatch(effect.id);
    }
  }
}
