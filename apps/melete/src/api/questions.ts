import type { Context, Hono } from 'hono';
import type { AnswerResult, QuestionService } from '../jobs/questions.ts';
import { jobView } from '../jobs/service.ts';

export function mountQuestions(app: Hono, questions: QuestionService) {
  app.get('/questions', async (c) => c.json({ questions: await questions.list() }));
  app.post('/questions/:id/answer', async (c) => {
    const result = await questions.answer(c.req.param('id'), await c.req.json());
    return answered(c, result);
  });
  // A secret's value arrives here alone and is sealed; nothing below echoes it.
  app.post('/questions/:id/secret', async (c) => {
    const body = await c.req.json().catch(() => null);
    return answered(c, await questions.answerSecret(c.req.param('id'), body));
  });
}

function answered(c: Context, result: AnswerResult) {
  return c.json(
    {
      question: result.question,
      job: result.job ? jobView(result.job) : null,
      receipt: result.receipt,
      ...(result.error ? { error: result.error } : {}),
    },
    result.status,
  );
}
