/**
 * `melete init [configure options]`: a new installation. It runs
 * deploy/scripts/configure.ts as before, which writes deploy/.env, then writes
 * deploy/melete.deploy.json from it.
 *
 * `melete init --adopt`: an installation that is already running. It reads the
 * project's containers from the engine (the image the service runs, the
 * overlay files Compose was given, whether the sandbox profile is in use) and
 * writes deploy/melete.deploy.json from them. It runs only read-only Docker
 * commands and writes that one file; deploy/.env and the stack are left as
 * they are.
 *
 * `--public-url https://…` sets the public address and the web origin together;
 * with `--hosted` the new file also says `"hosted": true`, so `check` and
 * `status` require what an installation for other people needs.
 *
 * Either refuses, with nothing changed, when deploy/melete.deploy.json exists.
 * `--min-free-mb` and `--pull-margin-mb` set the disk floors in the new file,
 * and `--backup-dir` the folder backups go to (by default one of the project's
 * own).
 *
 * A second installation on the machine takes `--project <name> --api-port
 * <port> --web-port <port>`, which configure.ts writes to deploy/.env. A new
 * installation is refused while its project name is in use on this engine:
 * another installation's containers or volumes would become this one's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { parseEnvFile } from '../../../../deploy/scripts/provider-settings.ts';
import { otherCheckouts, type ProjectUse, readProjectUse } from '../compose-project.ts';
import type { Context, Run } from '../context.ts';
import {
  BLOBS_S3_FILE,
  channelOf,
  createDeployConfig,
  DEFAULT_REGISTRY,
  DEPLOY_FILE,
  type DeployConfig,
  deployConfigSchema,
  EXTERNAL_DB_FILE,
  OVERLAY_FILES,
  type Overlay,
  PROJECT_NAME,
  renderDeployConfig,
} from '../deploy-config.ts';
import { configFromEnv, sandboxProfile } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';

export class InitRefusal extends Error {}

export type InitOptions = {
  adopt: boolean;
  disk: Partial<DeployConfig['disk']>;
  /** `--backup-dir`: where backups go, absolute or under ~/. */
  backupDir?: string;
  /** `--project`: the Compose project, also handed to configure.ts. */
  project?: string;
  /** Everything else, handed to configure.ts. */
  configure: string[];
};

/** An absolute folder, or one under the home folder (`~/…`), on any platform. */
const homeOrAbsolute = (value: string) =>
  value === '~' || value.startsWith('~/') || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);

export function initOptions(args: readonly string[]): InitOptions {
  const options: InitOptions = { adopt: false, disk: {}, configure: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const floor = (key: keyof DeployConfig['disk']) => {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value))
        throw new InitRefusal(`${arg} takes a whole number of MB.`);
      options.disk[key] = Number(value);
      index += 1;
    };
    if (arg === '--adopt') options.adopt = true;
    else if (arg === '--min-free-mb') floor('min_free_mb');
    else if (arg === '--pull-margin-mb') floor('pull_margin_mb');
    else if (arg === '--backup-dir') {
      const value = args[index + 1];
      if (value === undefined || !homeOrAbsolute(value))
        throw new InitRefusal('--backup-dir takes an absolute folder, or one under ~/.');
      options.backupDir = value;
      index += 1;
    } else if (arg === '--project') {
      const value = args[index + 1];
      if (value === undefined || !PROJECT_NAME.test(value))
        throw new InitRefusal(
          '--project takes a Compose project name: lower-case letters, digits, - and _, starting with a letter or a digit.',
        );
      options.project = value;
      options.configure.push(arg, value);
      index += 1;
    } else options.configure.push(arg);
  }
  if (options.adopt && options.configure.length > 0)
    throw new InitRefusal(
      `--adopt takes only --min-free-mb, --pull-margin-mb and --backup-dir; ${options.configure.join(' ')} belongs to a new installation.`,
    );
  return options;
}

/**
 * Why a new installation may not take this project name, or null when nothing
 * on this engine uses it. Another checkout's containers are named, so the
 * operator sees which installation it is.
 */
