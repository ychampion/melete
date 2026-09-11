import { claimId, sourceId } from '@melete/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { claimHistory, correctClaim, listClaims } from './claims.ts';
import { MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { ingest } from './evidence.ts';
import { deleteMemorySource, forgetMemory } from './forget.ts';
import type { MarkdownViews } from './markdown.ts';
import { type RecallOptions, recall } from './recall.ts';
import type { RestrictionJournal } from './restore.ts';

export type MemoryRouteOptions = {
  sql: MemorySql;
  journal: RestrictionJournal;
  /** Authentication resolves membership and purpose outside request metadata. Missing auth fails closed. */
  resolveScope?: (request: Request) => Promise<MemoryScope | null>;
  markdown?: MarkdownViews;
  recallOptions?: RecallOptions;
};
export function createMemoryRouter(options: MemoryRouteOptions) {
  const app = new Hono<{ Variables: { memoryScope: MemoryScope } }>();
  const authenticate: MiddlewareHandler<{ Variables: { memoryScope: MemoryScope } }> = async (
    c,
    next,
  ) => {
    const scope = await options.resolveScope?.(c.req.raw);
    if (!scope) return c.json({ error: { code: 'unauthenticated' } }, 401);
    c.set('memoryScope', scope);
    await next();
  };
  app.use('/memory/*', authenticate);
  app.use('/knowledge/*', authenticate);
  app.onError((error, c) => {
    const code =
      error instanceof MemoryError
        ? error.code
        : error instanceof ZodError || error instanceof SyntaxError
          ? 'invalid_request'
          : 'memory_unavailable';
    const status =
      code === 'invalid_request'
        ? 400
        : code === 'scope_denied'
          ? 403
          : code.endsWith('_not_found')
            ? 404
            : ['stale_revision', 'owner_edit_pending'].includes(code)
              ? 409
              : 503;
    return c.json({ error: { code } }, status);
  });
  const body = async (request: Request) => {
    const text = await request.text();
    if (text.length > 1048576) throw new MemoryError('invalid_request');
    return JSON.parse(text) as unknown;
  };
  const markdown = () => {
    if (!options.markdown) throw new MemoryError('view_not_configured');
    return options.markdown;
  };
  app.post('/memory/sources', async (c) =>
    c.json(await ingest(options.sql, c.get('memoryScope'), await body(c.req.raw)), 201),
  );
  app.post('/memory/recall', async (c) =>
    c.json(
      await recall(options.sql, c.get('memoryScope'), await body(c.req.raw), options.recallOptions),
    ),
  );
  app.post('/memory/corrections', async (c) =>
    c.json(await correctClaim(options.sql, c.get('memoryScope'), await body(c.req.raw))),
  );
  app.post('/memory/forget', async (c) =>
    c.json(
      await forgetMemory(options.sql, c.get('memoryScope'), await body(c.req.raw), options.journal),
    ),
  );
  app.delete('/memory/sources/:id', async (c) =>
    c.json(
      await deleteMemorySource(
        options.sql,
        c.get('memoryScope'),
        sourceId.parse(c.req.param('id')),
        options.journal,
      ),
    ),
  );
  app.get('/memory/claims', async (c) =>
    c.json(await listClaims(options.sql, c.get('memoryScope'))),
  );
  app.get('/memory/claims/:id/history', async (c) =>
    c.json(await claimHistory(options.sql, c.get('memoryScope'), claimId.parse(c.req.param('id')))),
  );
  app.get('/knowledge/proposals', async (c) =>
    c.json(await markdown().proposals(c.get('memoryScope'))),
  );
  app.post('/knowledge/proposals/:id/apply', async (c) => {
    const scope = c.get('memoryScope');
    const id = c.req.param('id');
    const preview = (await markdown().proposals(scope)).proposals.find((p) => p.id === id);
    if (!preview) throw new MemoryError('proposal_not_found');
    const result = await markdown().apply(scope, id);
    if (!['committed', 'duplicate'].includes(result.status))
      throw new MemoryError('stale_revision');
    return c.json({ ...preview, status: 'applied' as const });
  });
  app.delete('/knowledge/proposals/:id', async (c) => {
    const scope = c.get('memoryScope');
    const id = c.req.param('id');
    const preview = (await markdown().proposals(scope)).proposals.find((p) => p.id === id);
    if (!preview) throw new MemoryError('proposal_not_found');
    await markdown().discard(scope, id);
    return c.json({ ...preview, status: 'discarded' as const });
  });
  app.post('/knowledge/:id/edit', async (c) =>
    c.json(
      await markdown().edit(
        c.get('memoryScope'),
        claimId.parse(c.req.param('id')),
        await body(c.req.raw),
      ),
    ),
  );
  return app;
}
