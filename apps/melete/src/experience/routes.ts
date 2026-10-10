import {
  COMPUTER_PROCESS_LIMIT,
  connectionWatching,
  type ExperienceDraft,
  experienceOperations,
  experienceResult,
  MORNING_BRIEF_TITLE,
  morningBriefCreate,
  morningBriefInstruction,
  runLimitRequest,
  unavailable,
} from '@melete/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { readEventCursor } from '../api/events.ts';
import type { AttachmentService } from '../attachments/store.ts';
import { BrokerFault } from '../broker/errors.ts';
import { loadAction } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { saveWebReadSetting, webReadSetting } from '../connectors/web.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, connection, experienceDraftSend } from '../db/schema.ts';
import type { QuestionService } from '../jobs/questions.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobService } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { personStarted } from '../jobs/wake-guard.ts';
import { mcpActorOf } from '../mcp-server/actor.ts';
import { actionBecause } from '../memory/basis.ts';
import { MemoryError } from '../memory/db.ts';
import type { RestrictionJournal } from '../memory/restore.ts';
import { ownJobClause } from '../principals/authority.ts';
import { ownsSessionSpace } from '../principals/session-space.ts';
import type { PrivacyRouter } from '../privacy/router.ts';
import { HandoffService } from '../rooms/handoffs.ts';
import type { RunService } from '../runs/service.ts';
import { setWatching } from '../signals/watching.ts';
import { listActivity } from './activity.ts';
import { ExperienceBeliefs } from './beliefs.ts';
import { type ComputerBinding, type ComputerProcessRow, projectComputer } from './computer.ts';
import { ExperienceEffects } from './effects.ts';
import { type EventChanges, ExperienceEvents } from './events.ts';
import { type ConnectionLiveness, ExperienceHome } from './home.ts';
import { listMembers, removeMember } from './members.ts';
import { ExperienceMemory } from './memory.ts';
import { ExperiencePermissions } from './permissions.ts';
import { ExperiencePlanning } from './planning.ts';
import {
  draftForReview,
  meantForPerson,
  projectArtifact,
  projectCards,
  projectReceipt,
} from './projectors.ts';
import { ExperienceQuestions } from './questions.ts';
import { memorySourcesOf, removeJobs } from './removal.ts';
import { ExperienceService } from './service.ts';
import type { WorkspaceTrash } from './workspace-trash.ts';

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
  /** Provisions a space's memory on its owner's first use. */
  memoryProvision?: (spaceId: string, principalId: string) => Promise<void>;
  triggers?: TriggerService;
  /** Commit notifications for live conversation streams. */
  changes?: EventChanges;
  /** A browser worker is configured, so a conversation's agent can have a browser. */
  browser?: boolean;
  /** Resolves privacy placeholders for the conversation's own stream. */
  privacy?: Pick<PrivacyRouter, 'resolvePayload'>;
  /** Long work in the background. */
  runs?: RunService;
  /** The files people send in chat. */
  attachments?: AttachmentService;
  /** Where conversations' workspaces are, so a deleted one's goes to its trash. */
  workspaces?: WorkspaceTrash;
  /** Whether an active connection's connector runs here; see connectorLiveness. */
  liveness?: ConnectionLiveness;
};
/**
 * Rows these routes keep for the space as a whole rather than for one job: the
 * profile, tasks, saved rules, agents and connection reads. In a personal space
 * the caller is always the owner. In a shared space only its owner works with
 * them; a member keeps to conversations, plans and routines of their own.
 */
const NOT_CONNECTED = 'Your saved details are not connected yet.';
const RUNS_UNAVAILABLE = 'Long work is not connected yet.';
const SPACE_OWNER_SURFACES = new Set([
  'GET /profile',
  'PATCH /profile',
  'GET /home',
  'GET /tasks',
  'POST /tasks',
  'PATCH /tasks/{id}',
  'DELETE /tasks/{id}',
  'GET /experience/connections',
  'PUT /experience/connections/{id}/watching',
  'GET /rules',
  'DELETE /rules/{id}',
  'GET /web/settings',
  'PUT /web/settings',
  'GET /approval-settings',
  'PUT /approval-settings',
  'POST /agents',
  'PATCH /agents/{id}',
  'DELETE /agents/{id}',
  'DELETE /space/members/{id}',
]);

