/**
 * The melete command, for the person or program looking after an installation.
 *
 *   bun run melete <command> [--deploy-dir <path>] [--json] [options]
 *
 * Exit codes: 0 done or every check passed; 1 a check failed; 2 refused, and
 * nothing was changed; 3 acted, but did not finish (the output says what next).
 */
import { basename, resolve } from 'node:path';
import { runCheck } from './commands/check.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runLogs } from './commands/logs.ts';
import { runSet } from './commands/set.ts';
import { runStatus } from './commands/status.ts';
import { type Context, DEFAULT_DEPLOY_DIR, realContext } from './context.ts';
import { EXIT, type ExitCode } from './schema.ts';

export const USAGE = `Usage: bun run melete <command> [--deploy-dir <path>] [options]

  init [configure options]   Configure a new installation: deploy/.env, then deploy/melete.deploy.json
  init --adopt               Describe a running installation in deploy/melete.deploy.json; nothing else changes
  check [--json]             Judge deploy/melete.deploy.json, deploy/.env and the Compose files, without Docker
  doctor [--json] [--offline]  Judge this machine: Docker, disk in MB, memory, ports, images, registry
  status [--json]            The installation's report: services, API, account and the optional parts
  set NAME=value ...         Change settings in deploy/.env; --from-env NAME for a key
  logs [service ...]         The stack's logs: --since, --tail, --follow, --timestamps

--deploy-dir names the deployment directory of another checkout; the default is this checkout's deploy/.
Exit codes: 0 done, 1 a check failed, 2 refused with nothing changed, 3 acted but did not finish.
`;

export type Parsed = {
  command: string;
  rest: string[];
  deployDir: string;
  json: boolean;
  offline: boolean;
};

export function parseArguments(argv: readonly string[]): Parsed {
  const rest: string[] = [];
  let deployDir = DEFAULT_DEPLOY_DIR;
  let json = false;
  let offline = false;
  let command = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--deploy-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--deploy-dir needs a path.');
      deployDir = resolve(value);
      index += 1;
    } else if (arg.startsWith('--deploy-dir='))
      deployDir = resolve(arg.slice('--deploy-dir='.length));
    else if (arg === '--json') json = true;
    else if (arg === '--offline') offline = true;
    else if (!command && !arg.startsWith('-')) command = arg;
    else rest.push(arg);
  }
  return { command, rest, deployDir, json, offline };
}

export async function main(argv: readonly string[], make = realContext): Promise<ExitCode> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${USAGE}`);
    return EXIT.refused;
  }
  const context: Context = make(parsed.deployDir);
  const refuse = (message: string): ExitCode => {
    context.err(`${message}\n`);
    return EXIT.refused;
  };
  // The deployment directory sits in a checkout as deploy/: status.ts and configure.ts read it there.
  if (basename(context.deployDir) !== 'deploy')
    return refuse(`${context.deployDir} is not a checkout's deploy directory.`);
  const noExtra = (allowed: string) =>
    parsed.rest.length > 0
      ? refuse(`${parsed.command} takes no ${parsed.rest.join(' ')}. ${allowed}`)
      : null;
  switch (parsed.command) {
    case 'check':
      return noExtra('Usage: bun run melete check [--json]') ?? runCheck(context, parsed.json);
    case 'doctor':
      return (
        noExtra('Usage: bun run melete doctor [--json] [--offline]') ??
        (await runDoctor(context, parsed.json, parsed.offline))
      );
    case 'status':
      return (
        noExtra('Usage: bun run melete status [--json]') ?? (await runStatus(context, parsed.json))
      );
    case 'set':
      return await runSet(context, parsed.rest);
    case 'logs':
      return await runLogs(context, parsed.rest);
    case 'init':
      return await runInit(context, parsed.rest);
    case '':
    case 'help':
      context.out(USAGE);
      return parsed.command === 'help' ? EXIT.ok : EXIT.refused;
    default:
      return refuse(`${parsed.command} is not a melete command.\n${USAGE}`);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
