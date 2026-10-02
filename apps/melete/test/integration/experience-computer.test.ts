/**
 * A conversation's computer through the real service: the page its agent's browser is on, the
 * commands it ran, and who holds the browser. The browser half runs real Chromium in the worker,
 * the connector and its artifact sink, and the take-over and hand-back routes; the page the
 * person hands back carries a code in its title and a token in its address, and neither may
 * reach the view.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  type AgentComputer,
  agentComputer,
  agentResponse,
  conversationResponse,
  experienceResult,
} from '@melete/contracts';
import { createBrowserConnector } from '../../src/connectors/browser.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const queue = database ? await startQueue(database.url) : null;
/** Conversations are jobs; creating one needs the job service. */
const jobs = database && queue ? new JobService(database.db, queue.boss) : undefined;
const PASSWORD = 'a-long-enough-password';
/** What the page a person signs in to shows once they are through. */
const CODE = '482913';
const TOKEN = 'k7qp2x9mzr4t';
const withDb = database ? describe : describe.skip;

function handle() {
  if (!database) throw new Error('Postgres unavailable');
  return database;
}

type App = ReturnType<typeof createApp>;
const sessionCookie = (response: Response) => {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`expected a session cookie (${response.status})`);
  return value;
};

/** An owner, a second person on the same service, and a conversation that belongs to the owner. */
async function people(app: App, friend: string) {
  const owner = JSON.stringify({ email: 'owner@example.test', password: PASSWORD });
  const headers = { 'Content-Type': 'application/json' };
  // The first suite sets the service up; the second signs in to the same owner.
  const setup = await app.request('/setup', { method: 'POST', headers, body: owner });
  const cookie = sessionCookie(
    setup.status === 201
      ? setup
      : await app.request('/login', { method: 'POST', headers, body: owner }),
  );
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers: {
          Cookie: init.cookie ?? cookie,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  expect(
    (
      await call('/principals', {
        method: 'POST',
        body: { email: friend, password: PASSWORD },
      })
    ).status,
  ).toBe(201);
  const friendCookie = sessionCookie(
    await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: friend, password: PASSWORD }),
    }),
  );
  const persona = agentResponse.parse(
    await (
      await call('/agents', { method: 'POST', body: AGENT_TEMPLATES.templates[0]?.agent })
    ).json(),
  ).agent;
  const conversation = async (title: string) =>
    conversationResponse.parse(
      await (
        await call('/conversations', { method: 'POST', body: { title, agent_id: persona.id } })
      ).json(),
    ).conversation.id;
  const chatId = await conversation('Book the table');
  const [row] = await handle().sql`select space_id from job where id = ${chatId}`;
  const spaceId = String(row?.space_id);
  const attemptId = newId('att');
  await handle().sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${chatId}, 1, 'fake', 'fake', 'scripted')`;
  const computer = async (id: string, as = cookie) => {
    const response = await call(`/conversations/${id}/computer`, { cookie: as });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const view = async (id: string): Promise<AgentComputer> => {
    const read = await computer(id);
    expect(read.status).toBe(200);
    return agentComputer.parse(experienceResult(agentComputer).parse(read.body));
  };
  return { cookie, friendCookie, call, conversation, chatId, spaceId, attemptId, computer, view };
}

/** An action row as the broker leaves it once the connector has answered. */
async function recordAction(input: {
  id?: string;
  jobId: string;
  attemptId: string;
  connectionId: string;
  kind: string;
  effectClass?: string;
  payload: Record<string, unknown>;
  status: string;
  receipt?: unknown;
}) {
  const id = input.id ?? newId('act');
  const payload = JSON.stringify(input.payload);
  await handle().sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
    values (${id}, ${input.jobId}, ${input.attemptId}, ${input.connectionId}, ${input.kind},
      ${input.effectClass ?? 'read'}, ${payload}::jsonb,
      ${createHash('sha256').update(payload).digest('hex')}, ${input.status}, ${id},
      ${input.receipt === undefined ? null : JSON.stringify(input.receipt)}::jsonb,
      ${input.status === 'succeeded' ? new Date().toISOString() : null}::timestamptz)`;
  return id;
}

