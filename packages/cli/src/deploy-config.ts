/**
 * deploy/melete.deploy.json, contract 1: what an installation is, beyond what
 * deploy/.env says. It names the Compose project, the images and where they come
 * from, the profiles and overlay files the stack runs with (its own Compose
 * files among them), the disk floors
 * updates keep, where backups go, and which ports may leave this machine. It
 * holds no secret, so it can be committed to a repository that keeps the
 * deployment. Secrets and service settings stay in deploy/.env.
 *
 * A contract number this release does not know is refused rather than guessed
 * at, and so is any key it does not know: a misspelt floor must not silently
 * fall back to its default.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { z } from 'zod';

export const DEPLOY_FILE = 'melete.deploy.json';
export const CONTRACT = 1;

/** The overlay files each name adds, in the order Compose reads them. */
export const OVERLAY_FILES = {
  browser: 'docker-compose.browser.yml',
  tailscale: 'docker-compose.tailscale.yml',
  'tailscale-kernel': 'docker-compose.tailscale-kernel.yml',
} as const;
export type Overlay = keyof typeof OVERLAY_FILES;
const OVERLAYS = Object.keys(OVERLAY_FILES) as [Overlay, ...Overlay[]];

/** Read after the overlays when `database.external` is true: the service uses DATABASE_URL, and the bundled postgres stays off. */
export const EXTERNAL_DB_FILE = 'docker-compose.external-db.yml';
/** Read last when `blobs.store` is `s3`: the service keeps its blobs in the bucket deploy/.env names. */
export const BLOBS_S3_FILE = 'docker-compose.blobs-s3.yml';

export const PROFILES = ['sandbox'] as const;

/** The default registry, the one deploy/docker-compose.yml names when MELETE_IMAGE_REGISTRY is empty. */
export const DEFAULT_REGISTRY = 'ghcr.io/ychampion';

/**
 * How long a backup is kept by default, in days: the period hosted services
 * commonly give for deleted data to leave their backups.
 */
export const DEFAULT_BACKUP_DAYS = 30;

/** A Compose project name, as COMPOSE_PROJECT_NAME takes it. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Where backups go when the contract does not say: a folder of the project's
 * own, so two installations on one machine never prune each other's backups.
 * The project `melete` keeps the folder it always had; another project's
 * folder is inside it, where pruning never looks.
 */
export const defaultBackupDir = (project: string): string =>
  project === 'melete' ? '~/melete-backups' : `~/melete-backups/${project}`;

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

const images = z.strictObject({
  /** Where published images come from; null for images built on this machine. */
  registry: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/, 'a registry such as ghcr.io/ychampion')
    .nullable()
    .default(DEFAULT_REGISTRY),
  /** The image tag: `main`, a commit's short sha, a release tag, or `local` for images built here. */
  tag: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'a Docker image tag')
    .default('main'),
  /** Which line of releases the tag follows. */
  channel: z.enum(['main', 'release', 'local']).default('main'),
});

const disk = z.strictObject({
  /** The free space, in MB, below which nothing is pulled and the installation is reported short of disk. */
  min_free_mb: z.number().int().min(0).default(4096),
  /** Room left beyond an update's estimated size, in MB. */
  pull_margin_mb: z.number().int().min(0).default(512),
});

const backup = z.strictObject({
  dir: z.string().min(1).default('~/melete-backups'),
  /** How many backups `dir` keeps; each new one removes the oldest beyond this. */
  keep: z.number().int().min(1).default(3),
  /**
   * The most days a backup in `dir` is kept, whatever `keep` says, so what was
   * forgotten or deleted leaves the backups within this many days of a backup
   * made after it. Null keeps them by `keep` alone.
   */
  max_age_days: z.number().int().min(1).max(3650).nullable().default(DEFAULT_BACKUP_DAYS),
});

const blobs = z.discriminatedUnion('store', [
  z.strictObject({ store: z.literal('local') }),
  z.strictObject({
    store: z.literal('s3'),
    /** The S3-compatible service's address; left out for AWS S3, which the region selects. */
    endpoint: z.url().optional(),
    bucket: z.string().min(1),
    region: z.string().min(1).optional(),
  }),
]);

/**
 * Letters, digits and `. _ - / ~` only, because a remote path or command is
 * used in the remote shell. `~` at the start is that account's home.
 */
const remoteWord = z
  .string()
  .regex(/^[A-Za-z0-9._/~:=-]+$/, 'letters, digits and . _ - / ~ : = only')
  .refine((value) => !value.split('/').includes('..'), 'no .. in a path');

