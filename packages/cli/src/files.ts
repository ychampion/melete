/**
 * The files a backup holds besides the database: the spaces' trees, the files
 * kept by their content (the local blob store), the agents' shared /work, and
 * each agent computer's own two volumes, `/work` and its home.
 *
 * Every volume is archived on its own by a short-lived container of the
 * service's image that mounts it read-only, so a volume is reached whether or
 * not anything runs on it, and restore empties it and unpacks the archive into
 * it the same way. Nothing is reached through a running service.
 *
 * The computers are found by the labels the docker sandbox adapter puts on
 * their volumes: `com.melete.sandbox=v1`, this installation's
 * `melete.project` (MELETE_SANDBOX_PROJECT), and `com.melete.sandbox.name`,
 * the computer's container. Another installation's computers on the same
 * engine carry another project, so they are never listed.
 */
import type { Context } from './context.ts';
import type { DeployConfig } from './deploy-config.ts';
import { type Installation, longRunningServices } from './installation.ts';

/** The service that starts the runtime's attempt containers. */
export const CELLS_SERVICE = 'melete-cells';

/** What the backup holds besides the database, written beside SHA256SUMS. */
export const CONTENTS_FILE = 'contents.json';

/** The Compose volumes that hold what people made, each archived as `<part>.tar`. */
export const FILE_PARTS = ['spaces', 'artifacts', 'work'] as const;
export type FilePart = (typeof FILE_PARTS)[number];

/** What each part is, for reports. */
export const PART_NAMES: Record<FilePart, string> = {
  spaces: "the spaces' files",
  artifacts: 'the files kept by their content (uploads, Files)',
  work: "the agents' shared /work",
};

const SANDBOX_OWNER = 'com.melete.sandbox';
const SANDBOX_NAME = 'com.melete.sandbox.name';
const SANDBOX_PROJECT = 'melete.project';
/** A computer's volume, as the docker sandbox adapter names it. */
export const COMPUTER_VOLUME = /^(melete-sbx-[a-z0-9][a-z0-9_.-]{0,160})-(work|home)$/;
/** A label key or value a restore may hand to `docker volume create`. */
const LABEL_TEXT = /^[A-Za-z0-9_.:/@-]{1,200}$/;

export type ComputerVolume = {
  volume: string;
  /** The computer's container, from the volume's label. */
  computer: string;
  /** The volume's labels, put back on a machine that has no such volume yet. */
  labels: Record<string, string>;
  file: string;
};

/** contents.json. */
export type Contents = {
  format: 1;
  /** `offline`: the writers were stopped while the files were archived. */
  taken: 'online' | 'offline';
  parts: { part: FilePart; file: string }[];
  computers: ComputerVolume[];
  blobs: 'local' | 's3';
};

export const partFile = (part: FilePart) => `${part}.tar`;
export const computerFile = (volume: string) => `computer-${volume}.tar`;
export const composeVolume = (project: string, part: FilePart) => `${project}_${part}`;

/**
 * The image the archiving container runs: the service's, as the installation's
 * Compose files resolve it. It is on every machine that runs the stack.
 */
export function helperImage(installation: Pick<Installation, 'compose'>): string | null {
  for (const read of [...installation.compose].reverse()) {
    const image = read.resolved?.services?.melete?.image;
    if (typeof image === 'string' && image.trim()) return image.trim();
  }
  return null;
}

type Mount = { volume: string; path: string; readOnly: boolean };

/** A container with no network that mounts the volumes and runs one program as root. */
export function helperCommand(
  image: string,
  mounts: readonly Mount[],
  program: string,
  args: readonly string[],
  stdin = false,
): string[] {
  return [
    'docker',
    'run',
    '--rm',
    ...(stdin ? ['-i'] : []),
    '--network',
    'none',
    // Root, to read every owner's files and give each back its owner on restore.
    '--user',
    '0:0',
    ...mounts.flatMap((mount) => [
      '--mount',
      `type=volume,src=${mount.volume},dst=${mount.path}${mount.readOnly ? ',readonly' : ''}`,
    ]),
    '--entrypoint',
    program,
    image,
    ...args,
  ];
}

