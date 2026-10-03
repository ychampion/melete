/**
 * `melete logs [service ...] [--since 1h] [--tail 100] [--follow] [--timestamps]`:
 * the stack's logs through `docker compose logs`, with the contract's overlay
 * files and profiles, so a service an overlay adds is found by name.
 */
import type { Context } from '../context.ts';
import { composeCommand } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export const LOGS_USAGE =
  'Usage: bun run melete logs [service ...] [--since <time>] [--tail <lines>] [--follow] [--timestamps]';

export class LogsRefusal extends Error {}

/** The `docker compose logs` arguments for what was asked; anything else is refused. */
export function logsArguments(args: readonly string[]): string[] {
  const out: string[] = [];
  const services: string[] = [];
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
    else if (/^[a-z0-9][a-z0-9_.-]*$/.test(arg)) services.push(arg);
    else throw new LogsRefusal(`${arg} is not a service or an option. ${LOGS_USAGE}`);
  }
  return [...out, ...services];
}

export async function runLogs(context: Context, args: readonly string[]): Promise<ExitCode> {
  let options: string[];
  try {
    options = logsArguments(args);
  } catch (error) {
    if (!(error instanceof LogsRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
  const { config } = readInstallation(context.deployDir, context.machine.platform);
  const code = await context.attach([
    ...composeCommand(context.deployDir, config),
    'logs',
    ...options,
  ]);
  return code === 0 ? EXIT.ok : EXIT.failed;
}