/** Where `melete remote` finds this installation on the machine it reaches over SSH. */
const remote = z.strictObject({
  /** The remote checkout, absolute or under ~/. */
  path: remoteWord.refine(
    (value) => /^(\/|~\/|~$)/.test(value),
    'an absolute path or one under ~/',
  ),
  /** The command that runs the melete command there, from the checkout. */
  cli: z.array(remoteWord).min(1).default(['bun', 'run', 'melete']),
});

/** The files the contract's own keys choose, which `compose_files` may not name again. */
const BUILT_IN_FILES = new Set<string>([
  'docker-compose.yml',
  ...Object.values(OVERLAY_FILES),
  EXTERNAL_DB_FILE,
  BLOBS_S3_FILE,
]);

/**
 * A Compose file of the installation's own, relative to deploy/, such as
 * `../private/compose.extra.yml` or `docker-compose.brand.yml`. Letters,
 * digits and `. _ - /` only, with `/` as the separator, so the same contract
 * reads the same on every machine.
 */
const composeFile = z
  .string()
  .max(512)
  .regex(
    /^[A-Za-z0-9._-][A-Za-z0-9._/-]*\.ya?ml$/,
    'a path relative to deploy/ that ends in .yml or .yaml, with / between folders',
  )
  // Written one way only, so `./docker-compose.yml` cannot name a built-in
  // file again and `a/../b.yml` cannot list `b.yml` twice.
  .refine((value) => posix.normalize(value) === value, {
    message: 'a path written without ./, // or a folder/.. step',
  })
  .refine((value) => !BUILT_IN_FILES.has(value), {
    message: 'a file melete.deploy.json already chooses with its own keys',
  });

/** A contract with no backup folder gets its project's own (defaultBackupDir). */
function withProjectBackupDir(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const project = typeof record.project === 'string' ? record.project : 'melete';
  const backup = record.backup;
  if (backup === undefined) return { ...record, backup: { dir: defaultBackupDir(project) } };
  if (backup !== null && typeof backup === 'object' && !Array.isArray(backup) && !('dir' in backup))
    return { ...record, backup: { ...backup, dir: defaultBackupDir(project) } };
  return raw;
}

const contractObject = z
  .strictObject({
    contract: z.literal(CONTRACT),
    /** The Compose project: COMPOSE_PROJECT_NAME. */
    project: z
      .string()
      .regex(PROJECT_NAME, 'a Compose project name: lower-case letters, digits, - and _')
      .default('melete'),
    images: images.default({ registry: DEFAULT_REGISTRY, tag: 'main', channel: 'main' }),
    profiles: z.array(z.enum(PROFILES)).refine(unique, 'each profile once').default([]),
    overlays: z.array(z.enum(OVERLAYS)).refine(unique, 'each overlay once').default([]),
    /**
     * The installation's own Compose files, relative to deploy/, read after
     * every file the other keys add, in the order listed: services that run
     * beside the stack, a reverse proxy, a brand folder. Each must exist.
     */
    compose_files: z.array(composeFile).max(32).refine(unique, 'each file once').default([]),
    disk: disk.default({ min_free_mb: 4096, pull_margin_mb: 512 }),
    backup: backup.default({
      dir: '~/melete-backups',
      keep: 3,
      max_age_days: DEFAULT_BACKUP_DAYS,
    }),
    /** Whether a port may be published on an address other than loopback. */
    public_ports: z.boolean().default(false),
    /**
     * Whether people other than the operator reach this installation over the
     * internet. `check` and `status` then fail without an https public address,
     * the web origin that matches it, an alert target and an operator token.
     * Left out, it is false and the same rules only warn.
     */
    hosted: z.boolean().optional(),
    database: z.strictObject({ external: z.boolean().default(false) }).default({ external: false }),
    blobs: blobs.default({ store: 'local' }),
    cells: z
      .strictObject({
        hosts: z.array(z.string().regex(/^tcp\+tls:\/\/[^\s/]+$/, 'tcp+tls://host:port')),
      })
      .default({ hosts: [] }),
    remote: remote.optional(),
  })
  .superRefine((value, context) => {
    if (value.overlays.includes('tailscale-kernel') && !value.overlays.includes('tailscale'))
      context.addIssue({
        code: 'custom',
        path: ['overlays'],
        message: 'tailscale-kernel is read on top of tailscale; list both',
      });
    if ((value.images.registry === null) !== (value.images.tag === 'local'))
      context.addIssue({
        code: 'custom',
        path: ['images'],
        message:
          'images built here have registry null and tag local; published images name a registry and a published tag',
      });
  });

export const deployConfigSchema = z.preprocess(withProjectBackupDir, contractObject);

