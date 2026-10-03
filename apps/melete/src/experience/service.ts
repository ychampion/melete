import { createHash } from 'node:crypto';
import {
  agentDeleted,
  agentResponse,
  agentTemplateList,
  type Conversation,
  type ConversationProgress,
  conversation,
  conversationCreate,
  conversationListQuery,
  conversationMessage,
  conversationRename,
  conversationTurn,
  decodeConversationCursor,
  encodeConversationCursor,
  freeAgentName,
  type SubmissionReceipt,
  sameAgentName,
  unavailable,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { messageFiles } from '../attachments/render.ts';
import { type AttachmentService, attachTurn } from '../attachments/store.ts';
import type { Database } from '../db/client.ts';
import {
  agent,
  connection,
  event,
  experienceTurn,
  job,
  planMilestone,
  space,
  trigger,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import { inConversation, withdrawPermissions } from '../jobs/withdraw.ts';
import { ownJob, requestPrincipal, spaceAuthority } from '../principals/authority.ts';
import { mentionedRoomAgent } from '../rooms/mentions.ts';
import { AGENT_TEMPLATES, agentValues, agentView, MELETE_AGENT, mentionedAgent } from './agents.ts';
import { answerStream } from './answer-filter.ts';
import type { ExperienceEvents } from './events.ts';
import type { ExperiencePermissions } from './permissions.ts';
import { answerText, plainText, type STOPPED_NOTE, SUPERSEDED_NOTE } from './projectors.ts';

/** Turn statuses of work not yet over: an agent is not deleted under one. */
const UNDER_WAY = ['queued', 'working', 'streaming', 'needs_you', 'paused'];
/** Turn statuses whose answer may still grow. */
const STILL_WRITING = new Set(['queued', 'working', 'streaming']);
export const experienceMissing = () => new ServiceError('not_found', 'That item is not here.', 404);
export function conversationView(
  row: JobRow,
  turn?: typeof experienceTurn.$inferSelect | null,
  progress?: ConversationProgress,
  automationId?: string,
): Conversation {
  const status = row.paused
    ? 'paused'
    : (turn?.status ?? (row.state === 'running' ? 'working' : 'idle'));
  return conversation.parse({
    id: row.id,
    title: plainText(row.title, 'Conversation'),
    agent_id: row.agentId,
    status,
    composer:
      status === 'paused'
        ? 'resume'
        : status === 'streaming'
          ? 'stop'
          : ['working', 'queued'].includes(status)
            ? 'pause'
            : 'send',
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    plan_id: row.planId,
    ...(progress ? { progress } : {}),
    ...(automationId ? { automation_id: automationId } : {}),
  });
}

/**
 * A new message in a conversation changes what was asked for, so every
 * permission still waiting in it is stale: the draft it would send was written
 * for the request before this one. Stopping the turn withdraws them the same
 * way: the person said to stop, so nothing the turn asked for goes ahead. Each
 * is decided as denied with the note that says why (`replaced` or `stopped`),
 * in the same transaction that accepts the message or stops the turn, so it can
 * never be allowed afterwards and nothing it covered is sent. That includes the
 * send of a reviewed draft, which runs as a command job under the conversation.
 */
export async function withdrawPendingPermissions(
  tx: Transaction,
  conversationId: string,
  note: typeof SUPERSEDED_NOTE | typeof STOPPED_NOTE,
) {
  await withdrawPermissions(tx, inConversation(conversationId), note);
}

export class ExperienceService {
  /** The conversation projector the routes mounted beside this service, for the rooms routes. */
  events?: ExperienceEvents;
  /** The permission cards and answers mounted beside this service, for the rooms routes. */
  permissions?: ExperiencePermissions;
  /** Where the files people send are kept, when the blob store is mounted beside this service. */
  attachments?: AttachmentService;
  constructor(
    readonly db: Database,
    readonly jobs?: JobService,
    readonly submissions?: SubmissionService,
    readonly runner?: AttemptRunner,
    /** Where a turn has got, when the event projection is mounted beside this service. */
    public progress?: (
      spaceId: string,
      jobId: string,
      turnId: string,
      stage: 'under_way' | 'waiting' | 'ended',
    ) => Promise<ConversationProgress>,
  ) {
    if (submissions) {
      const prior = submissions.onAccepted;
      submissions.onAccepted = async (tx, receipt, row, kind) => {
        await prior?.(tx, receipt, row, kind);
        if (row.kind !== 'chat' || kind !== 'input' || !row.agentId) return;
        const dedupKey = `${row.id}:input:${row.stateVersion}`;
        const [input] = await tx.select().from(event).where(eq(event.dedupKey, dedupKey));
        const text = (input?.payload as { text?: string })?.text;
        const files = messageFiles((input?.payload as { attachments?: unknown })?.attachments);
        if (text === undefined || (!text && !files.length))
          throw new Error('Accepted conversation message is missing.');
        // "@Scout find …" hands this one message to Scout; the chat keeps its agent.
        // In a shared space only its owner hands a message on this way: a
        // member's message stays with the chat's agent and its reach.
        const speaker = (input?.payload as { principal_id?: string | null })?.principal_id ?? null;
        const [place] = await tx
          .select({ kind: space.kind, owner: space.ownerPrincipalId })
          .from(space)
          .where(eq(space.id, row.spaceId));
        // A room's request is the room's: whoever asked it hands a message to
        // any agent the room can use, which reaches only what the room marks.
        const room = row.audience === 'room';
        const mayHandOn =
          room || place?.kind !== 'shared' || (speaker !== null && speaker === place.owner);
        const usable = mayHandOn
          ? await tx
              .select({ id: agent.id, name: agent.name, isDefault: agent.isDefault })
              .from(agent)
              .where(and(eq(agent.spaceId, row.spaceId), isNull(agent.deletedAt)))
          : [];
        const mentioned = !mayHandOn
          ? null
          : room
            ? mentionedRoomAgent(
                text,
                usable,
                usable.find((candidate) => candidate.isDefault) ?? null,
              )
            : mentionedAgent(text, usable);
        const agentId = mentioned?.id ?? row.agentId;
        const turnId = newId('turn');
        const author = requestPrincipal() ?? row.principalId;
        await tx.insert(experienceTurn).values({
          id: turnId,
          jobId: row.id,
          agentId,
          submissionId: receipt.submission_id,
          authorPrincipalId: author,
          text,
        });
        // The message records who it was said to, so memory follows that agent's permission.
        await tx
          .update(event)
          .set({ payload: { ...(input?.payload as object), agent_id: agentId } })
          .where(eq(event.dedupKey, dedupKey));
        await attachTurn(
          tx,
          row.id,
          files.map((file) => file.id),
          turnId,
        );
        await tx.update(job).set({ currentTurnId: turnId }).where(eq(job.id, row.id));
        // A new message replaces what its own author asked for. In a room only the
        // person who asked a request supersedes it; nobody else's words reach it.
        if (row.audience !== 'room' || author === row.requestedByPrincipalId)
          await withdrawPendingPermissions(tx, row.id, SUPERSEDED_NOTE);
      };
    }
  }

  /**
   * Melete, the agent every space has. A space made after the migration that
   * added it gets it the first time anything asks; the unique index on the
   * space keeps two callers from making two.
   */
  async defaultAgent(spaceId: string) {
    const shared = await this.sharedSpace(spaceId);
    const find = () =>
      this.db
        .select()
        .from(agent)
        .where(and(eq(agent.spaceId, spaceId), eq(agent.isDefault, true)));
    const [found] = await find();
    if (found) return found;
    await this.db
      .insert(agent)
      .values({
        id: newId('agent'),
        spaceId,
        // In a shared space Melete reaches nothing until the owner chooses.
        ...agentValues(
          shared ? { ...MELETE_AGENT, allowed_connection_ids: [] } : MELETE_AGENT,
          true,
          !shared,
        ),
        isDefault: true,
      })
      .onConflictDoNothing();
    const [made] = await find();
    if (!made) throw experienceMissing();
    return made;
  }

  /** Whether a space is shared, where Melete's reach is the owner's to choose. */
  async sharedSpace(spaceId: string) {
    const [row] = await this.db
      .select({ kind: space.kind })
      .from(space)
      .where(eq(space.id, spaceId));
    return row?.kind === 'shared';
  }

  /** The agent named, or Melete when none was. */
  async agentOrDefault(spaceId: string, id: string | undefined) {
    return id ? this.requireAgent(spaceId, id) : this.defaultAgent(spaceId);
  }

  /** An agent of this space that has not been deleted. */
  async requireAgent(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(agent)
      .where(and(eq(agent.id, id), eq(agent.spaceId, spaceId), isNull(agent.deletedAt)));
    if (!row) throw experienceMissing();
    return row;
  }

  async agents(spaceId: string) {
    await this.defaultAgent(spaceId);
    const shared = await this.sharedSpace(spaceId);
    const rows = await this.db
      .select()
      .from(agent)
      .where(eq(agent.spaceId, spaceId))
      .orderBy(desc(agent.isDefault), agent.createdAt, agent.id);
    const stats = await this.db
      .select({
        agentId: job.agentId,
        count: sql<number>`count(*)::int`,
        last: sql<string | null>`max(${job.updatedAt})`,
      })
      .from(job)
      .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'chat'), ownJob()))
      .groupBy(job.agentId);
    // Routines run as an agent, counted as the Automations screen lists them.
    const routines = await this.db
      .select({ agentId: job.agentId, count: sql<number>`count(*)::int` })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'routine'),
          eq(trigger.kind, 'schedule'),
          ownJob(),
        ),
      )
      .groupBy(job.agentId);
    const view = (row: (typeof rows)[number]) => {
      const use = stats.find((item) => item.agentId === row.id);
      const runs = routines.find((item) => item.agentId === row.id)?.count ?? 0;
      return agentView(row, use?.count ?? 0, use?.last ? new Date(use.last) : null, shared, runs);
    };
    return {
      agents: rows.filter((row) => !row.deletedAt).map(view),
      removed: rows.filter((row) => row.deletedAt).map(view),
    };
  }

  /** Only the space's owner makes, changes or deletes its agents. */
  private async requireAgentOwner(spaceId: string) {
    const authority = await spaceAuthority(this.db, spaceId, requestPrincipal());
    if (authority.role !== 'owner')
      throw new ServiceError('scope_denied', 'Only the space’s owner changes its agents.', 403);
    return authority;
  }

  /**
   * Locks the space's agents for a change that depends on all of them: a name
   * check, or a deletion. Melete's row is always there, so it is the lock.
   */
  private async lockAgents(tx: Transaction, spaceId: string) {
    const [melete] = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.spaceId, spaceId), eq(agent.isDefault, true)))
      .for('update');
    if (!melete) throw experienceMissing();
    return melete;
  }

  /** The templates, each with a name no agent in the space has yet. */
  async agentTemplates(spaceId: string) {
    const taken = (
      await this.db
        .select({ name: agent.name })
        .from(agent)
        .where(and(eq(agent.spaceId, spaceId), isNull(agent.deletedAt)))
    ).map((row) => row.name);
    return agentTemplateList.parse({
      templates: AGENT_TEMPLATES.templates.map((template) => ({
        ...template,
        agent: { ...template.agent, name: freeAgentName(template.agent.name, taken) },
      })),
    });
  }

  async saveAgent(spaceId: string, raw: unknown, id?: string) {
    // Agents belong to the space: in a shared space only its owner makes or changes one.
    const authority = await this.requireAgentOwner(spaceId);
    const shared = authority.space.kind === 'shared';
    const existing = id ? await this.requireAgent(spaceId, id) : null;
    const isDefault = existing?.isDefault === true;
    const values = agentValues(raw, isDefault, isDefault && !shared);
    const chosen = values.allowedConnectionIds ?? [];
    const found = chosen.length
      ? await this.db
          .select({ id: connection.id })
          .from(connection)
          .where(and(eq(connection.spaceId, spaceId), inArray(connection.id, chosen)))
      : [];
    if (new Set(chosen).size !== found.length)
      throw new ServiceError('invalid_request', 'Choose connections from this space.', 400);
    await this.defaultAgent(spaceId);
    const row = await this.db.transaction(async (tx) => {
      await this.lockAgents(tx, spaceId);
      // "@name" picks one agent, so two in a space never share a name. An
      // agent saved under the name it already has is left alone.
      if (!existing || !sameAgentName(existing.name, values.name)) {
        const taken = (
          await tx
            .select({ id: agent.id, name: agent.name })
            .from(agent)
            .where(and(eq(agent.spaceId, spaceId), isNull(agent.deletedAt)))
        )
          .filter((other) => other.id !== id)
          .map((other) => other.name);
        if (taken.some((name) => sameAgentName(name, values.name)))
          throw new ServiceError(
            'name_taken',
            `You already have an agent called ${values.name.trim()}. Try ${freeAgentName(values.name, taken)}.`,
            409,
          );
      }
      const [saved] = id
        ? await tx
            .update(agent)
            .set(values)
            .where(and(eq(agent.id, id), eq(agent.spaceId, spaceId)))
            .returning()
        : await tx
            .insert(agent)
            .values({ id: newId('agent'), spaceId, ...values })
            .returning();
      return saved;
    });
    if (!row) throw experienceMissing();
    return agentResponse.parse({ agent: agentView(row, 0, null, shared) });
  }

  /**
   * Delete an agent other than Melete. Its chats (everyone's, in a shared
   * space), routines and plan steps move to Melete. The agent itself is only
   * marked deleted, so the turns it answered keep its name. In a personal
   * space Melete reaches everything, more than a narrow agent did, so its
   * routines are paused until the person turns them back on. Refused while any
   * of its work is running, so nothing changes hands mid-step.
   */
  async deleteAgent(spaceId: string, id: string) {
    const authority = await this.requireAgentOwner(spaceId);
    const target = await this.requireAgent(spaceId, id);
    if (target.isDefault)
      throw new ServiceError('default_agent_fixed', 'Melete is always here.', 400);
    await this.defaultAgent(spaceId);
    return this.db.transaction(async (tx) => {
      const melete = await this.lockAgents(tx, spaceId);
      const busy = new ServiceError(
        'agent_busy',
        `${target.name} is in the middle of something. Try again when it finishes.`,
        409,
      );
      // A turn of its still current: an older one a later message replaced
      // may keep the status it had then.
      const [turn] = await tx
        .select({ id: experienceTurn.id })
        .from(experienceTurn)
        .innerJoin(
          job,
          and(eq(job.id, experienceTurn.jobId), eq(job.currentTurnId, experienceTurn.id)),
        )
        .where(
          and(
            eq(experienceTurn.agentId, id),
            eq(job.spaceId, spaceId),
            inArray(experienceTurn.status, UNDER_WAY),
          ),
        )
        .limit(1);
      if (turn) throw busy;
      // Any attempt still running for work it is bound to: a plan step, a
      // routine run, a job with no turn at all.
      const running = await tx.execute(sql`select 1 from attempt a
        join job j on j.id = a.job_id
        left join experience_turn t on t.id = j.current_turn_id
        where j.space_id = ${spaceId} and a.ended_at is null
          and (j.agent_id = ${id} or t.agent_id = ${id})
        limit 1`);
      if (running.length) throw busy;
      // A private agent's chats are kept off models that leave this machine.
      // Moved to Melete they would not be, so its chats go first.
      const privately = await tx.execute(sql`select 1 from privacy_settings
        where space_id = ${spaceId} and jsonb_exists(settings->'private_agent_ids', ${id})`);
      const [chats] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(job)
        .where(and(eq(job.agentId, id), eq(job.spaceId, spaceId)));
      if (privately.length && Number(chats?.n ?? 0) > 0)
        throw new ServiceError(
          'agent_private',
          `${target.name} keeps its chats private. Delete them, or turn off private for ${target.name} in Settings, Privacy, first.`,
          409,
        );
      const moved = await tx
        .update(job)
        .set({ agentId: melete.id })
        .where(and(eq(job.agentId, id), eq(job.spaceId, spaceId)))
        .returning({ id: job.id, kind: job.kind });
      await tx
        .update(planMilestone)
        .set({ agentId: melete.id })
        .where(eq(planMilestone.agentId, id));
      // Paused the way the person pauses one: a resumed routine waits for its
      // next time rather than catching up.
      const routines = moved.filter((row) => row.kind === 'routine').map((row) => row.id);
      const paused =
        authority.space.kind === 'shared' || !routines.length
          ? []
          : await tx
              .update(trigger)
              .set({
                enabled: false,
                cursor: sql`(select coalesce(max(${event.seq}), 0)::text from ${event})`,
              })
              .where(
                and(
                  inArray(trigger.jobId, routines),
                  eq(trigger.kind, 'schedule'),
                  eq(trigger.enabled, true),
                ),
              )
              .returning({ jobId: trigger.jobId });
      await tx
        .update(agent)
        .set({ deletedAt: new Date() })
        .where(and(eq(agent.id, id), eq(agent.spaceId, spaceId), eq(agent.isDefault, false)));
      return agentDeleted.parse({
        id,
        moved_to: melete.id,
        conversations: moved.filter((row) => row.kind === 'chat').length,
        routines: routines.length,
        routines_paused: new Set(paused.map((row) => row.jobId)).size,
      });
    });
  }

  /** A conversation is a job: it exists only for the principal who owns it. */
  async requireConversation(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(job)
      .where(and(eq(job.id, id), eq(job.spaceId, spaceId), eq(job.kind, 'chat'), ownJob()));
    if (!row) throw experienceMissing();
    return row;
  }

  /**
   * A thread the person can read: one of their chats, or the thread one of
   * their routines writes each run into.
   */
  async requireThread(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(job)
      .where(
        and(
          eq(job.id, id),
          eq(job.spaceId, spaceId),
          inArray(job.kind, ['chat', 'routine']),
          ownJob(),
        ),
      );
    if (!row) throw experienceMissing();
    return row;
  }

  async view(row: JobRow) {
    const [turn] = row.currentTurnId
      ? await this.db
          .select()
          .from(experienceTurn)
          .where(and(eq(experienceTurn.id, row.currentTurnId), eq(experienceTurn.jobId, row.id)))
      : [];
    // A turn under way, or one that finished within the day, reports its steps.
    const stage = !turn
      ? 'ended'
      : ['queued', 'working', 'streaming', 'paused'].includes(turn.status)
        ? 'under_way'
        : turn.status === 'needs_you'
          ? 'waiting'
          : 'ended';
    const recent =
      turn && (stage !== 'ended' || Date.now() - row.updatedAt.getTime() < 24 * 60 * 60 * 1000);
    const progress =
      recent && this.progress
        ? await this.progress(row.spaceId, row.id, turn.id, stage)
        : undefined;
    const [schedule] =
      row.kind === 'routine'
        ? await this.db
            .select({ id: trigger.id })
            .from(trigger)
            .where(and(eq(trigger.jobId, row.id), eq(trigger.kind, 'schedule')))
            .limit(1)
        : [];
    return conversationView(
      row,
      turn,
      progress && (progress.steps_done > 0 || progress.current) ? progress : undefined,
      schedule?.id,
    );
  }

  /** The caller's chats, most recently active first, a page at a time. */
  async conversations(spaceId: string, raw: unknown = {}) {
    const query = conversationListQuery.parse(raw);
    const after = query.cursor ? decodeConversationCursor(query.cursor) : null;
    if (query.cursor && !after)
      throw new ServiceError('invalid_cursor', 'Start the list again from the top.', 400);
    // Compared to the millisecond, the precision the cursor carries, with the id
    // breaking ties, so no chat is skipped or shown twice across pages.
    const activity = sql`date_trunc('milliseconds', ${job.updatedAt})`;
    const rows = await this.db
      .select()
      .from(job)
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'chat'),
          ownJob(),
          after
            ? sql`(${activity}, ${job.id}) < (${after.updated_at}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(desc(activity), desc(job.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const result: Conversation[] = [];
    for (const row of page) result.push(await this.view(row));
    const last = page.at(-1);
    return {
      conversations: result,
      next_cursor:
        rows.length > query.limit && last
          ? encodeConversationCursor({ updated_at: last.updatedAt.toISOString(), id: last.id })
          : null,
    };
  }

  async createConversation(spaceId: string, raw: unknown) {
    const value = conversationCreate.parse(raw);
    const chosen = await this.agentOrDefault(spaceId, value.agent_id);
    if (!this.jobs) return unavailable('Conversations are not ready yet.');
    let context = '';
    if (value.plan_id) {
      const [plan] = await this.db
        .select()
        .from(job)
        .where(
          and(eq(job.id, value.plan_id), eq(job.spaceId, spaceId), eq(job.kind, 'plan'), ownJob()),
        );
      if (!plan) throw experienceMissing();
      context = `\nPlan: ${plan.title}\n${plan.objective}`;
    }
    const jobs = this.jobs;
    const row = await jobs.transaction((tx) =>
      jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: value.title, objective: `${value.title}${context}` },
        { kind: 'chat', agentId: chosen.id, planId: value.plan_id },
        // Started from a plan, the objective carries that plan's text as well.
        value.plan_id ? 'derived' : 'owner_request',
      ),
    );
    return { conversation: await this.view(row) };
  }

  /** A new title. When the chat was last active does not change, so it keeps its place in the list. */
  async rename(spaceId: string, id: string, raw: unknown) {
    const { title } = conversationRename.parse(raw);
    const row = await this.requireConversation(spaceId, id);
    await this.db.update(job).set({ title }).where(eq(job.id, id));
    return { conversation: await this.view({ ...row, title }) };
  }

  async switchAgent(spaceId: string, id: string, agentId: string) {
    await this.requireAgent(spaceId, agentId);
    const row = await this.requireConversation(spaceId, id);
    // An in-flight turn keeps the identity it started with. The next turn uses this selection.
    await this.db.update(job).set({ agentId, updatedAt: new Date() }).where(eq(job.id, id));
    return { conversation: await this.view({ ...row, agentId }) };
  }

  async messages(spaceId: string, id: string) {
    await this.requireThread(spaceId, id);
    const rows = await this.db
      .select()
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, id))
      .orderBy(experienceTurn.createdAt, experienceTurn.id);
    const files = this.attachments ? await this.attachments.forTurns(id) : new Map();
    return {
      turns: rows.map((row) =>
        conversationTurn.parse({
          id: row.id,
          conversation_id: row.jobId,
          agent_id: row.agentId,
          text: row.text,
          // A turn still being written shows what its stream has shown so far, so
          // the pieces that follow join it without repeating a held word.
          answer: (STILL_WRITING.has(row.status)
            ? answerStream(row.answer)
            : answerText(row.answer)
          ).trimStart(),
          status: row.status,
          delivery: row.status === 'queued' ? 'sending' : null,
          created_at: row.createdAt.toISOString(),
          attachments: files.get(row.id) ?? [],
        }),
      ),
    };
  }

  async message(spaceId: string, id: string, raw: unknown, key?: string) {
    const thread = await this.requireThread(spaceId, id);
    if (thread.kind === 'routine')
      throw new ServiceError(
        'routine_thread',
        'This is where a routine writes its runs. Start a chat to ask about a result.',
        409,
      );
    const value = conversationMessage.parse(raw);
    if (!this.submissions) return unavailable('Conversations are not ready yet.');
    // Prefixing an opaque submission key prevents a collision with another space or API caller.
    const scopedKey = key
      ? `chat:${createHash('sha256').update(`${spaceId}:${id}:${key}`).digest('hex')}`
      : undefined;
    const result = await this.submissions.input(id, value, scopedKey);
    // A file the message named that it may not carry is said as itself.
    if (result.receipt.state !== 'accepted' && result.error?.code.startsWith('attachment'))
      throw new ServiceError(result.error.code, result.error.message, result.status);
    if (result.receipt.state !== 'accepted')
      throw new ServiceError(
        'message_not_accepted',
        'This message could not be accepted. Try again when the current turn finishes.',
        result.status === 400 ? 400 : 409,
      );
    return this.acceptance(result.receipt, id);
  }

  private async acceptance(receipt: SubmissionReceipt, jobId: string) {
    const [turn] = await this.db
      .select()
      .from(experienceTurn)
      .where(
        and(
          eq(experienceTurn.submissionId, receipt.submission_id),
          eq(experienceTurn.jobId, jobId),
        ),
      );
    if (!turn) throw new Error('Accepted turn not found.');
    return {
      turn_id: turn.id,
      receipt: {
        id: receipt.submission_id,
        status: 'accepted' as const,
        received_at: turn.createdAt.toISOString(),
      },
    };
  }

  async stop(spaceId: string, id: string) {
    const row = await this.requireConversation(spaceId, id);
    if (!this.jobs || !this.runner)
      return unavailable('Stopping is not connected to the running assistant yet.');
    if (!row.currentTurnId) return { conversation: await this.view(row) };
    await this.runner.stopConversation(id);
    return { conversation: await this.view(await this.requireConversation(spaceId, id)) };
  }

  async pause(spaceId: string, id: string, resume = false) {
    await this.requireConversation(spaceId, id);
    if (!this.runner) return unavailable('Pausing is not connected to the running assistant yet.');
    const result = await this.runner.pauseConversation(id, resume);
    if (result) return result;
    return { conversation: await this.view(await this.requireConversation(spaceId, id)) };
  }
}
