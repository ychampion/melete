/**
 * An installation's name, of any length its setting allows, never stops the
 * instructions from loading: the identity's cap holds the file as written.
 */
import { expect, test } from 'bun:test';
import { DISPLAY_NAME_MAX } from '@melete/contracts';

const load = (env: Record<string, string>) =>
  Bun.spawnSync(['bun', '-e', 'await import("./instructions.ts")'], {
    cwd: import.meta.dir,
    // A blank identity file is unset, so the built-in identity takes the name.
    env: {
      ...process.env,
      MELETE_IDENTITY_FILE: '',
      MELETE_ASSISTANT_NAME: '',
      MELETE_INSTANCE_NAME: '',
      ...env,
    },
    stderr: 'pipe',
  });

test.each<Record<string, string>>([
  { MELETE_INSTANCE_NAME: 'Riverside Assistant' },
  { MELETE_ASSISTANT_NAME: 'Riverside Primary School Assistant' },
  { MELETE_ASSISTANT_NAME: 'x'.repeat(DISPLAY_NAME_MAX) },
])('the instructions load with %p', (env) => {
  const run = load(env);
  expect(run.stderr.toString()).toBe('');
  expect(run.exitCode).toBe(0);
});