export type DeployConfig = z.infer<typeof deployConfigSchema>;

export const defaultDeployConfig = (): DeployConfig => deployConfigSchema.parse({ contract: 1 });

export type LoadedConfig =
  | { kind: 'found'; config: DeployConfig }
  | { kind: 'missing'; config: DeployConfig }
  | { kind: 'invalid'; issues: string[] };

/** Parses the file's text; every problem is one line naming the key. */
export function parseDeployConfig(text: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'invalid',
      issues: [`${DEPLOY_FILE} is not JSON: ${error instanceof Error ? error.message : error}`],
    };
  }
  if (raw !== null && typeof raw === 'object' && 'contract' in raw && raw.contract !== CONTRACT)
    return {
      kind: 'invalid',
      issues: [
        `${DEPLOY_FILE} is contract ${JSON.stringify(raw.contract)}; this release reads contract ${CONTRACT}. Use the melete command from the release that wrote it.`,
      ],
    };
  const parsed = deployConfigSchema.safeParse(raw);
  if (parsed.success) return { kind: 'found', config: parsed.data };
  return {
    kind: 'invalid',
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  };
}

/**
 * The contract's own Compose files that are not there, one line each. A file
 * left out would start the stack without what it adds, so a missing one makes
 * the contract invalid rather than skipped. So does one that lands on a file
 * already read: `../deploy/docker-compose.yml` is the base file however it is
 * spelt, and a file read twice is not what the list says.
 */
export function missingComposeFiles(deployDir: string, config: DeployConfig): string[] {
  const read = new Set([...BUILT_IN_FILES].map((file) => resolve(deployDir, file)));
  return config.compose_files.flatMap((file, index) => {
    const path = join(deployDir, file);
    if (read.has(resolve(path)))
      return [`compose_files.${index}: deploy/${file} is a file the stack already reads`];
    read.add(resolve(path));
    let present = false;
    try {
      present = statSync(path).isFile();
    } catch {
      // Missing, or a folder on the way is: not there either way.
    }
    return present ? [] : [`compose_files.${index}: deploy/${file} does not exist`];
  });
}

/** The installation's file, or the defaults when there is none yet. */
export function loadDeployConfig(deployDir: string): LoadedConfig {
  const path = join(deployDir, DEPLOY_FILE);
  if (!existsSync(path)) return { kind: 'missing', config: defaultDeployConfig() };
  const loaded = parseDeployConfig(readFileSync(path, 'utf8'));
  if (loaded.kind !== 'found') return loaded;
  const missing = missingComposeFiles(deployDir, loaded.config);
  return missing.length ? { kind: 'invalid', issues: missing } : loaded;
}

/** The file's text: every key written out, so an operator sees each setting it can change. */
export function renderDeployConfig(config: DeployConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes a new file, refusing one that exists. */
export async function createDeployConfig(deployDir: string, config: DeployConfig): Promise<string> {
  const path = join(deployDir, DEPLOY_FILE);
  await writeFile(path, renderDeployConfig(config), { flag: 'wx', mode: 0o644 });
  return path;
}

/** The channel a tag belongs to. */
export const channelOf = (tag: string): DeployConfig['images']['channel'] =>
  tag === 'local' ? 'local' : /^v\d/.test(tag) ? 'release' : 'main';

/** The installation's own Compose files (`compose_files`), as paths, in their order. */
export const ownComposeFiles = (deployDir: string, config: DeployConfig): string[] =>
  config.compose_files.map((file) => join(deployDir, file));

/**
 * The base file, each overlay, the external database and the S3 blob store
 * files when the contract asks for them, then the installation's own files, in
 * Compose's reading order: a later file overrides an earlier one, so the
 * installation's own come last.
 */
export function composeFiles(deployDir: string, config: DeployConfig): string[] {
  const overlays = OVERLAYS.filter((overlay) => config.overlays.includes(overlay));
  return [
    join(deployDir, 'docker-compose.yml'),
    ...overlays.map((overlay) => join(deployDir, OVERLAY_FILES[overlay])),
    ...(config.database.external ? [join(deployDir, EXTERNAL_DB_FILE)] : []),
    ...(config.blobs.store === 's3' ? [join(deployDir, BLOBS_S3_FILE)] : []),
    ...ownComposeFiles(deployDir, config),
  ];
}

/** The `docker compose` prefix for this installation: its files and its profiles. */
export function composeCommand(deployDir: string, config: DeployConfig): string[] {
  return [
    'docker',
    'compose',
    ...composeFiles(deployDir, config).flatMap((file) => ['-f', file]),
    ...config.profiles.flatMap((profile) => ['--profile', profile]),
  ];
}
