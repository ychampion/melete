import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { feedbackListResponse, feedbackResponse } from '@melete/contracts';
import { loadEnv } from '../../src/env.ts';
import { reportMarkdown } from '../../src/feedback/markdown.ts';
import { FeedbackLimiter } from '../../src/feedback/rate-limit.ts';
import { createApp } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const password = 'my-test-password';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

function app(limiter = new FeedbackLimiter()) {
  return createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    db: database().db,
    checkDatabase: async () => 'ok',
    feedbackLimiter: limiter,
  });
}

type Api = ReturnType<typeof app>;

const json = (method: string, cookie: string, body?: unknown): RequestInit => ({
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function cookieOf(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('The response did not set a session cookie');
  return value;
}

/** The installation's owner and one other member, each signed in. */
async function people(api: Api) {
  const owner = cookieOf(
    await api.request(
      '/setup',
      json('POST', '', { email: 'owner@example.test', password }) as RequestInit,
    ),
  );
  const made = await api.request(
    '/principals',
    json('POST', owner, { email: 'member@example.test', password }),
  );
  expect(made.status).toBe(201);
  const member = cookieOf(
    await api.request('/login', json('POST', '', { email: 'member@example.test', password })),
  );
  return { owner, member };
}

async function send(api: Api, cookie: string, message: string, context?: unknown) {
  return api.request('/feedback', json('POST', cookie, { message, context }));
}

describeWithDb('problem reports against Postgres', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);

  afterAll(async () => {
    await handle?.close();
  });

  test('a report needs a session', async () => {
    expect((await app().request('/feedback', json('POST', '', { message: 'x' }))).status).toBe(401);
    expect((await app().request('/feedback')).status).toBe(401);
  });

  test('stores a report, answers with a short id, and redacts what the page sent', async () => {
    const api = app();
    const { member } = await people(api);
    const response = await send(api, member, 'The plan list is empty\nafter I reload', {
      route: '#/plans?email=jamie@example.com',
      user_agent: 'Mozilla/5.0 Test',
      viewport: { width: 390, height: 844, pixel_ratio: 3 },
      console_errors: [
        { at: '2026-09-30T10:00:00.000Z', message: 'Failed for jamie@example.com token=abc123' },
      ],
      failed_requests: [
        {
          at: '2026-09-30T10:00:01.000Z',
          method: 'GET',
          url: 'http://localhost/api/plans?token=secret-value&limit=5',
          status: 500,
          code: 'internal_error',
        },
      ],
    });
    expect(response.status).toBe(201);
    const { report } = feedbackResponse.parse(await response.json());
    expect(report.id).toMatch(/^FB-[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}$/);
    expect(report.status).toBe('open');
    expect(report.summary).toBe('The plan list is empty');
    expect(report.reporter.email).toBe('member@example.test');
    const stored = JSON.stringify(report.context);
    expect(stored).not.toContain('jamie@example.com');
    expect(stored).not.toContain('abc123');
    expect(stored).not.toContain('secret-value');
    expect(report.route).toBe('#/plans?email=[redacted]');
    expect(report.context.failed_requests?.[0]?.url).toBe(
      'http://localhost/api/plans?token=[redacted]&limit=5',
    );
    const markdown = reportMarkdown(report);
    expect(markdown).toContain(`# ${report.id}: The plan list is empty`);
    expect(markdown).toContain('## Failed requests (1)');
  });

  test('a member reads only their own reports; the owner reads and moves every one', async () => {
    const api = app();
    const { owner, member } = await people(api);
    const mine = feedbackResponse.parse(await (await send(api, member, 'Mine')).json()).report;
    const theirs = feedbackResponse.parse(await (await send(api, owner, 'Owner’s')).json()).report;

    const memberList = feedbackListResponse.parse(
      await (await api.request('/feedback', { headers: { Cookie: member } })).json(),
    );
    expect(memberList.can_manage).toBe(false);
    expect(memberList.reports.map((r) => r.id)).toEqual([mine.id]);
    expect(
      (await api.request(`/feedback/${theirs.id}`, { headers: { Cookie: member } })).status,
    ).toBe(404);
    expect(
      (await api.request(`/feedback/${mine.id}`, { headers: { Cookie: member } })).status,
    ).toBe(200);
    // A member cannot change a status, even on their own report, and learns nothing about others.
    expect(
      (await api.request(`/feedback/${mine.id}`, json('PATCH', member, { status: 'fixed' })))
        .status,
    ).toBe(403);
    expect(
      (await api.request(`/feedback/${theirs.id}`, json('PATCH', member, { status: 'fixed' })))
        .status,
    ).toBe(404);

    const ownerList = feedbackListResponse.parse(
      await (await api.request('/feedback', { headers: { Cookie: owner } })).json(),
    );
    expect(ownerList.can_manage).toBe(true);
    expect(ownerList.reports.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    const read = await api.request(`/feedback/${mine.id.toLowerCase()}`, {
      headers: { Cookie: owner },
    });
    expect(read.status).toBe(200);

    const moved = await api.request(
      `/feedback/${mine.id}`,
      json('PATCH', owner, { status: 'fixing', note: 'Looking at the plan query.' }),
    );
    expect(moved.status).toBe(200);
    const { report } = feedbackResponse.parse(await moved.json());
    expect(report.status).toBe('fixing');
    expect(report.note).toBe('Looking at the plan query.');
    const open = feedbackListResponse.parse(
      await (await api.request('/feedback?status=open', { headers: { Cookie: owner } })).json(),
    );
    expect(open.reports.map((r) => r.id)).toEqual([theirs.id]);
    expect(
      (await api.request('/feedback/FB-2222', json('PATCH', owner, { status: 'fixed' }))).status,
    ).toBe(404);
  });

  test('each person may send only a few reports in a short time', async () => {
    let now = 0;
    const api = app(new FeedbackLimiter(() => now, 2, 60_000));
    const { owner, member } = await people(api);
    expect((await send(api, member, 'one')).status).toBe(201);
    expect((await send(api, member, 'two')).status).toBe(201);
    const refused = await send(api, member, 'three');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Someone else is not held back by it, and the window passes.
    expect((await send(api, owner, 'mine')).status).toBe(201);
    now = 60_000;
    expect((await send(api, member, 'three, later')).status).toBe(201);
  });

  test('the command line lists open reports and prints one as Markdown', async () => {
    const api = app();
    const { owner, member } = await people(api);
    const { report } = feedbackResponse.parse(
      await (await send(api, member, 'Settings will not open', { route: '#/settings' })).json(),
    );
    const done = feedbackResponse.parse(await (await send(api, owner, 'Already fixed')).json());
    await api.request(`/feedback/${done.report.id}`, json('PATCH', owner, { status: 'fixed' }));
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(['bun', 'src/feedback/cli.ts', ...args], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, DATABASE_URL: database().url },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { out, code };
    };
    const listed = await cli();
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(report.id);
    expect(listed.out).not.toContain(done.report.id);
    expect((await cli('list', '--all')).out).toContain(done.report.id);
    const shown = await cli('show', report.id.toLowerCase());
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`# ${report.id}: Settings will not open`);
    expect(shown.out).toContain('- Route: `#/settings`');
    expect(shown.out).toContain('member@example.test');
    expect((await cli('show', 'FB-2222')).code).toBe(1);
  }, 30_000);

  test('an empty message is refused', async () => {
    const api = app();
    const { member } = await people(api);
    expect((await send(api, member, '   ')).status).toBe(400);
  });
});
