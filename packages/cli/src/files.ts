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
 * their volumes: `com.melete.sandbox=v1`, `com.melete.sandbox.name`, the
 * computer's container, `melete.project`, the sandbox project it was made
 * under, and `melete.install_project`, the Compose project of the
 * installation that made it (see ownedBy).
 */
import type { Context } from './context.ts';
import type { DeployConfig } from './deploy-config.ts';
import { type Installation, longRunningServices } from './installation.ts';
import { INSTALL_PROJECT, labelOf, otherSandboxProjects } from './sandbox-leftovers.ts';

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

/** What an online archive prints on stderr when a file changed while it was read. */
export const CHANGED_WHILE_READ = 'melete-backup: a file changed while it was read';

/**
 * What each part leaves out, as paths in its volume where `*` is one folder.
 * Each space's search index (`.index/`) and its staged writes (`.proposed/`)
 * are derived: the service rebuilds the index from the space's files the first
 * time the space is used after a restore, and staged writes are previews made
 * again from the database or expire. Left out, a backup is smaller and holds no
 * copy of an index file, where a removed record's words could linger.
 */
export const LEFT_OUT: Record<FilePart, readonly string[]> = {
  spaces: ['./*/.index', './*/.proposed'],
  artifacts: [],
  work: [],
};

// GNU tar's options that leave out these paths, archiving or unpacking.
// Anchored at the archive's top, and `*` never crosses a `/`: `./*/.index` is a
// space's own index, never a folder of that name deeper in someone's files.
const excluding = (leaveOut: readonly string[]): string =>
  leaveOut.length === 0
    ? ''
    : ` --anchored --no-wildcards-match-slash ${leaveOut.map((path) => `--exclude='${path}'`).join(' ')}`;

/**
 * Archives a volume to stdout, without the paths `leaveOut` names (see
 * LEFT_OUT). Taken online, a file written during the copy makes GNU tar exit 1
 * ("file changed as we read it"); the archive is whole and that one file may be
 * from mid-write, so 1 is accepted there and nowhere else, and
 * CHANGED_WHILE_READ on stderr says it happened.
 */
export function archiveCommand(
  image: string,
  volume: string,
  online: boolean,
  leaveOut: readonly string[] = [],
): string[] {
  const tar = `tar -C /v --numeric-owner${excluding(leaveOut)} -cf - .`;
  return helperCommand(image, [{ volume, path: '/v', readOnly: true }], 'sh', [
    '-c',
    online
      ? `${tar}; s=$?; if [ "$s" -eq 1 ]; then echo '${CHANGED_WHILE_READ}' >&2; exit 0; fi; exit "$s"`
      : `exec ${tar}`,
  ]);
}

/** The service's restriction journal, in its volume (MELETE_RESTRICTIONS_DIR). */
export const JOURNAL_FILE = 'restrictions.jsonl';

/** The last line of a failed command's stderr, or its exit code when it printed none. */
const failure = (output: { code: number; stderr: string }) =>
  output.stderr.trim().split('\n').at(-1) || `exit ${output.code}`;

/**
 * Whether a volume is on the engine. Only the engine saying it has no such
 * volume makes it absent: any other failure (an engine that did not answer, a
 * permission refused) leaves it unknown, with why, so nothing that would
 * overwrite a volume is planned on a guess.
 */
export function volumePresence(
  context: Context,
  volume: string,
): 'present' | 'absent' | { unreadable: string } {
  const inspected = context.run(['docker', 'volume', 'inspect', '--format', '{{.Name}}', volume]);
  if (inspected.code === 0) return 'present';
  if (/no such volume/i.test(inspected.stderr)) return 'absent';
  return { unreadable: failure(inspected) };
}

/**
 * The restriction journal volume as the engine has it: absent; there but with
 * no entry (no journal file, or only its header line), as `compose create`
 * leaves it on a new machine, or as the first start of an empty installation
 * leaves it; holding entries; or unreadable, with why.
 */
