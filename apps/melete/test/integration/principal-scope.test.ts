/**
 * Two accounts on one installation. Every surface a signed-in person can reach
 * is exercised twice: once against rows the other account owns, which must read
 * as absent or refused, and once against the caller's own rows, which must work.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  agentResponse,
  type CapabilityClaims,
  type ConnectorManifest,
  conversationResponse,
  type DispatchResult,
  memoryItemResponse,
  planResponse,
  taskResponse,
} from '@melete/contracts';
import { ServiceError } from '../../src/api/errors.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver, type TrustTableEntry } from '../../src/broker/trust.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import type { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { defaultBudget } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'principal-scope-signing-key-32-bytes!',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : undefined;
const root = await mkdtemp(join(tmpdir(), 'melete-scope-'));
const forgotten: RestrictionRecord[] = [];
const journal: RestrictionJournal = {
  read: async () => forgotten,
  append: async (record) => {
    forgotten.push(record);
  },
};
const registry = new ConnectorRegistry();
const calls: Action[] = [];
const trust = new Map<string, TrustTableEntry>([
  ['alex@example.test', { origin_trust: 'owner', handle: 'owner:alex' }],
]);
const broker = handle
  ? new BrokerService({
      sql: handle.sql,
      connectors: registry,
      resolveTrust: createTableTrustResolver(trust),
      resolveStandingGrant: resolveExperienceGrant,
    })
  : null;
const controlled: string[] = [];
const browserSessions = handle
  ? new BrowserSessionService(handle.sql, {
      get: async (spaceId) => {
        const change =
          (control: BrowserSession['control']) =>
          async (id: string): Promise<BrowserSession> => {
            controlled.push(`${control}:${id}`);
            const [binding] = await handle.sql`select * from browser_session_binding
              where id = ${id}`;
            return {
              id,
              space_id: spaceId,
              profile_dir: join(root, 'profile'),
              job_id: String(binding?.job_id),
              control_epoch: Number(binding?.control_epoch ?? 0) + 1,
              control,
              warm_until: Date.now() + 60_000,
            };
          };
        return {
          takeover: change('human'),
          handback: change('automation'),
        } as unknown as BrowserWorkerClient;
      },
    })
  : undefined;
const app =
  handle && broker
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
        jobs: jobs ?? undefined,
        runner: runner ?? undefined,
        triggers,
        sql: handle.sql,
        broker,
        registry,
        memory: { sql: handle.sql, journal },
        browserSessions,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}
async function call(cookie: string, path: string, method = 'GET', body?: unknown) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function login(email: string) {
  if (!app) throw new Error('Postgres unavailable');
  return sessionCookie(
    await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
}
function fixtureConnector(manifest: ConnectorManifest): Connector {
  return {
    manifest,
    async execute(action): Promise<DispatchResult> {
      calls.push(action);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail:
            action.kind === 'calendar.create'
              ? { uid: action.id, etag: '"one"' }
              : action.kind === 'calendar.list'
                ? { events: [] }
                : {},
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Everything one account owns, made through its own session where a route exists. */
async function seed(cookie: string, label: string) {
  const { sql } = database();
  if (!broker) throw new Error('Postgres unavailable');
  const me = (await json<{ owner: { id: string } }>(await call(cookie, '/me'))).owner.id;
  const spaces = (
    await json<{ spaces: { id: string; kind: string }[] }>(await call(cookie, '/spaces'))
  ).spaces;
  const spaceId = spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
  expect(spaceId).not.toBe('');
  const persona = agentResponse.parse(
    await json(await call(cookie, '/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)),
  ).agent;
  const created = await call(cookie, '/conversations', 'POST', {
    title: `${label} dinner`,
    agent_id: persona.id,
  });
  expect(created.status).toBe(200);
  const conversation = conversationResponse.parse(await json(created)).conversation;
  const mail = recordId('conn');
  const calendar = recordId('conn');
  for (const [id, manifest] of [
    [mail, emailManifest],
    [calendar, calendarManifest],
  ] as const) {
    const scopes = manifest.tools.map((tool) => tool.name);
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${id}, ${spaceId}, ${manifest.provider}, ${`${label} ${manifest.provider}`}, ${JSON.stringify(scopes)}::jsonb)`;
    registry.register(id, fixtureConnector(manifest));
  }
  await sql`update agent set allowed_connection_ids = ${JSON.stringify([mail, calendar])}::jsonb
    where id = ${persona.id}`;
  const attemptId = recordId('att');
  await sql`update job set state = 'running', lease_epoch = 1, next_wake_at = null where id = ${conversation.id}`;
  await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${conversation.id}, 1, 'fake', 'fake', 'scripted')`;
  const [row] = await sql`select revision from job where id = ${conversation.id}`;
  const claims: CapabilityClaims = {
    job_id: conversation.id,
    attempt_id: attemptId,
    space_id: spaceId,
    epoch: 1,
    revision: Number(row?.revision ?? 0),
    scopes: [...emailManifest.tools, ...calendarManifest.tools].map((tool) => tool.name),
    budget: {
      max_actions: defaultBudget.max_actions,
      max_output_tokens: defaultBudget.max_output_tokens,
      max_usd_est: defaultBudget.max_usd_est,
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const draft = (
    await broker.propose(claims, {
      connection_id: mail,
      kind: 'email.draft',
      payload: { to: 'alex@example.test', subject: `${label} dinner`, body: 'Dinner at seven?' },
    })
  ).action_id;
  const event = (summary: string) =>
    broker.propose(claims, {
      connection_id: calendar,
      kind: 'calendar.create',
      payload: { summary, start: '2026-09-13T18:00:00Z', end: '2026-09-13T19:00:00Z' },
    });
  // One request stays undecided; another is approved and dispatched so it has a receipt.
  const pending = await event(`${label} pending`);
  const done = await event(`${label} done`);
  const effects = new ExperienceEffects(sql, broker, registry);
  const permissions = new ExperiencePermissions(sql, broker, effects);
  const card = await permissions.card(spaceId, done.approval_id ?? '');
  await permissions.decide(spaceId, card.id, { option: 'allow_once', version: card.version });
  await broker.admit(claims, done.action_id, done.payload_hash);
  const dispatched = await broker.dispatch(done.action_id);
  const receipt = await effects.receipt(spaceId, dispatched);
  const artifactId = recordId('art');
  const bytes = Buffer.from(`${label} private notes`);
  await mkdir(join(root, spaceId, 'artifacts'), { recursive: true });
  await writeFile(join(root, spaceId, 'artifacts', 'notes.txt'), bytes);
  await sql`insert into artifact (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size)
    values (${artifactId}, ${spaceId}, ${conversation.id}, ${conversation.id}, 'artifacts', 'notes.txt', 'text',
      ${createHash('sha256').update(bytes).digest('hex')}, 'text/plain', ${bytes.length})`;
  const [message] =
    await sql`insert into event (job_id, attempt_id, type, payload, dedup_key, epoch)
    values (${conversation.id}, ${attemptId}, 'text_delta', ${JSON.stringify({ text: `${label} says hello` })}::jsonb,
      ${`${attemptId}:scope-message`}, 1) returning seq`;
  await sql`insert into experience_turn (id, job_id, agent_id, submission_id, text)
    values (${recordId('turn')}, ${conversation.id}, ${persona.id}, ${recordId('sub')}, ${`${label} private question`})`;
  const browserSession = `bs_${recordId('x')}`;
  await sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
    values (${browserSession}, ${spaceId}, ${conversation.id}, 1, 'automation')`;
  const task = taskResponse.parse(
    await json(await call(cookie, '/tasks', 'POST', { title: `${label} groceries`, due_at: null })),
  ).task;
  const plan = planResponse.parse(
    await json(
      await call(cookie, '/plans', 'POST', {
        title: `${label} holiday`,
        category: 'Personal',
        milestones: [{ title: 'Book flights', assignee: { kind: 'person' } }],
      }),
    ),
  ).plan;
  // Saved details are stored under the setup owner's memory catalog; another
  // account's own space reports them as not connected rather than borrowing it.
  const [installation] = await sql`select id from owner limit 1`;
  let detailId: string | null = null;
  if (installation?.id === me) {
    await provisionMemorySpace(sql, me, spaceId);
    await sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
    const saved = await call(cookie, '/memory/items', 'POST', {
      key: 'pref.home.city',
      value: `${label}ville`,
    });
    expect(saved.status).toBe(200);
    detailId = memoryItemResponse.parse(await json(saved)).item.id;
  } else {
    expect(await json(await call(cookie, '/memory/items'))).toMatchObject({
      status: 'not_available',
    });
  }
  return {
    cookie,
    principalId: me,
    spaceId,
    agentId: persona.id,
    conversationId: conversation.id,
    draftId: draft,
    permissionId: pending.approval_id ?? '',
    receiptId: receipt?.id ?? '',
    undoHandle: receipt?.undo?.handle ?? '',
    artifactId,
    messageId: String(message?.seq),
    browserSession,
    taskId: task.id,
    planId: plan.id,
    detailId,
    label,
  };
}

let first: Seeded;
let second: Seeded;
let secondCookie = '';

/** Every way `cookie` could read or change what `other` owns; none may succeed. */
async function isolated(cookie: string, other: Seeded, ownAgentId = other.agentId) {
  const { sql } = database();
  if (!app) throw new Error('Postgres unavailable');
  const lists: Array<[string, string]> = [
    ['/conversations', other.conversationId],
    ['/tasks', other.taskId],
    ['/plans', other.planId],
    ['/agents', other.agentId],
    ['/permissions', other.permissionId],
    ['/memory/items', `${other.label}ville`],
    ['/experience/connections', `${other.label} imap`],
    [`/search?q=${other.label}`, other.label],
    ['/events?view=experience', other.conversationId],
    ['/home', `${other.label} groceries`],
    ['/quick-answers', other.conversationId],
    ['/automations', other.label],
    ['/rules', other.label],
  ];
  for (const [path, marker] of lists) {
    const response = await call(cookie, path);
    expect([path, response.status]).toEqual([path, 200]);
    expect([path, (await response.text()).includes(marker)]).toEqual([path, false]);
  }
  const refused: Array<[string, string, unknown?]> = [
    ...['', '/messages', '/events', '/cards', '/receipts', '/drafts'].map(
      (suffix): [string, string] => [`/conversations/${other.conversationId}${suffix}`, 'GET'],
    ),
    [`/conversations/${other.conversationId}/messages`, 'POST', { text: 'Let me in' }],
    [`/conversations/${other.conversationId}/stop`, 'POST'],
    [`/conversations/${other.conversationId}/pause`, 'POST'],
    [`/conversations/${other.conversationId}/resume`, 'POST'],
    [`/conversations/${other.conversationId}/agent`, 'PATCH', { agent_id: ownAgentId }],
    [`/permissions/${other.permissionId}`, 'POST', { option: 'allow_once', version: 'any' }],
    [`/drafts/${other.draftId}/send`, 'POST'],
    [`/receipts/${other.receiptId}/undo`, 'POST'],
    [`/receipts/${other.undoHandle}/undo`, 'POST'],
    [`/tasks/${other.taskId}`, 'PATCH', { title: 'Taken', due_at: null, done: true }],
    [`/tasks/${other.taskId}`, 'DELETE'],
    [`/plans/${other.planId}`, 'GET'],
    [`/plans/${other.planId}/conversation`, 'POST', { agent_id: ownAgentId }],
    [`/agents/${other.agentId}`, 'PATCH', AGENT_TEMPLATES.templates[0]?.agent],
    [`/artifacts/${other.artifactId}/content`, 'GET'],
    [`/messages/${other.messageId}/reactions`, 'GET'],
    [`/messages/${other.messageId}/reactions`, 'POST', { emoji: '👍' }],
    [`/jobs/${other.conversationId}/reactions`, 'GET'],
    [`/jobs/${other.conversationId}`, 'GET'],
    [`/jobs/${other.conversationId}/events`, 'GET'],
    [`/browser/sessions/${other.browserSession}/takeover`, 'POST'],
    [`/browser/sessions/${other.browserSession}/handback`, 'POST'],
  ];
  const effectsBefore = calls.length;
  const controlBefore = controlled.length;
  for (const [path, method, body] of refused) {
    const response = await call(cookie, path, method, body);
    expect([method, path, [403, 404].includes(response.status)]).toEqual([method, path, true]);
  }
  if (other.detailId) {
    // Saved details answer "not connected" to anyone but their owner; nothing is read or changed.
    for (const [path, method, body] of [
      [`/memory/items/${other.detailId}/why`, 'GET', undefined],
      [`/memory/items/${other.detailId}`, 'PATCH', { value: 'Taken', version: 'x'.repeat(64) }],
      [`/memory/items/${other.detailId}`, 'DELETE', undefined],
    ] as const) {
      const response = await call(cookie, path, method, body);
      const text = await response.text();
      expect([method, path, text.includes(`${other.label}ville`)]).toEqual([method, path, false]);
      expect([
        method,
        path,
        [403, 404].includes(response.status) || text.includes('"not_available"'),
      ]).toEqual([method, path, true]);
    }
    expect(await (await call(other.cookie, '/memory/items')).text()).toContain(
      `${other.label}ville`,
    );
  }
  const foreignMemory = await app.request('/memory/claims', {
    headers: { Cookie: cookie, 'x-melete-space': other.spaceId },
  });
  expect([403, 404]).toContain(foreignMemory.status);
  // Nothing moved: no effect ran, no decision or reversal was stored, control stayed put.
  expect(calls.length).toBe(effectsBefore);
  expect(controlled.length).toBe(controlBefore);
  const [approval] = await sql`select decision from approval where id = ${other.permissionId}`;
  expect(approval?.decision).toBeNull();
  const [undo] = await sql`select reversal_action_id from experience_undo
    where handle = ${other.undoHandle}`;
  expect(undo?.reversal_action_id).toBeNull();
  expect(
    await sql`select 1 from experience_draft_send where draft_action_id = ${other.draftId}`,
  ).toHaveLength(0);
  expect(
    await sql`select 1 from event where job_id = ${other.conversationId} and type = 'reaction'`,
  ).toHaveLength(0);
  const [binding] = await sql`select control, control_epoch from browser_session_binding
    where id = ${other.browserSession}`;
  expect(binding).toMatchObject({ control: 'automation', control_epoch: 1 });
  const [task] = await sql`select title, done from task where id = ${other.taskId}`;
  expect(task).toMatchObject({ title: `${other.label} groceries`, done: false });
}

withDb('each account acts only inside its own space', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('setup seeds the first account and provisions a second one', async () => {
    if (!app) throw new Error('Postgres unavailable');
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.test', password }),
    });
    expect(setup.status).toBe(201);
    const ownerCookie = sessionCookie(setup);
    expect(
      (
        await call(ownerCookie, '/principals', 'POST', {
          email: 'second@example.test',
          password,
        })
      ).status,
    ).toBe(201);
    first = await seed(ownerCookie, 'First');
    secondCookie = await login('second@example.test');
  }, 60_000);

  test('a second account cannot list, read, decide, send, undo or control what the first owns', async () => {
    await isolated(secondCookie, first);
  }, 60_000);

  test('the second account has its own personal space and its own rows', async () => {
    second = await seed(secondCookie, 'Second');
    expect(second.spaceId).not.toBe(first.spaceId);
    expect(second.principalId).not.toBe(first.principalId);
  }, 60_000);

  test('isolation holds in both directions once both accounts hold data', async () => {
    await isolated(second.cookie, first, second.agentId);
    await isolated(first.cookie, second, first.agentId);
  }, 120_000);

  test('an approval is decided only by the principal whose job asked for it', async () => {
    const { sql } = database();
    if (!jobs || !runner) throw new Error('Postgres unavailable');
    // The service hooks the shared runner; the tests after this one run without it.
    const hook = runner.onApprovalWait;
    const approvals = new ApprovalService(jobs, runner);
    runner.onApprovalWait = hook;
    const [pending] = await sql`select payload_hash, decision from approval
      where id = ${first.permissionId}`;
    expect(pending?.decision).toBeNull();
    const answer = { decision: 'approved' as const, payload_hash: String(pending?.payload_hash) };
    // Another account holds the right id and the right bytes, and is still refused.
    let refused: unknown;
    try {
      await approvals.decide(first.permissionId, answer, second.principalId);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe('scope_denied');
    const [after] = await sql`select decision from approval where id = ${first.permissionId}`;
    expect(after?.decision).toBeNull();
  }, 60_000);

  test('each account fully works inside its own space', async () => {
    const { sql } = database();
    for (const actor of [first, second]) {
      const home = await call(actor.cookie, '/home');
      expect(home.status).toBe(200);
      const homeBody = await json<{ upcoming: unknown; tasks: { id: string }[] }>(home);
      expect(Array.isArray(homeBody.upcoming)).toBe(true);
      expect(homeBody.tasks.map((entry) => entry.id)).toContain(actor.taskId);
      const listed = await json<{ permissions: { id: string; version: string }[] }>(
        await call(actor.cookie, '/permissions'),
      );
      const pending = listed.permissions.find((entry) => entry.id === actor.permissionId);
      expect(pending).toBeDefined();
      const decided = await call(actor.cookie, `/permissions/${actor.permissionId}`, 'POST', {
        option: 'deny',
        version: pending?.version,
      });
      expect(decided.status).toBe(200);
      const sent = await call(actor.cookie, `/drafts/${actor.draftId}/send`, 'POST');
      expect(sent.status).toBe(200);
      const sentBody = await json<{ permission: { id: string; version: string } | null }>(sent);
      expect(sentBody.permission).not.toBeNull();
      const sendsBefore = calls.filter((entry) => entry.kind === 'email.send').length;
      const allowed = await call(actor.cookie, `/permissions/${sentBody.permission?.id}`, 'POST', {
        option: 'allow_once',
        version: sentBody.permission?.version,
      });
      expect(allowed.status).toBe(200);
      expect(calls.filter((entry) => entry.kind === 'email.send')).toHaveLength(sendsBefore + 1);
      // Each decision rides the conversation's stream, so a reload shows it decided.
      const stream = await json<{
        events: { item: { type: string; decision?: { id: string; outcome: string } } }[];
      }>(await call(actor.cookie, `/conversations/${actor.conversationId}/events?limit=200`));
      // The setup's own allowed calendar event is decided earlier on the same stream,
      // so these two are the last decisions on it, in the order they were made.
      expect(
        stream.events
          .flatMap((event) =>
            event.item.type === 'decision' && event.item.decision
              ? [[event.item.decision.id, event.item.decision.outcome]]
              : [],
          )
          .slice(-2),
      ).toEqual([
        [actor.permissionId, 'deny'],
        [sentBody.permission?.id ?? '', 'allow_once'],
      ]);
      const undone = await call(actor.cookie, `/receipts/${actor.undoHandle}/undo`, 'POST');
      expect(undone.status).toBe(200);
      expect(await undone.text()).toContain('Removed an event');
      const commands = await sql`select principal_id from job where space_id = ${actor.spaceId}
        and kind = 'command'`;
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((entry) => entry.principal_id === actor.principalId)).toBe(true);
      for (const suffix of ['', '/messages', '/events', '/cards', '/receipts', '/drafts']) {
        const path = `/conversations/${actor.conversationId}${suffix}`;
        expect([path, (await call(actor.cookie, path)).status]).toEqual([path, 200]);
      }
      const messages = await call(actor.cookie, `/conversations/${actor.conversationId}/messages`);
      expect(await messages.text()).toContain(`${actor.label} private question`);
      const content = await call(actor.cookie, `/artifacts/${actor.artifactId}/content`);
      expect(content.status).toBe(200);
      expect(await content.text()).toBe(`${actor.label} private notes`);
      expect(
        (
          await call(actor.cookie, `/messages/${actor.messageId}/reactions`, 'POST', {
            emoji: '👍',
          })
        ).status,
      ).toBe(201);
      expect((await call(actor.cookie, `/jobs/${actor.conversationId}/reactions`)).status).toBe(
        200,
      );
      const search = await call(actor.cookie, `/search?q=${actor.label}`);
      expect(await search.text()).toContain(actor.conversationId);
      const takeover = await call(
        actor.cookie,
        `/browser/sessions/${actor.browserSession}/takeover`,
        'POST',
      );
      expect(takeover.status).toBe(200);
      expect(await json(takeover)).toMatchObject({ control: 'human' });
    }
  }, 120_000);

  test('an account without a personal space receives exactly one, also under concurrent requests', async () => {
    const { sql } = database();
    const id = recordId('own');
    await sql`insert into principal (id, email, password_hash) values (${id}, 'third@example.test',
      ${await Bun.password.hash(password, { algorithm: 'argon2id' })})`;
    const cookie = await login('third@example.test');
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(cookie, '/tasks')));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain('First groceries');
      expect(text).not.toContain('Second groceries');
    }
    const owned = await sql`select id, kind, git_path from space where owner_principal_id = ${id}`;
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      kind: 'personal',
      git_path: join(root, String(owned[0]?.id)),
    });
    const again = await login('third@example.test');
    expect(
      (await call(again, '/tasks', 'POST', { title: 'Third errand', due_at: null })).status,
    ).toBe(200);
    expect(await sql`select id from space where owner_principal_id = ${id}`).toHaveLength(1);
    const [stored] = await sql`select space_id from task where title = 'Third errand'`;
    expect(stored?.space_id).toBe(owned[0]?.id);
    expect(await (await call(first.cookie, '/tasks')).text()).not.toContain('Third errand');
  }, 60_000);

  test('a selected shared space needs current membership and keeps other members jobs private', async () => {
    const { sql } = database();
    const shared = await json<{ space: { id: string } }>(
      await call(first.cookie, '/spaces/shared', 'POST', { name: 'Household' }),
    );
    const sharedId = shared.space.id;
    const grant = async () =>
      json<{ membership: { generation: number } }>(
        await call(first.cookie, `/spaces/${sharedId}/memberships`, 'POST', {
          principal_id: second.principalId,
        }),
      );
    const granted = await grant();
    const ownersJob = recordId('job');
    await sql`insert into job (id, space_id, principal_id, title, objective, kind, budget)
      values (${ownersJob}, ${sharedId}, ${first.principalId}, 'Owner household chat', 'Private', 'chat',
        ${JSON.stringify(defaultBudget)}::jsonb)`;
    const cookie = await login('second@example.test');
    const digest = createHash('sha256')
      .update(cookie.split('=')[1] ?? '')
      .digest('hex');
    // A stored selection of somebody else's personal space is ignored.
    await sql`update session set space_id = ${first.spaceId}, membership_generation = 0
      where token_hash = ${digest}`;
    const forged = await call(cookie, '/tasks');
    expect(forged.status).toBe(200);
    const forgedText = await forged.text();
    expect(forgedText).not.toContain('First groceries');
    expect(forgedText).toContain('Second groceries');
    await sql`update session set space_id = ${sharedId},
      membership_generation = ${granted.membership.generation} where token_hash = ${digest}`;
    const inside = await call(cookie, '/conversations');
    expect(inside.status).toBe(200);
    const insideText = await inside.text();
    expect(insideText).not.toContain(ownersJob);
    expect(insideText).not.toContain(second.conversationId);
    expect((await call(cookie, `/conversations/${ownersJob}`)).status).toBe(404);
    expect((await call(cookie, `/conversations/${ownersJob}/messages`)).status).toBe(404);
    expect(await (await call(cookie, '/search?q=household')).text()).not.toContain(ownersJob);
    expect(await (await call(cookie, '/events?view=experience')).text()).not.toContain(ownersJob);
    // A member does not administer the personal surfaces of a space somebody else owns.
    expect((await call(cookie, '/tasks')).status).toBe(403);
    expect((await call(cookie, '/rules')).status).toBe(403);
    // Revoking and granting again yields a new generation; the old selection stays dead.
    expect(
      (await call(first.cookie, `/spaces/${sharedId}/memberships/${second.principalId}`, 'DELETE'))
        .status,
    ).toBe(200);
    expect(await (await call(cookie, '/tasks')).text()).toContain('Second groceries');
    const regranted = await grant();
    expect(regranted.membership.generation).toBeGreaterThan(granted.membership.generation);
    expect(await (await call(cookie, '/conversations')).text()).toContain(second.conversationId);
  }, 60_000);

  test('only the job’s own principal speaks in it, and a message says who spoke', async () => {
    const { sql } = database();
    if (!jobs) throw new Error('Postgres unavailable');
    const club = (
      await json<{ space: { id: string } }>(
        await call(first.cookie, '/spaces/shared', 'POST', { name: 'Book club' }),
      )
    ).space.id;
    expect(
      (
        await call(first.cookie, `/spaces/${club}/memberships`, 'POST', {
          principal_id: second.principalId,
        })
      ).status,
    ).toBe(201);
    const ownersJob = recordId('job');
    await sql`insert into job (id, space_id, principal_id, title, objective, kind, state, budget)
      values (${ownersJob}, ${club}, ${first.principalId}, 'Owner book chat', 'Private', 'chat',
        'waiting_for_input', ${JSON.stringify(defaultBudget)}::jsonb)`;
    const said = () =>
      sql`select payload from event where job_id = ${ownersJob}
        and payload->>'kind' = 'user_message' order by seq`;
    const member = await login('second@example.test');

    // A member of the space cannot put words in the owner's conversation, by any route.
    for (const path of [`/jobs/${ownersJob}/input`, `/jobs/${ownersJob}/messages`])
      expect((await call(member, path, 'POST', { text: 'From a member' })).status).toBe(403);
    await expect(
      principalContext.run(second.principalId, () => jobs.input(ownersJob, 'From a member')),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    expect(await said()).toHaveLength(0);

    // The owner still can, and the message records who said it.
    const own = await call(first.cookie, `/jobs/${ownersJob}/input`, 'POST', {
      text: 'From the owner',
    });
    expect(own.status).toBeLessThan(300);
    const messages = await said();
    expect(messages.map((row) => row.payload)).toEqual([
      { kind: 'user_message', text: 'From the owner', principal_id: first.principalId },
    ]);
  }, 60_000);

  test('triggers and event deliveries answer only to the job owner and the setup owner', async () => {
    const { sql } = database();
    const [mail] = await sql`select id from connection where space_id = ${first.spaceId}
      and provider = ${emailManifest.provider} order by id limit 1`;
    const connection = String(mail?.id);
    // No trigger watches this one, so nothing downstream of the route has a job
    // to refuse on: only the route's own guard stands between a stranger and it.
    const [unwatched] = await sql`select id from connection where space_id = ${first.spaceId}
      and provider = ${calendarManifest.provider} order by id limit 1`;
    const quiet = String(unwatched?.id);
    const watch = (connectionId: string) => ({
      kind: 'event',
      connection_id: connectionId,
      event_name: 'mail.new',
    });
    const delivery = (key: string, connectionId = connection) => ({
      connection_id: connectionId,
      event_name: 'mail.new',
      cursor: key,
      dedup_key: key,
      payload: { subject: 'hello' },
    });
    const count = async () =>
      Number(
        (
          await sql`select count(*)::int as n from trigger where job_id = ${first.conversationId}`
        )[0]?.n,
      );

    // The job's own principal can watch its own connection, and the setup owner can deliver.
    expect(
      (
        await call(
          first.cookie,
          `/jobs/${first.conversationId}/triggers`,
          'POST',
          watch(connection),
        )
      ).status,
    ).toBe(201);
    expect(
      (await call(first.cookie, '/internal/events/deliver', 'POST', delivery('own'))).status,
    ).toBe(202);
    const triggersBefore = await count();

    // Another account can do neither against the first account's job or connection.
    expect(
      (
        await call(
          second.cookie,
          `/jobs/${first.conversationId}/triggers`,
          'POST',
          watch(connection),
        )
      ).status,
    ).toBe(403);
    for (const target of [connection, quiet]) {
      expect(
        (
          await call(
            second.cookie,
            '/internal/events/deliver',
            'POST',
            delivery('stranger', target),
          )
        ).status,
      ).toBe(403);
      // An event written here would also make the real one with this key a duplicate.
      expect(
        await sql`select 1 from event where dedup_key = ${`connector:${target}:stranger`}`,
      ).toHaveLength(0);
    }
    expect(await count()).toBe(triggersBefore);

    // A member of a shared space cannot add a trigger to the space owner's job there.
    const club = (
      await json<{ space: { id: string } }>(
        await call(first.cookie, '/spaces/shared', 'POST', { name: 'Club' }),
      )
    ).space.id;
    expect(
      (
        await call(first.cookie, `/spaces/${club}/memberships`, 'POST', {
          principal_id: second.principalId,
        })
      ).status,
    ).toBe(201);
    const ownersJob = recordId('job');
    await sql`insert into job (id, space_id, principal_id, title, objective, kind, budget)
      values (${ownersJob}, ${club}, ${first.principalId}, 'Club chat', 'Private', 'chat',
        ${JSON.stringify(defaultBudget)}::jsonb)`;
    const clubMail = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${clubMail}, ${club}, ${emailManifest.provider}, 'Club mail', '["email.search"]'::jsonb)`;
    const member = await login('second@example.test');
    expect(
      (await call(member, `/jobs/${ownersJob}/triggers`, 'POST', watch(clubMail))).status,
    ).toBe(403);
    expect(await sql`select 1 from trigger where job_id = ${ownersJob}`).toHaveLength(0);
    // Nor can a member deliver an event on the shared space's own connection.
    expect(
      (await call(member, '/internal/events/deliver', 'POST', delivery('member', clubMail))).status,
    ).toBe(403);
    expect(
      await sql`select 1 from event where dedup_key = ${`connector:${clubMail}:member`}`,
    ).toHaveLength(0);
  }, 60_000);
});
