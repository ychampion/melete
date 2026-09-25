/**
 * Generate local deployment secrets once, without logging or overwriting them.
 *
 *   bun run deploy/scripts/configure.ts [--provider name] [--model id]
 *     [--tailscale [--tailscale-hostname name]]
 *   bun run deploy/scripts/configure.ts --fake [--tailscale ...]
 *
 * The default is a production configuration: a real model provider, with its
 * key read from this command's environment (FIREWORKS_API_KEY for the default
 * provider) and written into deploy/.env, never printed. `--fake` is the
 * explicit opt-in to the demonstration: the scripted provider and the test
 * connector, and no key at all.
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
  OPENAI_COMPATIBLE,
  PROVIDER_NAMES,
  providerKeyProblem,
  providerKeyVariables,
  providerSelectionProblem,
  providersFromEnv,
} from '../../apps/melete/src/gateway/providers.ts';
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
import { tailscaleNodeName, tailscaleNotes } from './tailscale-origin.ts';

export const CONFIGURE_USAGE =
  'Usage: bun run deploy/scripts/configure.ts [--provider name] [--model id] [--tailscale [--tailscale-hostname name]], or --fake for the demonstration';

/**
 * The options, refused whole when one is not known: the file is written once
 * and never replaced, so a misspelt `--fake` would otherwise leave a real
 * provider selected with no key, and the fix would be deleting the file.
 */
export function configureOptions(args: readonly string[]): {
  fake: boolean;
  nodeName: string | null;
  provider?: string;
  model?: string;
} {
  let provider: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tailscale-hostname') index += 1;
    else if (argument === '--provider' || argument === '--model') {
      const value = args[index + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} needs a value. ${CONFIGURE_USAGE}`);
      if (argument === '--provider') provider = value;
      else model = value;
      index += 1;
    } else if (argument !== '--fake' && argument !== '--tailscale')
      throw new Error(`Unknown option ${argument}. ${CONFIGURE_USAGE}`);
  }
  const fake = args.includes('--fake');
  if (fake && (provider || model))
    throw new Error(
      `--fake runs the scripted demonstration provider; it takes no --provider or --model. ${CONFIGURE_USAGE}`,
    );
  if (provider !== undefined && !PROVIDER_NAMES.includes(provider))
    throw new Error(
      `--provider ${provider} is not a provider the gateway has. Use one of: ${PROVIDER_NAMES.join(', ')}.`,
    );
  // Named before anything is written, so a misspelt node name costs nothing.
  return {
    fake,
    nodeName: tailscaleNodeName(args),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * The provider settings deploy/.env gets. The demonstration turns on the
 * scripted provider and the test connector. Anything else is production: a
 * real provider whose key is in this command's environment, the model it is
 * asked for, and both demonstration switches written off. A production
 * configuration without its key is refused, so the file is never written in a
 * state where every model call would be refused.
 */
export function providerSettings(
  options: { fake: boolean; provider?: string; model?: string },
  example: Record<string, string>,
  environment: Record<string, string | undefined>,
): Record<string, string> {
  if (options.fake)
    return {
      MELETE_ENABLE_FAKE_PROVIDER: 'true',
      MELETE_ENABLE_TEST_CONNECTOR: 'true',
      MELETE_DEFAULT_PROVIDER: 'fake',
      MELETE_DEFAULT_MODEL: 'scripted',
    };
  const provider = options.provider ?? example.MELETE_DEFAULT_PROVIDER ?? '';
  const model =
    options.model ??
    (provider === example.MELETE_DEFAULT_PROVIDER ? example.MELETE_DEFAULT_MODEL : undefined);
  if (!model)
    throw new ConfigureRefusal(
      `Name the model with --model, written exactly as the ${provider} API expects it.`,
    );
  const baseUrl = environment.OPENAI_COMPAT_BASE_URL?.trim() || undefined;
  const variables = providerKeyVariables(provider, baseUrl);
  const production = {
    MELETE_DEFAULT_PROVIDER: provider,
    MELETE_DEFAULT_MODEL: model,
    MELETE_ENABLE_FAKE_PROVIDER: 'false',
    MELETE_ENABLE_TEST_CONNECTOR: 'false',
  };
  // A provider reached by the owner's sign-in has no key to read; the owner
  // signs in once the stack is up.
  if (variables.length === 0) return production;
  const keys = Object.fromEntries(
    variables.flatMap((name) => {
      const value = environment[name]?.trim();
      if (!value) return [];
      // A key never contains whitespace; one that does was pasted wrong, and a
      // line break would write a second setting into deploy/.env. Only the
      // variable is named, never what it holds.
      if (/\s/.test(value))
        throw new ConfigureRefusal(
          `${name} contains a space or a line break, so it is not a key as written. Set it again and run this again.`,
        );
      return [[name, value]];
    }),
  );
  const providers = providersFromEnv({ ...keys, OPENAI_COMPAT_BASE_URL: baseUrl });
  const problem =
    providerSelectionProblem(provider, providers) ?? providerKeyProblem(provider, providers);
  if (problem)
    throw new ConfigureRefusal(
      provider === OPENAI_COMPATIBLE && !baseUrl
        ? `Set OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY in this command's environment, or pass --fake for the demonstration.`
        : `Set ${variables[0]} in this command's environment, for example with read -rs ${variables[0]} && export ${variables[0]}, then run this again. Or pass --fake for the demonstration.`,
    );
  return {
    ...production,
    ...keys,
    ...(baseUrl && provider === OPENAI_COMPATIBLE ? { OPENAI_COMPAT_BASE_URL: baseUrl } : {}),
  };
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
    const socket = await access.statHost().catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new ConfigureRefusal(
          'There is no /var/run/docker.sock on this machine, and the Compose file mounts it into the service. Start Docker Engine, or link its socket to that path.',
        );
      throw error;
    });
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
export function createdMessage(
  platform: NodeJS.Platform,
  fake: boolean,
  provider?: string,
): string {
  const fakeProvider = fake
    ? ' and the explicit fake provider'
    : provider
      ? ` for the ${provider} provider`
      : '';
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
  const template = await readFile(resolve(root, 'deploy/.env.example'), 'utf8');
  // A production run without its key stops here, before Docker is asked anything.
  const provider = providerSettings(options, parseEnvFile(template), process.env);
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
  const password = randomBytes(24).toString('hex');
  const values: Record<string, string> = {
    MELETE_MASTER_KEY: randomBytes(32).toString('base64'),
    MELETE_CAPABILITY_KEY: randomBytes(32).toString('hex'),
    MELETE_APPROVAL_KEY: randomBytes(32).toString('hex'),
    MELETE_RUNTIME_KEY: randomBytes(32).toString('hex'),
    POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgres://melete:${password}@postgres:5432/melete`,
    DOCKER_GID: String(dockerGid),
    ...provider,
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
  process.stdout.write(
    `${createdMessage(process.platform, fake, provider.MELETE_DEFAULT_PROVIDER)}\n`,
  );
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