export function journalOnEngine(
  context: Context,
  image: string | null,
  volume: string,
): 'absent' | 'empty' | 'kept' | { unreadable: string } {
  const presence = volumePresence(context, volume);
  if (presence !== 'present') return presence;
  if (!image) return { unreadable: 'the Compose files name no image for the melete service' };
  const read = context.run(
    helperCommand(image, [{ volume, path: '/v', readOnly: true }], 'sh', [
      '-c',
      `if [ -e /v/${JOURNAL_FILE} ]; then echo "lines $(wc -l < /v/${JOURNAL_FILE})"; else echo 'lines none'; fi`,
    ]),
  );
  const lines = /^lines (none|\d+)$/m.exec(read.stdout)?.[1];
  if (read.code !== 0 || lines === undefined)
    return {
      // docker run's own error comes first; its last line only points at --help.
      unreadable: read.stderr.trim().split('\n')[0] || `exit ${read.code}`,
    };
  // The first line is the journal's header; each entry is a line after it.
  return lines === 'none' || Number(lines) <= 1 ? 'empty' : 'kept';
}

/** Where the journal sits in an archive a backup made of the journal's folder. */
export const JOURNAL_MEMBER = `restrictions/${JOURNAL_FILE}`;

/** The journal in a volume that holds one, as text; unreadable, with why, when it could not be read. */
export function journalInVolume(
  context: Context,
  image: string,
  volume: string,
): string | { unreadable: string } {
  const read = context.run(
    helperCommand(image, [{ volume, path: '/v', readOnly: true }], 'cat', [`/v/${JOURNAL_FILE}`]),
  );
  return read.code === 0 ? read.stdout : { unreadable: failure(read) };
}

/** A removal the journal records, as a report names it. */
export type JournalRemoval = { id: string; operation: string; recordedAt: string };

/**
 * The removals a journal's text records, in order: each line after the header
 * holds one. Null when a line is not one the service writes.
 */
export function journalRemovals(text: string): JournalRemoval[] | null {
  const removals: JournalRemoval[] = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    try {
      const record = (JSON.parse(line) as { record?: Record<string, unknown> }).record;
      if (typeof record?.id !== 'string') return null;
      removals.push({
        id: record.id,
        operation: String(record.operation ?? 'unknown'),
        recordedAt: String(record.recorded_at ?? 'unknown'),
      });
    } catch {
      return null;
    }
  }
  return removals;
}

/**
 * Which of these volumes hold at least one file, from one container that mounts
 * them read-only; null when that could not be read. Only volumes already on
 * the engine may be given: mounting a missing one would create it.
 */
export function volumesHoldingFiles(
  context: Context,
  image: string,
  volumes: readonly string[],
): string[] | null {
  if (volumes.length === 0) return [];
  const read = context.run(
    helperCommand(
      image,
      volumes.map((volume, index) => ({ volume, path: `/m/${index}`, readOnly: true })),
      'sh',
      [
        '-c',
        'for d in "$@"; do f=$(find "$d" -mindepth 1 -type f -print -quit) || exit 2; [ -z "$f" ] || echo "held $d"; done; echo done',
        'sh',
        ...volumes.map((_, index) => `/m/${index}`),
      ],
    ),
    600_000,
  );
  if (read.code !== 0 || !/^done$/m.test(read.stdout)) return null;
  return volumes.filter((_, index) => new RegExp(`^held /m/${index}$`, 'm').test(read.stdout));
}

/**
 * Empties a volume and unpacks the archive on stdin into it, keeping owners and
 * modes, without the paths `leaveOut` names (see LEFT_OUT): a backup made before
 * they were left out still holds them, and an old search index can hold the
 * words of records removed before that backup was made.
 */