export function projectInUse(project: string, use: ProjectUse, deployDir: string): string | null {
  if (use.containers.length === 0 && use.volumes.length === 0) return null;
  const others = otherCheckouts(use, deployDir);
  const choose = `Give this one a project, ports and backup folder of its own, for example: bun run melete init --project ${project === 'melete2' ? 'melete3' : 'melete2'} --api-port 3200 --web-port 3201 (with the options you meant to give). Nothing was written.`;
  if (others.length > 0)
    return `Another installation, in ${others.join(', ')}, already runs as the Compose project ${project}, and this one would take over its containers and volumes. ${choose}`;
  if (use.containers.length > 0)
    return `Compose project ${project} already has containers on this engine, and this one would take them over with new secrets. ${choose} If they are left from an installation you removed, remove them first (docker compose -p ${project} down).`;
  return `Compose project ${project} already has ${use.volumes.length} volume(s) on this engine: the data of an installation that is stopped or was removed. This one would start on that data with new secrets, and its database would not open. ${choose} If that data is no longer wanted, remove it first (docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=${project})).`;
}

export type ContainerFacts = {
  service: string;
  image: string;
  configFiles: string[];
  /** A `docker compose run` container: not part of the stack, and often on an older image. */
  oneoff: boolean;
  running: boolean;
};

/** `docker inspect` output, reduced to what adoption reads. */
export function parseInspect(stdout: string): ContainerFacts[] {
  const rows = JSON.parse(stdout) as {
    Config?: { Image?: string; Labels?: Record<string, string> | null };
    State?: { Running?: boolean };
  }[];
  return rows.map((row) => {
    const labels = row.Config?.Labels ?? {};
    return {
      service: labels['com.docker.compose.service'] ?? '',
      image: row.Config?.Image ?? '',
      configFiles: (labels['com.docker.compose.project.config_files'] ?? '')
        .split(',')
        .map((file) => file.trim())
        .filter(Boolean),
      oneoff: labels['com.docker.compose.oneoff'] === 'True',
      running: row.State?.Running === true,
    };
  });
}

/** `ghcr.io/ychampion/melete-service:main` as a registry and a tag; `melete-service:local` has none. */
export function parseServiceImage(image: string): DeployConfig['images'] | null {
  const match = /^(?:(.+)\/)?melete-service:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(image);
  if (!match?.[2]) return null;
  const tag = match[2];
  if (tag === 'local' && !match[1]) return { registry: null, tag, channel: 'local' };
  return { registry: match[1] ?? DEFAULT_REGISTRY, tag, channel: channelOf(tag) };
}

/** The contract the running containers describe. */
export function adoptedConfig(
  project: string,
  containers: readonly ContainerFacts[],
  env: Record<string, string>,
  disk: Partial<DeployConfig['disk']>,
  backupDir?: string,
): DeployConfig {
  const stack = containers.filter((container) => !container.oneoff);
  const services = stack.filter((container) => container.service === 'melete');
  if (services.length === 0)
    throw new InitRefusal(
      `Compose project ${project} has no melete service container on this engine. For a new installation run bun run melete init.`,
    );
  // A running service container says what the stack runs; a stopped one may be left from an older deploy.
  const running = services.filter((container) => container.running);
  const candidates = running.length > 0 ? running : services;
  const seen = [...new Set(candidates.map((container) => container.image))];
  if (seen.length > 1)
    throw new InitRefusal(
      `The melete service containers of project ${project} run different images (${seen.join(', ')}), so which one is the installation is not clear. Remove the stale container, or start the stack, and run this again.`,
    );
  const service = candidates[0] as ContainerFacts;
  const images = parseServiceImage(service.image);
  if (!images)
    throw new InitRefusal(
      `The melete service runs ${service.image}, which is not a Melete service image this command can describe.`,
    );
  const files = new Set(
    stack.flatMap((container) => container.configFiles.map((f) => basename(f.replace(/\\/g, '/')))),
  );
  const names = new Set(stack.map((container) => container.service));
  const overlays = (Object.entries(OVERLAY_FILES) as [Overlay, string][])
    .filter(([name, file]) => files.has(file) || (name !== 'tailscale-kernel' && names.has(name)))
    .map(([name]) => name);
  // sandbox-image keeps no container, except one an older Compose file started.
  const sandbox = names.has('sandbox-image') || sandboxProfile(env);
  const setting = (name: string) => env[name]?.trim() || undefined;
  const bucket = setting('MELETE_BLOB_S3_BUCKET');
  if (files.has(BLOBS_S3_FILE) && !bucket)
    throw new InitRefusal(
      `The stack runs with ${BLOBS_S3_FILE}, but deploy/.env names no MELETE_BLOB_S3_BUCKET, so the bucket it uses is not clear. Set it, and run this again.`,
    );
  return deployConfigSchema.parse({
    contract: 1,
    project,
    images,
    profiles: sandbox ? ['sandbox'] : [],
    overlays,
    disk: { min_free_mb: 4096, pull_margin_mb: 512, ...disk },
    ...(backupDir ? { backup: { dir: backupDir } } : {}),
    database: { external: files.has(EXTERNAL_DB_FILE) || names.has('database-client') },
    blobs: files.has(BLOBS_S3_FILE)
      ? {
          store: 's3',
          bucket,
          endpoint: setting('MELETE_BLOB_S3_ENDPOINT'),
          region: setting('MELETE_BLOB_S3_REGION'),
        }
      : { store: 'local' },
  });
}

