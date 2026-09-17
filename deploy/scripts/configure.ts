/** Generate local deployment secrets once, without logging or overwriting them. */
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnvFile, providerWarnings } from './provider-settings.ts';

const root = resolve(import.meta.dir, '../..');
const target = resolve(root, 'deploy/.env');
const fake = process.argv.includes('--fake');
const socket = await stat('/var/run/docker.sock');
if (!socket.isSocket()) throw new Error('/var/run/docker.sock is not a Docker socket');
const template = await readFile(resolve(root, 'deploy/.env.example'), 'utf8');
const password = randomBytes(24).toString('hex');
const values: Record<string, string> = {
  MELETE_MASTER_KEY: randomBytes(32).toString('base64'),
  MELETE_CAPABILITY_KEY: randomBytes(32).toString('hex'),
  MELETE_APPROVAL_KEY: randomBytes(32).toString('hex'),
  MELETE_RUNTIME_KEY: randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgres://melete:${password}@postgres:5432/melete`,
  DOCKER_GID: String(socket.gid),
  ...(fake
    ? {
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_ENABLE_TEST_CONNECTOR: 'true',
        MELETE_DEFAULT_PROVIDER: 'fake',
        MELETE_DEFAULT_MODEL: 'scripted',
      }
    : {}),
};
const content = template.replace(/^([A-Z_]+)=(.*)$/gm, (line, name: string) =>
  name in values ? `${name}=${values[name]}` : line,
);
try {
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    throw new Error('deploy/.env already exists. Keep it; edit its settings to change providers.');
  }
  throw error;
}
process.stdout.write(
  `Created deploy/.env with private permissions${fake ? ' and the explicit fake provider' : ''}.\n`,
);
// A real provider is selected with its key still empty. Say so now, not at the first job.
for (const warning of providerWarnings(parseEnvFile(content)))
  process.stderr.write(`WARNING: ${warning}\n`);