withDb('the computer view from recorded work', () => {
  let app: App;
  let who: Awaited<ReturnType<typeof people>>;

  beforeAll(async () => {
    const { db, sql } = handle();
    app = createApp({
      db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql,
      jobs,
      checkDatabase: async () => 'ok',
    });
    who = await people(app, 'friend@example.test');
  }, 60_000);

  test('a conversation with nothing on its computer says what can be connected', async () => {
    const empty = await who.view(who.chatId);
    expect(empty).toEqual({
      browser: null,
      terminal: [],
      processes: [],
      available: { browser: false, terminal: false },
    });
  });

  test('another person on the same service gets no view of it, and no conversation gets made up', async () => {
    expect((await who.computer(who.chatId, who.friendCookie)).status).toBe(404);
    expect((await who.computer('job_absent')).status).toBe(404);
  });

  test('terminal commands show what they printed, last lines first to go, credentials hidden', async () => {
    const sandbox = newId('conn');
    await handle().sql`insert into connection (id, space_id, provider, label, scopes)
      values (${sandbox}, ${who.spaceId}, 'sandbox', 'Sandbox', '["terminal.run"]'::jsonb)`;
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    await recordAction({
      jobId: who.chatId,
      attemptId: who.attemptId,
      connectionId: sandbox,
      kind: 'terminal.run',
      effectClass: 'write_reversible',
      payload: { command: 'ls -la\ncat notes.txt' },
      status: 'succeeded',
      receipt: {
        detail: {
          output: `${lines.join('\n')}\nAPI_KEY=sk-live-abcdefghijklmnop\n\u001b[32mgreen\u001b[0m\n`,
          output_binary: false,
          exit_code: 0,
        },
      },
    });
    await recordAction({
      jobId: who.chatId,
      attemptId: who.attemptId,
      connectionId: sandbox,
      kind: 'terminal.run',
      effectClass: 'write_reversible',
      payload: { command: 'bun test' },
      status: 'dispatched',
    });
    const view = await who.view(who.chatId);
    expect(view.available).toEqual({ browser: false, terminal: true });
    expect(view.terminal.map((entry) => [entry.command, entry.status])).toEqual([
      ['ls -la\ncat notes.txt', 'done'],
      ['bun test', 'running'],
    ]);
    const output = view.terminal[0]?.output ?? '';
    expect(output.split('\n').at(-1)).toBe('green');
    expect(output).toContain('[hidden]');
    expect(output).not.toContain('sk-live');
    expect(output).not.toContain('line 1\n');
    expect(output).toContain('line 60');
    expect(view.terminal[0]?.exit_code).toBe(0);
    expect(view.terminal[1]?.output).toBe('');
    // The view is the conversation's own: another of the owner's conversations stays empty.
    const other = await who.conversation('Something else');
    expect((await who.view(other)).terminal).toEqual([]);
  });
});

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
const suite = database && chromiumAvailable ? describe : describe.skip;

