/**
 * An installation as its files describe it, read without Docker: the deploy
 * contract, deploy/.env, and the Compose files with deploy/.env substituted in,
 * the way `docker compose` would read them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type Tags } from 'yaml';
import { parseEnvFile } from '../../../deploy/scripts/provider-settings.ts';
import {
  channelOf,
  composeFiles,
  DEFAULT_REGISTRY,
  type DeployConfig,
  deployConfigSchema,
  type LoadedConfig,
  loadDeployConfig,
} from './deploy-config.ts';
import { interpolateDocument, type Missing } from './interpolate.ts';

export type ComposePort = { service: string; hostIp: string | null; published: string };

export type ComposeDocument = {
  services?: Record<
    string,
    {
      profiles?: string[];
      ports?: (string | number | { host_ip?: string; published?: string | number })[];
      environment?: Record<string, unknown> | string[];
    }
  >;
};

export type ComposeRead = {
  file: string;
  /** As written, before substitution; null when it could not be read. */
  raw: ComposeDocument | null;
  /** With deploy/.env substituted in; null when it could not be read. */
  resolved: ComposeDocument | null;
  error?: string;
};

export type Installation = {
  deployDir: string;
  loaded: LoadedConfig;
  /** The contract in force: the file's, or what deploy/.env implies when there is no file or it is invalid. */
  config: DeployConfig;
  /** deploy/.env parsed; null when there is none. */
  env: Record<string, string> | null;
  /** deploy/.env's permission bits; null when there is none or the platform has none. */
  envMode: number | null;
  compose: ComposeRead[];
  /** Variables a Compose file requires that deploy/.env leaves empty. */
  missing: Missing[];
};

/**
 * Compose's merge tags: `!override` replaces what the files before it say, and
 * `!reset` removes it. They are read as the value they tag, so a file that uses
 * them parses without a warning.
 */
const MERGE_TAGS: Tags = ['!override', '!reset'].flatMap((tag) => [
  { tag, collection: 'map' as const, identify: () => false, resolve: (value: unknown) => value },
  { tag, collection: 'seq' as const, identify: () => false, resolve: (value: unknown) => value },
  { tag, identify: () => false, resolve: (value: string) => value },
]) as Tags;

/** A Compose file's text as a document. */
export const parseCompose = (text: string): ComposeDocument =>
  parse(text, { customTags: MERGE_TAGS }) as ComposeDocument;

/** The tag Compose runs: MELETE_IMAGE_TAG, or `local` when it is empty. */
export const envImageTag = (env: Record<string, string>): string =>
  env.MELETE_IMAGE_TAG?.trim() || 'local';

/** The images deploy/.env selects, in the contract's terms. */
export function imagesFromEnv(env: Record<string, string>): DeployConfig['images'] {
  const tag = envImageTag(env);
  return {
    registry: tag === 'local' ? null : env.MELETE_IMAGE_REGISTRY?.trim() || DEFAULT_REGISTRY,
    tag,
    channel: channelOf(tag),
  };
}

/** The contract deploy/.env implies on its own, for a new file or in place of a missing one. */
export function configFromEnv(
  env: Record<string, string>,
  overrides: Partial<DeployConfig> = {},
): DeployConfig {
  return deployConfigSchema.parse({
    contract: 1,
    project: env.COMPOSE_PROJECT_NAME?.trim() || 'melete',
    images: imagesFromEnv(env),
    profiles: env.MELETE_SANDBOX_PROVIDER?.trim() === 'docker' ? ['sandbox'] : [],
    ...overrides,
  });
}

export function readInstallation(
  deployDir: string,
  platform: NodeJS.Platform = process.platform,
): Installation {
  const loaded = loadDeployConfig(deployDir);
  const envPath = join(deployDir, '.env');
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : null;
  const envMode = env !== null && platform !== 'win32' ? statSync(envPath).mode & 0o777 : null;
  const config =
    loaded.kind === 'found'
      ? loaded.config
      : env !== null
        ? safeConfigFromEnv(env, loaded)
        : 'config' in loaded
          ? loaded.config
          : deployConfigSchema.parse({ contract: 1 });
  const missing: Missing[] = [];
  const compose = composeFiles(deployDir, config).map((file): ComposeRead => {
    try {
      const raw = parseCompose(readFileSync(file, 'utf8'));
      return { file, raw, resolved: interpolateDocument(raw, env ?? {}, missing) };
    } catch (error) {
      return {
        file,
        raw: null,
        resolved: null,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      };
    }
  });
  const seen = new Set<string>();
  return {
    deployDir,
    loaded,
    config,
    env,
    envMode,
    compose,
    missing: missing.filter((item) => !seen.has(item.name) && seen.add(item.name)),
  };
}

