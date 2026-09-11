import {
  operationRearm,
  operationRegistration,
  operationSettlement,
  operationVersion,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { type OperationService, operationView } from '../jobs/operations.ts';
import { ServiceError } from './errors.ts';

export function mountOperations(app: Hono, operations: OperationService) {
  app.get('/operations', async (c) =>
    c.json({ operations: (await operations.list(c.req.query('job_id'))).map(operationView) }),
  );
  app.post('/jobs/:id/operations', async (c) =>
    c.json(
      operationView(
        await operations.register(
          c.req.param('id'),
          operationRegistration.parse(await c.req.json()),
        ),
      ),
      201,
    ),
  );
  app.post('/operations/:id/claim', async (c) => {
    const input = operationVersion.parse(await c.req.json());
    const row = await operations.claim(c.req.param('id'), input.version);
    if (!row) throw new ServiceError('stale_operation', 'Operation is not ready for this owner.');
    return c.json(operationView(row));
  });
  app.post('/operations/:id/rearm', async (c) => {
    const input = operationRearm.parse(await c.req.json());
    return c.json(
      operationView(
        await operations.rearm(c.req.param('id'), input.version, new Date(input.due_at)),
      ),
    );
  });
  app.post('/operations/:id/settle', async (c) => {
    const input = operationSettlement.parse(await c.req.json());
    return c.json(
      operationView(await operations.settle(c.req.param('id'), input.version, input.result)),
    );
  });
}