/**
 * Archives a volume to stdout. Taken online, a file written during the copy
 * makes GNU tar exit 1 ("file changed as we read it"); the archive is whole and
 * that one file may be from mid-write, so 1 is accepted there and nowhere else.
 */
export function archiveCommand(image: string, volume: string, online: boolean): string[] {
  const tar = 'tar -C /v --numeric-owner -cf - .';
  return helperCommand(image, [{ volume, path: '/v', readOnly: true }], 'sh', [
    '-c',
    online ? `${tar}; s=$?; [ "$s" -eq 1 ] && exit 0; exit "$s"` : `exec ${tar}`,
  ]);
}

/** Empties a volume and unpacks the archive on stdin into it, keeping owners and modes. */
export function extractCommand(image: string, volume: string): string[] {
  return helperCommand(
    image,
    [{ volume, path: '/v', readOnly: false }],
    'sh',
    ['-c', 'find /v -mindepth 1 -delete && exec tar -C /v --numeric-owner -xpf -'],
    true,
  );
}

/**
 * The same for an archive made by an earlier `backup --with-volumes`: data.tar
 * holds /data (spaces, artifacts, and journal and keys that are not restored
 * from it), work.tar holds /work.
 */
export function legacyExtractCommand(
  image: string,
  project: string,
  file: 'data.tar' | 'work.tar',
): string[] {
  const parts: FilePart[] = file === 'data.tar' ? ['spaces', 'artifacts'] : ['work'];
  const path = (part: FilePart) => (part === 'work' ? '/r/work' : `/r/data/${part}`);
  const members = parts.map((part) => path(part).slice('/r/'.length));
  return helperCommand(
    image,
    parts.map((part) => ({
      volume: composeVolume(project, part),
      path: path(part),
      readOnly: false,
    })),
    'sh',
    [
      '-c',
      `${parts.map((part) => `find ${path(part)} -mindepth 1 -delete`).join(' && ')} && exec tar -C /r --numeric-owner -xpf - ${members.join(' ')}`,
    ],
    true,
  );
}

/** `du -sk` of every volume, in one container; parse with the backup's duBytes. */
export const measureCommand = (image: string, volumes: readonly string[]): string[] =>
  helperCommand(
    image,
    volumes.map((volume, index) => ({ volume, path: `/m/${index}`, readOnly: true })),
    'du',
    ['-sk', ...volumes.map((_, index) => `/m/${index}`)],
  );

export class FilesRefusal extends Error {}

/**
 * This installation's computers' volumes on this engine, with their labels.
 * Null project: the installation has no docker computers, so none are listed.
 * A listing that fails throws: a backup never leaves the computers out silently.
 */
export function listComputerVolumes(
  context: Context,
  sandboxProject: string | null,
): ComputerVolume[] {
  if (!sandboxProject) return [];
  const listed = context.run([
    'docker',
    'volume',
    'ls',
    '--quiet',
    '--filter',
    `label=${SANDBOX_OWNER}=v1`,
    '--filter',
    `label=${SANDBOX_PROJECT}=${sandboxProject}`,
  ]);
  if (listed.code !== 0)
    throw new FilesRefusal(
      `The agents' computers' volumes could not be listed: ${listed.stderr.trim().split('\n').at(-1) || `exit ${listed.code}`}`,
    );
  const names = listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => COMPUTER_VOLUME.test(name))
    .sort();
  if (names.length === 0) return [];
  const inspected = context.run([
    'docker',
    'volume',
    'inspect',
    '--format',
    '{{.Name}} {{json .Labels}}',
    ...names,
  ]);
  if (inspected.code !== 0)
    throw new FilesRefusal(
      `The agents' computers' volumes could not be read: ${inspected.stderr.trim().split('\n').at(-1) || `exit ${inspected.code}`}`,
    );
  const labelsOf = new Map<string, Record<string, string>>();
  for (const line of inspected.stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    try {
      labelsOf.set(line.slice(0, space), JSON.parse(line.slice(space + 1)) ?? {});
    } catch {
      // Left unread; the check below reports the volume.
    }
  }
  return names.map((volume) => {
    const labels = labelsOf.get(volume);
    const computer = COMPUTER_VOLUME.exec(volume)?.[1] ?? '';
    // Only a volume the adapter made for this computer, labelled for this installation.
    if (
      !labels ||
      labels[SANDBOX_NAME] !== computer ||
      labels[SANDBOX_PROJECT] !== sandboxProject ||
      labels[SANDBOX_OWNER] !== 'v1'
    )
      throw new FilesRefusal(`${volume}'s labels could not be read, or do not name its computer.`);
    return { volume, computer, labels, file: computerFile(volume) };
  });
}

