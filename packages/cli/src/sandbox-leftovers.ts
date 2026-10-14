/**
 * Agents' computers (docker sandboxes) and their networks that no installation
 * on this engine uses any more. Each installation labels its computers with
 * its own MELETE_SANDBOX_PROJECT and removes only those, so a computer whose
 * project label no installation names (one left by an earlier sandbox project,
 * or by an installation that was removed) stays, holding disk and one of the
 * engine's network blocks.
 *
 * Another installation's computers are never leftovers: a stopped computer or
 * an empty network is normal for it between a pause and a resume. A sandbox
 * project counts as in use when this installation's deploy/.env names it, or
 * when any Melete service container on the engine, running or stopped, runs
 * with it. Only that one setting is read from a container, so no secret in
 * its environment leaves the engine.
 */
import type { Run } from './context.ts';
import type { Result } from './schema.ts';

const SANDBOX = 'label=com.melete.sandbox=v1';
const PROJECT = 'melete.project';
/** A sandbox project as the service accepts MELETE_SANDBOX_PROJECT; no computer it makes has another. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{2,40}$/;
/** States in which a container runs nothing and `docker rm` removes it without force. */
const STOPPED = new Set(['exited', 'created', 'dead']);

export type SandboxContainer = { id: string; name: string; state: string; project: string };
export type SandboxNetwork = { name: string; project: string; containers: number };

export type Leftovers = {
  project: string;
  /** Stopped computers. */
  containers: SandboxContainer[];
  /** Networks no container is on. */
  networks: SandboxNetwork[];
};

const lines = (stdout: string) =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The project label as the listings print it, through `json`: a value with a
 * line break or a tab stays inside its own field, so it can never add a row
 * that names another container or network. Null for anything else.
 */