export function extractCommand(
  image: string,
  volume: string,
  leaveOut: readonly string[] = [],
): string[] {
  return helperCommand(
    image,
    [{ volume, path: '/v', readOnly: false }],
    'sh',
    [
      '-c',
      `find /v -mindepth 1 -delete && exec tar -C /v --numeric-owner${excluding(leaveOut)} -xpf -`,
    ],
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
  // What LEFT_OUT names, at where each part sits in this archive.
  const leaveOut = parts.flatMap((part) =>
    LEFT_OUT[part].map((left) => `${path(part).slice('/r/'.length)}/${left.replace(/^\.\//, '')}`),
  );
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
      `${parts.map((part) => `find ${path(part)} -mindepth 1 -delete`).join(' && ')} && exec tar -C /r --numeric-owner${excluding(leaveOut)} -xpf - ${members.join(' ')}`,
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

/** Whose agents' computers are this installation's: its Compose project, and its sandbox project now. */
export type ComputerOwner = { installProject: string; sandboxProject: string | null };

/**
 * Whether a computer's labels make it this installation's. One that names the
 * installation that made it is this one's when that is this installation's
 * Compose project, whatever sandbox project it was made under: an agent's
 * workspace is resumed by the name it was made with, so one made before
 * MELETE_SANDBOX_PROJECT changed can still be in use. Another installation's
 * is never this one's, even under the same sandbox project. One made before
 * computers named their installation is judged by its sandbox project alone,
 * as before: this installation's when it is the one it runs with now.
 */
export function ownedBy(labels: Record<string, string>, owner: ComputerOwner): boolean {
  const installation = labels[INSTALL_PROJECT];
  if (installation) return installation === owner.installProject;
  return owner.sandboxProject !== null && labels[SANDBOX_PROJECT] === owner.sandboxProject;
}

/**
 * A computer volume that names no installation, made under a sandbox project
 * this installation does not run with now: it may be this installation's,
 * from before MELETE_SANDBOX_PROJECT changed, or another's. Which cannot be
 * told, so a backup leaves it out and says so.
 */
export type UnattributedVolume = { volume: string; project: string };

/**
 * This installation's computers' volumes on this engine, with their labels
 * (see ownedBy). A listing that fails throws: a backup never leaves the
 * computers out silently. A volume of this installation whose name is not a
 * computer's `-work` or `-home` is not taken; its name goes into `skipped`, so
 * the backup can say so. When `unattributed` is given, the computer volumes
 * that name no installation and were made under a sandbox project that
 * neither this installation nor any other on the engine runs with now go into
 * it; one under a project another installation runs with is that one's, as
 * its own backup takes it.
 */
export function listComputerVolumes(
  context: Context,
  owner: ComputerOwner,
  skipped: string[] = [],
  unattributed?: UnattributedVolume[],
): ComputerVolume[] {
  const listed = context.run([
    'docker',
    'volume',
    'ls',
    '--filter',
    `label=${SANDBOX_OWNER}=v1`,
    '--format',
    `{{.Name}}\t{{json (.Label "${SANDBOX_PROJECT}")}}\t{{json (.Label "${INSTALL_PROJECT}")}}`,
  ]);
  if (listed.code !== 0)
    throw new FilesRefusal(
      `The agents' computers' volumes could not be listed: ${listed.stderr.trim().split('\n').at(-1) || `exit ${listed.code}`}`,
    );
  const rows = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      const project = labelOf(fields[1] ?? '');
      const installation = labelOf(fields[2] ?? '');
      // A line this command does not read could be one of this installation's.
      if (fields.length !== 3 || !fields[0] || project === null || installation === null)
        throw new FilesRefusal(
          "The agents' computers' volumes could not be read: docker volume ls printed a line this command does not read.",
        );
      return { name: fields[0], project, installation };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const labelled = (row: { project: string; installation: string }) => ({
    [SANDBOX_PROJECT]: row.project,
    ...(row.installation ? { [INSTALL_PROJECT]: row.installation } : {}),
  });
  if (unattributed) {
    const unknown = rows.filter(
      (row) =>
        !row.installation && row.project !== owner.sandboxProject && COMPUTER_VOLUME.test(row.name),
    );
    // Not knowing which projects the others run with, each such volume is named.
    const others =
      unknown.length > 0 ? otherSandboxProjects(context.run, owner.installProject) : null;
    unattributed.push(
      ...unknown
        .filter((row) => !others?.has(row.project))
        .map((row) => ({ volume: row.name, project: row.project })),
    );
  }
  const all = rows.filter((row) => ownedBy(labelled(row), owner)).map((row) => row.name);
  skipped.push(...all.filter((name) => !COMPUTER_VOLUME.test(name)));
  const names = all.filter((name) => COMPUTER_VOLUME.test(name));
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
      !ownedBy(labels, owner) ||
      labels[SANDBOX_OWNER] !== 'v1'
    )
      throw new FilesRefusal(`${volume}'s labels could not be read, or do not name its computer.`);
    return { volume, computer, labels, file: computerFile(volume) };
  });
}

