import {
  type ConversationProgress,
  conversationProgress,
  type ExperienceEvent,
  experienceEvent,
  MEMORY_TOOL_NOTICE,
  TOOL_TRACE_NOTICE,
  type ToolCall,
  type TrailStep,
  toolCall,
} from '@melete/contracts';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  action,
  approval,
  artifact,
  attempt,
  connection,
  event,
  experienceRule,
  job,
  question,
} from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { ownJob, requestPrincipal } from '../principals/authority.ts';
import {
  answerText,
  object,
  plainText,
  projectActionGroup,
  projectArtifact,
  projectCards,
  projectPermissionDecision,
  projectQuestionDecision,
  projectReceipt,
} from './projectors.ts';
import {
  actionCall,
  memoryCall,
  modelCall,
  retryCall,
  runtimeCall,
  toolId,
  traceCall,
} from './tools.ts';

type EventRow = typeof event.$inferSelect;
/** The trail already tells broker actions, grouped; the model itself and retries stay off it. */
const offTrail = (tool: ToolCall) =>
  tool.id.startsWith('action:') || tool.kind === 'model' || tool.kind === 'retry';

/**
 * The tool entries one raw event changes. Each is a whole copy of the entry as
 * of that event, built from the durable rows the event names, so projecting
 * late or twice tells the same story.
 */
async function toolCalls(
  tx: Transaction,
  source: EventRow,
  jobs: string[],
  spaceId: string,
): Promise<ToolCall[]> {
  const payload = object(source.payload);
  const effect = async (actionId: unknown) => {
    if (typeof actionId !== 'string') return undefined;
    const [row] = await tx
      .select({ action, connection })
      .from(action)
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(eq(action.id, actionId), inArray(action.jobId, jobs), eq(connection.spaceId, spaceId)),
      );
    return row;
  };
  if (source.type === 'action_requested' || source.type === 'action_status_changed') {
    const row = await effect(payload.action_id);
    if (!row) return [];
    const raw = source.type === 'action_requested' ? 'proposed' : String(payload.to ?? '');
    const [pending] =
      raw === 'needs_approval'
        ? await tx
            .select({ id: approval.id })
            .from(approval)
            .where(eq(approval.actionId, row.action.id))
            .orderBy(desc(approval.requestedAt))
            .limit(1)
        : [];
    return [actionCall({ ...row, raw, at: source.createdAt, approvalId: pending?.id })];
  }
  if (source.type === 'notice' && payload.phase === 'admission_rejected') {
    const row = await effect(payload.action_id);
    return row ? [actionCall({ ...row, raw: 'failed', at: source.createdAt })] : [];
  }
  if (source.type === 'notice' && payload.phase === 'repair_parked') {
    const row = await effect(payload.action_id);
    return row
      ? [
          retryCall(
            toolId('action', row.action.id),
            `${row.action.id}:${source.seq}`,
            source.createdAt,
          ),
        ]
      : [];
  }
  if (source.type === 'tool_call_proposed' && source.attemptId) {
    const call = runtimeCall({
      attemptId: source.attemptId,
      callId: String(payload.call_id ?? ''),
      tool: String(payload.tool ?? ''),
      arguments: payload.arguments,
      proposedAt: source.createdAt,
    });
    return call ? [call] : [];
  }
  if (source.type === 'tool_result' && source.attemptId && typeof payload.call_id === 'string') {
    const [proposal] = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.attemptId, source.attemptId),
          eq(event.type, 'tool_call_proposed'),
          sql`${event.payload}->>'call_id' = ${payload.call_id}`,
        ),
      )
      .orderBy(asc(event.seq))
      .limit(1);
    if (!proposal) return [];
    const proposed = object(proposal.payload);
    const call = runtimeCall({
      attemptId: source.attemptId,
      callId: payload.call_id,
      tool: String(proposed.tool ?? ''),
      arguments: proposed.arguments,
      proposedAt: proposal.createdAt,
      result: { ok: payload.ok === true, at: source.createdAt },
    });
    return call ? [call] : [];
  }
  if (source.type === 'notice' && payload.phase === 'model_request')
    return typeof payload.reservation_id === 'string'
      ? [modelCall({ reservationId: payload.reservation_id, requestedAt: source.createdAt })]
      : [];
  if (source.type === 'notice' && payload.phase === 'model_receipt') {
    if (typeof payload.reservation_id !== 'string' || !source.jobId) return [];
    const [request] = await tx
      .select({ createdAt: event.createdAt })
      .from(event)
      .where(
        and(
          eq(event.jobId, source.jobId),
          sql`${event.payload}->>'phase' = 'model_request'`,
          sql`${event.payload}->>'reservation_id' = ${payload.reservation_id}`,
        ),
      )
      .limit(1);
    return [
      modelCall({
        reservationId: payload.reservation_id,
        requestedAt: request?.createdAt ?? source.createdAt,
        receipt: { status: payload.status, latencyMs: payload.latency_ms, at: source.createdAt },
      }),
    ];
  }
  if (source.type === 'notice' && payload.kind === TOOL_TRACE_NOTICE) {
    const call = traceCall(payload.call);
    return call ? [call] : [];
  }
  if (source.type === 'notice' && payload.kind === MEMORY_TOOL_NOTICE) {
    const call = memoryCall(payload);
    return call ? [call] : [];
  }
  return [];
}

