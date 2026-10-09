/**
 * Whether the browser worker is on, judged from the installation's files: the
 * deploy contract's `browser` overlay, the two settings in deploy/.env, and the
 * owner-controlled deploy/config/connections.json. `check` and `doctor` both
 * report it, and every problem names the one command that settles it. Inside
 * the service's container, where there is no deploy/.env, the same judgment is
 * made from the settings and the connections file the service runs with.
 *
 * It also holds what turning the worker on writes to the deploy contract and the
 * connections file, shared by `browser enable` and by the one-line installer,
 * which asks the service image for it with `browser files`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DeployConfig,
  deployConfigSchema,
  type LoadedConfig,
  renderDeployConfig,
} from './deploy-config.ts';
import type { Installation } from './installation.ts';
import type { Result } from './schema.ts';

export const ENABLE_COMMAND = 'bun run melete browser enable';
/** The same, on a host that runs the published images without Bun. */
export const INSTALLER_ENABLE_COMMAND =
  'MELETE_BROWSER=1 curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | bash';
export const CONNECTIONS_FILE = join('config', 'connections.json');
export const SPACE_ID = /^sp_[A-Za-z0-9_-]+$/;
export const CONNECTION_ID = /^conn_[A-Za-z0-9_-]+$/;

export type BrowserEntry = { kind: 'browser'; id: string; worker_url?: string };

/** The connections file's entries, or why it cannot be read. A missing file is an empty list. */
export function readConnections(deployDir: string): unknown[] | { problem: string } {
  const path = join(deployDir, CONNECTIONS_FILE);
  return parseConnections(existsSync(path) ? readFileSync(path, 'utf8') : null);
}

/** The connections file's text as its entries; null, a missing file, is an empty list. */
export function parseConnections(text: string | null): unknown[] | { problem: string } {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      problem: `deploy/config/connections.json is not JSON: ${error instanceof Error ? error.message : error}`,
    };
  }
  return Array.isArray(value)
    ? value
    : { problem: 'deploy/config/connections.json is not a list of connections' };
}

/** Entries that select the browser for a connection. */
export const browserEntries = (entries: readonly unknown[]): BrowserEntry[] =>
  entries.filter(
    (entry): entry is BrowserEntry =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry as { kind?: unknown }).kind === 'browser' &&
      typeof (entry as { id?: unknown }).id === 'string',
  );

/** What the judgment reads, from the installation's files or from inside the service. */
type BrowserFacts = {
  connections: unknown[] | { problem: string };
  overlay: boolean;
  space: string;
  token: string;
  /** The command that settles a problem where this runs. */
  command: string;
};

/**
 * The browser worker's state. From a checkout it reads the installation's
 * files. Inside the service's container (no deploy/.env, but the service's own
 * MELETE_CONNECTIONS_FILE) it reads what the service runs with: the overlay
 * gives the service MELETE_BROWSER_URL beside the space and the token.
 */
export function judgeBrowser(
  installation: Installation,
  environment: Readonly<Record<string, string | undefined>> = {},
): Result[] {
  const { env, config } = installation;
  if (env !== null)
    return judgeBrowserFacts({
      connections: readConnections(installation.deployDir),
      overlay: config.overlays.includes('browser'),
      space: env.MELETE_BROWSER_SPACE?.trim() ?? '',
      token: env.MELETE_BROWSER_TOKEN?.trim() ?? '',
      command: ENABLE_COMMAND,
    });
  const file = environment.MELETE_CONNECTIONS_FILE?.trim();
  if (!file) return [];
  return judgeBrowserFacts({
    connections: parseConnections(existsSync(file) ? readFileSync(file, 'utf8') : null),
    overlay: Boolean(environment.MELETE_BROWSER_URL?.trim()),
    space: environment.MELETE_BROWSER_SPACE?.trim() ?? '',
    token: environment.MELETE_BROWSER_TOKEN?.trim() ?? '',
    command: `the installer with MELETE_BROWSER=1 (${INSTALLER_ENABLE_COMMAND}), or ${ENABLE_COMMAND} from a checkout`,
  });
}

function judgeBrowserFacts(facts: BrowserFacts): Result[] {
  const read = facts.connections;
  if ('problem' in read)
    return [
      {
        id: 'browser.connections',
        level: 'fail',
        detail: `${read.problem}, so the service refuses to start.`,
        fix: 'Correct deploy/config/connections.json; docs/browser-worker.md shows its form.',
      },
    ];
  // An entry with its own worker address is a worker the operator runs elsewhere.
  const local = browserEntries(read).filter((entry) => entry.worker_url === undefined);
  const { overlay, space, token, command } = facts;
  const fail = (detail: string): Result[] => [
    { id: 'browser.worker', level: 'fail', detail, fix: `Run ${command}.` },
  ];

  if (!overlay) {
    if (local.length > 0)
      return fail(
        'deploy/config/connections.json names a browser connection, but the stack runs without deploy/docker-compose.browser.yml, so the service refuses to start.',
      );
    return [
      {
        id: 'browser.worker',
        level: 'warn',
        detail:
          'The browser worker is off, so the agent has no browser of its own to read pages and fill in forms with.',
        fix: `Once your account exists, run ${command}.`,
      },
    ];
  }
  if (!SPACE_ID.test(space))
    return fail(
      space
        ? `MELETE_BROWSER_SPACE is ${space}, which is not a space id.`
        : 'The browser overlay is on, but deploy/.env names no MELETE_BROWSER_SPACE.',
    );
  if (token.length < 32 || /\s/.test(token))
    return fail(
      'MELETE_BROWSER_TOKEN in deploy/.env is missing or shorter than 32 characters, so the worker will not start.',
    );
  if (local.length === 0)
    return [
      {
        id: 'browser.worker',
        level: 'warn',
        detail:
          'The browser worker runs, but no connection in deploy/config/connections.json uses it.',
        fix: `Run ${command}.`,
      },
    ];
  return [{ id: 'browser.worker', level: 'ok', detail: `The browser worker works for ${space}.` }];
}

/**
 * What turning the worker on changes in the deploy contract and the connections
 * file: each new text, or null when that file stays as it is. The contract
 * gains the `browser` overlay (a missing file is written out in full, from the
 * contract in force). The connections file gains the connection's browser entry
 * unless it lists it already; every caller writes it last, since a start
 * without the overlay refuses it.
 */
export function browserFileChanges(input: {
  loaded: LoadedConfig;
  /** The contract in force: the file's, or what deploy/.env implies without one. */
  config: DeployConfig;
  contractText: string | null;
  connections: readonly unknown[];
  connectionId: string;
}): { config: DeployConfig; contract: string | null; connections: string | null } {
  const { loaded, config, contractText, connections, connectionId } = input;
  const next: DeployConfig = deployConfigSchema.parse({
    ...config,
    overlays: config.overlays.includes('browser')
      ? config.overlays
      : [...config.overlays, 'browser'],
  });
  const contractAfter =
    loaded.kind === 'found' && renderDeployConfig(loaded.config) === renderDeployConfig(next)
      ? contractText
      : renderDeployConfig(next);
  const listed = browserEntries(connections).some((entry) => entry.id === connectionId);
  return {
    config: next,
    contract: contractAfter !== null && contractAfter !== contractText ? contractAfter : null,
    connections: listed
      ? null
      : `${JSON.stringify([...connections, { kind: 'browser', id: connectionId }], null, 2)}\n`,
  };
}
