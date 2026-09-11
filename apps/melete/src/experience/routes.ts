import { experienceOperations, experienceResult, unavailable } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { readEventCursor } from '../api/events.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, connection, experienceDraftSend } from '../db/schema.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobService } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import { AGENT_TEMPLATES } from './agents.ts';
import { ExperienceEvents } from './events.ts';
import {
  object,
  plainText,
  projectArtifact,
  projectCards,
  projectReceipt,
  recipientText,
} from './projectors.ts';
import { ExperienceService } from './service.ts';

export type ExperienceDeps = {
  db: Database;
  jobs?: JobService;
  submissions?: SubmissionService;
  runner?: AttemptRunner;
};
export function mountExperience(app: Hono, deps: ExperienceDeps): ExperienceService {
  const service = new ExperienceService(deps.db, deps.jobs, deps.submissions, deps.runner);
  const events = new ExperienceEvents(deps.db);
  const effects = async (spaceId: string, id: string) => {
    await service.requireConversation(spaceId, id);
    return deps.db
      .select({ action, connection })
      .from(action)
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(and(eq(action.jobId, id), eq(connection.spaceId, spaceId)))
      .orderBy(action.createdAt, action.id);
  };
  const handlers: Record<
    string,
    (spaceId: string, c: Context, input: Record<string, unknown>) => Promise<unknown> | unknown
  > = {
    'GET /conversations/{id}/events': async (spaceId, c) => {
      const id = c.req.param('id') ?? '';
      await service.requireConversation(spaceId, id);
      const since = readEventCursor(c.req.header('Last-Event-ID'), c.req.query('since'));
      return c.req.header('Accept')?.includes('text/event-stream')
        ? events.response(spaceId, since, c.req.raw.signal, id)
        : events.page(spaceId, since, id, Number(c.req.query('limit') ?? 100));
    },
    'GET /conversations/{id}/cards': async (spaceId, c) => {
      const id = c.req.param('id') ?? '';
      const rows = await effects(spaceId, id);
      const artifacts = await deps.db
        .select()
        .from(artifact)
        .where(and(eq(artifact.spaceId, spaceId), eq(artifact.jobId, id)));
      return {
        cards: [
          ...rows.flatMap(({ action, connection }) => projectCards(action, connection)),
          ...artifacts.map(projectArtifact),
        ],
      };
    },
    'GET /conversations/{id}/receipts': async (spaceId, c) => ({
      receipts: (await effects(spaceId, c.req.param('id') ?? '')).flatMap(
        ({ action, connection }) => {
          const receipt = projectReceipt(action, connection);
          return receipt ? [receipt] : [];
        },
      ),
    }),
    'GET /conversations/{id}/drafts': async (spaceId, c) => {
      const rows = await effects(spaceId, c.req.param('id') ?? '');
      const drafts = [];
      for (const { action } of rows.filter(
        ({ action }) => action.kind === 'email.draft' && action.status === 'succeeded',
      )) {
        const [send] = await deps.db
          .select()
          .from(experienceDraftSend)
          .where(eq(experienceDraftSend.draftActionId, action.id));
        const payload = object(action.canonicalPayload);
        drafts.push({
          id: action.id,
          recipient: recipientText(payload),
          channel: 'email',
          body: plainText(payload.body, ''),
          subject: plainText(payload.subject, 'Draft'),
          connection_id: action.connectionId,
          status: send?.discardedAt
            ? 'discarded'
            : send?.sendActionId
              ? 'awaiting_permission'
              : 'draft',
        });
      }
      return { drafts };
    },
    'GET /agents': (spaceId) => service.agents(spaceId),
    'GET /agents/templates': () => AGENT_TEMPLATES,
    'POST /agents': (spaceId, _c, input) => service.saveAgent(spaceId, input),
    'PATCH /agents/{id}': (spaceId, c, input) =>
      service.saveAgent(spaceId, input, c.req.param('id') ?? ''),
    'GET /conversations': (spaceId) => service.conversations(spaceId),
    'POST /conversations': (spaceId, _c, input) => service.createConversation(spaceId, input),
    'GET /conversations/{id}': async (spaceId, c) => ({
      conversation: await service.view(
        await service.requireConversation(spaceId, c.req.param('id') ?? ''),
      ),
    }),
    'PATCH /conversations/{id}/agent': (spaceId, c, input) =>
      service.switchAgent(spaceId, c.req.param('id') ?? '', String(input.agent_id)),
    'GET /conversations/{id}/messages': (spaceId, c) =>
      service.messages(spaceId, c.req.param('id') ?? ''),
    'POST /conversations/{id}/messages': (spaceId, c, input) =>
      service.message(spaceId, c.req.param('id') ?? '', input, c.req.header('Idempotency-Key')),
    'POST /conversations/{id}/stop': (spaceId, c) => service.stop(spaceId, c.req.param('id') ?? ''),
    'POST /conversations/{id}/pause': (spaceId, c) =>
      service.pause(spaceId, c.req.param('id') ?? ''),
    'POST /conversations/{id}/resume': (spaceId, c) =>
      service.pause(spaceId, c.req.param('id') ?? '', true),
  };
  for (const [key, operation] of Object.entries(experienceOperations)) {
    const [method, path] = key.split(' ') as [string, string];
    app.on(method, path.replace(/\{([^}]+)\}/g, ':$1'), async (c) => {
      const spaceId = c.get('experienceSpaceId');
      if (!spaceId) throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
      const input = 'request' in operation ? operation.request.parse(await c.req.json()) : {};
      if ('query' in operation) operation.query.parse(c.req.query());
      const handler = handlers[key];
      const body = handler
        ? await handler(spaceId, c, input)
        : unavailable(
            path.includes('share')
              ? 'Sharing is not available yet.'
              : path.includes('browser')
                ? 'Browser tasks are not connected yet.'
                : path.includes('signin')
                  ? 'Use your password to sign in for now.'
                  : 'This feature is not connected yet.',
          );
      if (body instanceof Response) return body;
      return c.json(experienceResult(operation.response).parse(body));
    });
  }
  app.get('/events', async (c, next) => {
    if (c.req.query('view') !== 'experience') return next();
    const spaceId = c.get('experienceSpaceId');
    if (!spaceId) throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
    const since = readEventCursor(
      c.req.header('Last-Event-ID'),
      c.req.query('since') ?? c.req.query('after'),
    );
    return c.req.header('Accept')?.includes('text/event-stream')
      ? events.response(spaceId, since, c.req.raw.signal)
      : c.json(await events.page(spaceId, since));
  });
  return service;
}