/**
 * Whether a computer volume a backup lists is this installation's (see
 * ownedBy), labelled by the adapter for the computer its name gives, under the
 * sandbox project that name begins with. Another installation's computers, or
 * a list edited by hand, are never restored into.
 */
export function ownComputer(volume: ComputerVolume, owner: ComputerOwner): boolean {
  const project = volume.labels[SANDBOX_PROJECT];
  return (
    Boolean(project) &&
    volume.computer.startsWith(`melete-sbx-${project}-`) &&
    volume.labels[SANDBOX_OWNER] === 'v1' &&
    volume.labels[SANDBOX_NAME] === volume.computer &&
    ownedBy(volume.labels, owner)
  );
}

/**
 * A computer volume as the engine has it now: absent, this installation's (its
 * labels name the computer, and ownedBy takes them), someone else's, or
 * unreadable, with why. As with volumePresence, only "no such volume" is absent.
 */
export function volumeOnEngine(
  context: Context,
  volume: ComputerVolume,
  owner: ComputerOwner,
): 'absent' | 'ours' | 'foreign' | { unreadable: string } {
  const read = context.run([
    'docker',
    'volume',
    'inspect',
    '--format',
    '{{json .Labels}}',
    volume.volume,
  ]);
  if (read.code !== 0)
    return /no such volume/i.test(read.stderr) ? 'absent' : { unreadable: failure(read) };
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(read.stdout.trim()) ?? {};
  } catch {
    return 'foreign';
  }
  return labels[SANDBOX_NAME] === volume.computer &&
    ownedBy(labels, owner) &&
    labels[SANDBOX_OWNER] === 'v1'
    ? 'ours'
    : 'foreign';
}

/**
 * Stops the runtime's attempt containers of this Compose project. They mount
 * its shared /work, and stopping melete-cells leaves them running; it removes
 * them at its next start. An engine that cannot list them fails the step, so a
 * restore stops while nothing is replaced yet.
 */
export const stopCellsCommand = (project: string): string[] => [
  'sh',
  '-c',
  `ids=$(docker ps -q --filter label=com.melete.attempt-supervisor=v1 --filter 'label=com.melete.project=${project.replace(/[^A-Za-z0-9_.-]/g, '')}') || exit 1; [ -z "$ids" ] || docker stop $ids`,
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

/**
 * Whether a computer's container is on this machine, in any state. As with
 * volumePresence, only the engine saying it has no such container makes it
 * absent; any other failure leaves it unknown, with why.
 */
export function computerExists(
  context: Context,
  computer: string,
): 'present' | 'absent' | { unreadable: string } {
  const inspected = context.run([
    'docker',
    'container',
    'inspect',
    '--format',
    '{{.Id}}',
    computer,
  ]);
  if (inspected.code === 0) return 'present';
  if (/no such container/i.test(inspected.stderr)) return 'absent';
  return { unreadable: failure(inspected) };
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
export type FileSettings = ComputerOwner & {
  image: string | null;
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
    installProject: installation.config.project,
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
    computers = listComputerVolumes(context, settings);
  } catch {
    return null;
  }
  // Only volumes already on the engine: mounting a missing one would create it outside Compose.
  // One the engine could not describe may hold files, so the size is not known.
  const parts = FILE_PARTS.map((part) => composeVolume(config.project, part)).map((volume) => ({
    volume,
    presence: volumePresence(context, volume),
  }));
  if (parts.some(({ presence }) => typeof presence === 'object')) return null;
  const volumes = [
    ...parts.filter(({ presence }) => presence === 'present').map(({ volume }) => volume),
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