/** The copy of a tool entry this conversation last showed, as a live entry or a trail step. */
async function shownTool(tx: Transaction, jobId: string, id: string, item: 'tool' | 'action') {
  const [row] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        sql`${event.payload}->>'kind' = 'experience'`,
        sql`${event.payload}->'item'->>'type' = ${item}`,
        sql`${event.payload}->'item'->'tool'->>'id' = ${id}`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  const parsed = toolCall.safeParse(object(object(row?.payload).item).tool);
  return parsed.success ? parsed.data : undefined;
}

/** Projection has its own durable rows on the existing stream; reconnects never re-label history. */
export class ExperienceEvents {
  constructor(
    readonly db: Database,
    readonly projections?: {
      permission: (
        spaceId: string,
        id: string,
      ) => Promise<
        Extract<ExperienceEvent['item'], { type: 'permission' }>['permission'] | undefined
      >;
      question: (
        spaceId: string,
        id: string,
      ) => Promise<Extract<ExperienceEvent['item'], { type: 'question' }>['question'] | undefined>;
    },
  ) {}

  /**
   * The principal is an argument, not ambient state: a stream keeps polling
   * after the request that opened it has returned, and must keep its fence.
   */
  async sync(spaceId: string, jobId?: string, principalId = requestPrincipal()): Promise<void> {
    // Space-wide polling only revisits recent conversations; explicit requests can replay old history.
    const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ids = await this.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'chat'),
          jobId ? eq(job.id, jobId) : gt(job.updatedAt, recentSince),
          ownJob(job.principalId, principalId),
        ),
      );
    // Projection appends events, so it takes the event order first like every
    // other writer; otherwise a slow commit here lands behind a later sequence
    // number that a live stream has already read past.
    for (const { id } of ids)
      await serviceTransaction(this.db, async (tx) => {
        const [row] = await tx
          .select()
          .from(job)
          .where(and(eq(job.id, id), eq(job.spaceId, spaceId)))
          .for('update');
        if (!row) return;
        const linked = await tx
          .select({ id: job.id })
          .from(job)
          .where(and(eq(job.experienceParentId, id), eq(job.spaceId, spaceId)));
        const jobs = [id, ...linked.map((item) => item.id)];
        const raw = await tx
          .select()
          .from(event)
          .where(
            and(
              inArray(event.jobId, jobs),
              gt(event.seq, row.experienceCursor),
              sql`coalesce(${event.payload}->>'kind', '') <> 'experience'`,
            ),
          )
          .orderBy(asc(event.seq))
          .limit(1000);
        if (!raw.length) return;
        let group = [...row.experienceGroup];
        const emit = async (
          source: typeof event.$inferSelect,
          item: ExperienceEvent['item'],
          suffix: string = item.type,
        ) => {
          const [execution] = source.attemptId
            ? await tx
                .select({ turnId: attempt.turnId })
                .from(attempt)
                .where(eq(attempt.id, source.attemptId))
            : [];
          await appendEvent(tx, {
            jobId: id,
            attemptId: source.attemptId,
            type: 'notice',
            payload: {
              kind: 'experience',
              item,
              turn_id:
                execution?.turnId ??
                (typeof object(source.payload).turn_id === 'string'
                  ? String(object(source.payload).turn_id)
                  : row.currentTurnId),
              source_seq: source.seq,
              at: source.createdAt.toISOString(),
            },
            dedupKey: `experience:${source.seq}:${suffix}`,
          });
        };
        const flush = async (source: typeof event.$inferSelect) => {
          if (!group.length) return;
          const effects = await tx
            .select({ action, connection })
            .from(action)
            .innerJoin(connection, eq(connection.id, action.connectionId))
            .where(
              and(
                inArray(action.jobId, jobs),
                eq(connection.spaceId, spaceId),
                inArray(action.id, group),
              ),
            );
          const projected = projectActionGroup(effects);
          if (projected) await emit(source, projected, 'group');
          group = effects
            .filter(({ action }) => !['succeeded', 'failed', 'denied'].includes(action.status))
            .map(({ action }) => action.id);
        };
        for (const source of raw) {
          const payload = object(source.payload);
          for (const tool of await toolCalls(tx, source, jobs, spaceId)) {
            const shown = await shownTool(tx, id, tool.id, 'tool');
            if (JSON.stringify(shown) !== JSON.stringify(tool))
              await emit(source, { type: 'tool', tool }, `tool:${tool.id}`);
            // The trail keeps one finished step for each entry it does not already tell.
            if (
              ['done', 'failed', 'unknown'].includes(tool.status) &&
              !offTrail(tool) &&
              !(await shownTool(tx, id, tool.id, 'action'))
            )
              await emit(
                source,
                {
                  type: 'action',
                  label: tool.title,
                  meta: tool.output_summary?.text ?? '',
                  sources: [],
                  tool,
                },
                `trail:${tool.id}`,
              );
          }
          const boundary =
            source.type === 'turn_started' ||
            source.type === 'attempt_ended' ||
            source.type === 'text_delta' ||
            payload.kind === 'experience_say';
          if (boundary) await flush(source);
          if (
            source.type === 'action_requested' &&
            typeof payload.action_id === 'string' &&
            !group.includes(payload.action_id)
          )
            group.push(payload.action_id);
          if (payload.kind === 'experience_say') {
            const text = plainText(payload.text, '', 600);
            if (text) await emit(source, { type: 'say', text });
          } else if (
            source.type === 'approval_requested' &&
            typeof payload.approval_id === 'string'
          ) {
            const permission = await this.projections?.permission(spaceId, payload.approval_id);
            if (permission) await emit(source, { type: 'permission', permission });
          } else if (
            source.type === 'approval_decided' &&
            typeof payload.approval_id === 'string'
          ) {
            // "Always" is the approval that saved its standing rule in the same decision.
            const [rule] = await tx
              .select({ id: experienceRule.id })
              .from(experienceRule)
              .where(
                and(
                  eq(experienceRule.id, `rule_${payload.approval_id}`),
                  eq(experienceRule.spaceId, spaceId),
                ),
              );
            const decision = projectPermissionDecision({
              approvalId: payload.approval_id,
              decision: payload.decision,
              ruleSaved: Boolean(rule),
              note: payload.note,
              at: source.createdAt,
            });
            await emit(source, { type: 'decision', decision }, `decision:${decision.id}`);
          } else if (payload.kind === 'question_asked' && typeof payload.question_id === 'string') {
            const question = await this.projections?.question(spaceId, payload.question_id);
            if (question) await emit(source, { type: 'question', question });
          } else if (
            payload.kind === 'question_closed' &&
            typeof payload.question_id === 'string'
          ) {
            const [closed] = await tx
              .select({ id: question.id, state: question.state, answer: question.answer })
              .from(question)
              .where(and(eq(question.id, payload.question_id), inArray(question.jobId, jobs)));
            if (closed) {
              const decision = projectQuestionDecision({
                questionId: closed.id,
                state: closed.state,
                answer: closed.answer,
                at: source.createdAt,
              });
              await emit(source, { type: 'decision', decision }, `decision:${decision.id}`);
            }
          } else if (source.type === 'text_delta') {
            await emit(source, { type: 'text_delta', text: answerText(payload.text) });
          } else if (
            source.type === 'action_status_changed' &&
            payload.to === 'succeeded' &&
            typeof payload.action_id === 'string'
          ) {
            const [effect] = await tx
              .select({ action, connection })
              .from(action)
              .innerJoin(connection, eq(connection.id, action.connectionId))
              .where(
                and(
                  eq(action.id, payload.action_id),
                  inArray(action.jobId, jobs),
                  eq(connection.spaceId, spaceId),
                ),
              );
            if (effect) {
              const receipt = projectReceipt(effect.action, effect.connection);
              if (receipt) await emit(source, { type: 'receipt', receipt });
              // A card is projected once, when its draft is freshly prepared; its
              // later status reaches the person through the conversation's drafts.
              for (const card of projectCards(effect.action, effect.connection, 'draft'))
                await emit(source, { type: 'card', card }, `card:${card.id}`);
              if (source.jobId !== id) await flush(source);
            }
          } else if (source.type === 'attempt_ended') {
            const [execution] = source.attemptId
              ? await tx.select().from(attempt).where(eq(attempt.id, source.attemptId))
              : [];
            const outcome = object(payload.outcome);
            if (outcome.kind === 'completed' && payload.experience_completed !== false) {
              const effects = await tx
                .select({ action, connection })
                .from(action)
                .innerJoin(connection, eq(connection.id, action.connectionId))
                .where(
                  and(
                    eq(action.jobId, id),
                    source.attemptId ? eq(action.attemptId, source.attemptId) : undefined,
                    eq(connection.spaceId, spaceId),
                  ),
                );
              const done: Extract<TrailStep, { type: 'done' }> = {
                type: 'done',
                summary: plainText(outcome.summary, 'Finished this turn.'),
                elapsed_ms: Math.max(
                  0,
                  (execution?.endedAt ?? source.createdAt).getTime() -
                    (execution?.startedAt ?? source.createdAt).getTime(),
                ),
                apps: [
                  ...new Set(
                    projectActionGroup(effects)?.sources.map((source) => source.app) ?? [],
                  ),
                ],
                source_count: projectActionGroup(effects)?.sources.length ?? 0,
              };
              await emit(source, done);
              const files = await tx
                .select()
                .from(artifact)
                .where(and(eq(artifact.jobId, id), eq(artifact.spaceId, spaceId)));
              for (const file of files)
                await emit(
                  source,
                  { type: 'card', card: projectArtifact(file) },
                  `file:${file.id}`,
                );
            } else if (payload.experience_completed === false)
              await emit(source, { type: 'status', status: 'needs_you', composer: 'send' });
            else if (outcome.kind === 'failed')
              await emit(source, {
                type: 'note',
                text: 'I stopped before finishing. Your progress is saved.',
              });
          } else if (
            payload.kind === 'experience_stopped' ||
            payload.kind === 'experience_paused' ||
            payload.kind === 'experience_resumed'
          ) {
            await emit(source, {
              type: 'status',
              status:
                payload.kind === 'experience_stopped'
                  ? 'stopped'
                  : payload.kind === 'experience_paused'
                    ? 'paused'
                    : 'working',
              composer:
                payload.kind === 'experience_stopped'
                  ? 'send'
                  : payload.kind === 'experience_paused'
                    ? 'resume'
                    : 'pause',
            });
          } else if (source.type === 'notice' && payload.kind === 'gap') {
            await emit(source, {
              type: 'note',
              text: 'Part of the answer was interrupted. The saved progress is still here.',
            });
          }
        }
        await tx
          .update(job)
          .set({
            experienceCursor: raw.at(-1)?.seq ?? row.experienceCursor,
            experienceGroup: group,
          })
          .where(eq(job.id, id));
      });
  }

  /**
   * How far a conversation's current turn has got, told from its tool entries:
   * the steps that finished and the one under way. The model's own thinking
   * and retries are not steps; thinking can still be the step under way.
   */
  async progress(
    spaceId: string,
    jobId: string,
    turnId: string,
    stage: 'under_way' | 'waiting' | 'ended',
    principalId = requestPrincipal(),
  ): Promise<ConversationProgress> {
    await this.sync(spaceId, jobId, principalId);
    const rows = await this.db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.jobId, jobId),
          sql`${event.payload}->>'kind' = 'experience'`,
          sql`${event.payload}->>'turn_id' = ${turnId}`,
          sql`${event.payload}->'item'->>'type' = 'tool'`,
        ),
      )
      .orderBy(asc(event.seq));
    const latest = new Map<string, ToolCall>();
    for (const row of rows) {
      const parsed = toolCall.safeParse(object(object(row.payload).item).tool);
      if (!parsed.success) continue;
      // Re-inserting keeps the map in order of each entry's latest change.
      latest.delete(parsed.data.id);
      latest.set(parsed.data.id, parsed.data);
    }
    const calls = [...latest.values()];
    // While the turn runs, the latest running or waiting entry is the step under
    // way. While it waits on the person, only the entry asking for approval is.
    // Once it has ended nothing is under way, whatever was left running.
    const live =
      stage === 'under_way'
        ? ['running', 'needs_approval']
        : stage === 'waiting'
          ? ['needs_approval']
          : [];
    const current = [...calls].reverse().find((call) => live.includes(call.status));
    return conversationProgress.parse({
      steps_done: calls.filter(
        (call) =>
          !['model', 'retry'].includes(call.kind) &&
          ['done', 'failed', 'unknown'].includes(call.status),
      ).length,
      current: current?.title ?? null,
    });
  }

  async page(
    spaceId: string,
    after: number,
    jobId?: string,
    limit = 100,
    principalId = requestPrincipal(),
  ) {
    await this.sync(spaceId, jobId, principalId);
    const rows = await this.db
      .select({ event })
      .from(event)
      .innerJoin(job, eq(job.id, event.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          gt(event.seq, after),
          jobId ? eq(job.id, jobId) : undefined,
          ownJob(job.principalId, principalId),
          sql`${event.payload}->>'kind' = 'experience'`,
        ),
      )
      .orderBy(asc(event.seq))
      .limit(limit + 1);
    const events = rows.slice(0, limit).map(({ event: row }) => {
      const payload = object(row.payload);
      return experienceEvent.parse({
        seq: row.seq,
        conversation_id: row.jobId,
        turn_id: payload.turn_id ?? null,
        created_at: payload.at ?? row.createdAt.toISOString(),
        item: payload.item,
      });
    });
    return { events, next_cursor: events.at(-1)?.seq ?? after, has_more: rows.length > limit };
  }

  async response(
    spaceId: string,
    after: number,
    signal: AbortSignal,
    jobId?: string,
    principalId = requestPrincipal(),
  ): Promise<Response> {
    const initial = await this.page(spaceId, after, jobId, 100, principalId);
    let cursor = after;
    let buffered = initial.events;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const encoder = new TextEncoder();
    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wake?.();
      signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    const self = this;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (!closed) {
            if (buffered.length) {
              const next = buffered.shift();
              if (!next) continue;
              cursor = next.seq;
              controller.enqueue(
                encoder.encode(
                  `id: ${next.seq}\nevent: ${next.item.type}\ndata: ${JSON.stringify(next)}\n\n`,
                ),
              );
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, 1000);
            });
            wake = undefined;
            if (closed) break;
            const page = await self.page(spaceId, cursor, jobId, 100, principalId);
            buffered = page.events;
            if (!buffered.length) {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
              return;
            }
          }
          controller.close();
        },
        cancel: close,
      },
      { highWaterMark: 1 },
    );
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }
}
