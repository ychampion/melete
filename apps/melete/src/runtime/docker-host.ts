/**
 * What the machine running the stack must provide beyond the engine and
 * Compose versions: an engine on this machine, Linux containers, enough memory
 * when the engine runs in Docker Desktop's VM, and on Windows, paths the
 * checkout fits in. The configuration generator, the upgrade script and
 * `bun run doctor --docker` all gather these facts and judge them here, so a
 * Windows host running Docker Desktop hears the same thing from each of them.
 *
 * Gathering runs commands through an injected runner and reads the filesystem
 * through injected functions; the judgement is pure. Like docker-engine.ts,
 * this module needs nothing outside Node's standard library.
 *
 * Sources for the Docker Desktop behaviour relied on here:
 * - On Windows the client reaches the engine over the named pipe
 *   `//./pipe/docker_engine` (https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/).
 * - Inside a container, the bind-mounted `/var/run/docker.sock` is the VM's
 *   socket, `srwxrw---- root root`: a process may use it if its user or one of
 *   its groups is root (Docker Desktop 4.27.2 restored this after 4.27.1 broke
 *   it; https://github.com/docker/for-win/issues/13898#issuecomment-1934625891).
 *   The host has no such file, so its group is measured from a container.
 * - Under the WSL 2 backend the VM's memory is set in `.wslconfig`; under
 *   Hyper-V it is Settings > Resources > Advanced
 *   (https://docs.docker.com/desktop/settings-and-maintenance/settings/).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CommandOutput, type HostDockerOutputs, judgeHostDocker } from './docker-engine.ts';

export const DOCKER_HOST_COMMANDS = {
  info: ['docker', 'info', '--format', '{{json .}}'],
  context: ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
} as const;

/** The commands that tell whether long paths work for the checkout at `root`. */
export const longPathCommands = (root: string) =>
  ({
    registry: [
      'reg',
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
      '/v',
      'LongPathsEnabled',
    ],
    git: ['git', '-C', root, 'config', '--get', 'core.longpaths'],
    tracked: ['git', '-C', root, 'ls-files'],
  }) as const;

const GIB = 1024 ** 3;
/**
 * The warm runtime cell and each attempt may each use up to 2 GiB, beside
 * Postgres, the service and the web server. A VM given 4 GB reports a little
 * less than 4 GiB to `docker info`, so the floor sits below the advice.
 */
export const MIN_DESKTOP_MEMORY_BYTES = 3.5 * GIB;
/** Windows' MAX_PATH is 260 characters including the terminating NUL. */
export const WINDOWS_MAX_PATH = 259;

export type EngineInfo = {
  osType: string;
  operatingSystem: string;
  kernelVersion: string;
  memTotal: number;
  dockerRootDir: string;
};

export type LongPathFacts = {
  /** The repository root as Windows spells it. */
  root: string;
  /** The longest path under the root that Git checks out, relative to it. */
  deepestTracked: number;
  /** The longest path under the root's node_modules, relative to the root; 0 before `bun install`. */
  deepestInstalled: number;
  /** HKLM\...\FileSystem\LongPathsEnabled is 1; null when it could not be read. */
  longPathsEnabled: boolean | null;
  /** `git config core.longpaths` is true. */
  gitLongPaths: boolean;
};

export type DockerHostFacts = {
  platform: NodeJS.Platform;
  /** The endpoint the client uses: DOCKER_HOST when set, else the current context's. */
  endpoint: string | null;
  /** Whether the named pipe the endpoint names exists; null when the endpoint is not a pipe. */
  pipePresent: boolean | null;
  /** `docker info`, or null when no engine answered. */
  info: EngineInfo | null;
  /** Windows only. */
  paths?: LongPathFacts;
};

/** The fields of `docker info --format '{{json .}}'` this judgement reads. */
export function parseDockerInfo(output: CommandOutput): EngineInfo | null {
  if (output.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const fields = parsed as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  if (!text(fields.OSType)) return null;
  return {
    osType: text(fields.OSType),
    operatingSystem: text(fields.OperatingSystem),
    kernelVersion: text(fields.KernelVersion),
    memTotal: typeof fields.MemTotal === 'number' ? fields.MemTotal : 0,
    dockerRootDir: text(fields.DockerRootDir),
  };
}

/** Docker Desktop runs the engine in a VM, whichever system hosts it. */
export const isDockerDesktop = (info: EngineInfo | null) =>
  info !== null && /docker desktop/i.test(info.operatingSystem);

/** `npipe:////./pipe/docker_engine` as a path Windows can test: `\\.\pipe\docker_engine`. */
export function pipePath(endpoint: string): string | null {
  const name = /^npipe:\/\/.*\/pipe\/([^/]+)$/.exec(endpoint)?.[1];
  return name ? `\\\\.\\pipe\\${name}` : null;
}

/** A tcp:// or ssh:// endpoint on another machine; the local socket and pipe are not. */
function remoteEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null;
  const match = /^(tcp|ssh|https?):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/.exec(endpoint);
  if (!match) return null;
  const host = (match[2] ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(host) ? null : endpoint;
}

export type DockerHostInputs = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  info: CommandOutput;
  context: CommandOutput;
  /** Whether a path exists; used for the named pipe. */
  exists: (path: string) => boolean;
  paths?: LongPathFacts;
};

