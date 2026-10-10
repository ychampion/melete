import { describe, expect, test } from 'bun:test';
import { type DatabaseHandle, pingDatabase } from './client.ts';

const handle = (answer: () => Promise<unknown>) =>
  ({ sql: () => answer() }) as unknown as DatabaseHandle;

describe('the health ping', () => {
  test('a database that answers is reachable', async () => {
    expect(await pingDatabase(handle(async () => [{ '?column?': 1 }]))).toBe(true);
  });

  test('a refused connection is unreachable', async () => {
    expect(await pingDatabase(handle(async () => Promise.reject(new Error('ECONNREFUSED'))))).toBe(
      false,
    );
  });

  test('a database that never answers is unreachable within the time limit', async () => {
    const started = Date.now();
    expect(
      await pingDatabase(
        handle(() => new Promise(() => {})),
        50,
      ),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