function readContainers(run: Run, project: string): ContainerFacts[] {
  const listed = run([
    'docker',
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.oneoff=False',
  ]);
  if (listed.code !== 0)
    throw new InitRefusal(
      `docker ps did not answer (${listed.stderr.trim() || `exit ${listed.code}`}). Run bun run melete doctor.`,
    );
  const ids = listed.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return [];
  const inspected = run(['docker', 'inspect', ...ids]);
  if (inspected.code !== 0)
    throw new InitRefusal(`docker inspect did not answer (${inspected.stderr.trim()}).`);
  return parseInspect(inspected.stdout);
}

export async function runInit(context: Context, args: readonly string[]): Promise<ExitCode> {
  const contractPath = join(context.deployDir, DEPLOY_FILE);
  const envPath = join(context.deployDir, '.env');
  try {
    const options = initOptions(args);
    if (existsSync(contractPath))
      throw new InitRefusal(
        `${contractPath} exists already. Edit it, or remove it and run this again.`,
      );
    if (options.adopt) {
      if (!existsSync(envPath))
        throw new InitRefusal(
          'There is no deploy/.env, so there is no installation here to adopt. For a new one run bun run melete init.',
        );
      return await withLock(context.deployDir, 'init --adopt', async () => {
        const env = parseEnvFile(readFileSync(envPath, 'utf8'));
        const project = env.COMPOSE_PROJECT_NAME?.trim() || 'melete';
        const config = adoptedConfig(
          project,
          readContainers(context.run, project),
          env,
          options.disk,
          options.backupDir,
        );
        await createDeployConfig(context.deployDir, config);
        context.out(`Wrote ${DEPLOY_FILE} from the running stack:\n${renderDeployConfig(config)}`);
        const envTag = env.MELETE_IMAGE_TAG?.trim() || 'local';
        if (envTag !== config.images.tag)
          context.out(
            `deploy/.env names image tag ${envTag}, but the stack runs ${config.images.tag}. bun run melete check reports the difference until the two agree.\n`,
          );
        return EXIT.ok;
      });
    }
    if (existsSync(envPath))
      throw new InitRefusal(
        'deploy/.env exists already. To describe that installation, run bun run melete init --adopt.',
      );
    return await withLock(context.deployDir, 'init', async () => {
      // Checked before configure.ts writes anything. An engine that does not
      // answer is left to configure.ts, which names what is wrong with it.
      const project = options.project ?? 'melete';
      const use = readProjectUse(context.run, project);
      const taken = use && projectInUse(project, use, context.deployDir);
      if (taken) throw new InitRefusal(taken);
      const code = await context.attach([
        process.execPath,
        join(context.deployDir, 'scripts', 'configure.ts'),
        ...options.configure,
      ]);
      // configure.ts writes deploy/.env last, so a refusal leaves nothing behind.
      if (code !== 0 || !existsSync(envPath)) return EXIT.refused;
      try {
        const env = parseEnvFile(readFileSync(envPath, 'utf8'));
        const tailscale = options.configure.includes('--tailscale');
        const hosted = options.configure.includes('--hosted');
        const made = configFromEnv(env, {
          overlays: tailscale ? ['tailscale'] : [],
          disk: { min_free_mb: 4096, pull_margin_mb: 512, ...options.disk },
          ...(hosted ? { hosted: true } : {}),
        });
        const config = options.backupDir
          ? { ...made, backup: { ...made.backup, dir: options.backupDir } }
          : made;
        await createDeployConfig(context.deployDir, config);
        context.out(`Wrote ${DEPLOY_FILE}. Backups go to ${config.backup.dir}.\n`);
        return EXIT.ok;
      } catch (error) {
        context.err(
          `deploy/.env was written, but ${DEPLOY_FILE} was not (${error instanceof Error ? error.message : error}). Run bun run melete init --adopt once the stack is up, or write it by hand.\n`,
        );
        return EXIT.partial;
      }
    });
  } catch (error) {
    if (error instanceof InitRefusal || error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
