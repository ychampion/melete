/**
 * `melete browser enable [--space <id>]`: turns on the browser worker for one
 * space, the first person's own unless `--space` names another. Run it once
 * the account exists; running it again changes nothing.
 *
 * 1. The browser Compose check runs first; a failure stops everything.
 * 2. The service makes the space's browser connection, and its directory, as
 *    the service (apps/melete/src/workers/browser/enable.ts).
 * 3. A one-shot container, run as root on that space's subdirectory of the
 *    `spaces` volume and nothing else, makes `browser` there for uid/gid 10003
 *    with mode 0700. It changes that one directory, never anything under it.
 * 4. deploy/.env gets MELETE_BROWSER_SPACE and a new MELETE_BROWSER_TOKEN (an
 *    existing token is kept), deploy/melete.deploy.json lists the `browser`
 *    overlay, and deploy/config/connections.json selects the browser for the
 *    connection. Each file is written only when it changes.
 * 5. The worker image is built, and the stack is started with the overlay.
 *
 * The token is never printed. One worker serves one space: a second space runs
 * a worker of its own, set up by hand as docs/browser-worker.md describes.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserComposeResults } from '../../../../deploy/scripts/browser-compose-check.ts';
import { withSetting } from '../../../../deploy/scripts/set-env.ts';
import {
  ENV_FILE_MODE,
  type FileReplacer,
  fileReplacer,
  replaceFile,
} from '../../../../deploy/scripts/tailscale-origin.ts';
import { browserEntries, CONNECTIONS_FILE, readConnections } from '../browser.ts';
import type { Context } from '../context.ts';
import {
  composeCommand,
  DEPLOY_FILE,
  type DeployConfig,
  deployConfigSchema,
  renderDeployConfig,
} from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export const BROWSER_USAGE = 'Usage: bun run melete browser enable [--space <space id>]';
/** The worker's uid and gid, as deploy/docker-compose.browser.yml runs it. */
export const BROWSER_UID = 10003;
const SPACE_ID = /^sp_[A-Za-z0-9_-]+$/;
const SERVICE_SCRIPT = 'apps/melete/src/workers/browser/enable.ts';

/**
 * Run as root in a container that sees only the space's own directory at
 * /space. A link is refused rather than followed, and only `browser` itself is
 * given to the worker: nothing under it, and not the space root, whose owner
 * and mode are printed so the caller can check the worker can pass through it.
 */
export const PROVISION_SCRIPT = [
  'set -eu',
  'd=/space/browser',
  'if [ -L "$d" ]; then echo "$d is a link" >&2; exit 3; fi',
  'if [ ! -e "$d" ]; then mkdir -m 0700 "$d"; fi',
  'if [ -L "$d" ] || [ ! -d "$d" ]; then echo "$d is not a directory" >&2; exit 3; fi',
  `chown -h ${BROWSER_UID}:${BROWSER_UID} "$d"`,
  'chmod 0700 "$d"',
  'stat -c "%u:%g %a" /space "$d"',
].join('\n');

export class BrowserRefusal extends Error {}
/** A file could not be written after the run had begun changing them. */
class PartialWrite extends Error {}
export function browserOptions(args: readonly string[]): { space?: string } {
  if (args[0] !== 'enable') throw new BrowserRefusal(BROWSER_USAGE);
  let space: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--space' && space === undefined) {
      space = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--space=') && space === undefined) space = arg.slice(8);
    else throw new BrowserRefusal(`${arg} is not an option here. ${BROWSER_USAGE}`);
  }
  if (space !== undefined && !SPACE_ID.test(space))
    throw new BrowserRefusal(`--space takes a space id such as sp_.... ${BROWSER_USAGE}`);
  return space === undefined ? {} : { space };
}

/** The one-shot container that gives the worker its directory, and nothing more. */
export function provisionCommand(volume: string, spaceId: string, image: string): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'DAC_OVERRIDE',
    '--cap-add',
    'FOWNER',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--mount',
    `type=volume,source=${volume},target=/space,volume-subpath=${spaceId}`,
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    PROVISION_SCRIPT,
  ];
}

