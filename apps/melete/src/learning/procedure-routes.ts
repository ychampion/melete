import {
  engineSkillApprovalRequest,
  engineSkillEditRequest,
  engineSkillProhibitionRecord,
  learningSpaceQuery,
  learningSpaceRequest,
  procedureActivationRequest,
  procedureId,
  procedureReasonRequest,
  procedureTrialRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { EngineSkillService } from './engine-skills.ts';
import type { ProcedureEvaluator } from './evaluator.ts';
import type { ProcedureService } from './procedures.ts';

const prohibitionId = engineSkillProhibitionRecord.shape.id;

export function mountProcedures(
  app: Hono,
  service: ProcedureService,
  evaluator?: ProcedureEvaluator,
  engine?: EngineSkillService,
) {
  if (engine) mountEngineSkills(app, engine);
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

/**
 * The surface for skills the engine wrote: the queue of skills waiting to be read,
 * the controls over a live one, and the standing prohibitions. Any member of the
 * space has it for their own skills; every call is fenced inside the service to
 * the principal of the writing job, and an approval names the exact bytes.
 */
export function mountEngineSkills(app: Hono, engine: EngineSkillService) {
  app.get('/engine-skills', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json({ skills: await engine.list(c.get('owner').id, input.space_id) });
  });
  app.get('/engine-skills/prohibitions', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json({
      prohibitions: await engine.prohibitions(c.get('owner').id, input.space_id),
    });
  });
  app.post('/engine-skills/prohibitions/:id/lift', async (c) => {
    const input = learningSpaceRequest.parse(await c.req.json());
    return c.json({
      prohibition: await engine.lift(
        c.get('owner').id,
        input.space_id,
        prohibitionId.parse(c.req.param('id')),
      ),
    });
  });
  app.get('/engine-skills/held', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json({ skills: await engine.held(c.get('owner').id, input.space_id) });
  });
  app.post('/engine-skills/:id/approve', async (c) => {
    const input = engineSkillApprovalRequest.parse(await c.req.json());
    return c.json({
      skill: await engine.approve(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
        input.definition_hash,
      ),
    });
  });
  app.post('/engine-skills/:id/edit', async (c) => {
    const input = engineSkillEditRequest.parse(await c.req.json());
    return c.json({
      skill: await engine.edit(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
        input.definition_hash,
        input.body,
      ),
    });
  });
  for (const action of ['decline', 'delete', 'pause', 'resume'] as const)
    app.post(`/engine-skills/:id/${action}`, async (c) => {
      const input = learningSpaceRequest.parse(await c.req.json());
      const args = [
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
      ] as const;
      const applied =
        action === 'decline'
          ? await engine.decline(...args)
          : action === 'delete'
            ? await engine.remove(...args)
            : action === 'pause'
              ? await engine.pause(...args)
              : await engine.resume(...args);
      return c.json({ skill: applied });
    });
  // "Do not do this": the skill stops, and its name and body stay prohibited until lifted.
  app.post('/engine-skills/:id/stop', async (c) => {
    const input = procedureReasonRequest.parse(await c.req.json());
    return c.json({
      skill: await engine.stop(
        c.get('owner').id,
        input.space_id,
        procedureId.parse(c.req.param('id')),
        input.reason,
      ),
    });
  });
}
