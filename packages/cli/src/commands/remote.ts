/**
 * `melete remote <ssh-target> [--path <dir>] <command> [args]`: runs the melete
 * command on another machine over SSH, in that machine's checkout, and streams
 * its output back. The exit code is the remote command's.
 *
 * `melete remote <ssh-target> [--path <dir>] push [--replace] [--dry-run]`
 * copies the parts of this deployment directory that git does not carry there:
 * deploy/.env, deploy/melete.deploy.json and the files under deploy/config/. A
 * file that already differs on the remote is left alone unless --replace is
 * given, because a deploy or a set run there changes deploy/.env, and copying an
 * older one back would undo it.
 *
 * Before either, one SSH call checks the remote has Bun and a Docker engine this
 * account can reach, and that the checkout and its deploy/ are not writable by
 * every account there. Nothing on the remote changes until those pass.
 *
 * deploy/.env never passes through a string: it is streamed from the file into
 * `cat` on the remote, written under umask 077 and moved into place, so it is
 * 0600 there. Its contents are never printed; only file names and hashes are.
 *
 * The target is an SSH host alias or user@host; a port or key belongs in
 * ~/.ssh/config. SSH runs with BatchMode, so a key or agent must sign in
 * without a prompt.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Context } from '../context.ts';
import { DEPLOY_FILE } from '../deploy-config.ts';
import { readInstallation } from '../installation.ts';
import { EXIT, type ExitCode, type Result, renderReport, report } from '../schema.ts';

export const REMOTE_USAGE =
  'Usage: bun run melete remote <ssh-target> [--path <remote checkout>] <command> [args]\n' +
  '       bun run melete remote <ssh-target> [--path <remote checkout>] push [--replace] [--dry-run]';

/** The commands that run on the remote; `push` runs here. */
export const REMOTE_COMMANDS = [
  'check',
  'doctor',
  'status',
  'set',
  'logs',
  'init',
  'deploy',
  'rollback',
  'backup',
  'restore',
  'upgrade',
  'history',
] as const;

export class RemoteRefusal extends Error {}

export type RemoteOptions = {
  target: string;
  /** The remote checkout from --path; null to read remote.path from the deploy file. */
  path: string | null;
  command: string;
  args: string[];
};

/** An SSH host alias or user@host: it must not start with `-`, so ssh never reads it as an option. */
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
/** A remote path: letters, digits and . _ - / ~, absolute or under ~/. */
const REMOTE_PATH = /^(\/|~\/|~$)[A-Za-z0-9._/~-]*$/;

export function parseRemote(args: readonly string[]): RemoteOptions {
  const [target, ...rest] = args;
  if (!target || !TARGET.test(target))
    throw new RemoteRefusal(
      `${target ? `${target} is not an SSH target this command takes: use a host alias or user@host, with letters, digits and . _ - @.` : 'Name the machine.'}\n${REMOTE_USAGE}`,
    );
  let path: string | null = null;
  let index = 0;
  while (rest[index] === '--path' || rest[index]?.startsWith('--path=')) {
    const arg = rest[index] ?? '';
    const value = arg === '--path' ? rest[index + 1] : arg.slice('--path='.length);
    if (!value) throw new RemoteRefusal(`--path needs the remote checkout.\n${REMOTE_USAGE}`);
    path = value;
    index += arg === '--path' ? 2 : 1;
  }
  if (path !== null && (!REMOTE_PATH.test(path) || path.split('/').includes('..')))
    throw new RemoteRefusal(
      `${path} is not a remote checkout this command takes: use an absolute path or one under ~/, with letters, digits and . _ - /.`,
    );
  const command = rest[index] ?? '';
  const commandArgs = rest.slice(index + 1);
  if (command !== 'push' && !(REMOTE_COMMANDS as readonly string[]).includes(command))
    throw new RemoteRefusal(
      `${command ? `${command} is not a command melete remote runs.` : 'Name the command to run there.'}\n${REMOTE_USAGE}`,
    );
  // A key named with --from-env is read from the shell the command runs in, which is the remote's.
  if (
    command === 'set' &&
    commandArgs.some((arg) => arg === '--from-env' || arg.startsWith('--from-env='))
  )
    throw new RemoteRefusal(
      'set --from-env reads the key from the shell it runs in, which over SSH is the remote one. Run bun run melete set --from-env here, then bun run melete remote <target> push --replace. Nothing was changed.',
    );
  return { target, path, command, args: commandArgs };
}

