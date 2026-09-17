/**
 * A person's live browser view through the real service: the cookie session, the same-origin
 * fences, Server-Sent Events down and posts up, against real Chromium and embedded Postgres.
 * The person signs in to the two-site fixture by hand and the database is searched afterwards
 * for anything they typed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveOpen } from '@melete/contracts';
import { createStaticServer } from '../../../../deploy/scripts/serve-static.ts';
import { apiFetch, apiNetwork, trustedProxy } from '../../src/api/listener.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { type BrowserWorkerClient, BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import type { LiveDown, LiveInput } from '../../src/workers/browser/live-protocol.ts';
import {
  type BrowserRecipeCandidate,
  PostgresBrowserRecipeStore,
} from '../../src/workers/browser/recipes.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import { BrowserFault } from '../../src/workers/browser/sessions.ts';
import { seedJob } from '../helpers/broker.ts';
import { SIGN_IN, SIGN_IN_POINTS, startSignInFixture } from '../helpers/browser-fixture.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const PASSWORD = 'a-long-enough-password';
/** Short windows so a person's absence is visible inside a test. */
const IMPATIENT = { still_there_ms: 400, idle_close_ms: 1400, reconnect_ms: 8000 };
const PRESENCE = { still_there_ms: 2000, idle_close_ms: 120_000, reconnect_ms: 1000 };
/** Long windows, so that only the checks a request makes can refuse it. */
const UNHURRIED = { still_there_ms: 120_000, idle_close_ms: 120_000, reconnect_ms: 120_000 };

function handle() {
  if (!database) throw new Error('Postgres unavailable');
  return database;
}

/** One live view, read as the panel reads it: parse each event, keep the last frame sequence. */
function viewer(response: Response, abort?: AbortController) {
  const events: LiveDown[] = [];
  const seqs: number[] = [];
  let where = '';
  let closed = false;
  const reader = response.body?.getReader();
  const pump = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = block.split('\n').find((part) => part.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice('data: '.length)) as LiveDown;
        events.push(event);
        if (event.type === 'frame') seqs.push(event.seq);
        if (event.type === 'where') where = event.url;
      }
    }
    closed = true;
  })();
  const view = {
    events,
    seqs,
    frames: () => seqs.length,
    seq: () => seqs[seqs.length - 1] ?? 0,
    where: () => where,
    closed: () => closed,
    notices: () =>
      events.flatMap((event) => (event.type === 'notice' ? [event.code as string] : [])),
    ended: () => events.find((event) => event.type === 'ended'),
    wait: async (predicate: () => boolean, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !predicate()) await Bun.sleep(25);
      return predicate();
    },
    stop: async () => {
      abort?.abort();
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
  return view;
}
type Viewer = ReturnType<typeof viewer>;

const point = (part: { x: number; y: number }): LiveInput[] => [
  { k: 'down', ...part, button: 0, mods: 0, clicks: 1 },
  { k: 'up', ...part, button: 0, mods: 0, clicks: 1 },
];
/** Empty space on the account page: nothing to focus, so nothing keeps repainting. */
const QUIET_SPOT = { x: 20, y: 700 };
const ENTER: LiveInput[] = [
  { k: 'key', down: true, key: 'Enter', code: 'Enter', vk: 13, mods: 0, text: '\r' },
  { k: 'key', down: false, key: 'Enter', code: 'Enter', vk: 13, mods: 0 },
];

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
const suite = database && chromiumAvailable ? describe : describe.skip;

