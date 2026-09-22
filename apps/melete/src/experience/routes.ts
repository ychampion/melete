import { experienceOperations, experienceResult, unavailable } from '@melete/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { readEventCursor } from '../api/events.ts';
import { BrokerFault } from '../broker/errors.ts';
import { loadAction } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, connection, experienceDraftSend } from '../db/schema.ts';
import type { QuestionService } from '../jobs/questions.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobService } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { MemoryError } from '../memory/db.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { ownJobClause } from '../principals/authority.ts';
import { AGENT_TEMPLATES } from './agents.ts';
import { ExperienceEffects } from './effects.ts';
import { ExperienceEvents } from './events.ts';
import { ExperienceHome } from './home.ts';
import { ExperienceMemory } from './memory.ts';
import { ExperiencePermissions } from './permissions.ts';
import { ExperiencePlanning } from './planning.ts';
import { draftForReview, projectArtifact, projectCards, projectReceipt } from './projectors.ts';
import { ExperienceQuestions } from './questions.ts';
import { ExperienceService } from './service.ts';

export type ExperienceDeps = {
  db: Database;
  jobs?: JobService;
  submissions?: SubmissionService;
  runner?: AttemptRunner;
  sql?: Sql;
  broker?: BrokerService;
  registry?: ConnectorRegistry;
  questions?: QuestionService;
  memoryJournal?: RestrictionJournal;
  triggers?: TriggerService;
};
/**
 * Rows these routes keep for the space as a whole rather than for one job: the
 * profile, tasks, saved rules, agents and connection reads. In a personal space
 * the caller is always the owner. In a shared space only its owner works with
 * them; a member keeps to conversations, plans and routines of their own.
 */
const SPACE_OWNER_SURFACES = new Set([
  'GET /profile',
  'PATCH /profile',
  'GET /home',
  'GET /tasks',
  'POST /tasks',
  'PATCH /tasks/{id}',
  'DELETE /tasks/{id}',
  'GET /experience/connections',
  'GET /rules',
  'DELETE /rules/{id}',
  'POST /agents',
  'PATCH /agents/{id}',
]);