/** The facts, from command outputs already collected. */
export function dockerHostFacts(inputs: DockerHostInputs): DockerHostFacts {
  const fromContext = inputs.context.code === 0 ? inputs.context.stdout.trim() : '';
  // Without either, the Windows client uses Docker Desktop's documented pipe.
  const fallback = inputs.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : null;
  const endpoint = inputs.env.DOCKER_HOST?.trim() || fromContext || fallback;
  const pipe = inputs.platform === 'win32' && endpoint ? pipePath(endpoint) : null;
  return {
    platform: inputs.platform,
    endpoint,
    pipePresent: pipe === null ? null : inputs.exists(pipe),
    info: parseDockerInfo(inputs.info),
    ...(inputs.paths ? { paths: inputs.paths } : {}),
  };
}

/** The longest line of `git ls-files`, or of a directory listing, in characters. */
export const longestLine = (text: string) =>
  text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, line.trimEnd().length), 0);

export type LongPathInputs = {
  root: string;
  registry: CommandOutput;
  git: CommandOutput;
  tracked: CommandOutput;
  /** Paths under node_modules relative to it, or [] when it does not exist. */
  installed: readonly string[];
};

export function longPathFacts(inputs: LongPathInputs): LongPathFacts {
  const value = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(inputs.registry.stdout)?.[1];
  return {
    root: inputs.root,
    deepestTracked: inputs.tracked.code === 0 ? longestLine(inputs.tracked.stdout) : 0,
    deepestInstalled: inputs.installed.reduce(
      (longest, path) => Math.max(longest, 'node_modules/'.length + path.length),
      0,
    ),
    longPathsEnabled:
      inputs.registry.code === 0 && value !== undefined ? Number.parseInt(value, 16) === 1 : null,
    gitLongPaths: inputs.git.code === 0 && inputs.git.stdout.trim().toLowerCase() === 'true',
  };
}

const SHORT_CLONE = 'Clone the repository to a short path such as C:\\melete';

function judgePaths(paths: LongPathFacts): string[] {
  const problems: string[] = [];
  const tracked = paths.root.length + 1 + paths.deepestTracked;
  const installed = paths.root.length + 1 + paths.deepestInstalled;
  if (tracked > WINDOWS_MAX_PATH && !paths.gitLongPaths)
    problems.push(
      `The deepest file Git checks out here is ${tracked} characters long, past Windows' 260-character limit, and Git's core.longpaths is off. ${SHORT_CLONE}, or run \`git config --global core.longpaths true\`.`,
    );
  if (installed > WINDOWS_MAX_PATH && paths.longPathsEnabled !== true)
    problems.push(
      `The deepest file \`bun install\` writes here is ${installed} characters long, past Windows' 260-character limit, and long paths are ${paths.longPathsEnabled === null ? 'not known to be' : 'not'} enabled. ${SHORT_CLONE}, or enable long paths from an administrator PowerShell: \`New-ItemProperty -Path HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force\`, then sign out and in again.`,
    );
  return problems;
}

function memoryAdvice(info: EngineInfo): string {
  if (/microsoft-standard-wsl2/i.test(info.kernelVersion))
    return 'Docker Desktop uses the WSL 2 backend, so set `memory=4GB` or more under `[wsl2]` in `%UserProfile%\\.wslconfig`, run `wsl --shutdown`, and start Docker Desktop again.';
  return 'Raise it in Docker Desktop under Settings > Resources > Advanced, then apply and restart.';
}

/** One line per problem with the host beyond the engine and Compose versions. */
export function judgeDockerHost(facts: DockerHostFacts): string[] {
  const problems: string[] = [];
  const remote = remoteEndpoint(facts.endpoint);
  if (remote)
    problems.push(
      `The Docker client points at ${remote}, another machine. Compose mounts deploy/config and the Docker socket from the machine that runs the engine, so run Melete's scripts there, or unset DOCKER_HOST and select the local context with \`docker context use default\`.`,
    );
  if (facts.pipePresent === false && facts.endpoint)
    problems.push(
      `Nothing answers on ${facts.endpoint.replace(/^npipe:\/*/, '//')}, so Docker Desktop is not running. Start Docker Desktop, wait until it reports that the engine is running, and run this again.`,
    );
  const info = facts.info;
  if (info && info.osType !== 'linux')
    problems.push(
      `The Docker engine runs ${info.osType} containers; Melete's images are Linux images. From the Docker Desktop menu choose "Switch to Linux containers", then run this again.`,
    );
  else if (info && isDockerDesktop(info) && info.memTotal < MIN_DESKTOP_MEMORY_BYTES)
    problems.push(
      `Docker Desktop's VM has ${(info.memTotal / GIB).toFixed(1)} GiB of memory; Melete needs at least 4 GB (6 GB with the browser worker). ${memoryAdvice(info)}`,
    );
  if (facts.paths) problems.push(...judgePaths(facts.paths));
  return problems;
}