/** A word for the remote shell: single-quoted, with a leading ~ left for that shell to expand. */
export function shellWord(value: string): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/'))
    return value.length > 2 ? `"$HOME"/${quote(value.slice(2))}` : '"$HOME"/';
  return quote(value);
}

/** Bun's installer puts it in ~/.bun/bin, which a non-interactive SSH shell often lacks. */
const PATH_LINE = 'export PATH="$HOME/.bun/bin:$PATH"';

export const sshCommand = (target: string, script: string) => [
  'ssh',
  '-o',
  'BatchMode=yes',
  target,
  script,
];

/** The script that reports what the remote machine has, one fact per line. */
export function preflightScript(path: string): string {
  const p = shellWord(path);
  return [
    PATH_LINE,
    `p=${p}`,
    `echo "bun $(bun --version 2>/dev/null || echo missing)"`,
    `echo "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo missing)"`,
    `if [ -f "$p/deploy/docker-compose.yml" ]; then echo "checkout $(stat -c %a "$p" 2>/dev/null || echo unknown) $(stat -c %a "$p/deploy" 2>/dev/null || echo unknown)"; else echo "checkout missing"; fi`,
  ].join('\n');
}

export type RemoteFacts = {
  /** ssh's own exit code and last error line, when it could not connect. */
  ssh: { code: number; detail: string } | null;
  bun: string | null;
  docker: string | null;
  /** Permission bits of the checkout and its deploy/, as octal text; null when there is no checkout. */
  modes: [string, string] | null;
};

export function parsePreflight(stdout: string): Omit<RemoteFacts, 'ssh'> {
  const facts: Omit<RemoteFacts, 'ssh'> = { bun: null, docker: null, modes: null };
  for (const line of stdout.split('\n').map((text) => text.trim())) {
    const [key, ...words] = line.split(/\s+/);
    const value = words.join(' ');
    if (key === 'bun') facts.bun = value && value !== 'missing' ? value : null;
    else if (key === 'docker') facts.docker = value && value !== 'missing' ? value : null;
    else if (key === 'checkout')
      facts.modes = value === 'missing' ? null : [words[0] ?? 'unknown', words[1] ?? 'unknown'];
  }
  return facts;
}

/** Writable by every account on the remote, or unreadable: either way not a place for deploy/.env. */
const worldWritable = (mode: string) =>
  !/^[0-7]{3,4}$/.test(mode) || (Number.parseInt(mode, 8) & 0o002) !== 0;

export function judgeRemote(facts: RemoteFacts, target: string, path: string): Result[] {
  if (facts.ssh !== null)
    return [
      {
        id: 'remote.ssh',
        level: 'fail',
        detail: `ssh ${target} did not connect: ${facts.ssh.detail || `exit ${facts.ssh.code}`}`,
        fix: 'Check that ssh -o BatchMode=yes <target> true works from this terminal: the host alias, a key or agent that signs in without a prompt, and a known host key.',
      },
    ];
  const results: Result[] = [{ id: 'remote.ssh', level: 'ok', detail: `Connected to ${target}.` }];
  results.push(
    facts.bun
      ? { id: 'remote.bun', level: 'ok', detail: `Bun ${facts.bun}` }
      : {
          id: 'remote.bun',
          level: 'fail',
          detail: `${target} has no bun for this account.`,
          fix: 'Install it there: curl -fsSL https://bun.sh/install | bash',
        },
  );
  results.push(
    facts.docker
      ? { id: 'remote.docker', level: 'ok', detail: `Docker Engine ${facts.docker}` }
      : {
          id: 'remote.docker',
          level: 'fail',
          detail: `${target} has no Docker engine this account can reach.`,
          fix: 'Install Docker Engine 28 or newer with the Compose plugin (https://docs.docker.com/engine/install/), and add this account to the docker group.',
        },
  );
  if (facts.modes === null)
    results.push({
      id: 'remote.checkout',
      level: 'fail',
      detail: `${target} has no Melete checkout at ${path}.`,
      fix: `Clone it there (git clone https://github.com/ychampion/melete ${path}), or name the checkout with --path or remote.path in ${DEPLOY_FILE}.`,
    });
  else {
    const open = (['checkout', 'deploy/'] as const).filter((_, index) =>
      worldWritable(facts.modes?.[index] ?? ''),
    );
    results.push(
      open.length === 0
        ? { id: 'remote.checkout', level: 'ok', detail: `The checkout at ${path}.` }
        : {
            id: 'remote.checkout',
            level: 'fail',
            detail: `At ${path}, the ${open.join(' and the ')} ${open.length > 1 ? 'are' : 'is'} writable by every account on ${target}, or ${open.length > 1 ? 'their' : 'its'} mode could not be read, so another account could replace what runs there or read deploy/.env.`,
            fix: `Run chmod o-w on ${open.join(' and ')} there.`,
          },
    );
  }
  return results;
}

