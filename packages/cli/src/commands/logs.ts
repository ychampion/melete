/**
 * `melete logs [service ...] [--since 1h] [--tail 100] [--follow] [--timestamps]`:
 * the stack's logs through `docker compose logs`, with the contract's overlay
 * files and profiles, so a service an overlay adds is found by name.
 *
 * `melete logs --attempts [attempt]` and `melete logs --computers [name]`: the
 * containers melete-cells starts outside Compose, found by this installation's
 * labels. Without a name they are listed; with one, that container's logs are
 * shown with the same options.
 */
import type { Context } from '../context.ts';
import { composeCommand } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export const LOGS_USAGE =
  'Usage: bun run melete logs [service ...] [--since <time>] [--tail <lines>] [--follow] [--timestamps], or logs --attempts [attempt] / --computers [name] with the same options';

export class LogsRefusal extends Error {}

/** Which containers outside Compose to look at, when asked. */
export type Cells = 'attempts' | 'computers';

/** The `docker compose logs` arguments for what was asked; anything else is refused. */
export function logsArguments(args: readonly string[]): string[] {
  const parsed = parseLogs(args);
  return [...parsed.options, ...parsed.names];
}

export function parseLogs(args: readonly string[]): {
  /** --since, --tail, --follow and --timestamps, as docker compose logs and docker logs take them. */
  options: string[];
  /** Services, or with --attempts or --computers the one container asked for. */
  names: string[];
  cells: Cells | null;
} {
  const out: string[] = [];
  const services: string[] = [];
  let cells: Cells | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('-'))
        throw new LogsRefusal(`${arg} needs a value. ${LOGS_USAGE}`);
      index += 1;
      return next;
    };
    if (arg === '--since') {
      const since = value();
      if (!/^[0-9A-Za-z:.+-]+$/.test(since))
        throw new LogsRefusal(`--since takes a duration such as 1h or a timestamp. ${LOGS_USAGE}`);
      out.push('--since', since);
    } else if (arg === '--tail') {
      const tail = value();
      if (!/^(\d+|all)$/.test(tail))
        throw new LogsRefusal(`--tail takes a number of lines or all. ${LOGS_USAGE}`);
      out.push('--tail', tail);
    } else if (arg === '--follow' || arg === '-f') out.push('--follow');
    else if (arg === '--timestamps' || arg === '-t') out.push('--timestamps');
    else if (arg === '--attempts' || arg === '--computers') {
      if (cells !== null)
        throw new LogsRefusal(`Ask for attempts or computers, not both. ${LOGS_USAGE}`);
      cells = arg === '--attempts' ? 'attempts' : 'computers';
    } else if (/^[a-z0-9][a-z0-9_.-]*$/.test(arg)) services.push(arg);
    else throw new LogsRefusal(`${arg} is not a service or an option. ${LOGS_USAGE}`);
  }
  if (cells !== null && services.length > 1)
    throw new LogsRefusal(
      `Name one ${cells === 'attempts' ? 'attempt' : 'computer'}. ${LOGS_USAGE}`,
    );
  return { options: out, names: services, cells };
}

export type CellContainer = { name: string; status: string; label: string };

const FORMAT = (label: string) => `{{.Names}}\t{{.Status}}\t{{.Label "${label}"}}`;

/** The `docker ps` that lists this installation's attempt engines or agents' computers. */
export function cellListing(cells: Cells, project: string, sandboxProject: string): string[] {
  return cells === 'attempts'
    ? [
        'docker',
        'ps',
        '--all',
        '--filter',
        `label=com.melete.project=${project}`,
        '--filter',
        'label=com.melete.attempt',
        '--format',
        FORMAT('com.melete.attempt'),
      ]
    : [
        'docker',
        'ps',
        '--all',
        '--filter',
        'label=com.melete.sandbox',
        '--filter',
        `label=melete.project=${sandboxProject}`,
        '--format',
        FORMAT('com.melete.sandbox.name'),
      ];
}

export function parseCellListing(stdout: string): CellContainer[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [name = '', status = '', label = ''] = line.split('\t');
      return { name, status, label };
    });
}

async function runCellLogs(
  context: Context,
  cells: Cells,
  options: string[],
  named: string | undefined,
): Promise<ExitCode> {
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const sandboxProject = installation.env?.MELETE_SANDBOX_PROJECT?.trim() ?? '';
  if (cells === 'computers' && !sandboxProject) {
    context.err(
      "MELETE_SANDBOX_PROJECT is empty in deploy/.env, so the agents' computers of this installation cannot be told apart from others on this engine.\n",
    );
    return EXIT.refused;
  }
  const listed = context.run(cellListing(cells, installation.config.project, sandboxProject));
  if (listed.code !== 0) {
    context.err(`docker ps did not answer: ${listed.stderr.trim() || `exit ${listed.code}`}\n`);
    return EXIT.failed;
  }
  const containers = parseCellListing(listed.stdout);
  const what = cells === 'attempts' ? 'attempt' : 'computer';
  if (named === undefined) {
    if (containers.length === 0) {
      context.out(`No ${what} containers for this installation.\n`);
      return EXIT.ok;
    }
    for (const container of containers)
      context.out(`${container.name}\t${container.status}\t${container.label}\n`);
    context.out(
      `Show one with bun run melete logs --${cells} <name or ${what === 'attempt' ? 'attempt id' : 'computer name'}>.\n`,
    );
    return EXIT.ok;
  }
  const container = containers.find(
    (candidate) =>
      candidate.name === named || candidate.label === named || candidate.name.endsWith(`-${named}`),
  );
  if (!container) {
    context.err(
      `No ${what} container of this installation is named ${named}; bun run melete logs --${cells} lists them. A container removed after its ${what} ended has no logs left.\n`,
    );
    return EXIT.refused;
  }
  const code = await context.attach(['docker', 'logs', ...options, container.name]);
  return code === 0 ? EXIT.ok : EXIT.failed;
}

export async function runLogs(context: Context, args: readonly string[]): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseLogs>;
  try {
    parsed = parseLogs(args);
  } catch (error) {
    if (!(error instanceof LogsRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
  if (parsed.cells)
    return await runCellLogs(context, parsed.cells, parsed.options, parsed.names[0]);
  const { config } = readInstallation(context.deployDir, context.machine.platform);
  const code = await context.attach([
    ...composeCommand(context.deployDir, config),
    'logs',
    ...parsed.options,
    ...parsed.names,
  ]);
  return code === 0 ? EXIT.ok : EXIT.failed;
}
