/**
 * `melete browser files --connection <id>`: what turning the browser worker on
 * writes to deploy/melete.deploy.json and deploy/config/connections.json, worked
 * out by the same function `browser enable` uses. It reads and writes nothing
 * itself, so it runs in the service image, where the one-line installer asks it
 * on a host without Bun:
 *
 *   docker compose exec -T melete bun run melete browser files --connection conn_...
 *
 * Its input, on stdin, is three lines, each a file's text in base64 or `-` for
 * a file that is not there:
 *
 *   1. the deploy/.env settings the contract is derived from: COMPOSE_PROJECT_NAME,
 *      MELETE_IMAGE_TAG, MELETE_IMAGE_REGISTRY and MELETE_SANDBOX_PROVIDER, and no other;
 *   2. deploy/melete.deploy.json;
 *   3. deploy/config/connections.json.
 *
 * Its output is two lines, the new deploy/melete.deploy.json and the new
 * deploy/config/connections.json, each in base64, or `-` when that file stays
 * as it is. A contract or connections file it cannot read is refused with exit
 * 2 and one line on stderr.
 */
import { parseEnvFile } from '../../../../deploy/scripts/provider-settings.ts';
import { browserFileChanges, CONNECTION_ID, parseConnections } from '../browser.ts';
import type { Context } from '../context.ts';
import {
  DEPLOY_FILE,
  defaultDeployConfig,
  type LoadedConfig,
  parseDeployConfig,
} from '../deploy-config.ts';
import { configFromEnv } from '../installation.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export const FILES_USAGE = 'Usage: bun run melete browser files --connection <connection id>';

/** The deploy/.env settings the contract is derived from; nothing else is read. */
export const CONTRACT_SETTINGS = [
  'COMPOSE_PROJECT_NAME',
  'MELETE_IMAGE_TAG',
  'MELETE_IMAGE_REGISTRY',
  'MELETE_SANDBOX_PROVIDER',
] as const;

class FilesRefusal extends Error {}

const decode = (line: string | undefined): string | null => {
  const text = (line ?? '').trim();
  if (text === '-') return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new FilesRefusal('The input is not base64.');
  return Buffer.from(text, 'base64').toString('utf8');
};

const encode = (text: string | null): string =>
  text === null ? '-' : Buffer.from(text, 'utf8').toString('base64');

export async function runBrowserFiles(
  context: Context,
  args: readonly string[],
  input: () => Promise<string> = () => Bun.stdin.text(),
): Promise<ExitCode> {
  try {
    const connectionId =
      args.length === 3 && args[0] === 'files' && args[1] === '--connection' ? args[2] : undefined;
    if (connectionId === undefined || !CONNECTION_ID.test(connectionId))
      throw new FilesRefusal(FILES_USAGE);
    // A file's line may be empty, the base64 of an empty file; only the last line break is dropped.
    const lines = (await input()).replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length !== 3)
      throw new FilesRefusal(
        'The input is three lines: the settings, the contract and the connections.',
      );
    const parsed = parseEnvFile(decode(lines[0]) ?? '');
    const settings: Record<string, string> = {};
    for (const name of CONTRACT_SETTINGS)
      if (parsed[name] !== undefined) settings[name] = parsed[name];
    const contractText = decode(lines[1]);
    const loaded: LoadedConfig =
      contractText === null
        ? { kind: 'missing', config: defaultDeployConfig() }
        : parseDeployConfig(contractText);
    if (loaded.kind === 'invalid')
      throw new FilesRefusal(
        `${DEPLOY_FILE} is not valid (${loaded.issues.join('; ')}); correct it first.`,
      );
    const connections = parseConnections(decode(lines[2]));
    if ('problem' in connections)
      throw new FilesRefusal(`${connections.problem}. Correct it first.`);
    let config = loaded.config;
    if (loaded.kind === 'missing')
      try {
        config = configFromEnv(settings);
      } catch {
        // As readInstallation does: settings that do not make a contract leave the defaults.
      }
    const changes = browserFileChanges({ loaded, config, contractText, connections, connectionId });
    context.out(`${encode(changes.contract)}\n${encode(changes.connections)}\n`);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof FilesRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
}
