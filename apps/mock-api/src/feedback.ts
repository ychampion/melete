/**
 * Problem reports, in memory. The demo person runs the installation, so the
 * list is everyone's and statuses can be changed. Two reports are seeded so the
 * Settings screen has something to show.
 */
import {
  createFeedbackRequest,
  FEEDBACK_ID_ALPHABET,
  type FeedbackReport,
  feedbackListQuery,
  feedbackListResponse,
  feedbackResponse,
  redactText,
  redactUrl,
  updateFeedbackRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { AppDeps } from './app.ts';

const fail = (code: string, message: string) => ({ error: { code, message } });

const summarize = (message: string) => {
  const line = message.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

function newFeedbackId(taken: Map<string, unknown>): string {
  for (;;) {
    let id = 'FB-';
    for (let i = 0; i < 4; i++)
      id += FEEDBACK_ID_ALPHABET[Math.floor(Math.random() * FEEDBACK_ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
}

export function mountFeedbackMock(app: Hono, deps: AppDeps, reporter: () => string | null): void {
  const reports = new Map<string, FeedbackReport>();
  const minutesAgo = (minutes: number) =>
    new Date(deps.store.now().getTime() - minutes * 60_000).toISOString();
  const seed = (report: Omit<FeedbackReport, 'summary'>) =>
    reports.set(report.id, { ...report, summary: summarize(report.message) });
  seed({
    id: 'FB-7K3Q',
    status: 'open',
    message:
      'The plan I added this morning is missing from Plans after a reload.\nIt was there before I refreshed.',
    route: '#/plans',
    app_version: '0.1.0-pre',
    context: {
      route: '#/plans',
      user_agent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
      language: 'en-US',
      time_zone: 'America/Los_Angeles',
      viewport: { width: 1440, height: 900, pixel_ratio: 2 },
      color_scheme: 'light',
      console_errors: [{ at: minutesAgo(42), message: 'TypeError: plans is undefined' }],
      failed_requests: [
        {
          at: minutesAgo(42),
          method: 'GET',
          url: '/api/plans?limit=50',
          status: 500,
          code: 'internal_error',
        },
      ],
    },
    reporter: { principal_id: null, email: 'jamie.davis@fastmail.example' },
    note: null,
    created_at: minutesAgo(41),
    updated_at: minutesAgo(41),
  });
  seed({
    id: 'FB-M2XP',
    status: 'fixed',
    message: 'The Send button stayed grey after I pasted a message.',
    route: '#/chat/new',
    app_version: '0.1.0-pre',
    context: { route: '#/chat/new', viewport: { width: 390, height: 844, pixel_ratio: 3 } },
    reporter: { principal_id: null, email: 'jamie.davis@fastmail.example' },
    note: 'The composer now reads pasted text.',
    created_at: minutesAgo(60 * 26),
    updated_at: minutesAgo(60 * 20),
  });

  app.post('/feedback', async (c) => {
    const parsed = createFeedbackRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail('invalid_request', 'Request data is invalid.'), 400);
    const { message, context = {} } = parsed.data;
    const now = deps.store.now().toISOString();
    const cleaned = {
      ...context,
      ...(context.route ? { route: redactUrl(context.route) } : {}),
      ...(context.console_errors
        ? {
            console_errors: context.console_errors.map((e) => ({
              ...e,
              message: redactText(e.message),
            })),
          }
        : {}),
      ...(context.failed_requests
        ? {
            failed_requests: context.failed_requests.map((e) => ({ ...e, url: redactUrl(e.url) })),
          }
        : {}),
    };
    const report: FeedbackReport = {
      id: newFeedbackId(reports),
      status: 'open',
      message,
      summary: summarize(message),
      route: cleaned.route ?? null,
      app_version: '0.1.0-pre',
      context: cleaned,
      reporter: { principal_id: null, email: reporter() },
      note: null,
      created_at: now,
      updated_at: now,
    };
    reports.set(report.id, report);
    return c.json(feedbackResponse.parse({ report }), 201);
  });

  app.get('/feedback', (c) => {
    const query = feedbackListQuery.safeParse({ status: c.req.query('status') });
    if (!query.success) return c.json(fail('invalid_request', 'Request data is invalid.'), 400);
    const list = [...reports.values()]
      .filter((r) => !query.data.status || r.status === query.data.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return c.json(feedbackListResponse.parse({ reports: list, can_manage: true }));
  });

  app.get('/feedback/:id', (c) => {
    const report = reports.get(c.req.param('id').toUpperCase());
    if (!report) return c.json(fail('not_found', 'No such report.'), 404);
    return c.json(feedbackResponse.parse({ report }));
  });

  app.patch('/feedback/:id', async (c) => {
    const report = reports.get(c.req.param('id').toUpperCase());
    if (!report) return c.json(fail('not_found', 'No such report.'), 404);
    const parsed = updateFeedbackRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail('invalid_request', 'Request data is invalid.'), 400);
    const next: FeedbackReport = {
      ...report,
      status: parsed.data.status,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note || null } : {}),
      updated_at: deps.store.now().toISOString(),
    };
    reports.set(next.id, next);
    return c.json(feedbackResponse.parse({ report: next }));
  });
}
