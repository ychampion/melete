import { createHash } from 'node:crypto';
import {
  agentResponse,
  type Conversation,
  conversation,
  conversationCreate,
  conversationMessage,
  conversationTurn,
  type SubmissionReceipt,
  unavailable,
} from '@melete/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { agent, connection, event, experienceTurn, job } from '../db/schema.ts';
import { newId } from '../ids.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import { agentValues, agentView } from './agents.ts';
import { answerText, plainText } from './projectors.ts';

export const experienceMissing = () => new ServiceError('not_found', 'That item is not here.', 404);
export function conversationView(
  row: JobRow,
  turn?: typeof experienceTurn.$inferSelect | null,
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
  });
}

export class ExperienceService {
  constructor(
    readonly db: Database,
    readonly jobs?: JobService,
    readonly submissions?: SubmissionService,
    readonly runner?: AttemptRunner,
  ) {
    if (submissions) {
      const prior = submissions.onAccepted;
      submissions.onAccepted = async (tx, receipt, row, kind) => {
        await prior?.(tx, receipt, row, kind);
        if (row.kind !== 'chat' || kind !== 'input' || !row.agentId) return;
        const [input] = await tx
          .select()
          .from(event)
          .where(eq(event.dedupKey, `${row.id}:input:${row.stateVersion}`));
        const text = (input?.payload as { text?: string })?.text;
        if (!text) throw new Error('Accepted conversation message is missing.');
        const turnId = newId('turn');
        await tx.insert(experienceTurn).values({
          id: turnId,
          jobId: row.id,
          agentId: row.agentId,
          submissionId: receipt.submission_id,
          text,
        });
        await tx.update(job).set({ currentTurnId: turnId }).where(eq(job.id, row.id));
      };
    }
  }

  async requireAgent(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(agent)
      .where(and(eq(agent.id, id), eq(agent.spaceId, spaceId)));
    if (!row) throw experienceMissing();
    return row;
  }

  async agents(spaceId: string) {
    const rows = await this.db
      .select()
      .from(agent)
      .where(eq(agent.spaceId, spaceId))
      .orderBy(agent.createdAt, agent.id);
    const stats = await this.db
      .select({
        agentId: job.agentId,
        count: sql<number>`count(*)::int`,
        last: sql<string | null>`max(${job.updatedAt})`,
      })
      .from(job)
      .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'chat')))
      .groupBy(job.agentId);
    return {
      agents: rows.map((row) => {
        const use = stats.find((item) => item.agentId === row.id);
        return agentView(row, use?.count ?? 0, use?.last ? new Date(use.last) : null);
      }),
    };
  }

  async saveAgent(spaceId: string, raw: unknown, id?: string) {
    const values = agentValues(raw);
    const found = values.allowedConnectionIds.length
      ? await this.db
          .select({ id: connection.id })
          .from(connection)
          .where(
            and(
              eq(connection.spaceId, spaceId),
              inArray(connection.id, values.allowedConnectionIds),
            ),
          )
      : [];
    if (new Set(values.allowedConnectionIds).size !== found.length)
      throw new ServiceError('invalid_request', 'Choose connections from this space.', 400);
    const [row] = id
      ? await this.db
          .update(agent)
          .set(values)
          .where(and(eq(agent.id, id), eq(agent.spaceId, spaceId)))
          .returning()
      : await this.db
          .insert(agent)
          .values({ id: newId('agent'), spaceId, ...values })
          .returning();
    if (!row) throw experienceMissing();
    return agentResponse.parse({ agent: agentView(row) });
  }

  async requireConversation(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(job)
      .where(and(eq(job.id, id), eq(job.spaceId, spaceId), eq(job.kind, 'chat')));
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
    return conversationView(row, turn);
  }

  async conversations(spaceId: string) {
    const rows = await this.db
      .select()
      .from(job)
      .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'chat')))
      .orderBy(desc(job.updatedAt))
      .limit(200);
    const result: Conversation[] = [];
    for (const row of rows) result.push(await this.view(row));
    return { conversations: result };
  }

  async createConversation(spaceId: string, raw: unknown) {
    const value = conversationCreate.parse(raw);
    await this.requireAgent(spaceId, value.agent_id);
    if (!this.jobs) return unavailable('Conversations are not ready yet.');
    let context = '';
    if (value.plan_id) {
      const [plan] = await this.db
        .select()
        .from(job)
        .where(and(eq(job.id, value.plan_id), eq(job.spaceId, spaceId), eq(job.kind, 'plan')));
      if (!plan) throw experienceMissing();
      context = `\nPlan: ${plan.title}\n${plan.objective}`;
    }
    const jobs = this.jobs;
    const row = await jobs.transaction((tx) =>
      jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: value.title, objective: `${value.title}${context}` },
        { kind: 'chat', agentId: value.agent_id, planId: value.plan_id },
      ),
    );
    return { conversation: await this.view(row) };
  }

  async switchAgent(spaceId: string, id: string, agentId: string) {
    await this.requireAgent(spaceId, agentId);
    const row = await this.requireConversation(spaceId, id);
    // An in-flight turn keeps the identity it started with. The next turn uses this selection.
    await this.db.update(job).set({ agentId, updatedAt: new Date() }).where(eq(job.id, id));
    return { conversation: await this.view({ ...row, agentId }) };
  }

  async messages(spaceId: string, id: string) {
    await this.requireConversation(spaceId, id);
    const rows = await this.db
      .select()
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, id))
      .orderBy(experienceTurn.createdAt, experienceTurn.id);
    return {
      turns: rows.map((row) =>
        conversationTurn.parse({
          id: row.id,
          conversation_id: row.jobId,
          agent_id: row.agentId,
          text: row.text,
          answer: answerText(row.answer),
          status: row.status,
          delivery: row.status === 'queued' ? 'sending' : null,
          created_at: row.createdAt.toISOString(),
        }),
      ),
    };
  }

  async message(spaceId: string, id: string, raw: unknown, key?: string) {
    await this.requireConversation(spaceId, id);
    const value = conversationMessage.parse(raw);
    if (!this.submissions) return unavailable('Conversations are not ready yet.');
    // Prefixing an opaque submission key prevents a collision with another space or API caller.
    const scopedKey = key
      ? `chat:${createHash('sha256').update(`${spaceId}:${id}:${key}`).digest('hex')}`
      : undefined;
    const result = await this.submissions.input(id, value, scopedKey);
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
