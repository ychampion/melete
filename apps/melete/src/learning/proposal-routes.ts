import { prefixedId } from '@melete/contracts';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requireLearningSpace } from './episodes.ts';
import type { ProcedureProposer } from './proposer.ts';
import { episode, procedureCandidate } from './schema.ts';

const request = z.strictObject({ space_id: prefixedId('sp') });
export function mountProposals(app: Hono, proposer: ProcedureProposer) {
  app.post('/episodes/:id/propose', async (c) => {
    const input = request.parse(await c.req.json());
    return c.json(
      {
        candidate: await proposer.generate(
          c.get('owner').id,
          input.space_id,
          prefixedId('ep').parse(c.req.param('id')),
        ),
      },
      201,
    );
  });
  app.get('/procedures', async (c) => {
    const spaceId = prefixedId('sp').parse(c.req.query('space_id'));
    const candidates = await proposer.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, c.get('owner').id, spaceId);
      return tx
        .select({ procedure: procedureCandidate })
        .from(procedureCandidate)
        .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(episode.restricted, false),
            gt(episode.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(procedureCandidate.createdAt))
        .limit(100);
    });
    return c.json({ procedures: candidates.map((row) => row.procedure) });
  });
}
