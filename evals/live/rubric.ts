/**
 * The optional model grade beside a deterministic check. It is off unless
 * `--rubric` is given and `FIREWORKS_API_KEY` is in the environment; the grade
 * is reported, never used to decide a bar.
 */
import { MODEL, priceOf } from '../state.ts';
import type { Task } from './types.ts';

export type Grader = (
  task: Task,
  request: string,
  reply: string,
) => Promise<{ score: number; reason: string } | null>;

export function fireworksGrader(key: string, spent: { usd: number }): Grader {
  const price = priceOf(MODEL);
  return async (task, request, reply) => {
    const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You grade an assistant\'s answer for a demanding person. Reply with JSON {"score": 1-5, "reason": "one sentence"}.',
          },
          {
            role: 'user',
            content: `Request: ${request}\nWhat a good answer does: ${task.rubric}\n\nAnswer:\n${reply.slice(0, 12000)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (price && body.usage)
      spent.usd +=
        ((body.usage.prompt_tokens ?? 0) * price.input +
          (body.usage.completion_tokens ?? 0) * price.output) /
        1_000_000;
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as {
      score?: number;
      reason?: string;
    };
    return typeof parsed.score === 'number'
      ? { score: parsed.score, reason: String(parsed.reason ?? '') }
      : null;
  };
}