/** The remote checkout: --path, or remote.path in the deploy file. */
function remotePlace(context: Context, options: RemoteOptions) {
  const config = readInstallation(context.deployDir, context.machine.platform).config;
  const path = options.path ?? config.remote?.path ?? null;
  const cli = config.remote?.cli ?? ['bun', 'run', 'melete'];
  return { path, cli };
}

export type PushItem = {
  /** The path under deploy/, with forward slashes. */
  name: string;
  file: string;
  /** deploy/.env: written 0600. */
  private: boolean;
};

/** A name the remote shell takes without surprises. */
const PUSHABLE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** What push copies: deploy/.env, the deploy file, and every file under deploy/config/. */
export function pushItems(deployDir: string): { items: PushItem[]; skipped: string[] } {
  const items: PushItem[] = [{ name: '.env', file: join(deployDir, '.env'), private: true }];
  if (existsSync(join(deployDir, DEPLOY_FILE)))
    items.push({ name: DEPLOY_FILE, file: join(deployDir, DEPLOY_FILE), private: false });
  const skipped: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry);
      const name = relative(deployDir, file).replace(/\\/g, '/');
      if (statSync(file).isDirectory()) walk(file);
      else if (
        PUSHABLE.test(name) &&
        !name.split('/').some((part) => part === '..' || part === '.')
      )
        items.push({ name, file, private: false });
      else skipped.push(name);
    }
  };
  if (existsSync(join(deployDir, 'config'))) walk(join(deployDir, 'config'));
  return { items, skipped };
}

/** The script that prints `<sha256>  <name>` for each file that exists, and LOCKED while a command holds the lock there. */
export function hashScript(path: string, names: readonly string[]): string {
  const quoted = names.map((name) => shellWord(name)).join(' ');
  return [
    `cd ${shellWord(path)}/deploy || exit 3`,
    'if [ -e .melete/lock ]; then echo LOCKED; fi',
    `for f in ${quoted}; do if [ -f "$f" ]; then sha256sum -- "$f"; fi; done`,
  ].join('\n');
}

export function parseHashes(stdout: string): { hashes: Map<string, string>; locked: boolean } {
  const hashes = new Map<string, string>();
  let locked = false;
  for (const line of stdout.split('\n').map((text) => text.trim())) {
    if (line === 'LOCKED') locked = true;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match?.[1] && match[2]) hashes.set(match[2], match[1]);
  }
  return { hashes, locked };
}

/** The script that writes one file from stdin: under a temporary name, then moved into place. */
export function writeScript(path: string, item: PushItem): string {
  const target = shellWord(item.name);
  const temporary = shellWord(`${item.name}.melete-push`);
  const parent = item.name.includes('/') ? item.name.slice(0, item.name.lastIndexOf('/')) : null;
  return [
    `umask ${item.private ? '077' : '022'}`,
    `cd ${shellWord(path)}/deploy`,
    ...(parent ? [`mkdir -p ${shellWord(parent)}`] : []),
    `cat > ${temporary}`,
    ...(item.private ? [`chmod 600 ${temporary}`] : []),
    `mv -f ${temporary} ${target}`,
  ].join(' && ');
}

