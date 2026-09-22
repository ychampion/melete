/**
 * Generate local deployment secrets once, without logging or overwriting them.
 *
 *   bun run deploy/scripts/configure.ts [--fake]
 *     [--tailscale [--tailscale-hostname name]]
 *
 * `--tailscale` settles the node name the tailnet overlay joins under. It
 * writes no credential: the auth key is issued by the Tailscale admin console
 * and is pasted into deploy/.env afterwards.
 */
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { judgeHostDocker, readHostDocker } from '../../apps/melete/src/runtime/docker-engine.ts';
import { parseEnvFile, providerWarnings } from './provider-settings.ts';
import { TAILSCALE_USAGE, tailscaleNodeName, tailscaleNotes } from './tailscale-origin.ts';

/**
 * The options, refused whole when one is not known: the file is written once
 * and never replaced, so a misspelt `--fake` would otherwise leave a real
 * provider selected with no key, and the fix would be deleting the file.
 */
export function configureOptions(args: readonly string[]): {
  fake: boolean;
  nodeName: string | null;
} {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tailscale-hostname') index += 1;
    else if (argument !== '--fake' && argument !== '--tailscale')
      throw new Error(`Unknown option ${argument}. ${TAILSCALE_USAGE}`);
  }
  // Named before anything is written, so a misspelt node name costs nothing.
  return { fake: args.includes('--fake'), nodeName: tailscaleNodeName(args) };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const target = resolve(root, 'deploy/.env');
  const { fake, nodeName } = configureOptions(process.argv.slice(2));
  const socket = await stat('/var/run/docker.sock');
  if (!socket.isSocket()) throw new Error('/var/run/docker.sock is not a Docker socket');
  // An unsupported engine or Compose is named now, not as a failed `up` later.
  const unsupported = judgeHostDocker(readHostDocker());
  if (unsupported.length > 0) throw new Error(unsupported.join(' '));
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
    // TS_AUTHKEY stays as the template leaves it, which is empty: it is issued by
    // the Tailscale admin console and nothing here can invent one.
    ...(nodeName === null ? {} : { TS_HOSTNAME: nodeName }),
  };
  const content = template.replace(/^([A-Z_]+)=(.*)$/gm, (line, name: string) =>
    name in values ? `${name}=${values[name]}` : line,
  );
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        'deploy/.env already exists. Keep it; edit its settings to change providers.',
      );
    }
    throw error;
  }
  process.stdout.write(
    `Created deploy/.env with private permissions${fake ? ' and the explicit fake provider' : ''}.\n`,
  );
  if (nodeName !== null)
    for (const note of tailscaleNotes(nodeName)) process.stdout.write(`${note}\n`);
  // A real provider is selected with its key still empty. Say so now, not at the first job.
  for (const warning of providerWarnings(parseEnvFile(content)))
    process.stderr.write(`WARNING: ${warning}\n`);
}
