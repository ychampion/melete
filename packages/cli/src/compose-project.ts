/**
 * Who uses a Compose project name on this engine. Compose finds a project by
 * its name alone, so a second installation that took the first one's name
 * would take over its containers and volumes. Each container records the
 * checkout it was started from (`com.docker.compose.project.working_dir`,
 * the deploy/ folder), which tells this installation's containers from
 * another's.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Run } from './context.ts';

const WORKING_DIR = 'com.docker.compose.project.working_dir';

export type ProjectUse = {
  /** The folder each container was started from; null when it carries no such label. */
  containers: { workingDir: string | null }[];
  /** The project's volumes: its data, which outlives `docker compose down`. */
  volumes: string[];
};

/** The project's containers and volumes on this engine; null when the engine did not answer. */
export function readProjectUse(run: Run, project: string): ProjectUse | null {
  const label = `label=com.docker.compose.project=${project}`;
  const listed = run([
    'docker',
    'ps',
    '--all',
    '--filter',
    label,
    '--format',
    `dir={{.Label "${WORKING_DIR}"}}`,
  ]);
  if (listed.code !== 0) return null;
  const volumes = run(['docker', 'volume', 'ls', '--quiet', '--filter', label]);
  if (volumes.code !== 0) return null;
  return {
    containers: listed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('dir='))
      .map((line) => ({ workingDir: line.slice('dir='.length).trim() || null })),
    volumes: volumes.stdout.split(/\s+/).filter(Boolean),
  };
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether a container's folder is this checkout's deploy/, directly or through a link. */
export const fromThisCheckout = (workingDir: string, deployDir: string): boolean =>
  resolve(workingDir) === resolve(deployDir) || real(workingDir) === real(deployDir);

/**
 * The folders of the project's containers that another checkout started.
 * A container with no folder label could be this checkout's, so it is never
 * counted as another's.
 */
export const otherCheckouts = (use: ProjectUse, deployDir: string): string[] => [
  ...new Set(
    use.containers.flatMap(({ workingDir }) =>
      workingDir !== null && !fromThisCheckout(workingDir, deployDir) ? [workingDir] : [],
    ),
  ),
];
