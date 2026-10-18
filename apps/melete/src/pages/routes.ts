/**
 * The routes for a connection's pages.
 *
 * - `GET /conversations/:id/pages`: the conversation's pages, for its person.
 * - `POST /pages/:id/views`: a frame for one open page, in the person's own
 *   browser session; answers with a path that carries a view token, and the
 *   tool call's input and result for the page.
 * - `GET /pages/view/:token`: the page itself. It reads no session (the frame
 *   has an opaque origin and holds none): the token is checked, the page must
 *   still be open and the person's session still signed in, and the browser
 *   must be loading it into a frame. It is served with the page's own policy.
 * - `POST /pages/:id/outcome`: the connection's server reports what happened
 *   on the page. No session: believed only for its signature.
 */
import { connectionPageList, connectionPageView } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { sessionLive } from '../apps/serve.ts';
import type { Database } from '../db/client.ts';
import { requireJobAccess } from '../principals/authority.ts';
import { PAGE_VIEW_PREFIX } from '../viewer/headers.ts';
import { sessionTag } from '../viewer/tokens.ts';
import {
  conversationPages,
  type DeliverPageEvent,
  PageViewTokens,
  pageForView,
  pageResponse,
  refused,
  settlePage,
} from './service.ts';

export const PAGE_REPORT_PATH = /^\/pages\/cpg_[0-9A-Z]{26}\/outcome$/;

export type PageRouteDeps = {
  db: Database;
  sql: Sql;
  secret: string;
  deliver: DeliverPageEvent;
  tokens?: PageViewTokens;
};

/** Whether the person may see this page: it is theirs, or the conversation is. */
async function mayOpen(
  db: Database,
  row: { principal_id: string | null; job_id: string },
  actor: string,
) {
  if (row.principal_id === actor) return true;
  try {
    await requireJobAccess(db, row.job_id, actor);
    return true;
  } catch (error) {
    if (error instanceof ServiceError) return false;
    throw error;
  }
}

export function mountPages(app: Hono, deps: PageRouteDeps): void {
  const { db, sql, secret, deliver } = deps;
  const tokens = deps.tokens ?? new PageViewTokens(secret);

  app.get('/conversations/:id/pages', async (c: Context) => {
    const actor = c.get('owner')?.id as string | undefined;
    if (!actor) throw refused('No such conversation.');
    await requireJobAccess(db, c.req.param('id') ?? '', actor);
    return c.json(
      connectionPageList.parse({ pages: await conversationPages(sql, c.req.param('id') ?? '') }),
    );
  });

  app.post('/pages/:id/views', async (c: Context) => {
    const actor = c.get('owner')?.id as string | undefined;
    const digest = c.get('sessionDigest') as string | undefined;
    if (!actor) throw refused('No such page.');
    if (!digest) throw refused('Pages open in Melete, signed in in a browser.', 403);
    const row = await pageForView(sql, c.req.param('id') ?? '');
    if (!row || !(await mayOpen(db, row, actor))) throw refused('No such page.');
    if (row.state !== 'open' || row.expires_at.getTime() <= Date.now())
      throw refused('This page is no longer open.');
    const { token, expiresAt } = tokens.issue(
      { pageId: row.id, principalId: actor, sessionTag: sessionTag(digest) },
      row.expires_at.getTime(),
    );
    return c.json(
      connectionPageView.parse({
        view_path: `${PAGE_VIEW_PREFIX}${token}`,
        expires_at: new Date(expiresAt * 1000).toISOString(),
        tool_input: row.tool_input,
        tool_result: row.tool_result,
      }),
    );
  });

  app.get(`${PAGE_VIEW_PREFIX}:token`, async (c) => {
    // A page opened on its own, outside Melete's frame, is never served.
    if (c.req.header('sec-fetch-dest') !== 'iframe')
      throw refused('Open this page from Melete.', 403);
    const claims = tokens.verify(c.req.param('token'));
    if (!claims) throw refused('This page has ended.');
    const row = await pageForView(sql, claims.pageId);
    if (
      !row ||
      row.state !== 'open' ||
      row.expires_at.getTime() <= Date.now() ||
      !(await mayOpen(db, row, claims.principalId)) ||
      !(await sessionLive(sql, claims.principalId, claims.sessionTag))
    )
      throw refused('This page has ended.');
    return pageResponse(row, c.req.method === 'HEAD');
  });

  app.post('/pages/:id/outcome', async (c) => {
    const body = await c.req.text();
    const outcome = await settlePage(
      sql,
      deliver,
      secret,
      c.req.param('id') ?? '',
      {
        id: c.req.header('webhook-id'),
        timestamp: c.req.header('webhook-timestamp'),
        signature: c.req.header('webhook-signature'),
      },
      body,
    );
    if (!outcome.ok)
      return c.json(
        { error: { code: 'page_report_refused', message: outcome.message } },
        outcome.status,
      );
    return c.json({ ok: true, state: outcome.state, repeated: outcome.repeated });
  });
}
