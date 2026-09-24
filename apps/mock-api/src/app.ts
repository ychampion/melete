/**
 * Every operation in packages/contracts/openapi.json, in memory.
 *
 * Two rules hold the mock honest. Requests are parsed with the contract's own
 * Zod schemas, so a client that sends something the real service would refuse is
 * refused here too. Responses are parsed with the contract's schemas on the way
 * out, so a body the mock invents that the document does not describe is a 500
 * here rather than a surprise in the real service later.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  type ApiEvent,
  type ApprovalRequestView,
  actionListQuery,
  actionListResponse,
  actionResponse,
  approvalDecisionRequest,
  approvalDecisionResponse,
  approvalListResponse,
  attemptListResponse,
  attemptResponse,
  CONNECTION_CHECK_DETAIL,
  CONNECTION_KIND_DESCRIPTORS,
  cancelJobRequest,
  connectionCheckResponse,
  connectionGeneration,
  connectionInstallation,
  connectionKindListResponse,
  connectionLifecycle,
  connectionListResponse,
  connectionResponse,
  createConnectionRequest,
  createJobRequest,
  createSpaceRequest,
  credentialsRequest,
  type EventType,
  type errorResponse,
  eventPage,
  eventQuery,
  healthResponse,
  ID_PREFIXES,
  isRetrievable,
  type Job,
  type JobBudget,
  jobConstraints,
  jobListQuery,
  jobListResponse,
  jobResponse,
  knowledgeRecordResponse,
  knowledgeSearchQuery,
  knowledgeSearchResponse,
  ownerResponse,
  personReactionRequest,
  postMessageRequest,
  proposeKnowledgeRequest,
  proposeKnowledgeResponse,
  reactionListResponse,
  reactionResponse,
  resolveActionRequest,
  retractKnowledgeRequest,
  SSE_KEEPALIVE,
  setupStatusResponse,
  skillListResponse,
  spaceListResponse,
  sseFrame,
} from '@melete/contracts';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import { mountCompaniesMock } from './companies.ts';
import { mountExperienceMock } from './experience.ts';
import type { Runner } from './runner.ts';
import { chooseScenario, type Scenario } from './scenario.ts';
import { MockConflict, newId, type Store } from './store.ts';

export const MOCK_VERSION = '0.1.0-pre';

/** A budget a scripted job can never exceed, so nothing fails for the wrong reason. */
export const DEFAULT_BUDGET: JobBudget = {
  max_turns: 12,
  max_output_tokens: 40_000,
  max_wall_ms: 900_000,
  max_actions: 8,
  max_attempts: 4,
  max_usd_est: 1.5,
};

export type AppDeps = {
  store: Store;
  runner: Runner;
  scenarios: Scenario[];
  spaceId: string;
  experienceSpeed?: number;
  /** Seed conversations, plans, tasks and routines for the web app. Tests leave this off. */
  seedExperience?: boolean;
  /** Start as a fresh install: no account, and signed out until one is made. */
  setupNeeded?: boolean;
};

type ErrorBody = z.infer<typeof errorResponse>;

const fail = (code: string, message: string, detail?: Record<string, unknown>): ErrorBody =>
  detail ? { error: { code, message, detail } } : { error: { code, message } };

const KEEPALIVE_MS = 20_000;

