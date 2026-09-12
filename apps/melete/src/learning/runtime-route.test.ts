import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { learningRuntimeFetch } from './runtime-route.ts';

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
