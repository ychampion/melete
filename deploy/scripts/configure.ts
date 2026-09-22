/**
 * Generate local deployment secrets once, without logging or overwriting them.
 *
 *   bun run deploy/scripts/configure.ts [--fake]
 *     [--tailscale [--tailscale-hostname name]]
 *
 * `--tailscale` settles the node name the tailnet overlay joins under. It
 * writes no credential: the auth key is issued by the Tailscale admin console
 * and is pasted into deploy/.env afterwards.
 *
 * DOCKER_GID is the group of the Docker socket as the service will see it. On
 * a Linux host running Docker Engine that is the host's own socket. Docker
 * Desktop, on Windows, macOS or Linux, serves the socket from its VM, and an
 * engine reached over ssh:// or tcp:// has it on its own machine; in both the
 * host has no file to read, so the group is measured from a container.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  type CommandOutput,
  readHostDocker,
  spawnCommand,
} from '../../apps/melete/src/runtime/docker-engine.ts';
import {
  type DockerHostFacts,
  describeDockerHost,
  engineElsewhere,
  judgeDockerMachine,
  judgeSocketProbe,
  readDockerHost,
  socketProbeCommand,
} from '../../apps/melete/src/runtime/docker-host.ts';
import { parseEnvFile, providerWarnings } from './provider-settings.ts';
import { TAILSCALE_USAGE, tailscaleNodeName, tailscaleNotes } from './tailscale-origin.ts';

/**
 * The options, refused whole when one is not known: the file is written once
 * and never replaced, so a misspelt `--fake` would otherwise leave a real
 * provider selected with no key, and the fix would be deleting the file.
 */
export function configureOptions(args: readonly string[]): {
  fake: boolean;
  nodeName: string | null;
} {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tailscale-hostname') index += 1;
    else if (argument !== '--fake' && argument !== '--tailscale')
      throw new Error(`Unknown option ${argument}. ${TAILSCALE_USAGE}`);
  }
  // Named before anything is written, so a misspelt node name costs nothing.
  return { fake: args.includes('--fake'), nodeName: tailscaleNodeName(args) };
}

export type SocketAccess = {
  /** The host's own socket, as `stat` reports it. */
  statHost: () => Promise<{ isSocket(): boolean; gid: number }>;
  /** Runs the probe container; it may pull the image first, so it gets a long timeout. */
  runProbe: (command: readonly string[]) => CommandOutput;
  /** The image the probe runs: the stack's own pinned Postgres image. */
  probeImage: () => Promise<string>;
};

/** The socket's group as the service will see it, or an error that says why there is none. */
export async function dockerSocketGroup(host: DockerHostFacts, access: SocketAccess) {
  if (host.platform === 'linux' && !engineElsewhere(host)) {
    const socket = await access.statHost();
    if (!socket.isSocket())
      throw new ConfigureRefusal('/var/run/docker.sock is not a Docker socket');
    return socket.gid;
  }
  const probe = judgeSocketProbe(
    access.runProbe(socketProbeCommand(await access.probeImage())),
    host,
  );
  if ('problem' in probe) throw new ConfigureRefusal(probe.problem);
  return probe.gid;
}

/** A reason to stop that the operator acts on; printed as one line, without a stack. */
export class ConfigureRefusal extends Error {}

const ENV_EXISTS = 'deploy/.env already exists. Keep it; edit its settings to change providers.';

/** What was written. Windows applies no owner-only mode, so the file keeps its folder's. */
export function createdMessage(platform: NodeJS.Platform, fake: boolean): string {
  const fakeProvider = fake ? ' and the explicit fake provider' : '';
  return platform === 'win32'
    ? `Created deploy/.env${fakeProvider}. On Windows it has the permissions of its folder.`
    : `Created deploy/.env with private permissions${fakeProvider}.`;
}

/** The line and exit code for a failed run: a refusal is its message alone. */
export function failureReport(error: unknown): { text: string; code: number } | null {
  return error instanceof ConfigureRefusal ? { text: `${error.message}\n`, code: 1 } : null;
}

async function configure(root: string) {
  const target = resolve(root, 'deploy/.env');
  let options: ReturnType<typeof configureOptions>;
  try {
    options = configureOptions(process.argv.slice(2));
  } catch (error) {
    throw new ConfigureRefusal(error instanceof Error ? error.message : String(error));
  }
  const { fake, nodeName } = options;
  // Checked first so a second run is refused before it asks Docker anything;
  // the exclusive write below still settles a race.
  if (existsSync(target)) throw new ConfigureRefusal(ENV_EXISTS);
  // An unsupported engine, Compose or host is named now, not as a failed `up` later.
  const host = readDockerHost(spawnCommand, root);
  const unsupported = judgeDockerMachine(readHostDocker(), host);
  if (unsupported.length > 0) throw new ConfigureRefusal(unsupported.join(' '));
  for (const note of describeDockerHost(host)) process.stdout.write(`${note}\n`);
  const dockerGid = await dockerSocketGroup(host, {
    statHost: () => stat('/var/run/docker.sock'),
    runProbe: (command) => spawnCommand(command, 10 * 60_000),
    probeImage: async () => {
      const compose = parse(await readFile(resolve(root, 'deploy/docker-compose.yml'), 'utf8'));
      return String(compose.services.postgres.image);
    },
  });
  const template = await readFile(resolve(root, 'deploy/.env.example'), 'utf8');
  const password = randomBytes(24).toString('hex');
  const values: Record<string, string> = {
    MELETE_MASTER_KEY: randomBytes(32).toString('base64'),
    MELETE_CAPABILITY_KEY: randomBytes(32).toString('hex'),
    MELETE_APPROVAL_KEY: randomBytes(32).toString('hex'),
    MELETE_RUNTIME_KEY: randomBytes(32).toString('hex'),
    POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgres://melete:${password}@postgres:5432/melete`,
    DOCKER_GID: String(dockerGid),
    ...(fake
      ? {
          MELETE_ENABLE_FAKE_PROVIDER: 'true',
          MELETE_ENABLE_TEST_CONNECTOR: 'true',
          MELETE_DEFAULT_PROVIDER: 'fake',
          MELETE_DEFAULT_MODEL: 'scripted',
        }
      : {}),
    // TS_AUTHKEY stays as the template leaves it, which is empty: it is issued by
    // the Tailscale admin console and nothing here can invent one.
    ...(nodeName === null ? {} : { TS_HOSTNAME: nodeName }),
  };
  const content = template.replace(/^([A-Z_]+)=(.*)$/gm, (line, name: string) =>
    name in values ? `${name}=${values[name]}` : line,
  );
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new ConfigureRefusal(ENV_EXISTS);
    }
    throw error;
  }
  process.stdout.write(`${createdMessage(process.platform, fake)}\n`);
  if (nodeName !== null)
    for (const note of tailscaleNotes(nodeName)) process.stdout.write(`${note}\n`);
  // A real provider is selected with its key still empty. Say so now, not at the first job.
  for (const warning of providerWarnings(parseEnvFile(content)))
    process.stderr.write(`WARNING: ${warning}\n`);
}

if (import.meta.main) {
  try {
    await configure(resolve(import.meta.dir, '../..'));
  } catch (error) {
    const report = failureReport(error);
    if (!report) throw error;
    process.stderr.write(report.text);
    process.exit(report.code);
  }
}
