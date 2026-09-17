/**
 * What the deployment needs from Docker, in one place, and the judgement of
 * whether a host has it. The service asks the engine over its socket before it
 * opens anything else; the configuration generator, the upgrade script and
 * `bun run doctor` ask the `docker` client on the host. This module imports
 * nothing, so a host script can use it without the service's dependencies.
 *
 * Where each number comes from:
 * - API 1.48 is the version the supervisor speaks. Engine 28.0 introduced it,
 *   together with the `isolated` bridge gateway mode each attempt network uses
 *   (https://docs.docker.com/engine/release-notes/28/).
 * - Compose 2.33.1 added `gw_priority`, which needs Engine 28.0
 *   (https://github.com/docker/compose/releases/tag/v2.33.1). Volume `subpath`
 *   mounts are older (Compose 2.26.0, Engine 26), and the isolated gateway mode
 *   is a network driver option Compose passes through unchanged, so
 *   `gw_priority` sets the floor.
 */
export const DOCKER_API_VERSION = '1.48';
export const REQUIRED_ENGINE_VERSION = '28.0';
export const REQUIRED_COMPOSE_VERSION = '2.33.1';
export const DOCKER_REQUIREMENT = `Melete requires Docker Engine ${REQUIRED_ENGINE_VERSION} or newer (API ${DOCKER_API_VERSION}) and Docker Compose ${REQUIRED_COMPOSE_VERSION} or newer`;

export type DockerEngine = { version: string; apiVersion: string };
export interface DockerVersionSource {
  /** The engine's unversioned `/version` answer, parsed. */
  version(): Promise<unknown>;
}

const DOTTED = /^\d+(?:\.\d+)*$/;

/** Dotted numeric comparison: 1.100 is newer than 1.48, and 2.33 is older than 2.33.1. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function tooOld(version: string, apiVersion: string): string {
  return `Docker Engine ${version} (API ${apiVersion}) is too old. ${DOCKER_REQUIREMENT}.`;
}

/** One line for an operator; never the submitted configuration or a cause chain. */
function judgeEngine(answer: unknown): DockerEngine {
  const fields = (answer !== null && typeof answer === 'object' ? answer : {}) as Record<
    string,
    unknown
  >;
  const apiVersion = fields.ApiVersion;
  if (typeof apiVersion !== 'string' || !DOTTED.test(apiVersion))
    throw new Error(`The Docker Engine did not report an API version. ${DOCKER_REQUIREMENT}.`);
  const version = typeof fields.Version === 'string' && fields.Version ? fields.Version : 'unknown';
  if (compareVersions(apiVersion, DOCKER_API_VERSION) < 0)
    throw new Error(tooOld(version, apiVersion));
  const minimum = fields.MinAPIVersion;
  if (
    typeof minimum === 'string' &&
    DOTTED.test(minimum) &&
    compareVersions(minimum, DOCKER_API_VERSION) > 0
  )
    throw new Error(
      `Docker Engine ${version} no longer serves API ${DOCKER_API_VERSION} (its minimum is ${minimum}); this Melete release cannot supervise attempts on it. ${DOCKER_REQUIREMENT}.`,
    );
  return { version, apiVersion };
}

/** Fails fast, with one message, unless the engine behind the socket serves the supervisor API. */
export async function assertDockerEngine(
  source: DockerVersionSource,
  socket: string,
): Promise<DockerEngine> {
  let answer: unknown;
  try {
    answer = await source.version();
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown error';
    throw new Error(
      `Cannot reach the Docker Engine at ${socket} (${code}). Mount the socket into the service and set DOCKER_GID to the socket's group. ${DOCKER_REQUIREMENT}.`,
    );
  }
  return judgeEngine(answer);
}

export type CommandOutput = { code: number; stdout: string; stderr: string };
export type HostDockerOutputs = { engine: CommandOutput; compose: CommandOutput };

/** The two host commands, in the order `judgeHostDocker` expects their output. */
export const HOST_DOCKER_COMMANDS = {
  engine: ['docker', 'version', '--format', '{{.Server.APIVersion}} {{.Server.Version}}'],
  compose: ['docker', 'compose', 'version', '--short'],
} as const;

/** One line per problem with the host's engine or Compose plugin; empty means supported. */
export function judgeHostDocker(outputs: HostDockerOutputs): string[] {
  const problems: string[] = [];
  const [apiVersion = '', version = 'unknown'] = outputs.engine.stdout.trim().split(/\s+/);
  if (outputs.engine.code !== 0 || !DOTTED.test(apiVersion))
    problems.push(
      `\`docker version\` did not reach a Docker Engine; start Docker and run this from an account that can use its socket. ${DOCKER_REQUIREMENT}.`,
    );
  else if (compareVersions(apiVersion, DOCKER_API_VERSION) < 0)
    problems.push(tooOld(version, apiVersion));
  // Distribution builds add a prefix or suffix: v2.40.3-desktop.1, 2.27.1+ds1-0ubuntu1.
  const compose = /^v?(\d+\.\d+\.\d+)/.exec(outputs.compose.stdout.trim())?.[1];
  if (outputs.compose.code !== 0 || !compose)
    problems.push(
      `\`docker compose version\` failed; install the Docker Compose plugin. ${DOCKER_REQUIREMENT}.`,
    );
  else if (compareVersions(compose, REQUIRED_COMPOSE_VERSION) < 0)
    problems.push(
      `Docker Compose ${compose} is too old: \`gw_priority\` needs ${REQUIRED_COMPOSE_VERSION} or newer. ${DOCKER_REQUIREMENT}.`,
    );
  return problems;
}

/** Runs both host commands synchronously; a missing `docker` binary is an ordinary failure. */
export function readHostDocker(
  run: (command: readonly string[]) => CommandOutput = spawnCommand,
): HostDockerOutputs {
  return { engine: run(HOST_DOCKER_COMMANDS.engine), compose: run(HOST_DOCKER_COMMANDS.compose) };
}

function spawnCommand(command: readonly string[]): CommandOutput {
  try {
    const result = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : 'not found' };
  }
}
