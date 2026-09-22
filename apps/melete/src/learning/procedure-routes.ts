import {
  learningSpaceQuery,
  learningSpaceRequest,
  procedureActivationRequest,
  procedureId,
  procedureReasonRequest,
  procedureTrialRequest,
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
      const raw = await c.req.json();
      const id = procedureId.parse(c.req.param('id'));
      if (action === 'activate') {
        const input = procedureActivationRequest.parse(raw);
        return c.json({
          candidate: await service.activate(c.get('owner').id, input.space_id, id, input.scope),
        });
      }
      const input = learningSpaceRequest.parse(raw);
      return c.json({
        candidate: await service.enableCanary(c.get('owner').id, input.space_id, id),
      });
    });
  app.post('/procedures/:id/trial', async (c) => {
    const input = procedureTrialRequest.parse(await c.req.json());
    return c.json({
      candidate: await service.startTrial(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
        input.definition_hash,
      ),
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