function safeConfigFromEnv(env: Record<string, string>, loaded: LoadedConfig): DeployConfig {
  try {
    return configFromEnv(env);
  } catch {
    return 'config' in loaded ? loaded.config : deployConfigSchema.parse({ contract: 1 });
  }
}

/** Whether a service runs with the installation's profiles: one with no profiles always does. */
const active = (profiles: string[] | undefined, config: DeployConfig) =>
  !profiles?.length || profiles.some((profile) => (config.profiles as string[]).includes(profile));

/** Every port the active services publish, after substitution. */
export function publishedPorts(installation: Installation): ComposePort[] {
  const ports: ComposePort[] = [];
  for (const read of installation.compose)
    for (const [service, definition] of Object.entries(read.resolved?.services ?? {})) {
      if (!active(definition?.profiles, installation.config)) continue;
      for (const port of definition?.ports ?? []) {
        const parsed = parsePort(port);
        if (parsed) ports.push({ service, ...parsed });
      }
    }
  return ports;
}

/**
 * The host address and port of one `ports` entry. Short syntax is
 * `[host_ip:][published:]target[/protocol]`, with an IPv6 address in brackets;
 * a bare target is published on every address at a port Docker picks.
 */
export function parsePort(
  entry: string | number | { host_ip?: string; published?: string | number },
): { hostIp: string | null; published: string } | null {
  if (typeof entry === 'object')
    return entry.published === undefined
      ? null
      : { hostIp: entry.host_ip?.trim() || null, published: String(entry.published) };
  const text = String(entry).replace(/\/(tcp|udp|sctp)$/, '');
  const bracketed = /^\[([^\]]+)\]:([^:]*):(.+)$/.exec(text);
  if (bracketed) return { hostIp: bracketed[1] ?? null, published: bracketed[2] ?? '' };
  const parts = text.split(':');
  if (parts.length >= 3)
    return { hostIp: parts.slice(0, -2).join(':') || null, published: parts.at(-2) ?? '' };
  if (parts.length === 2) return { hostIp: null, published: parts[0] ?? '' };
  return { hostIp: null, published: '' };
}

/** 127.0.0.0/8, ::1 and localhost: reachable from this machine only. */
export const isLoopback = (address: string | null): boolean =>
  address !== null &&
  (address === 'localhost' || address === '::1' || /^127(\.\d{1,3}){3}$/.test(address));

/** One service's environment from every file, later files winning, as Compose merges them. */
export function serviceEnvironment(
  installation: Installation,
  service: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const read of installation.compose) {
    const environment = read.resolved?.services?.[service]?.environment;
    if (Array.isArray(environment))
      for (const item of environment) {
        const [name, ...value] = String(item).split('=');
        if (name) merged[name] = value.join('=');
      }
    else
      for (const [name, value] of Object.entries(environment ?? {}))
        merged[name] = value === null || value === undefined ? '' : String(value);
  }
  return merged;
}

/** Rule-id form of a setting's name: MELETE_MASTER_KEY is `master_key`. */
export const settingId = (name: string): string =>
  name
    .replace(/^MELETE_/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');

export const deployFilePresent = (deployDir: string, name: string) =>
  existsSync(join(deployDir, name));

/**
 * Settings deploy writes or judges. Compose takes a value set in the shell over
 * deploy/.env, so one set there would leave a deploy writing one release and
 * Compose running another.
 */
export const SHELL_PINNED = [
  'MELETE_IMAGE_TAG',
  'MELETE_IMAGE_REGISTRY',
  'COMPOSE_PROJECT_NAME',
  'MELETE_SANDBOX_DOCKER_IMAGE',
] as const;

/** The settings deploy and rollback write to deploy/.env. */
export const WRITTEN_BY_DEPLOY = ['MELETE_IMAGE_TAG'] as const;

/**
 * The pinned settings this shell would override, names only: any it sets that
 * the command is about to write (Compose would keep the shell's value whatever
 * deploy/.env says next), and any it sets to something other than deploy/.env.
 */
export function shellOverrides(
  environment: Readonly<Record<string, string | undefined>>,
  env: Record<string, string>,
  written: readonly string[] = [],
): string[] {
  return SHELL_PINNED.filter((name) => {
    const shell = environment[name];
    return shell !== undefined && (written.includes(name) || shell !== (env[name] ?? ''));
  });
}

export const shellOverrideMessage = (names: readonly string[]) =>
  `This shell sets ${names.join(', ')}, which Compose reads before deploy/.env, so the stack would not run what deploy/.env says. Run unset ${names.join(' ')}, then run this again. Nothing was changed.`;
