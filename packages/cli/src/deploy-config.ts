/**
 * deploy/melete.deploy.json, contract 1: what an installation is, beyond what
 * deploy/.env says. It names the Compose project, the images and where they come
 * from, the profiles and overlay files the stack runs with, the disk floors
 * updates keep, where backups go, and which ports may leave this machine. It
 * holds no secret, so it can be committed to a repository that keeps the
 * deployment. Secrets and service settings stay in deploy/.env.
 *
 * A contract number this release does not know is refused rather than guessed
 * at, and so is any key it does not know: a misspelt floor must not silently
 * fall back to its default.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  keep: z.number().int().min(1).default(3),
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

export const deployConfigSchema = z
  .strictObject({
    contract: z.literal(CONTRACT),
    /** The Compose project: COMPOSE_PROJECT_NAME. */
    project: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'a Compose project name: lower-case letters, digits, - and _')
      .default('melete'),
    images: images.default({ registry: DEFAULT_REGISTRY, tag: 'main', channel: 'main' }),
    profiles: z.array(z.enum(PROFILES)).refine(unique, 'each profile once').default([]),
    overlays: z.array(z.enum(OVERLAYS)).refine(unique, 'each overlay once').default([]),
    disk: disk.default({ min_free_mb: 4096, pull_margin_mb: 512 }),
    backup: backup.default({ dir: '~/melete-backups', keep: 3 }),
    /** Whether a port may be published on an address other than loopback. */
    public_ports: z.boolean().default(false),
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

/** The installation's file, or the defaults when there is none yet. */
export function loadDeployConfig(deployDir: string): LoadedConfig {
  const path = join(deployDir, DEPLOY_FILE);
  if (!existsSync(path)) return { kind: 'missing', config: defaultDeployConfig() };
  return parseDeployConfig(readFileSync(path, 'utf8'));
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

/**
 * The base file, each overlay, then the external database and the S3 blob store
 * files when the contract asks for them, in Compose's reading order.
 */
export function composeFiles(deployDir: string, config: DeployConfig): string[] {
  const overlays = OVERLAYS.filter((overlay) => config.overlays.includes(overlay));
  return [
    join(deployDir, 'docker-compose.yml'),
    ...overlays.map((overlay) => join(deployDir, OVERLAY_FILES[overlay])),
    ...(config.database.external ? [join(deployDir, EXTERNAL_DB_FILE)] : []),
    ...(config.blobs.store === 's3' ? [join(deployDir, BLOBS_S3_FILE)] : []),
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