/** What the provisioning container printed, judged: the worker's directory and the root it passes through. */
export function judgeProvisioned(stdout: string): string | null {
  const [root, browser] = stdout.trim().split(/\r?\n/);
  if (browser?.trim() !== `${BROWSER_UID}:${BROWSER_UID} 700`)
    return `the space's browser directory reads ${browser?.trim() || 'nothing'}, not ${BROWSER_UID}:${BROWSER_UID} 700`;
  const mode = Number.parseInt(root?.trim().split(' ')[1] ?? '', 8);
  if (Number.isNaN(mode) || (mode & 0o001) === 0)
    return `the space's own directory (${root?.trim() || 'unknown'}) cannot be passed through by uid ${BROWSER_UID}; it was left as it is`;
  return null;
}

/** A token kept when deploy/.env has a usable one, so a second run changes nothing. */
const usableToken = (value: string | undefined) =>
  value !== undefined && value.trim().length >= 32 && !/\s/.test(value.trim());

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim() ?? '';

export async function runBrowser(
  context: Context,
  args: readonly string[],
  file: FileReplacer = fileReplacer,
): Promise<ExitCode> {
  try {
    const options = browserOptions(args);
    const installation = readInstallation(context.deployDir, context.machine.platform);
    const env = installation.env;
    if (env === null)
      throw new BrowserRefusal('There is no deploy/.env yet. Run bun run melete init first.');
    if (installation.loaded.kind === 'invalid')
      throw new BrowserRefusal(
        `${DEPLOY_FILE} is not valid (${installation.loaded.issues.join('; ')}); correct it first.`,
      );
    const configured = env.MELETE_BROWSER_SPACE?.trim() || undefined;
    if (configured && options.space && configured !== options.space)
      throw new BrowserRefusal(
        `The browser worker already works for ${configured}. One worker serves one space; docs/browser-worker.md shows how to run another for ${options.space}. Nothing was changed.`,
      );
    let failures: { name: string }[];
    try {
      failures = browserComposeResults(context.deployDir).filter((result) => !result.ok);
    } catch (error) {
      // A file that does not parse is refused like one that fails a check.
      failures = [
        { name: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' },
      ];
    }
    if (failures.length > 0)
      throw new BrowserRefusal(
        `The browser Compose files fail their check (${failures.map((result) => result.name).join('; ')}). Restore them from the release and run this again. Nothing was changed.`,
      );
    const connections = readConnections(context.deployDir);
    if ('problem' in connections)
      throw new BrowserRefusal(`${connections.problem}. Correct it first. Nothing was changed.`);
    const image = installation.compose[0]?.raw?.services?.postgres as { image?: unknown };
    if (typeof image?.image !== 'string')
      throw new BrowserRefusal('deploy/docker-compose.yml names no postgres image.');
    const helperImage = image.image;
    const space = options.space ?? configured;

    return await withLock(context.deployDir, 'browser enable', async () => {
      const current = installation.config;
      // The service is asked with the files it runs with now: the overlay needs
      // settings that may not be written yet.
      const running = composeCommand(context.deployDir, {
        ...current,
        overlays: current.overlays.filter((overlay) => overlay !== 'browser'),
      });
      const asked = context.run(
        [
          ...running,
          'exec',
          '-T',
          'melete',
          'bun',
          'run',
          SERVICE_SCRIPT,
          ...(space ? ['--space', space] : []),
        ],
        120_000,
      );
      if (asked.code !== 0)
        throw new BrowserRefusal(
          asked.code === 2
            ? `${lastLine(asked.stderr)} Nothing was changed.`
            : `The service did not answer (${lastLine(asked.stderr) || `exit ${asked.code}`}). Start Melete, create your account, then run this again. Nothing was changed.`,
        );
      let enabled: { space_id: string; connection_id: string; created: boolean };
      try {
        enabled = JSON.parse(lastLine(asked.stdout));
      } catch {
        throw new BrowserRefusal('The service answered with something other than its result.');
      }
      if (!SPACE_ID.test(enabled.space_id) || !/^conn_[A-Za-z0-9_-]+$/.test(enabled.connection_id))
        throw new BrowserRefusal('The service answered with an id this command does not accept.');

      // 3. The worker's directory, as root on that one subpath.
      const volume = `${current.project}_spaces`;
      if (context.run(['docker', 'volume', 'inspect', '--format', '{{.Name}}', volume]).code !== 0)
        throw new BrowserRefusal(
          `There is no ${volume} volume on this engine, so Melete has not started here yet.`,
        );
      const made = context.run(
        provisionCommand(volume, enabled.space_id, helperImage),
        10 * 60_000,
      );
      const problem =
        made.code === 0
          ? judgeProvisioned(made.stdout)
          : lastLine(made.stderr) || `exit ${made.code}`;
      if (problem)
        throw new BrowserRefusal(
          `The worker's directory could not be made: ${problem}. deploy/.env and the Compose files were not changed.`,
        );

      // 4. The files, each only when it changes.
      const envPath = join(context.deployDir, '.env');
      const envBefore = readFileSync(envPath, 'utf8');
      let envAfter = withSetting(envBefore, 'MELETE_BROWSER_SPACE', enabled.space_id);
      if (!usableToken(env.MELETE_BROWSER_TOKEN))
        envAfter = withSetting(envAfter, 'MELETE_BROWSER_TOKEN', randomBytes(32).toString('hex'));
      const next: DeployConfig = deployConfigSchema.parse({
        ...current,
        overlays: current.overlays.includes('browser')
          ? current.overlays
          : [...current.overlays, 'browser'],
      });
      const contractPath = join(context.deployDir, DEPLOY_FILE);
      const contractBefore = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : null;
      const contractAfter =
        installation.loaded.kind === 'found' &&
        renderDeployConfig(installation.loaded.config) === renderDeployConfig(next)
          ? contractBefore
          : renderDeployConfig(next);
      const connectionsPath = join(context.deployDir, CONNECTIONS_FILE);
      const listed = browserEntries(connections).some(
        (entry) => entry.id === enabled.connection_id,
      );
      const written: string[] = [];
      const write = async (path: string, text: string, mode: number, name: string) => {
        try {
          await replaceFile(path, text, file, mode);
        } catch (error) {
          throw new PartialWrite(
            `${name} could not be written (${error instanceof Error ? error.message : error})${written.length ? `, after ${written.join(' and ')} were` : ''}. Run this again once it can be.`,
          );
        }
        written.push(name);
      };
      if (envAfter !== envBefore) await write(envPath, envAfter, ENV_FILE_MODE, 'deploy/.env');
      if (contractAfter !== contractBefore && contractAfter !== null)
        await write(contractPath, contractAfter, 0o644, `deploy/${DEPLOY_FILE}`);
      // Written last: it is the file a start without the overlay refuses.
      if (!listed)
        await write(
          connectionsPath,
          `${JSON.stringify([...connections, { kind: 'browser', id: enabled.connection_id }], null, 2)}\n`,
          0o644,
          'deploy/config/connections.json',
        );
      context.out(
        written.length === 0 && !enabled.created
          ? `The browser worker's settings are already in place for ${enabled.space_id}.\n`
          : `Set up the browser worker for ${enabled.space_id}${written.length ? `: wrote ${written.join(', ')}` : ''}.\n`,
      );

      // 5. Build the worker and start the stack with it.
      const compose = composeCommand(context.deployDir, next);
      const built = await context.attach([...compose, 'build', 'browser']);
      const started =
        built === 0
          ? await context.attach([
              ...compose,
              'up',
              '-d',
              '--no-build',
              '--wait',
              '--wait-timeout',
              '600',
            ])
          : built;
      if (started !== 0) {
        context.err(
          `The settings are written, but the stack did not ${built === 0 ? 'become healthy' : 'build the browser image'}. See ${compose.join(' ')} logs --tail=100 browser melete, then run this again.\n`,
        );
        return EXIT.partial;
      }
      context.out(
        `The browser worker is on. bun run melete deploy starts it with the rest; a docker compose command needs -f deploy/docker-compose.browser.yml after -f deploy/docker-compose.yml from now on.\n`,
      );
      return EXIT.ok;
    });
  } catch (error) {
    if (error instanceof PartialWrite) {
      context.err(`${error.message}\n`);
      return EXIT.partial;
    }
    if (error instanceof BrowserRefusal || error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
