import { prefixedId } from '@melete/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ProcedureProposer } from './proposer.ts';

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
}