export function createMockApp(deps: AppDeps) {
  const { store, runner, scenarios } = deps;
  const app = new Hono();
  const mockSession = randomUUID();

  // The reference client is served from another port in development, and the
  // session cookie has to survive that, so the origin is reflected rather than
  // wildcarded: `*` and credentials are not allowed together.
  app.use(
    '*',
    cors({
      origin: (origin) => origin ?? '*',
      credentials: true,
      allowHeaders: ['content-type', 'accept', 'last-event-id', 'idempotency-key'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  const experience = mountExperienceMock(app, deps);
  if (deps.seedExperience) experience.seed();
  // The companies surface is agreed but not yet in openapi.json, so it mounts
  // its own routes rather than going through the contract's operation table.
  mountCompaniesMock(app, deps, experience);

  /**
   * Parse an outgoing body with the contract before it leaves. A failure here is
   * the mock's bug, never the caller's, and it says so.
   */
  const send = <T extends z.ZodType>(
    schema: T,
    body: unknown,
    status: 200 | 201 | 202 = 200,
  ): Response => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        fail('contract_violation', 'the mock produced a body openapi.json does not describe', {
          issues: parsed.error.issues.slice(0, 8),
        }),
        { status: 500 },
      );
    }
    return Response.json(parsed.data, { status });
  };

  const reject = (status: 400 | 404 | 409, body: ErrorBody): Response =>
    Response.json(body, { status });

  const parseBody = async <T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<{ ok: true; value: z.infer<T> } | { ok: false; response: Response }> => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = undefined;
    }
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        response: reject(
          400,
          fail('invalid_request', 'the request body failed validation', {
            issues: parsed.error.issues.slice(0, 8),
          }),
        ),
      };
    }
    return { ok: true, value: parsed.data };
  };

  // ------------------------------------------------------------------
  // the account: the first one, and signing in with a password
  // ------------------------------------------------------------------

  /** The demo owner, unless the mock starts as a fresh install with none. */
  let account: { id: string; email: string; password: string; created_at: string } | null =
    deps.setupNeeded
      ? null
      : {
          id: newId('own'),
          email: 'jamie.davis@fastmail.example',
          password: 'melete-demo-password',
          created_at: store.now().toISOString(),
        };
  if (deps.setupNeeded) experience.signedOut = true;
  const owned = (row: NonNullable<typeof account>) => ({
    owner: { id: row.id, email: row.email, created_at: row.created_at },
  });

  app.get('/setup', () => send(setupStatusResponse, { needed: account === null }));

  app.post('/setup', async (c) => {
    if (account) return c.json(fail('already_setup', 'The owner is already set up.'), 409);
    const body = await parseBody(c.req.raw, credentialsRequest);
    if (!body.ok)
      return c.json(
        fail('invalid_input', 'Provide an email and a password of 8 characters or more.'),
        400,
      );
    account = {
      id: newId('own'),
      email: body.value.email.toLowerCase(),
      password: body.value.password,
      created_at: store.now().toISOString(),
    };
    experience.signedOut = false;
    return send(ownerResponse, owned(account), 201);
  });

  app.post('/login', async (c) => {
    const body = await parseBody(c.req.raw, credentialsRequest);
    if (!body.ok) return c.json(fail('invalid_input', 'Provide an email and password.'), 400);
    if (
      !account ||
      body.value.email.toLowerCase() !== account.email ||
      body.value.password !== account.password
    )
      return c.json(fail('invalid_credentials', 'Email or password is wrong.'), 401);
    experience.signedOut = false;
    return send(ownerResponse, owned(account));
  });

  // ------------------------------------------------------------------
  // health, spaces
  // ------------------------------------------------------------------

  app.get('/health', () =>
    send(healthResponse, {
      status: 'ok',
      version: MOCK_VERSION,
      database: 'not_configured',
      time: store.now().toISOString(),
    }),
  );

  app.get('/spaces', (c) => {
    // The demo's existing space bootstrap supplies a session for its fixed space.
    setCookie(c, 'melete_mock_session', mockSession, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
    return send(spaceListResponse, { spaces: [...store.spaces.values()] });
  });

  app.get('/artifacts/:id/content', (c) => {
    if (getCookie(c, 'melete_mock_session') !== mockSession)
      return c.json(fail('unauthorized', 'A session is required.'), 401);
    const entry = store.artifacts.get(c.req.param('id'));
    if (
      !entry ||
      entry.artifact.space_id !== deps.spaceId ||
      (entry.artifact.job_id && store.jobs.get(entry.artifact.job_id)?.space_id !== deps.spaceId) ||
      createHash('sha256').update(entry.bytes).digest('hex') !== entry.artifact.content_hash
    )
      return c.json(fail('not_found', 'No such artifact.'), 404);
    return new Response(Uint8Array.from(entry.bytes), {
      headers: {
        'content-type': entry.artifact.mime,
        'content-length': String(entry.bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.post('/spaces', async (c) => {
    const parsed = await parseBody(c.req.raw, createSpaceRequest);
    if (!parsed.ok) return parsed.response;
    const id = newId(ID_PREFIXES.space);
    store.spaces.set(id, {
      id,
      name: parsed.value.name,
      kind: 'personal',
      audience: 'owner',
      git_path: `/data/spaces/${parsed.value.name}`,
      created_at: store.now().toISOString(),
    });
    return send(spaceListResponse, { spaces: [...store.spaces.values()] }, 201);
  });

  // ------------------------------------------------------------------
  // jobs
  // ------------------------------------------------------------------

  app.get('/jobs', (c) => {
    const query = jobListQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) {
      return reject(400, fail('invalid_request', 'the job filter failed validation'));
    }
    const jobs = [...store.jobs.values()]
      .filter((job) => !query.data.space_id || job.space_id === query.data.space_id)
      .filter((job) => !query.data.state || job.state === query.data.state)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, query.data.limit);
    return send(jobListResponse, { jobs });
  });

  app.post('/jobs', async (c) => {
    const parsed = await parseBody(c.req.raw, createJobRequest);
    if (!parsed.ok) return parsed.response;
    const request = parsed.value;
    if (!store.spaces.has(request.space_id)) {
      return reject(400, fail('unknown_space', `no space ${request.space_id}`));
    }

    const now = store.now().toISOString();
    const id = newId(ID_PREFIXES.job);
    const script = chooseScenario(scenarios, `${request.title} ${request.objective}`);
    const job: Job = {
      id,
      space_id: request.space_id,
      title: request.title,
      objective: request.objective,
      constraints: jobConstraints.parse(request.constraints ?? {}),
      state: 'queued',
      revision: 0,
      lease_epoch: 0,
      next_wake_at: null,
      wait: { kind: 'none' },
      budget: { ...DEFAULT_BUDGET, ...request.budget },
      created_by: 'owner',
      created_at: now,
      updated_at: now,
      state_version: 0,
    };
    store.jobs.set(id, job);
    store.append({
      type: 'job_created',
      job_id: id,
      payload: { title: job.title, objective: job.objective, scenario: script.id },
    });
    runner.begin(id, script);
    return send(jobResponse, { job }, 201);
  });

  app.get('/jobs/:jobId', (c) => {
    const job = store.jobs.get(c.req.param('jobId'));
    if (!job) return reject(404, fail('not_found', 'no such job'));
    return send(jobResponse, { job });
  });

  app.post('/jobs/:jobId/cancel', async (c) => {
    const jobId = c.req.param('jobId');
    const job = store.jobs.get(jobId);
    if (!job) return reject(404, fail('not_found', 'no such job'));
    const parsed = await parseBody(c.req.raw, cancelJobRequest);
    if (!parsed.ok) return parsed.response;

    try {
      // Bumping the epoch is the fence: an attempt still in flight can deliver a
      // late receipt but can never admit new work.
      const cancelled = store.move(
        jobId,
        { kind: 'cancelled' },
        {
          wait: { kind: 'none' },
          lease_epoch: job.lease_epoch + 1,
          next_wake_at: null,
        },
      );
      store.append({
        type: 'notice',
        job_id: jobId,
        payload: {
          level: 'info',
          title: 'Cancelled',
          body: parsed.value.reason || 'Cancelled by the owner.',
        },
      });
      runner.signal(jobId, { kind: 'cancelled' });
      return send(jobResponse, { job: cancelled });
    } catch (error) {
      return conflict(error);
    }
  });

  app.post('/jobs/:jobId/messages', async (c) => {
    const jobId = c.req.param('jobId');
    const job = store.jobs.get(jobId);
    if (!job) return reject(404, fail('not_found', 'no such job'));
    const parsed = await parseBody(c.req.raw, postMessageRequest);
    if (!parsed.ok) return parsed.response;
    if (job.state !== 'waiting_for_input') {
      return reject(409, fail('not_waiting_for_input', `the job is ${job.state}`));
    }

    store.append({
      type: 'turn_started',
      job_id: jobId,
      payload: { from: 'owner', text: parsed.value.text },
    });
    const queued = store.move(jobId, { kind: 'user_input_received' }, { wait: { kind: 'none' } });
    runner.signal(jobId, { kind: 'input', text: parsed.value.text });
    return send(jobResponse, { job: queued }, 202);
  });

  /**
   * A message is an event, so its id is that event's seq. Reactions are events
   * too, which is why nothing here keeps a second list: the stream already has
   * them, and a client draws them on the bubble by matching `message_id`.
   */
  const reactionsOn = (messageId: string) =>
    store
      .eventsAfter(0, { types: ['reaction'], limit: 1000 })
      .events.filter((entry) => (entry.payload as { message_id?: string }).message_id === messageId)
      .map((entry) => ({
        message_id: messageId,
        emoji: (entry.payload as { emoji: string }).emoji,
        by: (entry.payload as { by: string }).by,
        job_id: entry.job_id,
        seq: entry.seq,
        created_at: entry.created_at,
      }));

  app.post('/messages/:messageId/reactions', async (c) => {
    const messageId = c.req.param('messageId');
    const target = store
      .eventsAfter(0, { limit: 10_000 })
      .events.find((entry) => String(entry.seq) === messageId);
    if (!target) return reject(404, fail('not_found', 'no such message'));
    if (target.type === 'reaction')
      return reject(409, fail('not_reactable', 'a reaction is not a message'));
    const parsed = await parseBody(c.req.raw, personReactionRequest);
    if (!parsed.ok) return parsed.response;
    const already = reactionsOn(messageId).find(
      (entry) => entry.emoji === parsed.value.emoji && entry.by === 'person',
    );
    if (already) return send(reactionResponse, { reaction: already }, 201);
    const written = store.append({
      type: 'reaction',
      job_id: target.job_id,
      payload: { message_id: messageId, emoji: parsed.value.emoji, by: 'person' },
    });
    return send(
      reactionResponse,
      {
        reaction: {
          message_id: messageId,
          emoji: parsed.value.emoji,
          by: 'person',
          job_id: written.job_id,
          seq: written.seq,
          created_at: written.created_at,
        },
      },
      201,
    );
  });

  app.get('/messages/:messageId/reactions', (c) =>
    send(reactionListResponse, { reactions: reactionsOn(c.req.param('messageId')) }),
  );

  app.get('/jobs/:jobId/reactions', (c) => {
    const jobId = c.req.param('jobId');
    const reactions = store
      .eventsAfter(0, { jobId, types: ['reaction'], limit: 1000 })
      .events.map((entry) => ({
        message_id: (entry.payload as { message_id: string }).message_id,
        emoji: (entry.payload as { emoji: string }).emoji,
        by: (entry.payload as { by: string }).by,
        job_id: entry.job_id,
        seq: entry.seq,
        created_at: entry.created_at,
      }));
    return send(reactionListResponse, { reactions });
  });

  app.get('/jobs/:jobId/attempts', (c) => {
    const jobId = c.req.param('jobId');
    const attempts = [...store.attempts.values()]
      .filter((attempt) => attempt.job_id === jobId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
    return send(attemptListResponse, { attempts });
  });

  app.get('/attempts/:attemptId', (c) => {
    const attempt = store.attempts.get(c.req.param('attemptId'));
    if (!attempt) return reject(404, fail('not_found', 'no such attempt'));
    return send(attemptResponse, { attempt });
  });

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  const eventsHandler = (jobId?: string) => (c: { req: { url: string; raw: Request } }) => {
    const url = new URL(c.req.url);
    const searchParams = Object.fromEntries(url.searchParams);
    const types = url.searchParams
      .getAll('types')
      .flatMap((value) => value.split(','))
      .filter((value): value is EventType => value.length > 0);
    const parsed = eventQuery.safeParse({
      ...searchParams,
      ...(types.length ? { types } : { types: undefined }),
    });
    if (!parsed.success) {
      return reject(400, fail('invalid_request', 'the event query failed validation'));
    }

    // `Last-Event-ID` wins: it is what the browser sends on its own, and a client
    // that reconnects must not be handed events it already has.
    const header = c.req.raw.headers.get('last-event-id');
    const resume = header && /^\d+$/.test(header) ? Number(header) : null;
    const after = resume ?? parsed.data.after;
    const wants = c.req.raw.headers.get('accept') ?? '';

    if (!wants.includes('text/event-stream')) {
      const page = store.eventsAfter(after, {
        ...(jobId ? { jobId } : {}),
        ...(parsed.data.types ? { types: parsed.data.types } : {}),
        limit: parsed.data.limit,
      });
      const last = page.events.at(-1);
      return send(eventPage, {
        events: page.events,
        next_cursor: last ? last.seq : after,
        has_more: page.total > page.events.length,
      });
    }

    return streamEvents(after, jobId, parsed.data.types);
  };

  const streamEvents = (after: number, jobId?: string, types?: EventType[]): Response => {
    const encoder = new TextEncoder();
    let release: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const push = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            open = false;
          }
        };
        const wanted = (event: ApiEvent): boolean =>
          (!jobId || event.job_id === jobId) && (!types?.length || types.includes(event.type));

        // Replay first, from the persisted log, then follow. Same order the real
        // service uses, which is why a reconnect needs no separate bookkeeping.
        //
        // The replay is deliberately unbounded. A page has a limit because the
        // caller asked for one and gets a cursor to continue with; a stream has
        // no second request to make, so capping it would hand the client a hole
        // it never asked about and could only discover as a skipped sequence.
        for (const event of store.eventsAfter(after, {
          ...(jobId ? { jobId } : {}),
          ...(types ? { types } : {}),
          limit: Number.POSITIVE_INFINITY,
        }).events) {
          push(sseFrame(event));
        }

        const unsubscribe = store.subscribe((event) => {
          if (wanted(event)) push(sseFrame(event));
        });
        const keepalive = setInterval(() => push(SSE_KEEPALIVE), KEEPALIVE_MS);
        release = () => {
          open = false;
          unsubscribe();
          clearInterval(keepalive);
        };
      },
      cancel() {
        release?.();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  };

  app.get('/jobs/:jobId/events', (c) => eventsHandler(c.req.param('jobId'))(c));
  app.get('/events', (c) => eventsHandler()(c));

  // ------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------

  app.get('/actions', (c) => {
    const parsed = actionListQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) {
      return reject(400, fail('invalid_request', 'the action filter failed validation'));
    }
    const query = parsed.data;
    const actions = [...store.actions.values()]
      .filter((action) => !query.job_id || action.job_id === query.job_id)
      .filter((action) => !query.status || action.status === query.status)
      .filter((action) => !query.effect_class || action.effect_class === query.effect_class)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, query.limit);
    return send(actionListResponse, { actions });
  });

  app.get('/actions/:actionId', (c) => {
    const action = store.actions.get(c.req.param('actionId'));
    if (!action) return reject(404, fail('not_found', 'no such action'));
    return send(actionResponse, { action });
  });

  app.post('/actions/:actionId/resolve', async (c) => {
    const action = store.actions.get(c.req.param('actionId'));
    if (!action) return reject(404, fail('not_found', 'no such action'));
    const parsed = await parseBody(c.req.raw, resolveActionRequest);
    if (!parsed.ok) return parsed.response;
    if (action.status !== 'unknown' && action.status !== 'unresolved') {
      return reject(409, fail('not_awaiting_reconciliation', `the action is ${action.status}`));
    }

    const now = store.now().toISOString();
    const settled = store.patchAction(action.id, {
      status: parsed.value.resolution,
      resolved_at: parsed.value.resolution === 'unresolved' ? null : now,
      reconciliation: {
        decided_by: 'owner',
        decided_at: now,
        resolution: parsed.value.resolution,
        note: parsed.value.note ?? '',
      },
    });

    const job = store.jobs.get(action.job_id);
    if (job?.state === 'needs_reconciliation') {
      store.move(job.id, { kind: 'reconciled' }, { wait: { kind: 'none' } });
      runner.signal(job.id, { kind: 'reconciled' });
    }
    experience.actionResolved(settled);
    return send(actionResponse, { action: settled });
  });

  // ------------------------------------------------------------------
  // approvals
  // ------------------------------------------------------------------

  const approvalView = (approvalId: string): ApprovalRequestView | null => {
    const approval = store.approvals.get(approvalId);
    if (!approval) return null;
    const action = store.actions.get(approval.action_id);
    if (!action) return null;
    return {
      approval_id: approval.id,
      action_id: action.id,
      job_id: action.job_id,
      job_revision: approval.job_revision,
      kind: action.kind,
      effect_class: action.effect_class,
      connection_id: action.connection_id,
      canonical_payload: action.canonical_payload,
      payload_hash: approval.payload_hash,
      requested_at: approval.requested_at,
      expires_at: approval.expires_at,
    };
  };

  app.get('/approvals', () => {
    const approvals = [...store.approvals.values()]
      .filter((approval) => approval.decision === null)
      .map((approval) => approvalView(approval.id))
      .filter((view): view is ApprovalRequestView => view !== null)
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    return send(approvalListResponse, { approvals });
  });

  app.post('/approvals/:approvalId', async (c) => {
    const approval = store.approvals.get(c.req.param('approvalId'));
    if (!approval) return reject(404, fail('not_found', 'no such approval'));
    const parsed = await parseBody(c.req.raw, approvalDecisionRequest);
    if (!parsed.ok) return parsed.response;
    if (approval.decision !== null) {
      return reject(409, fail('already_decided', `this approval was already ${approval.decision}`));
    }

    const action = store.requireAction(approval.action_id);
    // The decision binds to the bytes the person was shown. A different hash
    // means the draft moved, and the approval is refused rather than spent.
    if (parsed.value.payload_hash !== approval.payload_hash) {
      return reject(
        409,
        fail('approval_hash_mismatch', 'the payload changed since this approval was requested', {
          shown: parsed.value.payload_hash,
          current: approval.payload_hash,
        }),
      );
    }
    const job = store.requireJob(action.job_id);
    if (job.revision !== approval.job_revision) {
      return reject(
        409,
        fail('revision_mismatch', 'the job changed since this approval was requested'),
      );
    }

    const now = store.now().toISOString();
    store.approvals.set(approval.id, {
      ...approval,
      decision: parsed.value.decision,
      decided_at: now,
      decided_by: 'owner',
    });
    store.patchAction(action.id, {
      status: parsed.value.decision === 'approved' ? 'approved' : 'denied',
      authorization_ref: approval.id,
      ...(parsed.value.decision === 'denied' ? { resolved_at: now } : {}),
    });
    store.append({
      type: 'approval_decided',
      job_id: action.job_id,
      payload: {
        approval_id: approval.id,
        action_id: action.id,
        decision: parsed.value.decision,
        payload_hash: approval.payload_hash,
        note: parsed.value.note ?? '',
      },
    });

    if (job.state === 'waiting_for_approval') {
      store.move(
        job.id,
        { kind: 'approval_decided', decision: parsed.value.decision },
        { wait: { kind: 'none' } },
      );
    }
    runner.signal(job.id, { kind: 'approval', decision: parsed.value.decision });

    return send(approvalDecisionResponse, {
      approval_id: approval.id,
      action_id: action.id,
      decision: parsed.value.decision,
      payload_hash: approval.payload_hash,
      decided_at: now,
    });
  });

  // ------------------------------------------------------------------
  // connections
  // ------------------------------------------------------------------

  app.get('/connections', () =>
    send(connectionListResponse, { connections: store.listConnections() }),
  );

  const checked = (code: 'ok' | 'revoked') => ({
    status: code === 'ok' ? ('ok' as const) : ('failing' as const),
    code,
    detail: CONNECTION_CHECK_DETAIL[code],
    checked_at: store.now().toISOString(),
  });

  app.get('/connection-kinds', () =>
    send(connectionKindListResponse, { kinds: CONNECTION_KIND_DESCRIPTORS }),
  );

  app.post('/connections', async (c) => {
    const parsed = await parseBody(c.req.raw, createConnectionRequest);
    if (!parsed.ok) return parsed.response;
    const installation = connectionInstallation(parsed.value);
    if (!installation.ok) return reject(400, fail('invalid_request', installation.error));
    const spaceId = parsed.value.space_id ?? [...store.spaces.keys()][0];
    if (!spaceId) return reject(400, fail('invalid_request', 'name the space to install into'));
    const now = store.now().toISOString();
    const id = newId(ID_PREFIXES.connection);
    const kind = installation.value;
    store.connections.set(id, {
      id,
      space_id: spaceId,
      provider: kind.provider,
      label: parsed.value.label,
      // Sealed on arrival and never returned. The mock keeps only the pointer,
      // which is the same thing the API is allowed to know.
      secret_ref:
        kind.kind === 'ics' ||
        parsed.value.credentials ||
        (kind.kind === 'mcp_stdio' && kind.config.secret_env.length)
          ? newId(ID_PREFIXES.secret)
          : null,
      scopes:
        kind.kind === 'mcp' || kind.kind === 'mcp_stdio' ? kind.config.allowed_scopes : kind.scopes,
      status: 'active',
      health: 'ok',
      setup_state: 'connected',
      generation: 0,
      last_checked_at: now,
      created_at: now,
    });
    const created = store.connections.get(id);
    if (!created) return reject(400, fail('invalid_request', 'the connection was not stored'));
    return send(connectionResponse, { connection: store.view(created), check: checked('ok') }, 201);
  });

  app.post('/connections/:connectionId/lifecycle', async (c) => {
    const connection = store.connections.get(c.req.param('connectionId'));
    if (!connection) return reject(404, fail('not_found', 'no such connection'));
    const parsed = await parseBody(c.req.raw, connectionLifecycle);
    if (!parsed.ok) return parsed.response;
    const generation = connection.generation ?? 0;
    if (parsed.value.expected_generation !== generation)
      return reject(409, fail('generation_conflict', 'the connection generation changed'));
    const status = parsed.value.kind === 'revoke' ? ('revoked' as const) : ('active' as const);
    store.connections.set(connection.id, { ...connection, status, generation: generation + 1 });
    return send(connectionGeneration, {
      connection_id: connection.id,
      generation: generation + 1,
      policy_generation: generation + 1,
      status,
    });
  });

  app.get('/connections/:connectionId', (c) => {
    const connection = store.connections.get(c.req.param('connectionId'));
    if (!connection) return reject(404, fail('not_found', 'no such connection'));
    return send(connectionResponse, { connection: store.view(connection) });
  });

  app.post('/connections/:connectionId/health', (c) => {
    const connection = store.connections.get(c.req.param('connectionId'));
    if (!connection) return reject(404, fail('not_found', 'no such connection'));
    const check = checked(connection.status === 'revoked' ? 'revoked' : 'ok');
    const next = {
      ...connection,
      health: connection.status === 'revoked' ? connection.health : ('ok' as const),
      last_checked_at: check.checked_at,
    };
    store.connections.set(connection.id, next);
    return send(connectionCheckResponse, { connection: store.view(next), check });
  });

  // ------------------------------------------------------------------
  // knowledge
  // ------------------------------------------------------------------

  app.get('/knowledge/search', (c) => {
    const parsed = knowledgeSearchQuery.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) {
      return reject(400, fail('invalid_request', 'the search query failed validation'));
    }
    const { q, limit, space_id, include_retracted } = parsed.data;
    const needle = q.toLowerCase();
    const hits = [...store.knowledge.values()]
      .filter((record) => record.space_id === space_id)
      // Retraction leaves retrieval at once. The flag exists so an operator can
      // audit what was removed, not so a job can read it back.
      .filter((record) => include_retracted || isRetrievable(record.frontmatter.status))
      .map((record) => {
        const haystack = `${record.frontmatter.title}\n${record.body}`.toLowerCase();
        const at = haystack.indexOf(needle);
        return { record, at };
      })
      .filter(({ at }) => at !== -1)
      .slice(0, limit)
      .map(({ record, at }) => ({
        id: record.id,
        path: record.path,
        title: record.frontmatter.title,
        excerpt: excerptAround(`${record.frontmatter.title}\n${record.body}`, at, q.length),
        status: record.frontmatter.status,
        score: Number((1 / (1 + at / 40)).toFixed(3)),
      }));
    return send(knowledgeSearchResponse, { hits });
  });

  app.get('/knowledge/:recordId', (c) => {
    const record = store.knowledge.get(c.req.param('recordId'));
    if (!record) return reject(404, fail('not_found', 'no such record'));
    return send(knowledgeRecordResponse, {
      id: record.id,
      path: record.path,
      frontmatter: record.frontmatter,
      body: record.body,
    });
  });

  app.delete('/knowledge/:recordId', async (c) => {
    const record = store.knowledge.get(c.req.param('recordId'));
    if (!record) return reject(404, fail('not_found', 'no such record'));
    const parsed = await parseBody(c.req.raw, retractKnowledgeRequest);
    if (!parsed.ok) return parsed.response;

    const retracted = {
      ...record,
      frontmatter: { ...record.frontmatter, status: 'retracted' as const },
      body: `${record.body}\n\nRetracted: ${parsed.value.reason}`,
    };
    if (parsed.value.hard_delete) store.knowledge.delete(record.id);
    else store.knowledge.set(record.id, retracted);

    store.append({
      type: 'knowledge_changed',
      payload: {
        record_id: record.id,
        path: record.path,
        change: parsed.value.hard_delete ? 'deleted' : 'retracted',
        reason: parsed.value.reason,
      },
    });
    return send(knowledgeRecordResponse, {
      id: retracted.id,
      path: retracted.path,
      frontmatter: retracted.frontmatter,
      body: retracted.body,
    });
  });

  app.post('/knowledge/proposals', async (c) => {
    const parsed = await parseBody(c.req.raw, proposeKnowledgeRequest);
    if (!parsed.ok) return parsed.response;
    const proposalId = `prop_${newId(ID_PREFIXES.knowledge).slice(2)}`;
    const path = `.proposed/${parsed.value.path}`;
    const diff = renderDiff(parsed.value.path, parsed.value.frontmatter.title, parsed.value.body);
    store.proposals.set(proposalId, { path, diff });
    store.append({
      type: 'knowledge_changed',
      payload: { change: 'proposed', path, rationale: parsed.value.rationale },
    });
    return send(proposeKnowledgeResponse, { proposal_id: proposalId, path, diff }, 201);
  });

  // ------------------------------------------------------------------
  // skills
  // ------------------------------------------------------------------

  app.get('/skills', () =>
    send(skillListResponse, {
      skills: [...store.skills.values()].map((skill) => ({
        id: skill.id,
        space_id: skill.space_id,
        path: skill.path,
        enabled: skill.enabled,
        frontmatter: skill.frontmatter,
      })),
    }),
  );

  app.notFound(() => reject(404, fail('not_found', 'no such endpoint in openapi.json')));

  app.onError((error) => {
    if (error instanceof MockConflict) return conflict(error);
    process.stderr.write(`mock-api: ${String(error)}\n`);
    return Response.json(fail('internal', 'the mock failed'), { status: 500 });
  });

  function conflict(error: unknown): Response {
    if (error instanceof MockConflict) {
      const status = error.code === 'not_found' ? 404 : 409;
      const body = error.detail
        ? fail(error.code, error.message, error.detail)
        : fail(error.code, error.message);
      return Response.json(body, { status });
    }
    throw error;
  }

  return app;
}

const excerptAround = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${
    end < text.length ? '…' : ''
  }`;
};

const renderDiff = (path: string, title: string, body: string): string =>
  [
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.split('\n').length + 2} @@`,
    `+# ${title}`,
    `+`,
    ...body.split('\n').map((line) => `+${line}`),
  ].join('\n');