export function mountExperience(app: Hono, deps: ExperienceDeps): ExperienceService {
  const service = new ExperienceService(deps.db, deps.jobs, deps.submissions, deps.runner);
  const questions = new ExperienceQuestions(deps.db, deps.questions, deps.sql);
  const memory = deps.sql ? new ExperienceMemory(deps.sql, deps.memoryJournal) : undefined;
  const ownerEffects =
    deps.sql && deps.broker && deps.registry
      ? new ExperienceEffects(deps.sql, deps.broker, deps.registry)
      : undefined;
  const permissions =
    deps.sql && deps.broker && ownerEffects
      ? new ExperiencePermissions(deps.sql, deps.broker, ownerEffects)
      : undefined;
  const home = new ExperienceHome(deps.db, ownerEffects);
  const planning = new ExperiencePlanning(service, deps.triggers);
  const events = new ExperienceEvents(deps.db, {
    permission: (spaceId, id) => permissions?.card(spaceId, id) ?? Promise.resolve(undefined),
    question: async (spaceId, id) =>
      (await questions.list(spaceId)).questions.find((item) => item.id === id),
  });
  service.progress = (spaceId, jobId, turnId, stage) =>
    events.progress(spaceId, jobId, turnId, stage);
  const effects = async (spaceId: string, id: string) => {
    await service.requireConversation(spaceId, id);
    const linked = deps.sql
      ? await deps.sql`select j.id from job j where j.experience_parent_id = ${id}
          and j.space_id = ${spaceId} ${ownJobClause(deps.sql, 'j')}`
      : [];
    return deps.db
      .select({ action, connection })
      .from(action)
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(
          inArray(action.jobId, [id, ...linked.map((row) => String(row.id))]),
          eq(connection.spaceId, spaceId),
        ),
      )
      .orderBy(action.createdAt, action.id);
  };
  const handlers: Record<
    string,
    (spaceId: string, c: Context, input: Record<string, unknown>) => Promise<unknown> | unknown
  > = {
    'GET /profile': (spaceId) => home.profile(spaceId),
    'PATCH /profile': (spaceId, _c, input) => home.saveProfile(spaceId, input),
    'GET /home': (spaceId) => home.home(spaceId),
    'GET /tasks': (spaceId) => home.tasks(spaceId),
    'POST /tasks': (spaceId, _c, input) => home.saveTask(spaceId, input),
    'PATCH /tasks/{id}': (spaceId, c, input) =>
      home.saveTask(spaceId, input, c.req.param('id') ?? ''),
    'DELETE /tasks/{id}': (spaceId, c) => home.deleteTask(spaceId, c.req.param('id') ?? ''),
    'GET /experience/connections': (spaceId) => home.connections(spaceId),
    'GET /search': (spaceId, c) =>
      home.search(spaceId, c.req.query('q') ?? '', c.get('sessionSpace')?.role !== 'member'),
    'GET /plans': (spaceId) => planning.plans(spaceId),
    'POST /plans': (spaceId, _c, input) => planning.create(spaceId, input),
    'GET /plans/{id}': async (spaceId, c) => ({
      plan: await planning.view(await planning.requirePlan(spaceId, c.req.param('id') ?? '')),
    }),
    'PATCH /plans/{id}/milestones/{milestoneId}': (spaceId, c, input) =>
      planning.complete(
        spaceId,
        c.req.param('id') ?? '',
        c.req.param('milestoneId') ?? '',
        Boolean(input.done),
      ),
    'POST /plans/{id}/conversation': (spaceId, c, input) =>
      planning.conversation(spaceId, c.req.param('id') ?? '', String(input.agent_id)),
    'GET /automations': (spaceId) => planning.automations(spaceId),
    'POST /automations': (spaceId, _c, input) => planning.createAutomation(spaceId, input),
    'POST /automations/{id}/test': (spaceId, c) =>
      planning.testAutomation(spaceId, c.req.param('id') ?? ''),
    'POST /automations/morning-brief': (spaceId, _c, input) =>
      planning.createAutomation(spaceId, {
        ...input,
        title: 'Your morning brief',
        instruction:
          'Summarize my upcoming events and open tasks for today. Ask before making changes.',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      }),
    'GET /quick-answers': (spaceId) => questions.list(spaceId),
    'POST /quick-answers/{id}': (spaceId, c, input) =>
      questions.answer(spaceId, c.req.param('id') ?? '', String(input.option_id)),
    'POST /memory/items': (spaceId, c, input) =>
      memory?.create(spaceId, c.get('owner').id, input) ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/items': (spaceId, c) =>
      memory?.list(spaceId, c.get('owner').id) ??
      unavailable('Your saved details are not connected yet.'),
    'PATCH /memory/items/{id}': (spaceId, c, input) =>
      memory?.edit(spaceId, c.get('owner').id, c.req.param('id') ?? '', input) ??
      unavailable('Your saved details are not connected yet.'),
    'DELETE /memory/items/{id}': (spaceId, c) =>
      memory?.forget(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/items/{id}/why': (spaceId, c) =>
      memory?.why(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/settings': (_spaceId, c) =>
      memory?.settings(c.get('owner').id) ??
      unavailable('Your saved details are not connected yet.'),
    'PUT /memory/settings': (_spaceId, c, input) =>
      memory?.saveSettings(c.get('owner').id, input) ??
      unavailable('Your saved details are not connected yet.'),
    'GET /permissions': (spaceId) =>
      permissions?.list(spaceId) ?? unavailable('Permissions are not connected yet.'),
    'POST /permissions/{id}': (spaceId, c, input) =>
      permissions?.decide(spaceId, c.req.param('id') ?? '', input) ??
      unavailable('Permissions are not connected yet.'),
    'GET /rules': (spaceId) =>
      permissions?.rules(spaceId) ?? unavailable('Rules are not connected yet.'),
    'DELETE /rules/{id}': (spaceId, c) =>
      permissions?.revoke(spaceId, c.req.param('id') ?? '') ??
      unavailable('Rules are not connected yet.'),
    'POST /drafts/{id}/send': (spaceId, c) =>
      permissions?.send(spaceId, c.req.param('id') ?? '') ??
      unavailable('Sending is not connected yet.'),
    'POST /receipts/{id}/undo': (spaceId, c) =>
      ownerEffects?.undo(spaceId, c.req.param('id') ?? '') ??
      unavailable('Undo is not connected yet.'),
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
    'GET /conversations/{id}/receipts': async (spaceId, c) => {
      const receipts = [];
      for (const { action, connection } of await effects(spaceId, c.req.param('id') ?? '')) {
        const receipt =
          ownerEffects && deps.sql
            ? await ownerEffects.receipt(spaceId, await loadAction(deps.sql, action.id))
            : projectReceipt(action, connection);
        if (receipt) receipts.push(receipt);
      }
      return { receipts };
    },
    'GET /conversations/{id}/drafts': async (spaceId, c) => {
      const rows = await effects(spaceId, c.req.param('id') ?? '');
      const drafts = [];
      for (const { action } of rows.filter(
        ({ action }) => action.kind === 'email.draft' && action.status === 'succeeded',
      )) {
        if (ownerEffects) {
          const draft = await ownerEffects.draft(spaceId, action.id);
          if ('reason' in draft) return draft;
          drafts.push(draft);
          continue;
        }
        const [send] = await deps.db
          .select()
          .from(experienceDraftSend)
          .where(eq(experienceDraftSend.draftActionId, action.id));
        const draft = draftForReview(action);
        if (!draft)
          return unavailable(
            'The full message cannot be shown safely. Prepare a new draft before sending.',
          );
        drafts.push({
          ...draft,
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
      const member = c.get('sessionSpace')?.role === 'member';
      const ownerOnly = () =>
        new ServiceError('scope_denied', 'Only the owner of this space can do that.', 403);
      if (member && SPACE_OWNER_SURFACES.has(key)) throw ownerOnly();
      const input = 'request' in operation ? operation.request.parse(await c.req.json()) : {};
      if ('query' in operation) operation.query.parse(c.req.query());
      // A standing rule changes what the whole space permits, not one job.
      if (
        member &&
        key === 'POST /permissions/{id}' &&
        (input as { option?: string }).option === 'always'
      )
        throw ownerOnly();
      const handler = handlers[key];
      let body: unknown;
      try {
        body = handler
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
      } catch (error) {
        if (error instanceof MemoryError)
          throw new ServiceError(
            'saved_detail_unavailable',
            'This detail is no longer available or has changed.',
            error.code.includes('not_found') ? 404 : 409,
          );
        if (!(error instanceof BrokerFault)) throw error;
        throw new ServiceError(
          'permission_changed',
          error.code === 'scope_denied'
            ? 'This agent no longer has access to that connection.'
            : 'This action needs to be reviewed again before it can continue.',
          error.code === 'scope_denied' ? 403 : 409,
        );
      }
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
