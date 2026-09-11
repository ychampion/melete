import type { Hono } from 'hono';
import type { QuestionService } from '../jobs/questions.ts';
import { jobView } from '../jobs/service.ts';

export function mountQuestions(app: Hono, questions: QuestionService) {
  app.get('/questions', async (c) => c.json({ questions: await questions.list() }));
  app.post('/questions/:id/answer', async (c) => {
    const result = await questions.answer(c.req.param('id'), await c.req.json());
    return c.json(
      {
        question: result.question,
        job: result.job ? jobView(result.job) : null,
        receipt: result.receipt,
        ...(result.error ? { error: result.error } : {}),
      },
      result.status,
    );
  });
}