async function push(
  context: Context,
  options: RemoteOptions,
  path: string,
  args: readonly string[],
  json: boolean,
): Promise<ExitCode> {
  const unknown = args.filter((arg) => arg !== '--replace' && arg !== '--dry-run');
  if (unknown.length > 0) {
    context.err(`push takes no ${unknown.join(' ')}.\n${REMOTE_USAGE}\n`);
    return EXIT.refused;
  }
  const replace = args.includes('--replace');
  const dryRun = args.includes('--dry-run');
  const results: Result[] = [];
  const finish = (code: ExitCode) => {
    const value = report('remote', results);
    context.out(json ? `${JSON.stringify(value, null, 2)}\n` : renderReport(value));
    return code;
  };

  const envFile = join(context.deployDir, '.env');
  if (!existsSync(envFile)) {
    results.push({
      id: 'remote.push_env',
      level: 'fail',
      detail: 'There is no deploy/.env here to copy.',
      fix: 'Run bun run melete init here, or run it on the remote with bun run melete remote <target> init.',
    });
    return finish(EXIT.refused);
  }
  if (context.machine.platform !== 'win32' && (statSync(envFile).mode & 0o077) !== 0) {
    results.push({
      id: 'remote.push_env',
      level: 'fail',
      detail: `deploy/.env here has mode ${(statSync(envFile).mode & 0o777).toString(8)}, so other accounts on this machine can read its keys. Nothing was copied.`,
      fix: 'Run chmod 600 deploy/.env, then push again.',
    });
    return finish(EXIT.refused);
  }

  const { items, skipped } = pushItems(context.deployDir);
  for (const name of skipped)
    results.push({
      id: 'remote.push_skipped',
      level: 'warn',
      detail: `${name} is left out: its name has characters other than letters, digits and . _ - /.`,
    });
  const local = new Map<string, string>();
  for (const item of items) {
    const hashed = await context.stream({ file: item.file }, []);
    if (!hashed.ok) {
      results.push({
        id: 'remote.push_read',
        level: 'fail',
        detail: `${item.name} could not be read here: ${hashed.detail}`,
      });
      return finish(EXIT.refused);
    }
    local.set(item.name, hashed.sha256);
  }

  const listing = context.run(
    sshCommand(
      options.target,
      hashScript(
        path,
        items.map((item) => item.name),
      ),
    ),
  );
  if (listing.code !== 0) {
    results.push({
      id: 'remote.push_compare',
      level: 'fail',
      detail: `Could not read the files at ${path}/deploy on ${options.target}: ${listing.stderr.trim().split('\n').at(-1) || `exit ${listing.code}`}`,
    });
    return finish(EXIT.refused);
  }
  const remote = parseHashes(listing.stdout);
  if (remote.locked) {
    results.push({
      id: 'remote.push_locked',
      level: 'fail',
      detail: `A melete command is running on ${options.target} (deploy/.melete/lock is held). Nothing was copied.`,
      fix: 'Wait for it to finish, then push again.',
    });
    return finish(EXIT.refused);
  }
  const same = items.filter((item) => remote.hashes.get(item.name) === local.get(item.name));
  const added = items.filter((item) => !remote.hashes.has(item.name));
  const changed = items.filter(
    (item) => remote.hashes.has(item.name) && remote.hashes.get(item.name) !== local.get(item.name),
  );
  if (changed.length > 0 && !replace) {
    results.push({
      id: 'remote.push_diverged',
      level: 'fail',
      detail: `These differ on ${options.target} from the copies here: ${changed.map((item) => item.name).join(', ')}. A deploy or set run there changes deploy/.env, so copying this one over could undo it. Nothing was copied.`,
      fix: 'Bring the remote changes here first (bun run melete remote <target> check shows what runs there), or pass --replace to overwrite them.',
    });
    return finish(EXIT.refused);
  }
  const writes = [...added, ...changed];
  results.push({
    id: 'remote.push_plan',
    level: 'ok',
    detail:
      writes.length === 0
        ? `Every file is the same on ${options.target}; nothing to copy.`
        : `${dryRun ? 'Would copy' : 'Copying'} ${writes.map((item) => item.name).join(', ')}; ${same.length} already the same.`,
  });
  if (dryRun || writes.length === 0) return finish(EXIT.ok);

  const written: string[] = [];
  for (const item of writes) {
    const outcome = await context.stream({ file: item.file }, [
      { command: sshCommand(options.target, writeScript(path, item)) },
    ]);
    if (!outcome.ok || outcome.sha256 !== local.get(item.name)) {
      results.push({
        id: 'remote.push_write',
        level: 'fail',
        detail: `${item.name} was not copied: ${outcome.detail || 'it changed while it was read'}. ${written.length > 0 ? `Already copied: ${written.join(', ')}.` : 'Nothing was copied before it.'}`,
        fix: 'Push again: files already the same are skipped.',
      });
      return finish(written.length > 0 ? EXIT.partial : EXIT.refused);
    }
    written.push(item.name);
  }

  // Read back: every file is what was sent, and deploy/.env is private there.
  const check = context.run(
    sshCommand(
      options.target,
      `${hashScript(
        path,
        items.map((item) => item.name),
      )}\nstat -c 'mode %a' .env`,
    ),
  );
  const after = parseHashes(check.stdout);
  const wrong = items.filter((item) => after.hashes.get(item.name) !== local.get(item.name));
  const mode = /mode (\d+)/.exec(check.stdout)?.[1] ?? null;
  results.push(
    check.code === 0 && wrong.length === 0
      ? {
          id: 'remote.push_verified',
          level: 'ok',
          detail: `Copied ${written.join(', ')}; every file on ${options.target} matches.`,
        }
      : {
          id: 'remote.push_verified',
          level: 'fail',
          detail: `After the copy, ${wrong.length > 0 ? wrong.map((item) => item.name).join(', ') : 'the files'} could not be confirmed on ${options.target}.`,
          fix: 'Push again.',
        },
  );
  results.push(
    mode === '600'
      ? {
          id: 'remote.env_private',
          level: 'ok',
          detail: `deploy/.env is 0600 on ${options.target}.`,
        }
      : {
          id: 'remote.env_private',
          level: 'fail',
          detail: `deploy/.env on ${options.target} has mode ${mode ?? 'unknown'}.`,
          fix: `Run chmod 600 ${path}/deploy/.env there.`,
        },
  );
  const failed = results.some((result) => result.level === 'fail');
  return finish(failed ? EXIT.partial : EXIT.ok);
}