/**
 * The engine and Compose judgement together with this host's. When the named
 * pipe is missing it says why the engine did not answer, so the generic line
 * about an unreachable engine is left out; when there is no `docker` program
 * at all, that is the one thing worth saying.
 */
export function judgeDockerMachine(outputs: HostDockerOutputs, facts: DockerHostFacts): string[] {
  if (outputs.engine.code === 127 && outputs.compose.code === 127)
    return [
      facts.platform === 'linux'
        ? 'The `docker` command was not found. Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/'
        : 'The `docker` command was not found. Install Docker Desktop (https://docs.docker.com/desktop/), start it, and open a new terminal so its programs are on PATH.',
    ];
  const host = judgeDockerHost(facts);
  const versions = judgeHostDocker(outputs).filter(
    (line) => facts.pipePresent !== false || !line.startsWith('`docker version` did not reach'),
  );
  return [...versions, ...host];
}

/**
 * The Docker socket as a container sees it: `<gid> <octal mode> <type>` from
 * busybox `stat`. Run from an image the stack already pulls, with no network.
 */
export const socketProbeCommand = (image: string) =>
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'stat',
    '--volume',
    '/var/run/docker.sock:/var/run/docker.sock',
    image,
    '-c',
    '%g %a %F',
    '/var/run/docker.sock',
  ] as const;

/**
 * The group the service must join to use the socket, or why it cannot. The
 * service runs as an unprivileged user, so the socket must be writable by a
 * group it can be given.
 */
export function judgeSocketProbe(output: CommandOutput): { gid: number } | { problem: string } {
  const match = /^(\d+) ([0-7]{3,4}) (.+)$/.exec(output.stdout.trim());
  if (output.code !== 0 || !match)
    return {
      problem: `A container could not inspect /var/run/docker.sock (${output.stderr.trim().split('\n').at(-1) || `exit ${output.code}`}). Check that Docker can run a container and mount the socket.`,
    };
  const [, gid, mode, type] = match;
  if (!/socket/.test(type ?? ''))
    return {
      problem: `/var/run/docker.sock inside a container is a ${type}, not a socket. Check that Docker Desktop exposes its socket to containers.`,
    };
  const permissions = Number.parseInt(mode ?? '0', 8);
  if ((permissions & 0o020) === 0 && (permissions & 0o002) === 0)
    return {
      problem: `/var/run/docker.sock inside a container has mode ${mode}, so only its owner can use it and the service, which is not root, cannot. Update Docker Desktop; releases that serve the socket to its group show mode 760 or 660.`,
    };
  return { gid: Number(gid) };
}

/** What the gatherers read from the machine, injected so each branch can be tested anywhere. */
export type MachineAccess = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** Paths under `<root>/node_modules`, relative to it; [] when it does not exist. */
  installed: (root: string) => string[];
};

export const localMachine: MachineAccess = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  installed: (root) => {
    try {
      return readdirSync(join(root, 'node_modules'), { recursive: true, encoding: 'utf8' });
    } catch {
      return [];
    }
  },
};

/** The long-path facts for the checkout at `root`, from commands already run. */
export function readLongPaths(
  root: string,
  run: (command: readonly string[]) => CommandOutput,
  machine: MachineAccess,
): LongPathFacts {
  const commands = longPathCommands(root);
  return longPathFacts({
    root,
    registry: run(commands.registry),
    git: run(commands.git),
    tracked: run(commands.tracked),
    installed: machine.installed(root),
  });
}

/** Every fact this module judges, gathered synchronously; the long paths only on Windows. */
export function readDockerHost(
  run: (command: readonly string[]) => CommandOutput,
  root: string,
  machine: MachineAccess = localMachine,
): DockerHostFacts {
  return dockerHostFacts({
    platform: machine.platform,
    env: machine.env,
    info: run(DOCKER_HOST_COMMANDS.info),
    context: run(DOCKER_HOST_COMMANDS.context),
    exists: machine.exists,
    ...(machine.platform === 'win32' ? { paths: readLongPaths(root, run, machine) } : {}),
  });
}
