import {
  keepAnswerRequest,
  learnedTryRequest,
  learnedUndoRequest,
  learningNoticeId,
  learningSpaceQuery,
  learningSpaceRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import type { LearnedService } from './learned.ts';

/** The person's own view of what was learned, and their answers to what learning asks. */
export function mountLearned(app: Hono, service: LearnedService) {
  app.get('/learned', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json(await service.list(c.get('owner').id, input.space_id));
  });
  app.post('/learned/undo', async (c) => {
    const input = learnedUndoRequest.parse(await c.req.json());
    return c.json(await service.undo(c.get('owner').id, input.space_id, input.change_id));
  });
  app.post('/learned/:id/try', async (c) => {
    const input = learnedTryRequest.parse(await c.req.json());
    return c.json(
      await service.try(
        c.get('owner').id,
        input.space_id,
        c.req.param('id'),
        input.definition_hash,
      ),
    );
  });
  for (const action of ['pause', 'resume', 'remove'] as const)
    app.post(`/learned/:id/${action}`, async (c) => {
      const input = learningSpaceRequest.parse(await c.req.json());
      return c.json(
        await service.change(c.get('owner').id, input.space_id, c.req.param('id'), action),
      );
    });
  app.get('/learning/notices', async (c) => {
    const input = learningSpaceQuery.parse(c.req.query());
    return c.json({ notices: await service.notices(c.get('owner').id, input.space_id) });
  });
  app.post('/learning/notices/:id/answer', async (c) => {
    const id = learningNoticeId.parse(c.req.param('id'));
    const input = keepAnswerRequest.parse(await c.req.json());
    return c.json(await service.answer(c.get('owner').id, input.space_id, id, input));
  });
  app.post('/learning/notices/:id/read', async (c) => {
    const id = learningNoticeId.parse(c.req.param('id'));
    const input = learningSpaceRequest.parse(await c.req.json());
    return c.json({ notice: await service.read(c.get('owner').id, input.space_id, id) });
  });
}
