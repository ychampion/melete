/**
 * What the registry and the engine say about an image, read without pulling it.
 * The registry side comes from `docker buildx imagetools inspect`: the digest a
 * pull would fetch, the commit the image was built from (its
 * org.opencontainers.image.revision label), and each layer's compressed size
 * paired with the uncompressed digest the engine records once it has the layer.
 * The engine side comes from `docker image inspect`.
 */
import type { Run } from './context.ts';

export const REVISION_LABEL = 'org.opencontainers.image.revision';

export type RemoteImage = {
  ref: string;
  /** The digest `docker pull` fetches: the index's, or the manifest's when there is no index. */
  digest: string;
  revision: string | null;
  /** In order: each layer's uncompressed digest and its compressed size in bytes. */
  layers: { diffId: string; size: number }[];
};

export type LocalImage = {
  id: string;
  /** `repository@sha256:...` for each registry digest the engine recorded. */
  repoDigests: string[];
  /** Uncompressed layer digests. */
  layers: string[];
  revision: string | null;
};

/** `ghcr.io/ychampion/melete-service:main` is repository `ghcr.io/ychampion/melete-service`. */
export function repositoryOf(ref: string): string {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/** The engine's architecture in the registry's words. */
export function registryArchitecture(engineArch: string | undefined): string {
  if (!engineArch) return 'amd64';
  return (
    ({ x86_64: 'amd64', aarch64: 'arm64', armv7l: 'arm' } as Record<string, string>)[engineArch] ??
    engineArch
  );
}

type Platform = { os?: string; architecture?: string };
type Descriptor = { digest?: string; size?: number; platform?: Platform; mediaType?: string };
type Manifest = {
  digest?: string;
  mediaType?: string;
  manifests?: Descriptor[];
  layers?: Descriptor[];
};
type ImageConfig = {
  config?: { Labels?: Record<string, string> | null };
  rootfs?: { diff_ids?: string[] };
};

const parse = <T>(stdout: string): T | null => {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
};

const inspect = (ref: string, format: string) => [
  'docker',
  'buildx',
  'imagetools',
  'inspect',
  ref,
  '--format',
  format,
];

/** The registry's facts about one reference, or why they could not be read. */
export function inspectRemote(
  run: Run,
  ref: string,
  architecture: string,
): RemoteImage | { error: string } {
  const why = (stderr: string, code: number) =>
    stderr.trim().split('\n').at(-1)?.trim() || `exit ${code}`;
  const top = run(inspect(ref, '{{json .Manifest}}'), 120_000);
  const manifest = top.code === 0 ? parse<Manifest>(top.stdout) : null;
  if (!manifest?.digest)
    return { error: `the registry did not describe ${ref}: ${why(top.stderr, top.code)}` };
  const configOutput = run(inspect(ref, '{{json .Image}}'), 120_000);
  const raw =
    configOutput.code === 0
      ? parse<ImageConfig | Record<string, ImageConfig>>(configOutput.stdout)
      : null;
  const config: ImageConfig | null =
    raw && 'rootfs' in raw
      ? (raw as ImageConfig)
      : ((raw as Record<string, ImageConfig> | null)?.[`linux/${architecture}`] ?? null);
  if (!config?.rootfs?.diff_ids)
    return {
      error: `the registry gave no image configuration for ${ref}: ${why(configOutput.stderr, configOutput.code)}`,
    };
  let layers = manifest.layers;
  if (!layers) {
    const platform = manifest.manifests?.find(
      (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === architecture,
    );
    if (!platform?.digest) return { error: `${ref} has no linux/${architecture} image.` };
    const platformOutput = run(
      [
        'docker',
        'buildx',
        'imagetools',
        'inspect',
        '--raw',
        `${repositoryOf(ref)}@${platform.digest}`,
      ],
      120_000,
    );
    layers = (platformOutput.code === 0 ? parse<Manifest>(platformOutput.stdout) : null)?.layers;
    if (!layers)
      return {
        error: `the registry gave no layer list for ${ref}: ${why(platformOutput.stderr, platformOutput.code)}`,
      };
  }
  const diffIds = config.rootfs.diff_ids;
  if (diffIds.length !== layers.length)
    return { error: `${ref}'s layer list and configuration disagree.` };
  return {
    ref,
    digest: manifest.digest,
    revision: config.config?.Labels?.[REVISION_LABEL] ?? null,
    layers: layers.map((layer, index) => ({ diffId: diffIds[index] ?? '', size: layer.size ?? 0 })),
  };
}

type InspectRow = {
  Id?: string;
  RepoDigests?: string[] | null;
  RootFS?: { Layers?: string[] | null };
  Config?: { Labels?: Record<string, string> | null };
};

const toLocal = (row: InspectRow): LocalImage => ({
  id: row.Id ?? '',
  repoDigests: row.RepoDigests ?? [],
  layers: row.RootFS?.Layers ?? [],
  revision: row.Config?.Labels?.[REVISION_LABEL] ?? null,
});

/** The engine's facts about images by reference or id; a missing one is left out. */
export function inspectLocal(run: Run, refs: readonly string[]): Map<string, LocalImage> {
  const found = new Map<string, LocalImage>();
  for (const ref of refs) {
    const output = run(['docker', 'image', 'inspect', '--format', '{{json .}}', ref]);
    if (output.code !== 0) continue;
    const row = parse<InspectRow>(output.stdout.trim());
    if (row?.Id) found.set(ref, toLocal(row));
  }
  return found;
}

/** Every image the engine holds in these repositories, by id. */
export function imagesInRepositories(run: Run, repositories: readonly string[]): LocalImage[] {
  const ids = new Set<string>();
  for (const repository of repositories) {
    const listed = run(['docker', 'images', '--no-trunc', '--format', '{{.ID}}', repository]);
    if (listed.code === 0) for (const id of listed.stdout.split(/\s+/)) if (id) ids.add(id);
  }
  return [...inspectLocal(run, [...ids]).values()];
}

/** Whether the engine already has exactly what a pull of this reference would fetch. */
export const sameContent = (remote: RemoteImage, local: LocalImage | undefined): boolean =>
  local !== undefined &&
  (local.id === remote.digest ||
    local.repoDigests.includes(`${repositoryOf(remote.ref)}@${remote.digest}`));

/** Compressed bytes a pull fetches: the layers the engine has under no image in these repositories. */
export function downloadBytes(remote: RemoteImage, known: ReadonlySet<string>): number {
  const counted = new Set<string>();
  let total = 0;
  for (const layer of remote.layers) {
    if (known.has(layer.diffId) || counted.has(layer.diffId)) continue;
    counted.add(layer.diffId);
    total += layer.size;
  }
  return total;
}
