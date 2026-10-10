/**
 * `melete account <list|create|reset|disable|enable|setup-code> [<email>]` and
 * `melete feedback [list|show] …`: the operator's account and support tasks,
 * run in the service's container (apps/melete/src/account/cli.ts and
 * apps/melete/src/feedback/cli.ts), so `melete remote <host> account …` reaches
 * an installation without a shell on it. Links point at MELETE_PUBLIC_URL, or
 * at the loopback web port when there is none.
 */
import type { Context } from '../context.ts';
import { composeCommand } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export const ACCOUNT_SCRIPT = 'apps/melete/src/account/cli.ts';
export const FEEDBACK_SCRIPT = 'apps/melete/src/feedback/cli.ts';

export const ACCOUNT_USAGE = `Usage: bun run melete account <command> [--json]
  list                 Every account: email, kind, created, disabled, live sessions
  create <email>       A new account and a link to choose its password (the owner, on a new installation)
  reset <email>        A one-time link that sets a new password and signs the account out everywhere
  disable <email>      Stop the account signing in, and end its sessions, devices and connected apps
  enable <email>       Let a disabled account sign in again
  setup-code           A new one-time code for creating the first account`;

export const FEEDBACK_USAGE = `Usage: bun run melete feedback [list] [--all | --status open|fixing|fixed|wontfix]
       bun run melete feedback show FB-XXXX`;

const WITH_EMAIL = new Set(['create', 'reset', 'disable', 'enable']);
const WITHOUT = new Set(['list', 'setup-code']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The arguments handed to the service's script, or the reason they are refused. */
export function accountArguments(args: readonly string[]): string[] | string {
  const [command, target, ...extra] = args;
  if (!command || extra.length > 0) return ACCOUNT_USAGE;
  if (WITHOUT.has(command)) return target === undefined ? [command] : ACCOUNT_USAGE;
  if (!WITH_EMAIL.has(command)) return `${command} is not an account command.\n${ACCOUNT_USAGE}`;
  if (!target || !EMAIL.test(target)) return `${command} takes an email address.\n${ACCOUNT_USAGE}`;
  return [command, target];
}

/** The arguments handed to the feedback reader, or the reason they are refused. */
export function feedbackArguments(args: readonly string[]): string[] | string {
  const [command = 'list'] = args;
  if (command === 'show')
    return /^FB-?[0-9A-Za-z]{2,8}$/.test(args[1] ?? '') && args.length === 2
      ? [...args]
      : FEEDBACK_USAGE;
  const rest = command === 'list' ? args.slice(1) : args;
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '--all')) return [...args];
  if (
    rest.length === 2 &&
    rest[0] === '--status' &&
    ['open', 'fixing', 'fixed', 'wontfix'].includes(rest[1] ?? '')
  )
    return [...args];
  return FEEDBACK_USAGE;
}

/** Where a link printed here opens: the public address, or the web port on this machine. */
export function webUrlOf(env: Record<string, string> | null): string {
  const published = env?.MELETE_PUBLIC_URL?.trim();
  if (published) return published;
  const port = env?.WEB_PORT?.trim() || '3101';
  return `http://127.0.0.1:${port}`;
}

async function inService(
  context: Context,
  script: string,
  args: readonly string[],
): Promise<ExitCode> {
  const { config } = readInstallation(context.deployDir, context.machine.platform);
  const code = await context.attach([
    ...composeCommand(context.deployDir, config),
    'exec',
    '-T',
    'melete',
    'bun',
    'run',
    script,
    ...args,
  ]);
  // 1 is the script refusing (no such account, an owner already exists), 2 its usage.
  return code === 0 ? EXIT.ok : code === 1 || code === 2 ? EXIT.refused : EXIT.failed;
}

export async function runAccount(
  context: Context,
  args: readonly string[],
  json: boolean,
): Promise<ExitCode> {
  const parsed = accountArguments(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n`);
    return EXIT.refused;
  }
  const { env } = readInstallation(context.deployDir, context.machine.platform);
  return inService(context, ACCOUNT_SCRIPT, [
    ...parsed,
    '--web-url',
    webUrlOf(env),
    ...(json ? ['--json'] : []),
  ]);
}

export async function runFeedback(context: Context, args: readonly string[]): Promise<ExitCode> {
  const parsed = feedbackArguments(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n`);
    return EXIT.refused;
  }
  return inService(context, FEEDBACK_SCRIPT, parsed);
}
