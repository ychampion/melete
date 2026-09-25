/**
 * `bun install --frozen-lockfile` refuses to run when the root package.json names
 * a workspace whose manifest is not in the build context yet. Images copy
 * manifests one by one before installing, so a new workspace must be added to
 * every Dockerfile that installs. This reads the Dockerfiles without Docker and
 * names any workspace manifest a build would be missing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckResult = { name: string; ok: boolean; detail: string };

/** The workspace directories the root manifest declares, with a manifest on disk. */
export function workspaceDirectories(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const directories = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, '')}/package.json`);
    for (const match of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const path = match.replaceAll('\\', '/');
      if (!path.includes('node_modules/')) directories.add(path.replace(/\/package\.json$/, ''));
    }
  }
  return [...directories].sort();
}

/** Join continuation lines and drop comments, leaving one instruction per entry. */
function instructions(text: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!current && (line === '' || line.startsWith('#'))) continue;
    if (current && line.startsWith('#')) continue;
    if (line.endsWith('\\')) {
      current += `${line.slice(0, -1)} `;
      continue;
    }
    result.push(`${current}${line}`.trim());
    current = '';
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

const normalize = (path: string) =>
  path.replace(/^\.\/+/, '').replace(/\/+$/, '') || (path.startsWith('.') ? '.' : path);

/**
 * Workspace manifests a Dockerfile does not copy before one of its installs.
 * Only sources copied from the build context in the same stage count.
 */
export function missingWorkspaceManifests(text: string, workspaces: string[]): string[] {
  const missing = new Set<string>();
  let copied: string[] = [];
  for (const instruction of instructions(text)) {
    const [keyword = '', ...rest] = instruction.split(/\s+/);
    const command = keyword.toUpperCase();
    if (command === 'FROM') {
      copied = [];
      continue;
    }
    if (command === 'COPY' || command === 'ADD') {
      if (rest.some((argument) => argument.startsWith('--from='))) continue;
      const sources = rest.filter((argument) => !argument.startsWith('--')).slice(0, -1);
      copied.push(...sources.map(normalize));
      continue;
    }
    if (command === 'RUN' && /\bbun\s+install\b/.test(instruction)) {
      for (const workspace of workspaces) {
        const manifest = `${workspace}/package.json`;
        const covered = copied.some(
          (source) => source === '.' || source === manifest || manifest.startsWith(`${source}/`),
        );
        if (!covered) missing.add(manifest);
      }
    }
  }
  return [...missing].sort();
}

/** Tracked Dockerfiles that run a Bun install. */
export function installingDockerfiles(root: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '*Dockerfile*'], { cwd: root });
  if (listed.exitCode !== 0) throw new Error('git ls-files failed while listing Dockerfiles');
  return listed.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((file) => /\bbun\s+install\b/.test(readFileSync(join(root, file), 'utf8')))
    .sort();
}

export function checkDockerfileWorkspaces(root: string): CheckResult[] {
  const workspaces = workspaceDirectories(root);
  return installingDockerfiles(root).map((file) => {
    const missing = missingWorkspaceManifests(readFileSync(join(root, file), 'utf8'), workspaces);
    return {
      name: `${file} copies every workspace manifest before installing`,
      ok: missing.length === 0,
      detail: `bun install --frozen-lockfile fails without: ${missing.join(', ')}`,
    };
  });
}

/** Apps that exist for development, a demonstration or their own image, never the service's. */
export const DEVELOPMENT_APPS = ['apps/mock-api', 'apps/tryit', 'apps/web'] as const;

/**
 * Sources of a development app the service image copies beyond its manifest.
 * A manifest is needed for the frozen install; anything else would put mock or
 * demonstration code into the production image, and so does copying `apps/`
 * or the whole context.
 */
export function developmentSourcesCopied(text: string): string[] {
  const found = new Set<string>();
  for (const instruction of instructions(text)) {
    const [keyword = '', ...rest] = instruction.split(/\s+/);
    if (!['COPY', 'ADD'].includes(keyword.toUpperCase())) continue;
    if (rest.some((argument) => argument.startsWith('--from='))) continue;
    for (const source of rest.filter((argument) => !argument.startsWith('--')).slice(0, -1)) {
      const path = normalize(source);
      if (path === '.' || path === 'apps') found.add(path);
      for (const app of DEVELOPMENT_APPS)
        if ((path === app || path.startsWith(`${app}/`)) && path !== `${app}/package.json`)
          found.add(path);
    }
  }
  return [...found].sort();
}

export function checkServiceImageSources(root: string): CheckResult[] {
  const copied = developmentSourcesCopied(
    readFileSync(join(root, 'deploy/Dockerfile.melete'), 'utf8'),
  );
  return [
    {
      name: 'the service image copies no development app',
      ok: copied.length === 0,
      detail: `deploy/Dockerfile.melete copies ${copied.join(', ')}; copy apps/melete alone`,
    },
  ];
}
