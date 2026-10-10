/**
 * Problem reports over HTTP. Every route already required a session before it
 * got here. Anyone signed in may send a report and read their own; the person
 * who runs the installation reads all of them and moves them through
 * open, fixing, fixed and won't fix.
 */

import type { FeedbackReport } from '@melete/contracts';
import {
  createFeedbackRequest,
  feedbackListQuery,
  feedbackListResponse,
  feedbackResponse,
  updateFeedbackRequest,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import type { LimitStore } from '../ops/limiter.ts';
import { reportMarkdown } from './markdown.ts';
import { FeedbackLimiter } from './rate-limit.ts';
import { type FeedbackScope, FeedbackStore } from './service.ts';

const NOT_FOUND = () => new ServiceError('not_found', 'No such report.', 404);

/** Hands a new report to the people who run the installation. */
export type FeedbackForward = (report: FeedbackReport) => Promise<void>;

/**
 * Forwards each report as a JSON POST to `MELETE_FEEDBACK_WEBHOOK_URL`: a
 * `text` line chat webhooks show, the report itself as the API returns it, and
 * the same Markdown `melete feedback show` prints. `installation` is the
 * public address, so one endpoint can take reports from many installations.
 */
export function feedbackWebhook(
  url: string,
  installation: string | null = null,
  transport: (request: Request) => Promise<Response> = fetch,
): FeedbackForward {
  return async (report) => {
    const response = await transport(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `New Melete problem report ${report.id}${installation ? ` on ${installation}` : ''}: ${report.summary}`,
          service: 'melete',
          installation,
          report,
          markdown: reportMarkdown(report),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }),
    );
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`feedback webhook answered ${response.status}`);
  };
}

export function mountFeedback(
  app: Hono,
  deps: {
    db: Database;
    version: string;
    limiter?: FeedbackLimiter;
    /** Where reports are counted; left out, in this process. */
    limits?: LimitStore;
    /** Where each new report is also sent, for the people running the installation. */
    webhook?: FeedbackForward;
  },
): void {
  const store = new FeedbackStore(deps.db);
  const limiter = deps.limiter ?? new FeedbackLimiter(undefined, undefined, undefined, deps.limits);

  /** The installation, the caller, and whether the caller runs the installation. */
  async function scopeOf(c: Context): Promise<FeedbackScope & { manager: boolean; actor: string }> {
    const actor = c.get('owner').id;
    const installationId = await store.installation();
    if (!installationId) throw new ServiceError('unauthorized', 'Setup is required.', 401);
    const manager = installationId === actor;
    return { installationId, actor, manager, ...(manager ? {} : { onlyFrom: actor }) };
  }

  app.post('/feedback', async (c) => {
    const input = createFeedbackRequest.parse(await c.req.json());
    const scope = await scopeOf(c);
    const retryAfter = await limiter.admit(scope.actor);
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: {
            code: 'feedback_rate_limited',
            message: 'That’s a lot of reports in a short time. Try again in a few minutes.',
          },
        },
        429,
      );
    }
    try {
      const report = await store.create({
        installationId: scope.installationId,
        principalId: scope.actor,
        message: input.message,
        context: input.context,
        appVersion: deps.version,
      });
      // After the answer, and never in its way: the report is kept here either way.
      if (deps.webhook)
        void deps
          .webhook(report)
          .catch((error: unknown) =>
            process.stderr.write(
              `problem report ${report.id} was not forwarded: ${error instanceof Error ? error.message : String(error)}\n`,
            ),
          );
      return c.json(feedbackResponse.parse({ report }), 201);
    } catch (error) {
      // The report's own failure is what the person hears about, not the refund's.
      await limiter.refund(scope.actor).catch(() => {});
      throw error;
    }
  });

  app.get('/feedback', async (c) => {
    const query = feedbackListQuery.parse({ status: c.req.query('status') });
    const scope = await scopeOf(c);
    return c.json(
      feedbackListResponse.parse({
        reports: await store.list(scope, query.status),
        can_manage: scope.manager,
      }),
    );
  });

  app.get('/feedback/:id', async (c) => {
    const report = await store.get(await scopeOf(c), c.req.param('id'));
    if (!report) throw NOT_FOUND();
    return c.json(feedbackResponse.parse({ report }));
  });

  app.patch('/feedback/:id', async (c) => {
    const change = updateFeedbackRequest.parse(await c.req.json());
    const scope = await scopeOf(c);
    if (!scope.manager) {
      // Someone who may not see the report is told it does not exist.
      if (!(await store.get(scope, c.req.param('id')))) throw NOT_FOUND();
      throw new ServiceError(
        'scope_denied',
        'Only the person who runs this installation changes a report’s status.',
        403,
      );
    }
    const report = await store.update(scope, c.req.param('id'), change);
    if (!report) throw NOT_FOUND();
    return c.json(feedbackResponse.parse({ report }));
  });
}
