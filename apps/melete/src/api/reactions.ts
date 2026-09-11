import { createReactionRequest } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { ReactionScope, ReactionService } from '../jobs/reactions.ts';
import { ServiceError } from './errors.ts';

/**
 * Which space the session is asking about. v0.1 has one owner holding one
 * personal space, so the answer is that space; the seam exists because the
 * moment a second space is reachable this is the line that has to change, and
 * a scope that is computed is easier to correct than a scope that is assumed.
 */
export type SpaceResolver = (c: Context) => Promise<ReactionScope | null>;

export function mountReactions(
  app: Hono,
  reactions: ReactionService,
  resolveSpace: SpaceResolver,
): void {
  const scopeFor = async (c: Context): Promise<ReactionScope> => {
    const scope = await resolveSpace(c);
    // No space means nothing the caller can name exists. Saying "forbidden"
    // here would confirm that the message they named does.
    if (!scope) throw new ServiceError('not_found', 'No such message.', 404);
    return scope;
  };

  app.post('/messages/:id/reactions', async (c) => {
    const text = await c.req.text();
    const input = createReactionRequest.parse(text ? JSON.parse(text) : {});
    const scope = await scopeFor(c);
    return c.json({ reaction: await reactions.add(scope, c.req.param('id'), input) }, 201);
  });

  app.get('/messages/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.list(await scopeFor(c), c.req.param('id')) }),
  );

  app.get('/jobs/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.listForJob(await scopeFor(c), c.req.param('id')) }),
  );
}