/**
 * Whether a computer volume a backup lists is this installation's: labelled by
 * the adapter for this sandbox project and for the computer its name gives.
 * Another installation's computers, or a list edited by hand, are never
 * restored into.
 */
export function ownComputer(volume: ComputerVolume, sandboxProject: string | null): boolean {
  return (
    sandboxProject !== null &&
    volume.computer.startsWith(`melete-sbx-${sandboxProject}-`) &&
    volume.labels[SANDBOX_OWNER] === 'v1' &&
    volume.labels[SANDBOX_NAME] === volume.computer &&
    volume.labels[SANDBOX_PROJECT] === sandboxProject
  );
}

/**
 * A computer volume as the engine has it now: absent, this installation's (its
 * labels name the computer and the project), or someone else's.
 */
export function volumeOnEngine(
  context: Context,
  volume: ComputerVolume,
  sandboxProject: string,
): 'absent' | 'ours' | 'foreign' {
  const read = context.run([
    'docker',
    'volume',
    'inspect',
    '--format',
    '{{json .Labels}}',
    volume.volume,
  ]);
  if (read.code !== 0) return 'absent';
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(read.stdout.trim()) ?? {};
  } catch {
    return 'foreign';
  }
  return labels[SANDBOX_NAME] === volume.computer &&
    labels[SANDBOX_PROJECT] === sandboxProject &&
    labels[SANDBOX_OWNER] === 'v1'
    ? 'ours'
    : 'foreign';
}

/**
 * Stops the runtime's attempt containers of this Compose project. They mount
 * its shared /work, and stopping melete-cells leaves them running; it removes
 * them at its next start.
 */
export const stopCellsCommand = (project: string): string[] => [
  'sh',
  '-c',
  `docker ps -q --filter label=com.melete.attempt-supervisor=v1 --filter 'label=com.melete.project=${project.replace(/[^A-Za-z0-9_.-]/g, '')}' | xargs -r docker stop`,
];

/** What an archive made by an earlier `backup --with-volumes` must hold to be put back. */
export const legacyMembers = (file: 'data.tar' | 'work.tar'): string[] =>
  file === 'data.tar' ? ['data/spaces', 'data/artifacts'] : ['work'];

/** What the labels of a volume a restore creates may hold, so a label never reaches a shell as code. */
export function safeLabels(labels: Record<string, string>): boolean {
  return Object.entries(labels).every(
    ([key, value]) => LABEL_TEXT.test(key) && LABEL_TEXT.test(value),
  );
}

/** Whether a computer's container runs now and is not paused. */
export function computerRunning(context: Context, computer: string): boolean {
  const state = context.run([
    'docker',
    'container',
    'inspect',
    '--format',
    '{{.State.Running}} {{.State.Paused}}',
    computer,
  ]);
  return state.code === 0 && state.stdout.trim() === 'true false';
}

