import {
  learningSpaceQuery,
  learningSpaceRequest,
  procedureId,
  procedureReasonRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { ProcedureEvaluator } from './evaluator.ts';
import type { ProcedureService } from './procedures.ts';

export function mountProcedures(
  app: Hono,
  service: ProcedureService,
  evaluator?: ProcedureEvaluator,
) {
  app.get('/procedures', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    const rows = await service.list(c.get('owner').id, input.space_id);
    return c.json({ procedures: rows.map((row) => row.procedure) });
  });
  app.get('/procedures/:id', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json(
      await service.inspect(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
      ),
    );
  });
  app.post('/procedures/:id/evaluate', async (c) => {
    const input = learningSpaceRequest.parse(await c.req.json());
    if (!evaluator)
      throw new ServiceError(
        'evaluation_unavailable',
        'Configure the trusted runtime evaluator.',
        503,
      );
    return c.json(
      await evaluator.evaluate(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
      ),
    );
  });
  for (const action of ['canary', 'activate'] as const)
    app.post(`/procedures/:id/${action}`, async (c) => {
      const input = learningSpaceRequest.parse(await c.req.json());
      const args = [
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
      ] as const;
      return c.json({
        candidate:
          action === 'canary'
            ? await service.enableCanary(...args)
            : await service.activate(...args),
      });
    });
  for (const action of ['reject', 'rollback'] as const)
    app.post(`/procedures/:id/${action}`, async (c) => {
      const input = procedureReasonRequest.parse(await c.req.json());
      const args = [
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
        input.reason,
      ] as const;
      return c.json({
        candidate:
          action === 'reject' ? await service.reject(...args) : await service.rollback(...args),
      });
    });
}