suite('the computer view of a real browser, across a take-over and a hand-back', () => {
  let root = '';
  let pool: BrowserWorkerPool;
  let sessions: BrowserSessionService;
  let app: App;
  let who: Awaited<ReturnType<typeof people>>;
  let site: ReturnType<typeof Bun.serve>;
  const visits: string[] = [];
  let connectionId = '';
  let sessionId = '';

  const constraints = {
    public_compartment: false,
    allowed_domains: ['127.0.0.1'],
    deliverable: { kind: 'none' as const },
  };
  /** One browser action through the real connector, recorded as the broker records it. */
  const act = async (kind: string, payload: Record<string, unknown>) => {
    const id = newId('act');
    const connector = createBrowserConnector({
      sessions,
      artifacts: browserArtifactSink(handle().sql, root),
      spaceId: who.spaceId,
    });
    const outcome = await connector.execute(
      {
        id,
        job_id: who.chatId,
        attempt_id: who.attemptId,
        connection_id: connectionId,
        kind,
        canonical_payload: payload,
        idempotency_key: id,
      } as unknown as Action,
      { job_id: who.chatId, space_id: who.spaceId, idempotency_key: id, constraints },
    );
    if (outcome.outcome !== 'succeeded')
      throw new Error(`browser ${kind}: ${JSON.stringify(outcome)}`);
    await recordAction({
      id,
      jobId: who.chatId,
      attemptId: who.attemptId,
      connectionId,
      kind,
      payload,
      status: 'succeeded',
      receipt: outcome.receipt,
    });
    const detail = outcome.receipt.detail as { session_id: string; control_epoch: number };
    sessionId = detail.session_id;
    return detail;
  };

  beforeAll(async () => {
    const { db, sql } = handle();
    // A page the agent opens, which moves on by itself to an account page, as a person's sign-in
    // would, a moment after the person has taken the browser.
    site = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        visits.push(url.pathname);
        const page = (title: string, body: string) =>
          new Response(
            `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head><body>${body}</body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        if (url.pathname === '/start')
          return page(
            'Luna Trattoria · Book a table',
            `<h1>Luna Trattoria</h1><a href="/account/${TOKEN}?session=${TOKEN}" style="position:absolute;inset:0;display:block">Choose 7:30 PM</a>`,
          );
        if (url.pathname.startsWith('/account/'))
          return page(`Your code is ${CODE}`, `<h1>Signed in</h1><p>Your code is ${CODE}</p>`);
        return new Response('Not found', { status: 404 });
      },
    });
    root = await mkdtemp(join(tmpdir(), 'melete-computer-'));
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>Melete</title>\n');
    pool = new BrowserWorkerPool({
      spacesRoot: root,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [site.url.origin],
    });
    sessions = new BrowserSessionService(sql, pool);
    app = createApp({
      db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      sql,
      jobs,
      browserSessions: sessions,
      checkDatabase: async () => 'ok',
    });
    who = await people(app, 'neighbour@example.test');
    connectionId = newId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes, configuration)
      values (${connectionId}, ${who.spaceId}, 'web', 'Browser', '["browser.observe"]'::jsonb,
        '{"kind":"browser"}'::jsonb)`;
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
    site?.stop(true);
    await queue?.stop();
    await handle().close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  test('before any browsing, the view is empty and says a browser can be used', async () => {
    const view = await who.view(who.chatId);
    expect(view.browser).toBeNull();
    expect(view.available.browser).toBe(true);
  });

  test('the page the agent is on, with its title and a picture only its owner can open', async () => {
    const first = await act('browser.observe', {});
    await act('browser.open', {
      session_id: first.session_id,
      control_epoch: first.control_epoch,
      url: `${site.url.origin}/start`,
      after_observation: 'first',
    });
    await act('browser.observe', {
      session_id: first.session_id,
      control_epoch: first.control_epoch,
    });
    const view = await who.view(who.chatId);
    expect(view.browser).toMatchObject({
      session_id: sessionId,
      control: 'agent',
      url: `${site.url.origin}/start`,
      title: 'Luna Trattoria · Book a table',
    });
    const picture = view.browser?.screenshot?.artifact_id ?? '';
    expect(picture).toMatch(/^art_/);
    const own = await who.call(`/artifacts/${picture}/content`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('image/png');
    expect(
      (await who.call(`/artifacts/${picture}/content`, { cookie: who.friendCookie })).status,
    ).toBe(404);
    expect((await who.computer(who.chatId, who.friendCookie)).status).toBe(404);
  }, 60_000);

  test('a handed-back page shows no picture, and no code or token from its title or address', async () => {
    const opened = await act('browser.observe', {});
    await act('browser.open', {
      session_id: opened.session_id,
      control_epoch: opened.control_epoch,
      url: `${site.url.origin}/start`,
      after_observation: 'again',
    });
    // Another person cannot take the browser; its owner can.
    expect(
      (
        await who.call(`/browser/sessions/${sessionId}/takeover`, {
          method: 'POST',
          cookie: who.friendCookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (await who.call(`/browser/sessions/${sessionId}/takeover`, { method: 'POST' })).status,
    ).toBe(200);
    expect((await who.view(who.chatId)).browser?.control).toBe('you');
    // The person signs in through their live view: one click on the page, and it moves on.
    const live = `/browser/sessions/${sessionId}/live`;
    const channel = (await (await who.call(live, { method: 'POST' })).json()) as {
      live_id: string;
    };
    const abort = new AbortController();
    const stream = await app.request(`${live}/frames?live_id=${channel.live_id}`, {
      headers: { Cookie: who.cookie },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    let text = '';
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader?.read().catch(() => undefined);
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    })();
    const deadline = Date.now() + 20_000;
    while (!text.includes('event: frame') && Date.now() < deadline) await Bun.sleep(50);
    const seq = Number(/^id: (\d+)$/m.exec(text)?.[1] ?? 0);
    const click = { x: 500, y: 400, button: 0, mods: 0, clicks: 1 };
    const sent = await who.call(`${live}/input`, {
      method: 'POST',
      body: {
        live_id: channel.live_id,
        ack_through: seq,
        events: [
          { k: 'down', ...click },
          { k: 'up', ...click },
        ],
      },
    });
    expect(sent.status).toBe(200);
    while (!visits.some((path) => path.startsWith('/account/')) && Date.now() < deadline)
      await Bun.sleep(50);
    expect(visits.some((path) => path.startsWith('/account/'))).toBe(true);
    abort.abort();
    await reader?.cancel().catch(() => {});
    await pump;
    await Bun.sleep(300);
    const back = await who.call(`/browser/sessions/${sessionId}/handback`, { method: 'POST' });
    expect(back.status).toBe(200);
    const epoch = ((await back.json()) as { control_epoch: number }).control_epoch;
    await act('browser.observe', { session_id: sessionId, control_epoch: epoch });
    const view = await who.view(who.chatId);
    expect(view.browser?.control).toBe('agent');
    expect(view.browser?.screenshot).toBeNull();
    const shown = JSON.stringify(view);
    expect(shown).not.toContain(CODE);
    expect(shown).not.toContain(TOKEN);
    expect(view.browser?.url?.startsWith(`${site.url.origin}/account/`)).toBe(true);
    // What the page shows, its title included, is withheld until automation leaves it.
    expect(view.browser?.title).toBeNull();
  }, 90_000);
});