/** Whether a computer's container is on this machine, in any state. */
export function computerExists(context: Context, computer: string): boolean {
  return (
    context.run(['docker', 'container', 'inspect', '--format', '{{.Id}}', computer]).code === 0
  );
}

/** Whether a computer's container is paused now. */
export function computerPaused(context: Context, computer: string): boolean {
  const state = context.run([
    'docker',
    'container',
    'inspect',
    '--format',
    '{{.State.Paused}}',
    computer,
  ]);
  return state.code === 0 && state.stdout.trim() === 'true';
}

/** The settings a backup of the files reads from deploy/.env. */
export type FileSettings = {
  image: string | null;
  sandboxProject: string | null;
  /** MELETE_SANDBOX_PROVIDER, when it names something other than this engine. */
  remoteSandboxes: string | null;
  blobs: DeployConfig['blobs'];
  /** Whether the stack runs melete-cells, whose attempt containers mount the shared /work. */
  cells: boolean;
};

export function fileSettings(installation: Installation): FileSettings {
  const env = installation.env ?? {};
  const provider = env.MELETE_SANDBOX_PROVIDER?.trim() || null;
  return {
    cells: longRunningServices(installation).includes(CELLS_SERVICE),
    image: helperImage(installation),
    sandboxProject: env.MELETE_SANDBOX_PROJECT?.trim() || null,
    remoteSandboxes: provider && provider !== 'docker' ? provider : null,
    blobs: installation.config.blobs,
  };
}

/** Bytes the files take, from one measuring container; null when they could not be measured. */
export function measureFiles(
  context: Context,
  config: DeployConfig,
  settings: FileSettings,
  duBytes: (output: { code: number; stdout: string }) => number | null,
): number | null {
  if (!settings.image) return null;
  let computers: ComputerVolume[];
  try {
    computers = listComputerVolumes(context, settings.sandboxProject);
  } catch {
    return null;
  }
  // Only volumes already on the engine: mounting a missing one would create it outside Compose.
  const volumes = [
    ...FILE_PARTS.map((part) => composeVolume(config.project, part)).filter(
      (volume) =>
        context.run(['docker', 'volume', 'inspect', '--format', '{{.Name}}', volume]).code === 0,
    ),
    ...computers.map((computer) => computer.volume),
  ];
  if (volumes.length === 0) return 0;
  return duBytes(context.run(measureCommand(settings.image, volumes), 600_000));
}

/** Reads contents.json; null when the backup has none (made before backups held files). */
export function parseContents(text: string): Contents | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `${CONTENTS_FILE} is not JSON`;
  }
  const contents = value as Partial<Contents>;
  if (contents.format !== 1) return `${CONTENTS_FILE} has a format this command does not read`;
  if (!Array.isArray(contents.parts) || !Array.isArray(contents.computers))
    return `${CONTENTS_FILE} does not list its parts`;
  if (
    (contents.taken !== 'online' && contents.taken !== 'offline') ||
    (contents.blobs !== 'local' && contents.blobs !== 's3')
  )
    return `${CONTENTS_FILE} does not say how it was taken`;
  for (const part of contents.parts)
    if (!FILE_PARTS.includes(part?.part) || part.file !== partFile(part.part))
      return `${CONTENTS_FILE} names a part this command does not know`;
  // A backup holds every part or none: one with some volumes left out would empty the rest.
  const named = contents.parts.map((part) => part.part);
  if (named.length !== FILE_PARTS.length || FILE_PARTS.some((part) => !named.includes(part)))
    return `${CONTENTS_FILE} does not list every part a backup holds`;
  for (const computer of contents.computers) {
    const match = COMPUTER_VOLUME.exec(computer?.volume ?? '');
    if (
      !match ||
      match[1] !== computer.computer ||
      computer.file !== computerFile(computer.volume) ||
      typeof computer.labels !== 'object' ||
      computer.labels === null ||
      !safeLabels(computer.labels)
    )
      return `${CONTENTS_FILE} names a computer volume this command does not take`;
  }
  return contents as Contents;
}