function labelOf(field: string): string | null {
  try {
    const value: unknown = JSON.parse(field);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** The sandbox projects the Melete service containers on this engine run with. */
function projectsInUse(run: Run): Set<string> | null {
  const listed = run([
    'docker',
    'ps',
    '--all',
    '--quiet',
    '--filter',
    'label=com.docker.compose.service=melete',
  ]);
  if (listed.code !== 0) return null;
  const ids = lines(listed.stdout).filter((id) => /^[0-9a-f]{6,64}$/.test(id));
  if (ids.length === 0) return new Set();
  const inspected = run([
    'docker',
    'inspect',
    '--format',
    '{{range .Config.Env}}{{if eq (index (split . "=") 0) "MELETE_SANDBOX_PROJECT"}}{{.}}{{end}}{{end}}',
    ...ids,
  ]);
  if (inspected.code !== 0) return null;
  return new Set(
    lines(inspected.stdout)
      .filter((line) => line.startsWith('MELETE_SANDBOX_PROJECT='))
      .map((line) => line.slice('MELETE_SANDBOX_PROJECT='.length).trim())
      .filter(Boolean),
  );
}

/**
 * Stopped computers and empty networks, by sandbox project, of every project
 * neither `own` nor any installation on this engine uses; null when the
 * engine could not be asked.
 */
export function readSandboxLeftovers(run: Run, own: string | null): Leftovers[] | null {
  const inUse = projectsInUse(run);
  if (inUse === null) return null;
  if (own) inUse.add(own);
  const containers = run([
    'docker',
    'ps',
    '--all',
    '--filter',
    SANDBOX,
    '--format',
    `{{.ID}}\t{{.Names}}\t{{.State}}\t{{json (.Label "${PROJECT}")}}`,
  ]);
  if (containers.code !== 0) return null;
  const listed = run(['docker', 'network', 'ls', '--quiet', '--filter', SANDBOX]);
  if (listed.code !== 0) return null;
  const networkIds = lines(listed.stdout).filter((id) => /^[0-9a-f]{6,64}$/.test(id));
  let networks: SandboxNetwork[] = [];
  if (networkIds.length > 0) {
    const inspected = run([
      'docker',
      'network',
      'inspect',
      '--format',
      `{{.Name}}\t{{json (index .Labels "${PROJECT}")}}\t{{len .Containers}}`,
      ...networkIds,
    ]);
    if (inspected.code !== 0) return null;
    networks = lines(inspected.stdout).flatMap((line) => {
      const fields = line.split('\t');
      const [name = '', label = '', count = ''] = fields;
      const project = labelOf(label);
      return fields.length === 3 && name && project !== null && /^\d+$/.test(count)
        ? [{ name, project, containers: Number(count) }]
        : [];
    });
  }
  const stopped = lines(containers.stdout).flatMap((line): SandboxContainer[] => {
    const fields = line.split('\t');
    const [id = '', name = '', state = '', label = ''] = fields;
    const project = labelOf(label);
    return fields.length === 4 && id && project !== null && STOPPED.has(state)
      ? [{ id, name, state, project }]
      : [];
  });
  const left = (project: string) => PROJECT_NAME.test(project) && !inUse.has(project);
  const byProject = new Map<string, Leftovers>();
  const entry = (project: string) => {
    let found = byProject.get(project);
    if (!found) {
      found = { project, containers: [], networks: [] };
      byProject.set(project, found);
    }
    return found;
  };
  for (const container of stopped)
    if (left(container.project)) entry(container.project).containers.push(container);
  for (const network of networks)
    if (network.containers === 0 && left(network.project))
      entry(network.project).networks.push(network);
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const described = (leftovers: readonly Leftovers[]) =>
  leftovers
    .map(
      (each) =>
        `${each.project} (${[
          each.containers.length
            ? count(each.containers.length, 'stopped computer', 'stopped computers')
            : '',
          each.networks.length
            ? count(each.networks.length, 'empty network', 'empty networks')
            : '',
        ]
          .filter(Boolean)
          .join(', ')})`,
    )
    .join('; ');

export const LEFTOVERS_ID = 'docker.leftover_sandboxes';

/** The rule: what is left, by sandbox project, and how to remove it on purpose. */
export function judgeLeftovers(leftovers: readonly Leftovers[] | null): Result {
  if (leftovers === null)
    return {
      id: LEFTOVERS_ID,
      level: 'warn',
      detail: "The agents' computers on this engine could not be listed.",
    };
  if (leftovers.length === 0)
    return {
      id: LEFTOVERS_ID,
      level: 'ok',
      detail:
        "No agents' computers or networks are left by a sandbox project no installation here uses.",
    };
  return {
    id: LEFTOVERS_ID,
    level: 'warn',
    detail: `Left by sandbox projects no installation on this engine uses: ${described(leftovers)}. They keep disk and Docker network addresses.`,
    fix: "If none of them belongs to an installation that is down (docker compose down removes its service container, so its computers are listed here too), remove them with bun run melete doctor --remove-leftovers. It removes only these stopped computers and empty networks; the computers' volumes are kept.",
  };
}

/**
 * Removes the stopped computers, then the empty networks, without force: the
 * engine refuses a container that started again or a network a container
 * joined since they were listed, and those stay.
 */
export function removeLeftovers(run: Run, leftovers: readonly Leftovers[]): Result {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const each of leftovers) {
    for (const container of each.containers)
      (run(['docker', 'rm', container.id]).code === 0 ? removed : kept).push(container.name);
    for (const network of each.networks)
      (run(['docker', 'network', 'rm', network.name]).code === 0 ? removed : kept).push(
        network.name,
      );
  }
  return kept.length === 0
    ? {
        id: LEFTOVERS_ID,
        level: 'ok',
        detail: `Removed what ${described(leftovers)} had left: ${removed.join(', ')}.`,
      }
    : {
        id: LEFTOVERS_ID,
        level: 'warn',
        detail: `Removed ${removed.length ? removed.join(', ') : 'nothing'}. The engine kept ${kept.join(', ')}: in use again, or already gone.`,
        fix: 'Run bun run melete doctor again to see what is still left.',
      };
}
