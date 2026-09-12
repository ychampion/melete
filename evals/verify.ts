import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  command,
  DATA,
  DATABASE_CONTAINER,
  DATABASE_NAME,
  PRIVATE,
  PROJECT,
  type Secrets,
} from './stack.ts';

/** Run the repository's verification commands against only the evaluation database.
 * Existing test helpers create and remove their own disposable databases.
 * The database password is passed in the child environment, never printed.
 */
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const allowed = new Set([
  'test',
  'test:plugin',
  'conformance',
  'conformance:memory',
  'typecheck',
  'lint',
]);
const script = args.shift();
if (!script || !allowed.has(script)) throw new Error('Choose a repository verification script');
const owner = await command([
  'docker',
  'inspect',
  DATABASE_CONTAINER,
  '--format',
  '{{index .Config.Labels "com.docker.compose.project"}}',
]);
if (owner !== PROJECT) throw new Error('Evaluation database ownership mismatch');
const address = await command([
  'docker',
  'inspect',
  DATABASE_CONTAINER,
  '--format',
  `{{(index .NetworkSettings.Networks "${PROJECT}_database").IPAddress}}`,
]);
if (!/^\d+\.\d+\.\d+\.\d+$/.test(address))
  throw new Error('Evaluation database has no private address');
const secrets: Secrets = JSON.parse(await readFile(resolve(PRIVATE, 'secrets.json'), 'utf8'));
const temporary = resolve(DATA, 'verification-tmp');
await mkdir(temporary, { recursive: true, mode: 0o700 });
const run = Bun.spawn([process.execPath, 'run', script, ...args], {
  env: {
    ...process.env,
    TMPDIR: temporary,
    DATABASE_URL: `postgres://evals:${secrets.database}@${address}:5432/${DATABASE_NAME}`,
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await run.exited);