export function mountExperience(app: Hono, deps: ExperienceDeps): ExperienceService {
  const service = new ExperienceService(deps.db, deps.jobs, deps.submissions, deps.runner);
  if (deps.attachments) service.attachments = deps.attachments;
  if (deps.workspaces) service.workspaces = deps.workspaces;
  const questions = new ExperienceQuestions(deps.db, deps.questions, deps.sql);
  const memory = deps.sql
    ? new ExperienceMemory(deps.sql, deps.memoryJournal, deps.memoryProvision)
    : undefined;
  const beliefs = memory ? new ExperienceBeliefs(memory) : undefined;
  const ownerEffects =
    deps.sql && deps.broker && deps.registry
      ? new ExperienceEffects(deps.sql, deps.broker, deps.registry)
      : undefined;
  const permissions =
    deps.sql && deps.broker && ownerEffects
      ? new ExperiencePermissions(deps.sql, deps.broker, ownerEffects)
      : undefined;
  const home = new ExperienceHome(deps.db, ownerEffects, deps.liveness);
  // Work rooms handed the person, shown on their Home and with their approvals.
  const handoffs = deps.jobs
    ? new HandoffService({ db: deps.db, jobs: deps.jobs, triggers: deps.triggers })
    : undefined;
  const planning = new ExperiencePlanning(service, deps.triggers);
  const events = new ExperienceEvents(
    deps.db,
    {
      permission: (spaceId, id) => permissions?.card(spaceId, id) ?? Promise.resolve(undefined),
      question: async (spaceId, id) =>
        (await questions.list(spaceId)).questions.find((item) => item.id === id),
      because: async (spaceId, actionId) =>
        deps.sql ? actionBecause(deps.sql, spaceId, actionId) : [],
      ...(ownerEffects
        ? {
            receiptState: (spaceId: string, actionId: string) =>
              ownerEffects.receiptState(spaceId, actionId),
          }
        : {}),
      rehydrate: deps.privacy
        ? async (jobId, attemptId, value) =>
            (await deps.privacy?.resolvePayload(jobId, attemptId, value))?.value ?? value
        : undefined,
    },
    deps.changes,
  );
  service.progress = (spaceId, jobId, turnId, stage) =>
    events.progress(spaceId, jobId, turnId, stage);
  service.events = events;
  service.permissions = permissions;
  /** The conversation's own job and the command jobs it started, all the caller's own. */
  const conversationJobs = async (spaceId: string, id: string) => {
    await service.requireThread(spaceId, id);
    const linked = deps.sql
      ? await deps.sql`select j.id from job j where j.experience_parent_id = ${id}
          and j.space_id = ${spaceId} ${ownJobClause(deps.sql, 'j')}`
      : [];
    return [id, ...linked.map((row) => String(row.id))];
  };
  const actionsOf = (spaceId: string, jobIds: string[]) =>
    deps.db
      .select({ action, connection })
      .from(action)
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(and(inArray(action.jobId, jobIds), eq(connection.spaceId, spaceId)))
      .orderBy(action.createdAt, action.id);
  const effects = async (spaceId: string, id: string) =>
    actionsOf(spaceId, await conversationJobs(spaceId, id));
  const handlers: Record<
    string,
    (spaceId: string, c: Context, input: Record<string, unknown>) => Promise<unknown> | unknown
  > = {
    'GET /profile': (spaceId) => home.profile(spaceId),
    'PATCH /profile': async (spaceId, _c, input) => {
      const { profile, moved } = await home.saveProfile(spaceId, input);
      // Routines keep their local hour when the person's time zone changes.
      if (moved) await planning.retimeSchedules(spaceId, moved);
      return { profile };
    },
    'GET /home': async (spaceId, c) => ({
      ...(await home.home(spaceId)),
      routine_results: await planning.recentResults(spaceId),
      ...(handoffs ? { handoffs: await handoffs.waiting(c.get('owner').id, spaceId) } : {}),
    }),
    'GET /tasks': (spaceId) => home.tasks(spaceId),
    'POST /tasks': (spaceId, _c, input) => home.saveTask(spaceId, input),
    'PATCH /tasks/{id}': (spaceId, c, input) =>
      home.saveTask(spaceId, input, c.req.param('id') ?? ''),
    'DELETE /tasks/{id}': (spaceId, c) => home.deleteTask(spaceId, c.req.param('id') ?? ''),
    'GET /runs': (spaceId, c) => {
      if (!deps.runs) return unavailable(RUNS_UNAVAILABLE);
      return deps.runs.list(spaceId, c.req.query('conversation_id') || undefined);
    },
    'POST /runs': async (spaceId, c, input) => {
      const runs = deps.runs;
      const jobs = deps.jobs;
      if (!runs || !jobs) return unavailable(RUNS_UNAVAILABLE);
      const agentId = typeof input.agent_id === 'string' ? input.agent_id : undefined;
      if (agentId) await service.requireAgent(spaceId, agentId);
      const row = await jobs.transaction(async (tx) => {
        const created = await runs.create(tx, spaceId, input, {
          agentId: agentId ?? null,
          typed: true,
        });
        // The person started it: its first shift is theirs, not background work.
        await personStarted(tx, created.id, (c.get('owner')?.id as string | undefined) ?? null);
        return created;
      });
      await runs.syncSchedules();
      return { run: await runs.view(row) };
    },
    'GET /runs/{id}': async (spaceId, c) => {
      if (!deps.runs) return unavailable(RUNS_UNAVAILABLE);
      return {
        run: await deps.runs.view(await deps.runs.requireRun(spaceId, c.req.param('id') ?? '')),
      };
    },
    'GET /runs/{id}/record': async (spaceId, c) => {
      if (!deps.runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await deps.runs.requireRun(spaceId, c.req.param('id') ?? '');
      return deps.runs.record(row, c.req.query('after'));
    },
    'GET /runs/{id}/export': async (spaceId, c) => {
      if (!deps.runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await deps.runs.requireRun(spaceId, c.req.param('id') ?? '');
      return { markdown: await deps.runs.markdown(row) };
    },
    'POST /runs/{id}/message': async (spaceId, c, input) => {
      const runs = deps.runs;
      if (!runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await runs.requireRun(spaceId, c.req.param('id') ?? '');
      await runs.message(row, String(input.text));
      return { run: await runs.view(await runs.requireRun(spaceId, row.id)) };
    },
    'POST /runs/{id}/pause': async (spaceId, c) => {
      const runs = deps.runs;
      if (!runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await runs.requireRun(spaceId, c.req.param('id') ?? '');
      await runs.setPaused(row, true);
      return { run: await runs.view(await runs.requireRun(spaceId, row.id)) };
    },
    'POST /runs/{id}/resume': async (spaceId, c) => {
      const runs = deps.runs;
      if (!runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await runs.requireRun(spaceId, c.req.param('id') ?? '');
      await runs.setPaused(row, false);
      return { run: await runs.view(await runs.requireRun(spaceId, row.id)) };
    },
    'POST /runs/{id}/stop': async (spaceId, c) => {
      const runs = deps.runs;
      if (!runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await runs.requireRun(spaceId, c.req.param('id') ?? '');
      await runs.stop(row);
      return { run: await runs.view(await runs.requireRun(spaceId, row.id)) };
    },
    'PUT /runs/{id}/limit': async (spaceId, c, input) => {
      const runs = deps.runs;
      if (!runs) return unavailable(RUNS_UNAVAILABLE);
      const row = await runs.requireRun(spaceId, c.req.param('id') ?? '');
      await runs.setLimit(row, runLimitRequest.parse(input));
      return { run: await runs.view(await runs.requireRun(spaceId, row.id)) };
    },
    'GET /experience/connections': (spaceId) => home.connections(spaceId),
    'PUT /experience/connections/{id}/watching': async (spaceId, c, input) => {
      if (!deps.sql) return unavailable('Watching accounts is not connected yet.');
      await setWatching(
        deps.sql,
        spaceId,
        c.req.param('id') ?? '',
        connectionWatching.parse(input).on,
      );
      return home.connections(spaceId);
    },
    'GET /activity': (spaceId, c) =>
      deps.sql
        ? listActivity(deps.sql, spaceId, c.get('owner').id)
        : unavailable('Activity is not connected yet.'),
    'POST /activity/{id}/undo': (spaceId, c) =>
      ownerEffects?.undoActivity(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Activity is not connected yet.'),
    'GET /space/members': (spaceId, c) =>
      deps.sql
        ? listMembers(deps.sql, spaceId, c.get('owner').id)
        : unavailable('People in this space are not connected yet.'),
    'DELETE /space/members/{id}': (spaceId, c) =>
      deps.jobs
        ? removeMember(deps.db, deps.jobs, spaceId, c.get('owner').id, c.req.param('id') ?? '')
        : unavailable('People in this space are not connected yet.'),
    'GET /search': (spaceId, c) =>
      home.search(spaceId, c.req.query('q') ?? '', ownsSessionSpace(c.get('sessionSpace'))),
    'GET /plans': (spaceId) => planning.plans(spaceId),
    'POST /plans': (spaceId, _c, input) => planning.create(spaceId, input),
    'GET /plans/{id}': async (spaceId, c) => ({
      plan: await planning.view(await planning.requirePlan(spaceId, c.req.param('id') ?? '')),
    }),
    'DELETE /plans/{id}': (spaceId, c) =>
      planning.remove(spaceId, c.req.param('id') ?? '', deps.sql),
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
    'POST /automations/{id}/pause': (spaceId, c) =>
      planning.setAutomationEnabled(spaceId, c.req.param('id') ?? '', false),
    'POST /automations/{id}/resume': (spaceId, c) =>
      planning.setAutomationEnabled(spaceId, c.req.param('id') ?? '', true),
    'POST /automations/{id}/restart': (spaceId, c) =>
      planning.restartAutomation(spaceId, c.req.param('id') ?? ''),
    'DELETE /automations/{id}': (spaceId, c) =>
      planning.deleteAutomation(spaceId, c.req.param('id') ?? '', deps.sql),
    'POST /automations/morning-brief': (spaceId, _c, input) => {
      const { topics, ...when } = morningBriefCreate.parse(input);
      return planning.createAutomation(spaceId, {
        ...when,
        title: MORNING_BRIEF_TITLE,
        instruction: morningBriefInstruction(topics),
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      });
    },
    'GET /quick-answers': (spaceId) => questions.list(spaceId),
    'POST /quick-answers/{id}': (spaceId, c, input) =>
      questions.answer(spaceId, c.req.param('id') ?? '', input),
    'POST /quick-answers/{id}/dismiss': (spaceId, c) =>
      questions.dismiss(spaceId, c.req.param('id') ?? ''),
    'POST /memory/items': (spaceId, c, input) => {
      // Another assistant saving through the MCP endpoint is recorded as that assistant.
      const assistant = mcpActorOf(c.env);
      return (
        memory?.create(
          spaceId,
          c.get('owner').id,
          input,
          assistant ? { assistantClientId: assistant.clientId } : undefined,
        ) ?? unavailable('Your saved details are not connected yet.')
      );
    },
    'GET /memory/items': (spaceId, c) =>
      memory?.list(spaceId, c.get('owner').id, c.req.query('after') ?? null, {
        forAssistant: mcpActorOf(c.env) !== undefined,
      }) ?? unavailable('Your saved details are not connected yet.'),
    'PATCH /memory/items/{id}': (spaceId, c, input) =>
      memory?.edit(spaceId, c.get('owner').id, c.req.param('id') ?? '', input) ??
      unavailable('Your saved details are not connected yet.'),
    'DELETE /memory/items/{id}': (spaceId, c) =>
      memory?.forget(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/items/{id}/why': (spaceId, c) =>
      memory?.why(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/notes': (spaceId, c) =>
      memory?.notes(spaceId, c.get('owner').id) ??
      unavailable('Your saved details are not connected yet.'),
    'DELETE /memory/notes/{id}': (spaceId, c) =>
      memory?.forgetNote(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable('Your saved details are not connected yet.'),
    'GET /memory/settings': (_spaceId, c) =>
      memory?.settings(c.get('owner').id) ??
      unavailable('Your saved details are not connected yet.'),
    'PUT /memory/settings': (_spaceId, c, input) =>
      memory?.saveSettings(c.get('owner').id, input) ??
      unavailable('Your saved details are not connected yet.'),
    'GET /web/settings': (spaceId) =>
      deps.sql
        ? webReadSetting(deps.sql, spaceId)
        : unavailable('Web reading is not connected yet.'),
    'PUT /web/settings': (spaceId, _c, input) =>
      deps.sql
        ? saveWebReadSetting(deps.sql, spaceId, input.enabled === true)
        : unavailable('Web reading is not connected yet.'),
    'GET /memory/beliefs': (spaceId, c) =>
      beliefs?.list(spaceId, c.get('owner').id) ?? unavailable(NOT_CONNECTED),
    'GET /memory/beliefs/{id}/history': (spaceId, c) =>
      beliefs?.history(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable(NOT_CONNECTED),
    'POST /memory/beliefs/{id}/block': (spaceId, c) =>
      beliefs?.block(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable(NOT_CONNECTED),
    'GET /memory/blocks': (spaceId, c) =>
      beliefs?.blocks(spaceId, c.get('owner').id) ?? unavailable(NOT_CONNECTED),
    'DELETE /memory/blocks/{id}': (spaceId, c) =>
      beliefs?.unblock(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable(NOT_CONNECTED),
    'GET /memory/timeline': (spaceId, c) =>
      beliefs?.timeline(spaceId, c.get('owner').id, c.req.query()) ?? unavailable(NOT_CONNECTED),
    'POST /memory/rewind/preview': (spaceId, c, input) =>
      beliefs?.preview(spaceId, c.get('owner').id, input) ?? unavailable(NOT_CONNECTED),
    'POST /memory/rewind': (spaceId, c, input) =>
      beliefs?.rewind(spaceId, c.get('owner').id, input) ?? unavailable(NOT_CONNECTED),
    'POST /memory/rewinds/{id}/undo': (spaceId, c) =>
      beliefs?.undoRewind(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable(NOT_CONNECTED),
    'GET /memory/digest': (spaceId, c) =>
      beliefs?.digest(spaceId, c.get('owner').id) ?? unavailable(NOT_CONNECTED),
    'POST /memory/digest/{id}/seen': (spaceId, c) =>
      beliefs?.seen(spaceId, c.get('owner').id, c.req.param('id') ?? '') ??
      unavailable(NOT_CONNECTED),
    'GET /memory/export': (spaceId, c) =>
      beliefs?.export(spaceId, c.get('owner').id, c.req.query()) ?? unavailable(NOT_CONNECTED),
    'POST /memory/import': (spaceId, c, input) =>
      beliefs?.import(spaceId, c.get('owner').id, input) ?? unavailable(NOT_CONNECTED),
    'GET /permissions': async (spaceId, c) =>
      permissions
        ? {
            ...(await permissions.list(spaceId)),
            ...(handoffs ? { handoffs: await handoffs.waiting(c.get('owner').id, spaceId) } : {}),
          }
        : unavailable('Permissions are not connected yet.'),
    'POST /permissions/{id}': (spaceId, c, input) =>
      permissions?.decide(spaceId, c.req.param('id') ?? '', input) ??
      unavailable('Permissions are not connected yet.'),
    'GET /approval-settings': (spaceId) =>
      permissions?.approvalSettings(spaceId) ?? unavailable('Approvals are not connected yet.'),
    'PUT /approval-settings': (spaceId, _c, input) =>
      permissions?.saveApprovalSettings(spaceId, input) ??
      unavailable('Approvals are not connected yet.'),
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
      await service.requireThread(spaceId, id);
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
      // A draft card offers sending only while its draft can still be sent.
      const cards = [];
      for (const { action, connection } of rows) {
        let status: ExperienceDraft['status'] | undefined;
        if (action.kind === 'email.draft' && action.status === 'succeeded') {
          if (ownerEffects) {
            const draft = await ownerEffects.draft(spaceId, action.id);
            status = 'reason' in draft ? undefined : draft.status;
          } else {
            const [send] = await deps.db
              .select()
              .from(experienceDraftSend)
              .where(eq(experienceDraftSend.draftActionId, action.id));
            status = send?.discardedAt
              ? 'discarded'
              : send?.sendActionId
                ? 'awaiting_permission'
                : 'draft';
          }
        }
        cards.push(...projectCards(action, connection, status));
      }
      return { cards: [...cards, ...artifacts.filter(meantForPerson).map(projectArtifact)] };
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
    'GET /conversations/{id}/computer': async (spaceId, c) => {
      const jobIds = await conversationJobs(spaceId, c.req.param('id') ?? '');
      const rows = await actionsOf(spaceId, jobIds);
      const bindings = deps.sql
        ? await deps.sql<ComputerBinding[]>`select id, control, updated_at
            from browser_session_binding
            where space_id = ${spaceId} and job_id in ${deps.sql(jobIds)}`
        : [];
      const [sandbox] = await deps.db
        .select({ id: connection.id })
        .from(connection)
        .where(
          and(
            eq(connection.spaceId, spaceId),
            eq(connection.provider, 'sandbox'),
            eq(connection.status, 'active'),
          ),
        )
        .limit(1);
      // The conversation's agent's computer keeps processes across its jobs. A
      // process started elsewhere is named, with its output, only when it was
      // started by this person outside a sensitive conversation; otherwise
      // only its state, port and time are shown, as the process tools do.
      const conversation = jobIds[0] ?? '';
      const processes = deps.sql
        ? await deps.sql<ComputerProcessRow[]>`with mine as (
              select p.*, (
                p.job_id in ${deps.sql(jobIds)} or (
                  coalesce(h.principal_id, (select id from owner limit 1)) is not distinct from
                    coalesce(c.principal_id, (select id from owner limit 1))
                  and not exists (select 1 from privacy_conversation pc
                    where pc.conversation_id = coalesce(h.experience_parent_id, h.id)
                      and pc.sensitive <> 'none'))
              ) as attributable,
              -- A preview is offered only to the person whose job started the process.
              (h.id is not null and coalesce(h.principal_id, (select id from owner limit 1))
                is not distinct from coalesce(c.principal_id, (select id from owner limit 1))
              ) as previewable
              from sandbox_process p
              join job c on c.id = ${conversation}
              left join job h on h.id = p.job_id
              where p.space_id = ${spaceId}
                and p.agent_id in (select agent_id from job
                  where space_id = ${spaceId} and id in ${deps.sql(jobIds)} and agent_id is not null))
          (select id, name, state, started_at, created_at, port, last_line, attributable, previewable
            from mine where state in ('starting', 'running'))
          union all
          (select id, name, state, started_at, created_at, port, last_line, attributable, previewable
            from mine where state not in ('starting', 'running')
            order by created_at desc limit ${COMPUTER_PROCESS_LIMIT})`
        : [];
      return projectComputer({
        rows: rows.map((row) => row.action),
        bindings,
        processes,
        available: { browser: deps.browser ?? false, terminal: Boolean(sandbox) },
      });
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
    'GET /agents/templates': (spaceId) => service.agentTemplates(spaceId),
    'POST /agents': (spaceId, _c, input) => service.saveAgent(spaceId, input),
    'PATCH /agents/{id}': (spaceId, c, input) =>
      service.saveAgent(spaceId, input, c.req.param('id') ?? ''),
    'DELETE /agents/{id}': async (spaceId, c) => {
      const deleted = await service.deleteAgent(spaceId, c.req.param('id') ?? '');
      if (deleted.routines_paused) await deps.triggers?.syncSchedules();
      return deleted;
    },
    'GET /conversations': (spaceId, c) => service.conversations(spaceId, c.req.query()),
    'POST /conversations': (spaceId, _c, input) => service.createConversation(spaceId, input),
    'GET /conversations/{id}': async (spaceId, c) => ({
      conversation: await service.view(
        await service.requireThread(spaceId, c.req.param('id') ?? ''),
      ),
    }),
    'PATCH /conversations/{id}': (spaceId, c, input) =>
      service.rename(spaceId, c.req.param('id') ?? '', input),
    'DELETE /conversations/{id}': async (spaceId, c) => {
      const id = c.req.param('id') ?? '';
      // A chat, or a routine's thread whose routine is gone; a routine still
      // set up is deleted as a routine, which takes its thread with it.
      const thread = await service.requireThread(spaceId, id);
      if (!deps.jobs || !deps.sql) return unavailable('Deleting chats is not connected yet.');
      if (thread.kind === 'routine') {
        const [schedule] = await deps.sql`select id from trigger where job_id = ${id} limit 1`;
        if (schedule)
          throw new ServiceError(
            'routine_thread',
            'This chat belongs to a routine. Delete the routine to remove it.',
            409,
          );
      }
      const ids = await conversationJobs(spaceId, id);
      const ownerId = c.get('owner').id;
      let forget: ((sources: readonly string[]) => Promise<number>) | undefined;
      if (c.req.query('forget_memory') === 'true') {
        // Checked before anything goes: a chat is never deleted on the promise
        // of a forgetting that cannot happen here.
        const ready = await memory?.forgetReady(spaceId, ownerId);
        if (!ready && (await memorySourcesOf(deps.sql, ids)).length)
          return unavailable('Forgetting is not connected yet, so nothing was deleted.');
        if (ready)
          forget = async (sources) => (await memory?.forgetSources(spaceId, ownerId, sources)) ?? 0;
      }
      const removal = await removeJobs(
        {
          jobs: deps.jobs,
          sql: deps.sql,
          runner: deps.runner,
          blobs: deps.attachments?.store,
          workspaces: deps.workspaces,
        },
        ids,
        forget,
      );
      return { id, ...removal };
    },
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
      // Anyone who is not the space's owner, whatever their role.
      const member = !ownsSessionSpace(c.get('sessionSpace'));
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
