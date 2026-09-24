import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { ENGINE_SKILL_PATH, learningRuntimeFetch } from './runtime-route.ts';

test('a rejected schema probe is retried on the next catalog request', async () => {
  let probes = 0;
  const errors: unknown[] = [];
  const sql = (async () => {
    probes++;
    if (probes === 1) throw new Error('Transient database connection failure');
    return [{ available: false }];
  }) as unknown as Sql;
  const fetch = learningRuntimeFetch({
    sql,
    capabilityKey: 'unused-before-learning-migration',
    broker: {
      authorize: async () => {
        throw new Error('Schema is not installed');
      },
    },
    fallback: () => Response.json({ tools: [] }),
    onError: (error) => errors.push(error),
  });
  expect((await fetch(new Request('http://local/tools'))).status).toBe(500);
  expect((await fetch(new Request('http://local/tools'))).status).toBe(200);
  expect((await fetch(new Request('http://local/tools'))).status).toBe(200);
  expect(probes).toBe(2);
  expect(errors).toHaveLength(1);
});

test('an unwired skill intake refuses loudly instead of looking absent', async () => {
  const errors: unknown[] = [];
  const sql = (async () => [{ available: true }]) as unknown as Sql;
  const fetch = learningRuntimeFetch({
    sql,
    capabilityKey: 'a-capability-key-of-at-least-thirty-two-bytes',
    broker: { authorize: async () => {} },
    fallback: () => Response.json({ error: { code: 'not_found' } }, { status: 404 }),
    onError: (error) => errors.push(error),
  });
  const post = () =>
    fetch(
      new Request(`http://local${ENGINE_SKILL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'weekly-digest', description: '', body: 'Keep it short.' }),
      }),
    );
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'skill_intake_unwired' } });
  // Said once, so a busy plugin cannot fill the log with the same deployment mistake.
  await post();
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain('mounted without a service');
});