suite('a person steering the browser through the service', () => {
  let fixture: ReturnType<typeof startSignInFixture>;
  let root = '';
  let pool: BrowserWorkerPool;
  let sessions: BrowserSessionService;
  let app: ReturnType<typeof createApp>;
  let impatient: ReturnType<typeof createApp>;
  let unhurried: ReturnType<typeof createApp>;
  let cookie = '';
  let friendCookie = '';
  let principalId = '';
  let friendId = '';
  let spaceId = '';
  let jobId = '';
  let sessionId = '';
  let epoch = 0;
  let worker: BrowserWorkerClient;
  let liveId = '';
  let view: Viewer;

  const sessionCookie = (response: Response) => {
    const value = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session='));
    if (!value) throw new Error(`expected a session cookie (${response.status})`);
    return value;
  };
  const call = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      headers?: Record<string, string>;
      address?: string;
      on?: ReturnType<typeof createApp>;
    } = {},
  ): Promise<Response> =>
    Promise.resolve(
      (options.on ?? app).request(
        path,
        {
          method: options.method ?? 'GET',
          headers: {
            Cookie: options.cookie ?? cookie,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        },
        options.address ? { clientAddress: options.address } : undefined,
      ),
    );
  const refusal = async (response: Response): Promise<[number, string | undefined]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code,
  ];
  const live = (suffix = '') => `/browser/sessions/${sessionId}/live${suffix}`;
  const frames = (id = liveId) => live(`/frames?live_id=${id}`);
  const command = (operation: unknown) =>
    worker.request<BrowserCommandResult>('/command', {
      session_id: sessionId,
      job_id: jobId,
      control_epoch: epoch,
      operation,
    });
  const send = (events: LiveInput[], id = liveId, on?: ReturnType<typeof createApp>) =>
    call(live('/input'), {
      method: 'POST',
      cookie,
      body: { live_id: id, ack_through: view?.seq() ?? 0, events },
      ...(on ? { on } : {}),
    });
  const open = async (on?: ReturnType<typeof createApp>) => {
    const response = await call(live(), { method: 'POST', ...(on ? { on } : {}) });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`the live view did not open: ${text}`);
    return JSON.parse(text) as LiveOpen;
  };
  const watch = async (id = liveId, resume?: number, on?: ReturnType<typeof createApp>) =>
    viewer(
      await call(frames(id), {
        ...(resume === undefined ? {} : { headers: { 'Last-Event-ID': String(resume) } }),
        ...(on ? { on } : {}),
      }),
    );
  const control = async (operation: 'takeover' | 'handback') => {
    const response = await call(`/browser/sessions/${sessionId}/${operation}`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { control_epoch: number; control: string };
    epoch = body.control_epoch;
    return body;
  };

  beforeAll(async () => {
    const { sql, db } = handle();
    fixture = startSignInFixture();
    root = await mkdtemp(join(tmpdir(), 'melete-live-service-'));
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>Melete</title>\n');
    pool = new BrowserWorkerPool({
      spacesRoot: root,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [fixture.app, fixture.idp, fixture.other],
    });
    const env = loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root });
    sessions = new BrowserSessionService(sql, pool, {
      live: { presence: PRESENCE, pullMs: 400 },
    });
    app = createApp({ db, env, sql, browserSessions: sessions, checkDatabase: async () => 'ok' });
    const service = (presence: typeof PRESENCE, pullMs: number) =>
      createApp({
        db,
        env,
        sql,
        browserSessions: new BrowserSessionService(sql, pool, { live: { presence, pullMs } }),
        checkDatabase: async () => 'ok',
      });
    impatient = service(IMPATIENT, 200);
    unhurried = service(UNHURRIED, 400);

    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: PASSWORD }),
    });
    expect(setup.status).toBe(201);
    cookie = sessionCookie(setup);
    principalId = ((await (await call('/me')).json()) as { owner: { id: string } }).owner.id;
    expect(
      (
        await call('/principals', {
          method: 'POST',
          body: { email: 'friend@example.test', password: PASSWORD },
        })
      ).status,
    ).toBe(201);
    const signedIn = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'friend@example.test', password: PASSWORD }),
    });
    friendCookie = sessionCookie(signedIn);
    friendId = (
      (await (await call('/me', { cookie: friendCookie })).json()) as { owner: { id: string } }
    ).owner.id;

    // One shared space, both people in it, and a job that belongs to the first person.
    const seeded = await seedJob(sql, {
      provider: 'web',
      constraints: { allowed_domains: ['127.0.0.1'] },
    });
    spaceId = seeded.claims.space_id;
    jobId = seeded.claims.job_id;
    await sql`update space set kind = 'shared', owner_principal_id = ${principalId}
      where id = ${spaceId}`;
    await sql`update job set principal_id = ${principalId} where id = ${jobId}`;
    await sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${principalId}, ${spaceId}, 'owner', 1), (${friendId}, ${spaceId}, 'member', 1)`;

    const leased = await sessions.lease({
      job_id: jobId,
      space_id: spaceId,
      idempotency_key: 'live-service',
      constraints: {
        public_compartment: false,
        allowed_domains: ['127.0.0.1'],
        deliverable: { kind: 'none' },
      },
    });
    sessionId = leased.session.id;
    epoch = leased.session.control_epoch;
    worker = leased.worker;
    await command({ kind: 'observe' });
    // The sign-in page shows a password field, so the agent is refused and the person is needed.
    await command({ kind: 'open', url: `${fixture.app}/signin` }).catch(() => {});
    await control('takeover');
  }, 120_000);

  afterAll(async () => {
    await view?.stop();
    await pool?.close();
    await fixture?.close();
    await handle().close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  test('a second viewer is refused live_taken', async () => {
    const opened = await open();
    expect(opened).toMatchObject({
      control_epoch: epoch,
      viewport: { width: 1024, height: 768 },
      site_scope: ['127.0.0.1'],
    });
    expect(opened.live_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    liveId = opened.live_id;
    expect(await refusal(await call(live(), { method: 'POST' }))).toEqual([409, 'live_taken']);
    view = await watch();
    expect(await view.wait(() => view.frames() > 0)).toBe(true);
    expect(await view.wait(() => view.where() === `${fixture.app}/signin`)).toBe(true);
    // A viewer is attached, so the second opener is still refused rather than taking it over.
    expect(await refusal(await call(live(), { method: 'POST' }))).toEqual([409, 'live_taken']);
    expect(view.ended()).toBeUndefined();
  }, 60_000);

  test('another principal in the same space cannot open, read or drive the live view', async () => {
    const frameCount = view.frames();
    const refused = await Promise.all([
      call(live(), { method: 'POST', cookie: friendCookie }).then(refusal),
      call(frames(), { cookie: friendCookie }).then(refusal),
      call(live('/input'), {
        method: 'POST',
        cookie: friendCookie,
        body: { live_id: liveId, ack_through: 0, events: [{ k: 'text', text: 'not-yours' }] },
      }).then(refusal),
      call(live('/scope'), {
        method: 'POST',
        cookie: friendCookie,
        body: { live_id: liveId, host: '127.0.0.9' },
      }).then(refusal),
      call(live('/close'), {
        method: 'POST',
        cookie: friendCookie,
        body: { live_id: liveId },
      }).then(refusal),
    ]);
    const absent: [number, string] = [404, 'session_not_found'];
    expect(refused).toEqual([absent, absent, absent, absent, absent]);
    expect(JSON.stringify(fixture.requests)).not.toContain('not-yours');
    // The person's own view is untouched: still open, still painting, still theirs to drive.
    expect(view.ended()).toBeUndefined();
    expect(await send(point(SIGN_IN_POINTS.first_field))).toMatchObject({ status: 200 });
    expect(await view.wait(() => view.frames() > frameCount)).toBe(true);
  }, 60_000);

  test('a cross-site page cannot open the live stream', async () => {
    const cross: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of cross) {
      expect(await refusal(await call(live(), { method: 'POST', headers }))).toEqual([
        403,
        'origin_rejected',
      ]);
      // A read is a GET, so this route makes the same-origin check the mutation middleware makes.
      expect(await refusal(await call(frames(), { headers }))).toEqual([403, 'origin_refused']);
      expect(
        await refusal(
          await call(live('/input'), {
            method: 'POST',
            headers,
            body: { live_id: liveId, ack_through: 0, events: [{ k: 'text', text: 'cross-site' }] },
          }),
        ),
      ).toEqual([403, 'origin_rejected']);
    }
    expect(JSON.stringify(fixture.requests)).not.toContain('cross-site');
    expect(view.ended()).toBeUndefined();
  }, 30_000);

  test('the live view refuses a request from another address', async () => {
    expect(await refusal(await call(frames(), { address: '203.0.113.7' }))).toEqual([
      403,
      'not_you',
    ]);
    expect(
      await refusal(
        await call(live('/input'), {
          method: 'POST',
          address: '203.0.113.7',
          body: {
            live_id: liveId,
            ack_through: 0,
            events: [{ k: 'text', text: 'from-elsewhere' }],
          },
        }),
      ),
    ).toEqual([403, 'not_you']);
    expect(JSON.stringify(fixture.requests)).not.toContain('from-elsewhere');
    expect(view.ended()).toBeUndefined();
  }, 30_000);

  test('no persisted event contains the typed secret or the identity-provider host', async () => {
    const { sql } = handle();
    // The person signs in by hand: password, one-time code, the identity provider and back.
    await send(point(SIGN_IN_POINTS.first_field));
    expect(await send([{ k: 'text', text: SIGN_IN.password }])).toMatchObject({ status: 200 });
    await send(ENTER);
    expect(await view.wait(() => view.where() === `${fixture.app}/otp`)).toBe(true);
    await send(point(SIGN_IN_POINTS.first_field));
    await send([{ k: 'text', text: SIGN_IN.code }]);
    await send(ENTER);
    expect(await view.wait(() => view.where().startsWith(`${fixture.app}/account`))).toBe(true);
    const posted = fixture.requests.filter(
      (request) => request.method === 'POST' && ['/signin', '/otp'].includes(request.path),
    );
    expect(posted.map((request) => request.path)).toEqual(['/signin', '/otp']);
    expect(posted[0]?.body).toContain('password=');
    expect(
      fixture.requests.filter((request) => request.site === 'idp' && request.path === '/idp'),
    ).toHaveLength(1);

    await control('handback');
    expect(await view.wait(() => view.ended()?.code === 'epoch_changed')).toBe(true);
    const idpHost = new URL(fixture.idp).host;
    const secrets = [SIGN_IN.password, SIGN_IN.code, idpHost];
    const events = await sql`select type, payload::text as payload from event
      where job_id = ${jobId}`;
    expect(events.length).toBeGreaterThan(0);
    for (const row of events)
      for (const secret of secrets)
        expect([row.type, String(row.payload).includes(secret)]).toEqual([row.type, false]);
    // Nothing anywhere in the database holds what the person typed.
    const tables = await sql<{ name: string }[]>`select table_name as name
      from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    expect(tables.length).toBeGreaterThan(10);
    for (const { name } of tables) {
      const rows = await sql`select to_jsonb(t)::text as row from ${sql(name)} t limit 500`;
      const text = rows.map((row) => String(row.row)).join('\n');
      for (const secret of [SIGN_IN.password, SIGN_IN.code])
        expect([name, text.includes(secret)]).toEqual([name, false]);
    }
    await control('takeover');
  }, 120_000);

  test('a live stream reconnects without replaying frames', async () => {
    const reopened = await open();
    liveId = reopened.live_id;
    view = await watch();
    expect(await view.wait(() => view.frames() > 0)).toBe(true);
    await send(point(SIGN_IN_POINTS.first_field));
    expect(await view.wait(() => view.frames() > 1)).toBe(true);
    // Click away from the field, so no caret blinks and the page stops sending frames at all.
    await send(point(QUIET_SPOT));
    let settled = -1;
    while (settled !== view.frames()) {
      settled = view.frames();
      await Bun.sleep(1500);
    }
    const painted = view.seq();
    const seen = [...view.seqs];
    await view.stop();

    // The page is not moving, so a returning viewer only has a picture if it is repainted.
    view = await watch(liveId, painted);
    expect(await view.wait(() => view.frames() > 0, 10_000)).toBe(true);
    expect(view.seqs.filter((seq) => seq <= painted)).toEqual([]);
    expect(seen.some((seq) => view.seqs.includes(seq))).toBe(false);
    expect(view.ended()).toBeUndefined();
    expect(await send(point(SIGN_IN_POINTS.first_field))).toMatchObject({ status: 200 });
  }, 90_000);

  test('a viewer that does not come back within the window closes the live view', async () => {
    await view.stop();
    await Bun.sleep(PRESENCE.reconnect_ms + 1000);
    expect(await refusal(await call(frames()))).toEqual([410, 'live_closed']);
    expect(
      await refusal(
        await call(live('/input'), {
          method: 'POST',
          body: { live_id: liveId, ack_through: 0, events: [] },
        }),
      ),
    ).toEqual([410, 'live_closed']);
    // Control stayed with the person, so they can open another view.
    const [binding] = await handle()
      .sql`select control from browser_session_binding where id = ${sessionId}`;
    expect(binding?.control).toBe('human');
    const again = await open();
    liveId = again.live_id;
    view = await watch();
    expect(await view.wait(() => view.frames() > 0)).toBe(true);
  }, 60_000);

  test('a person who stops is asked whether they are still there, and then the view closes', async () => {
    expect((await call(live('/close'), { method: 'POST', body: { live_id: liveId } })).status).toBe(
      200,
    );
    expect(await view.wait(() => view.ended()?.code === 'closed')).toBe(true);
    const patient = await open(impatient);
    const watching = await watch(patient.live_id, undefined, impatient);
    try {
      expect(await watching.wait(() => watching.notices().includes('still_there'), 10_000)).toBe(
        true,
      );
      expect(await watching.wait(() => watching.ended()?.code === 'live_idle', 10_000)).toBe(true);
      const [binding] = await handle()
        .sql`select control from browser_session_binding where id = ${sessionId}`;
      expect(binding?.control).toBe('human');
    } finally {
      await watching.stop();
    }
  }, 60_000);

  test("the live view reaches the browser through the web origin's proxy", async () => {
    const api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 60,
      fetch: apiFetch(app, apiNetwork('127.0.0.1', '255.255.255.255'), trustedProxy('127.0.0.1')),
    });
    const web = createStaticServer({
      root: join(root, 'web'),
      port: 0,
      hostname: '127.0.0.1',
      apiOrigin: `http://127.0.0.1:${api.port}`,
    });
    const origin = `http://127.0.0.1:${web.port}`;
    const abort = new AbortController();
    let through: Viewer | undefined;
    try {
      const opened = await fetch(`${origin}/api${live()}`, {
        method: 'POST',
        headers: { cookie, origin },
      });
      expect(opened.status).toBe(200);
      const proxied = (await opened.json()) as LiveOpen;
      const streamed = await fetch(`${origin}/api${live()}/frames?live_id=${proxied.live_id}`, {
        headers: { cookie, origin },
        signal: abort.signal,
      });
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get('content-type')).toBe('text/event-stream');
      through = viewer(streamed, abort);
      // The stream is still open, so the proxy passed the first frames without buffering.
      expect(await through.wait(() => through?.frames() !== 0)).toBe(true);
      expect(through.closed()).toBe(false);
      const typed = await fetch(`${origin}/api${live()}/input`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          live_id: proxied.live_id,
          ack_through: through.seq(),
          events: point(SIGN_IN_POINTS.first_field),
        }),
      });
      expect(await typed.json()).toEqual({ accepted: 2 });
      // A page on another site cannot read the stream: the proxy refuses before the API is asked.
      const foreign = await fetch(`${origin}/api${live()}/frames?live_id=${proxied.live_id}`, {
        headers: { cookie, origin: 'https://evil.example' },
      });
      expect(foreign.status).toBe(403);
      expect(
        (
          await fetch(`${origin}/api${live()}/close`, {
            method: 'POST',
            headers: { cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify({ live_id: proxied.live_id }),
          })
        ).status,
      ).toBe(200);
      expect(await through.wait(() => through?.ended()?.code === 'closed')).toBe(true);
    } finally {
      await through?.stop();
      web.stop(true);
      api.stop(true);
    }
  }, 90_000);

  test('a live view is refused once control has changed hands', async () => {
    const { sql } = handle();
    // This view has no viewer attached, so only the checks each request makes can refuse it.
    const stale = await open(unhurried);
    const client = await pool.get(spaceId);
    const elsewhere = new BrowserSessionService(sql, { get: async () => client });
    expect((await elsewhere.control(sessionId, 'handback', principalId)).control).toBe(
      'automation',
    );
    expect(await refusal(await call(live(), { method: 'POST', on: unhurried }))).toEqual([
      409,
      'not_human_control',
    ]);
    const taken = await elsewhere.control(sessionId, 'takeover', principalId);
    epoch = taken.control_epoch;
    expect(
      await refusal(
        await call(live('/input'), {
          method: 'POST',
          on: unhurried,
          body: {
            live_id: stale.live_id,
            ack_through: 0,
            events: [{ k: 'text', text: 'stale-epoch' }],
          },
        }),
      ),
    ).toEqual([409, 'epoch_changed']);
    expect(await refusal(await call(frames(stale.live_id), { on: unhurried }))).toEqual([
      410,
      'live_closed',
    ]);
    expect(JSON.stringify(fixture.requests)).not.toContain('stale-epoch');
  }, 60_000);

  test('no recipe can be saved between takeover and the recorded binding', async () => {
    const { sql } = handle();
    await control('handback');
    const store = new PostgresBrowserRecipeStore(sql);
    const recipe: BrowserRecipeCandidate = {
      id: 'recipe_live_service',
      space_id: spaceId,
      version: 1,
      state: 'candidate',
      schema: [
        { label: 'Note', role: 'textbox', required: true, sensitive: false },
        { label: 'Save note', role: 'button', required: false, sensitive: false },
      ],
      steps: [
        { action: 'fill', label: 'Note', value_key: 'note' },
        { action: 'submit', role: 'button', name: 'Save note' },
      ],
      safe_aliases: {},
      reason: 'recorded',
    };
    await store.save(recipe);
    const saving = (version: number) =>
      store.save({ ...recipe, version }).then(
        () => 'saved',
        (error: Error) => error.message,
      );

    // The worker is asked for control only after the binding says the person has it.
    const client = await pool.get(spaceId);
    const watched = Object.create(client) as BrowserWorkerClient;
    let during = '';
    watched.takeover = async (id: string) => {
      during = await saving(2);
      return client.takeover(id);
    };
    const taken = await new BrowserSessionService(sql, { get: async () => watched }).control(
      sessionId,
      'takeover',
      principalId,
    );
    expect([taken.control, during]).toEqual(['human', 'recipe_frozen']);
    epoch = taken.control_epoch;

    // A worker that refuses leaves the binding as it found it, so learning resumes.
    await control('handback');
    const refusing = Object.create(client) as BrowserWorkerClient;
    refusing.takeover = async () => {
      throw new BrowserFault('worker_busy');
    };
    const outcome = await new BrowserSessionService(sql, { get: async () => refusing })
      .control(sessionId, 'takeover', principalId)
      .then(
        () => 'taken',
        (error: Error) => error.message,
      );
    expect(outcome).toBe('worker_busy');
    const [binding] = await sql`select control, control_epoch from browser_session_binding
      where id = ${sessionId}`;
    expect(binding).toMatchObject({ control: 'automation', control_epoch: epoch });
    expect(await saving(3)).toBe('saved');
  }, 90_000);
});
