/**
 * Whether the browser worker is on, judged from the installation's files: the
 * deploy contract's `browser` overlay, the two settings in deploy/.env, and the
 * owner-controlled deploy/config/connections.json. `check` and `doctor` both
 * report it, and every problem names the one command that settles it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Installation } from './installation.ts';
import type { Result } from './schema.ts';

export const ENABLE_COMMAND = 'bun run melete browser enable';
export const CONNECTIONS_FILE = join('config', 'connections.json');
const SPACE_ID = /^sp_[A-Za-z0-9_-]+$/;

export type BrowserEntry = { kind: 'browser'; id: string; worker_url?: string };

/** The connections file's entries, or why it cannot be read. A missing file is an empty list. */
export function readConnections(deployDir: string): unknown[] | { problem: string } {
  const path = join(deployDir, CONNECTIONS_FILE);
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
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

export function judgeBrowser(installation: Installation): Result[] {
  const { env, config } = installation;
  if (env === null) return [];
  const read = readConnections(installation.deployDir);
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
  const overlay = config.overlays.includes('browser');
  const space = env.MELETE_BROWSER_SPACE?.trim() ?? '';
  const token = env.MELETE_BROWSER_TOKEN?.trim() ?? '';
  const fail = (detail: string): Result[] => [
    { id: 'browser.worker', level: 'fail', detail, fix: `Run ${ENABLE_COMMAND}.` },
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
        fix: `Once your account exists, run ${ENABLE_COMMAND}.`,
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
        fix: `Run ${ENABLE_COMMAND}.`,
      },
    ];
  return [{ id: 'browser.worker', level: 'ok', detail: `The browser worker works for ${space}.` }];
}
