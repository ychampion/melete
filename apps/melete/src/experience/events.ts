import { type ExperienceEvent, experienceEvent, type TrailStep } from '@melete/contracts';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action, artifact, attempt, connection, event, job } from '../db/schema.ts';
import { appendEvent } from '../events/store.ts';
import {
  answerText,
  object,
  plainText,
  projectActionGroup,
  projectArtifact,
  projectCards,
  projectReceipt,
} from './projectors.ts';

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

  async sync(spaceId: string, jobId?: string): Promise<void> {
    const ids = await this.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(eq(job.spaceId, spaceId), eq(job.kind, 'chat'), jobId ? eq(job.id, jobId) : undefined),
      );
    for (const { id } of ids)
      await this.db.transaction(async (tx) => {
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
          } else if (payload.kind === 'question_asked' && typeof payload.question_id === 'string') {
            const question = await this.projections?.question(spaceId, payload.question_id);
            if (question) await emit(source, { type: 'question', question });
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
              for (const card of projectCards(effect.action, effect.connection))
                await emit(source, { type: 'card', card }, `card:${card.id}`);
              if (source.jobId !== id) await flush(source);
            }
          } else if (source.type === 'attempt_ended') {
            const [execution] = source.attemptId
              ? await tx.select().from(attempt).where(eq(attempt.id, source.attemptId))
              : [];
            const outcome = object(payload.outcome);
            if (outcome.kind === 'completed') {
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
                    effects
                      .map(
                        ({ connection }) =>
                          projectActionGroup(effects)?.sources.find(
                            (item) => item.connection_id === connection.id,
                          )?.app,
                      )
                      .filter((item): item is string => Boolean(item)),
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
            } else if (outcome.kind === 'failed')
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

  async page(spaceId: string, after: number, jobId?: string, limit = 100) {
    await this.sync(spaceId, jobId);
    const rows = await this.db
      .select({ event })
      .from(event)
      .innerJoin(job, eq(job.id, event.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          gt(event.seq, after),
          jobId ? eq(job.id, jobId) : undefined,
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
  ): Promise<Response> {
    const initial = await this.page(spaceId, after, jobId);
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
            const page = await self.page(spaceId, cursor, jobId);
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
