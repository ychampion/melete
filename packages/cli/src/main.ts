/**
 * The melete command, for the person or program looking after an installation.
 *
 *   bun run melete <command> [--deploy-dir <path>] [--json] [options]
 *
 * Exit codes: 0 done or every check passed; 1 a check failed; 2 refused, and
 * nothing was changed; 3 acted, but did not finish (the output says what next).
 */
import { basename, resolve } from 'node:path';
import { type Context, DEFAULT_DEPLOY_DIR, realContext } from './context.ts';
import { readHistory, renderHistory } from './history.ts';
import { EXIT, type ExitCode } from './schema.ts';

export const USAGE = `Usage: bun run melete <command> [--deploy-dir <path>] [options]

  init [configure options]   Configure a new installation: deploy/.env, then deploy/melete.deploy.json
       [--public-url https://your.domain [--hosted]]
                             The public address and web origin together; --hosted for other people
  init --adopt               Describe a running installation in deploy/melete.deploy.json; nothing else changes
  check [--json]             Judge deploy/melete.deploy.json, deploy/.env and the Compose files, without Docker
  doctor [--json] [--offline]  Judge this machine: Docker, disk in MB, memory, ports, images, registry
  status [--json]            The installation's report: services, API, account and the optional parts
  set NAME=value ...         Change settings in deploy/.env; --from-env NAME for a key, --clear NAME
                             to empty one; says which services to recreate
  browser enable [--space <id>]
                             Turn on the browser worker for the first person's space, or the one named
  logs [service ...]         The stack's logs: --since, --tail, --follow, --timestamps
  logs --attempts [id]       Attempt containers, or one's logs; --computers [name] for agents' computers
  deploy [--tag <tag>]       Update to published images: plan, back up, pull one at a time, switch, verify
         [--dry-run] [--checkout | --allow-compose-mismatch] [--skip-backup | --backup-to ssh://host:/path]
  rollback [--dry-run]       Back to the images before the last deploy, or the restore steps if migrations ran
  backup [--estimate]        Back up the database, journal and settings to backup.dir, a new private directory
         [--with-volumes] [--dir <path>] [--to ssh://host:/path]
         [--encrypt | --encrypt-to <age recipient>]
  restore <backup> [--plan]  Check a backup's checksums and print the steps that restore it
  upgrade <version>          Upgrade an installation that builds its images, with the release's own script
  history [--json]           The deploys, rollbacks and upgrades this installation has run
  remote <ssh-target> [--path <dir>] <command> [args]
                             Run one of these commands on another machine over SSH, in its checkout
  remote <ssh-target> [--path <dir>] push [--replace] [--dry-run]
                             Copy deploy/.env, deploy/melete.deploy.json and deploy/config/ there

--deploy-dir names the deployment directory of another checkout; the default is this checkout's deploy/.
Without Bun on the host, check, doctor and status run in the service container:
  docker compose -f deploy/docker-compose.yml exec melete bun run melete doctor --offline
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
  // Each command is loaded when it runs, so check, doctor and status need only the
  // files the service image ships (deploy/Dockerfile.melete) and run inside it.
  switch (parsed.command) {
    case 'check':
      return (
        noExtra('Usage: bun run melete check [--json]') ??
        (await import('./commands/check.ts')).runCheck(context, parsed.json)
      );
    case 'doctor':
      return (
        noExtra('Usage: bun run melete doctor [--json] [--offline]') ??
        (await (
          await import('./commands/doctor.ts')
        ).runDoctor(context, parsed.json, parsed.offline))
      );
    case 'status':
      return (
        noExtra('Usage: bun run melete status [--json]') ??
        (await (await import('./commands/status.ts')).runStatus(context, parsed.json))
      );
    case 'set':
      return (await import('./commands/set.ts')).runSet(context, parsed.rest);
    case 'browser':
      // `files` is the one-line installer's half, run inside the service image.
      return parsed.rest[0] === 'files'
        ? (await import('./commands/browser-files.ts')).runBrowserFiles(context, parsed.rest)
        : (await import('./commands/browser.ts')).runBrowser(context, parsed.rest);
    case 'logs':
      return (await import('./commands/logs.ts')).runLogs(context, parsed.rest);
    case 'init':
      return (await import('./commands/init.ts')).runInit(context, parsed.rest);
    case 'deploy':
      return (await import('./commands/deploy.ts')).runDeploy(context, parsed.rest, parsed.json);
    case 'rollback':
      return (await import('./commands/rollback.ts')).runRollback(
        context,
        parsed.rest,
        parsed.json,
      );
    case 'backup':
      return (await import('./commands/backup.ts')).runBackup(context, parsed.rest, parsed.json);
    case 'restore':
      return (await import('./commands/restore.ts')).runRestore(context, parsed.rest, parsed.json);
    case 'upgrade':
      return (await import('./commands/upgrade.ts')).runUpgrade(context, parsed.rest);
    case 'remote':
      return (await import('./commands/remote.ts')).runRemote(context, parsed.rest, {
        json: parsed.json,
        offline: parsed.offline,
      });
    case 'history': {
      const refused = noExtra('Usage: bun run melete history [--json]');
      if (refused !== null) return refused;
      const entries = readHistory(context.deployDir);
      context.out(json(parsed.json, entries));
      return EXIT.ok;
    }
    case '':
    case 'help':
      context.out(USAGE);
      return parsed.command === 'help' ? EXIT.ok : EXIT.refused;
    default:
      return refuse(`${parsed.command} is not a melete command.\n${USAGE}`);
  }
}

const json = (asJson: boolean, entries: ReturnType<typeof readHistory>) =>
  asJson
    ? `${JSON.stringify(entries, null, 2)}
`
    : renderHistory(entries);

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
