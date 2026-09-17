import { personReactionRequest } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { ReactionScope, ReactionService } from '../jobs/reactions.ts';
import { ServiceError } from './errors.ts';

/**
 * Which space the session is asking about, and for whom. The answer comes from
 * the authenticated session: the principal's own personal space, or a space it
 * selected and is still a member of. A message belongs to a job's timeline, so
 * the scope also names the principal and another member's messages stay absent.
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
    const input = personReactionRequest.parse(text ? JSON.parse(text) : {});
    const scope = await scopeFor(c);
    return c.json(
      { reaction: await reactions.add(scope, c.req.param('id'), { ...input, by: 'person' }) },
      201,
    );
  });

  app.get('/messages/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.list(await scopeFor(c), c.req.param('id')) }),
  );

  app.get('/jobs/:id/reactions', async (c) =>
    c.json({ reactions: await reactions.listForJob(await scopeFor(c), c.req.param('id')) }),
  );
}