export async function runRemote(
  context: Context,
  args: readonly string[],
  flags: { json: boolean; offline: boolean },
): Promise<ExitCode> {
  let options: RemoteOptions;
  try {
    options = parseRemote(args);
  } catch (error) {
    if (!(error instanceof RemoteRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
  const { path, cli } = remotePlace(context, options);
  if (path === null || !REMOTE_PATH.test(path)) {
    context.err(
      `Name the checkout on ${options.target} with --path <dir>, or as remote.path in ${DEPLOY_FILE}. Nothing was changed.\n`,
    );
    return EXIT.refused;
  }

  const probe = context.run(sshCommand(options.target, preflightScript(path)), 60_000);
  const facts: RemoteFacts =
    probe.code === 255 || (probe.code !== 0 && probe.stdout.trim() === '')
      ? {
          ssh: { code: probe.code, detail: probe.stderr.trim().split('\n').at(-1)?.trim() ?? '' },
          bun: null,
          docker: null,
          modes: null,
        }
      : { ssh: null, ...parsePreflight(probe.stdout) };
  const preflight = judgeRemote(facts, options.target, path);
  if (preflight.some((result) => result.level === 'fail')) {
    const value = report('remote', preflight);
    context.out(
      flags.json
        ? `${JSON.stringify(value, null, 2)}\n`
        : `${renderReport(value)}Nothing was changed on ${options.target}.\n`,
    );
    return EXIT.refused;
  }

  if (options.command === 'push')
    return await push(context, options, path, options.args, flags.json);

  // The summary goes to stderr, so the remote command's --json output stays the only stdout.
  context.err(
    `On ${options.target} at ${path}: Bun ${facts.bun}, Docker Engine ${facts.docker}.\n`,
  );
  const script = [
    PATH_LINE,
    `cd ${shellWord(path)}`,
    `exec ${[
      ...cli.map(shellWord),
      shellWord(options.command),
      '--deploy-dir',
      `${shellWord(path)}/deploy`,
      ...options.args.map(shellWord),
      ...(flags.json ? ['--json'] : []),
      ...(flags.offline ? ['--offline'] : []),
    ].join(' ')}`,
  ].join('\n');
  const code = await context.attach(sshCommand(options.target, script));
  if (code === 255) {
    context.err(
      `The SSH connection to ${options.target} ended before the command finished. Run bun run melete remote ${options.target} history and status to see where it stopped.\n`,
    );
    return EXIT.partial;
  }
  return code >= 0 && code <= 3 ? (code as ExitCode) : EXIT.failed;
}
