import { attributionRequest, claimId, prefixedId, sourceId, trustRequest } from '@melete/contracts';
import { Hono, type MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { checkPayloadAttribution } from './attribution.ts';
import { claimHistory, correctClaim, listClaims } from './claims.ts';
import { listContradictions, listQuestions } from './contradictions.ts';
import { lockSpace, MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { ingest, loadEvidence } from './evidence.ts';
import { deleteMemorySource, forgetMemory } from './forget.ts';
import type { MarkdownViews } from './markdown.ts';
import { pendingRepairBriefs, recordOutput } from './outputs.ts';
import { type RecallOptions, recall } from './recall.ts';
import type { RestrictionJournal } from './restore.ts';
import { createTrustResolver } from './trust.ts';

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
    if (!scope)
      return c.json(
        { error: { code: 'unauthenticated', message: 'Authentication is required.' } },
        401,
      );
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
    const status = ['invalid_request', 'invalid_forget_target', 'invalid_validity'].includes(code)
      ? 400
      : code === 'scope_denied'
        ? 403
        : code.endsWith('_not_found')
          ? 404
          : [
                'stale_revision',
                'owner_edit_pending',
                'source_version_conflict',
                'idempotency_conflict',
              ].includes(code)
            ? 409
            : 503;
    const message =
      status === 400
        ? 'The memory request is invalid.'
        : status === 403
          ? 'This operation is outside your memory access scope.'
          : status === 404
            ? 'The requested memory is not accessible.'
            : status === 409
              ? 'Memory changed. Inspect the current record before retrying.'
              : 'Memory is temporarily unavailable.';
    return c.json({ error: { code, message } }, status);
  });
  const body = async (request: Request) => {
    const reader = request.body?.getReader();
    if (!reader) throw new MemoryError('invalid_request');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1048576) throw new MemoryError('invalid_request');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof TypeError) throw new MemoryError('invalid_request');
      throw error;
    } finally {
      await reader.cancel();
    }
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
  app.get('/memory/sources/:id', async (c) => {
    const result = await loadEvidence(
      options.sql,
      c.get('memoryScope'),
      sourceId.parse(c.req.param('id')),
    );
    if (!result) throw new MemoryError('source_not_found');
    return c.json(result);
  });
  // E1. The runtime declares what an output used. An empty manifest is recorded
  // as unattributed rather than refused: chat prose is real, and saying which
  // outputs the precise rule does not cover is more honest than pretending.
  app.post('/memory/outputs', async (c) =>
    c.json(await recordOutput(options.sql, c.get('memoryScope'), await body(c.req.raw)), 201),
  );
  // E1. The check the broker runs before admitting a write_external or spend.
  // It is pure: the caller supplies the payload, the manifest and the items that
  // were delivered, and gets back every value it cannot account for.
  app.post('/memory/attribution', async (c) => {
    const input = attributionRequest.parse(await body(c.req.raw));
    return c.json(checkPayloadAttribution(input.payload, input.delivered, input.uses));
  });
  // E4. Per-field origin, with the sentence a person is shown on the approval card.
  app.post('/memory/trust', async (c) => {
    const scope = c.get('memoryScope');
    const input = trustRequest.parse(await body(c.req.raw));
    const resolver = createTrustResolver(options.sql, async () => scope);
    return c.json(
      await resolver.resolve({
        space_id: scope.spaceId,
        payload: input.payload,
        handles: input.handles,
      }),
    );
  });
  app.get('/memory/questions', async (c) =>
    c.json(
      await options.sql.begin(async (tx) => {
        const scope = c.get('memoryScope');
        await lockSpace(tx, scope, false);
        return { questions: await listQuestions(tx, scope) };
      }),
    ),
  );
  app.get('/memory/contradictions', async (c) =>
    c.json(
      await options.sql.begin(async (tx) => {
        const scope = c.get('memoryScope');
        await lockSpace(tx, scope, false);
        return { contradictions: await listContradictions(tx, scope) };
      }),
    ),
  );
  app.get('/memory/rejections', async (c) =>
    c.json(
      await options.sql.begin(async (tx) => {
        const scope = c.get('memoryScope');
        await lockSpace(tx, scope, false);
        const rows = await tx`select work_id, proposal_index, key, reason, detail, recorded_at
          from memory_rejections where space_id = ${scope.spaceId} order by recorded_at desc, id limit 200`;
        return {
          rejected: rows.map((row) => ({
            work_id: row.work_id,
            index: row.proposal_index,
            key: row.key ?? null,
            reason: row.reason,
            detail: row.detail,
            recorded_at: new Date(row.recorded_at as Date).toISOString(),
          })),
        };
      }),
    ),
  );
  app.get('/memory/jobs/:id/repair-briefs', async (c) => {
    const scope = c.get('memoryScope');
    const jobId = prefixedId('job').parse(c.req.param('id'));
    // A brief carries a job's before-and-after values. The job stays private to
    // its principal inside a shared space, so its briefs are read by that
    // principal alone; a job that names none belongs to the setup owner.
    if (scope.principalId) {
      const [owned] = await options.sql`select 1 from job where id = ${jobId}
        and space_id = ${scope.spaceId}
        and coalesce(principal_id, (select id from owner limit 1)) = ${scope.principalId}`;
      if (!owned) throw new MemoryError('job_not_found');
    }
    return c.json({ repair_briefs: await pendingRepairBriefs(options.sql, scope, jobId) });
  });
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
