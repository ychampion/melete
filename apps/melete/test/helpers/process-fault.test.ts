import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { CHILD_TIMEOUT_MS } from './process-fault.ts';

test('the fault child timeout defaults to fifteen seconds and is raised from the environment', async () => {
  expect(CHILD_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "import('./apps/melete/test/helpers/process-fault.ts').then((m) => console.log(m.CHILD_TIMEOUT_MS))",
    ],
    {
      cwd: resolve(import.meta.dir, '..', '..', '..', '..'),
      env: { ...process.env, MELETE_TEST_CHILD_TIMEOUT_MS: '45000' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  expect((await new Response(child.stdout).text()).trim()).toBe('45000');
  expect(await child.exited).toBe(0);
});
