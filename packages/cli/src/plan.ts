/**
 * The judgement half of `melete deploy`, as pure functions over facts gathered
 * beforehand: whether the update may start, which images it pulls and in what
 * order, how much disk that takes, and whether a backup must come first. The
 * same facts always give the same plan, so the tests drive every refusal
 * without Docker.
 */
import type { DeployConfig } from './deploy-config.ts';
import { downloadBytes, type LocalImage, type RemoteImage, sameContent } from './images.ts';
import type { Result } from './schema.ts';

const MB = 1024 ** 2;
/** Room a pull takes per compressed byte: the download, and the layers unpacked from it. */
export const PULL_FACTOR = 2.2;
/** Room left beyond the database's size for its dump and the files beside it. */
export const BACKUP_MARGIN_BYTES = 64 * MB;

/** The order images are pulled in: the service first, the web server last. */
export const PULL_ORDER = ['melete-service', 'melete-runtime', 'melete-sandbox', 'melete-web'];

export type ImageTarget = {
  ref: string;
  /** The first Compose service that runs it. */
  service: string;
  /** Published by the release pipeline, so the registry describes it. */
  published: boolean;
  local: LocalImage | null;
  remote: RemoteImage | null;
  remoteError: string | null;
};

/** none: the images must come from the checkout's commit. */
export type CheckoutMode = 'none' | 'checkout' | 'allow-mismatch';

export type BackupTarget =
  | { kind: 'dir'; location: string; freeBytes: number | null; sameDiskAsDocker: boolean | null }
  | { kind: 'ssh'; location: string }
  | { kind: 'skip' };

export type DeployFacts = {
  config: DeployConfig;
  from: { tag: string; revision: string | null };
  /** What the operator asked for, and the immutable tag it resolves to. */
  requested: string;
  target: { tag: string; revision: string | null } | { error: string };
  /** The checkout's commit; null when it is not a git checkout. */
  head: string | null;
  mode: CheckoutMode;
  /** Tracked files changed outside deploy/config/. */
  dirty: string[];
  /** The target commit is in the checkout's object store, so it can be checked out and read. */
  revisionAvailable: boolean;
  images: ImageTarget[];
  /** Uncompressed layer digests the engine holds under the stack's repositories. */
  knownLayers: ReadonlySet<string>;
  freeBytes: number | null;
  migrations: MigrationFacts;
  databaseBytes: number | null;
  backup: BackupTarget;
};

export type Pull = { ref: string; service: string; bytes: number };

export type DeployPlan = {
  results: Result[];
  refused: boolean;
  /** Everything is already in place: the target tag runs, and nothing is to be pulled. */
  current: boolean;
  pulls: Pull[];
  downloadBytes: number;
  neededBytes: number;
  backupNeeded: boolean;
};

const mb = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;

const orderOf = (ref: string) => {
  const index = PULL_ORDER.findIndex(
    (name) => ref.includes(`/${name}:`) || ref.startsWith(`${name}:`),
  );
  return index === -1 ? PULL_ORDER.length : index;
};

/**
 * Migrations by their journal time (`when`), which the database records as
 * `created_at`. The service applies, at startup, each journal entry newer than
 * the newest one recorded; so an entry is pending when it is not recorded, and
 * one older than the newest recorded entry would never run.
 */
export type MigrationFacts = {
  /** What the database records; null when it did not answer. */
  recorded: number[] | null;
  /** The journal at the checkout's commit, the release running now. */
  current: number[] | null;
  /** The journal at the target commit; null when that commit is not here to read. */
  target: number[] | null;
  /**
   * Recorded entries the target is known to run beside already: a rollback
   * passes those that were recorded before the deploy it undoes.
   */
  accepted?: number[];
};

export type MigrationDelta = {
  /** Both the database and the target journal were read. */
  known: boolean;
  /** Target entries the database has not recorded: they run when the target starts. */
  pending: number[];
  /** Pending entries older than the newest recorded one: the service would skip them. */
  skipped: number[];
  /** Recorded entries the running release has and the target lacks: going back past them. */
  behind: number[];
  /** Recorded entries neither release has, from some other build. */
  foreign: number[];
};

export function migrationDelta(facts: MigrationFacts): MigrationDelta {
  const { recorded, current, target } = facts;
  if (recorded === null || target === null)
    return { known: false, pending: [], skipped: [], behind: [], foreign: [] };
  const done = new Set(recorded);
  const wanted = new Set(target);
  const accepted = new Set(facts.accepted ?? []);
  const running = new Set((current ?? []).filter((when) => !accepted.has(when)));
  const newest = Math.max(-Infinity, ...recorded);
  const pending = target.filter((when) => !done.has(when));
  return {
    known: true,
    pending,
    skipped: pending.filter((when) => when <= newest),
    behind: recorded.filter((when) => !wanted.has(when) && running.has(when)),
    foreign: recorded.filter((when) => !wanted.has(when) && !running.has(when)),
  };
}

const runs = (delta: MigrationDelta) =>
  delta.known ? `${delta.pending.length} new migration(s)` : 'migrations it could not count';

export function judgeDeploy(facts: DeployFacts): DeployPlan {
  const results: Result[] = [];
  const fail = (id: string, detail: string, fix?: string) =>
    results.push({ id, level: 'fail', detail, ...(fix ? { fix } : {}) });
  const plan: DeployPlan = {
    results,
    refused: false,
    current: false,
    pulls: [],
    downloadBytes: 0,
    neededBytes: 0,
    backupNeeded: false,
  };

  if ('error' in facts.target) {
    fail(
      'deploy.target',
      facts.target.error,
      'Check the tag exists in the registry: the release pipeline publishes main, each commit on main by its short sha, and each version.',
    );
    plan.refused = true;
    return plan;
  }
  const target = facts.target;
  results.push({
    id: 'deploy.target',
    level: 'ok',
    detail:
      target.tag === facts.requested
        ? `${target.tag}, built from ${target.revision ?? 'an unknown commit'}.`
        : `${facts.requested} is ${target.tag} now, built from ${target.revision}; that tag is the one deployed, so it cannot move under the update.`,
  });

  // The Compose file and the images must come from the same commit.
  if (target.revision !== null && target.revision === facts.head)
    results.push({
      id: 'images.revision_matches_checkout',
      level: 'ok',
      detail: `The checkout is at ${target.revision.slice(0, 12)}, the commit the images were built from.`,
    });
  else if (facts.mode === 'checkout') {
    if (target.revision === null)
      fail(
        'images.revision_matches_checkout',
        `${target.tag} carries no revision label, so there is no commit to check out.`,
        'Pass --allow-compose-mismatch to run it with this checkout.',
      );
    else if (!facts.revisionAvailable)
      fail(
        'images.revision_matches_checkout',
        `Commit ${target.revision.slice(0, 12)} is not in this checkout, even after git fetch.`,
        "Check the checkout's origin is the repository the images were built from.",
      );
    else if (facts.dirty.length > 0)
      fail(
        'checkout.clean',
        `The checkout has changes outside deploy/config/: ${facts.dirty.slice(0, 5).join(', ')}${facts.dirty.length > 5 ? ', ...' : ''}`,
        'Commit or set them aside first; deploy checks out the release commit.',
      );
    else
      results.push({
        id: 'images.revision_matches_checkout',
        level: 'ok',
        detail: `The checkout moves from ${facts.head?.slice(0, 12) ?? 'nothing'} to ${target.revision.slice(0, 12)} when the images are in place.`,
      });
  } else if (facts.mode === 'allow-mismatch')
    results.push({
      id: 'images.revision_matches_checkout',
      level: 'warn',
      detail: `The images were built from ${target.revision?.slice(0, 12) ?? 'an unknown commit'}, the checkout is at ${facts.head?.slice(0, 12) ?? 'no commit'}; this checkout's Compose file runs them.`,
    });
  else
    fail(
      'images.revision_matches_checkout',
      `The images were built from ${target.revision?.slice(0, 12) ?? 'an unknown commit'}, but the checkout is at ${facts.head?.slice(0, 12) ?? 'no commit'}.`,
      'Pass --checkout to check out the commit the images were built from, or --allow-compose-mismatch to run them with this Compose file.',
    );

  const delta = migrationDelta(facts.migrations);
  if (delta.behind.length > 0)
    fail(
      'migrations.forward_only',
      `The database records ${delta.behind.length} migration(s) the running release ran and ${target.tag} does not know. Migrations only go forward.`,
      'Going back past them means restoring the database from the backup taken before them: bun run melete rollback prints the steps.',
    );
  if (delta.skipped.length > 0)
    fail(
      'migrations.would_skip',
      `${delta.skipped.length} of ${target.tag}'s migrations are older than the newest one the database records, so the service would never run them.`,
      'The database has migrations from a build outside this release line; restore it from a backup taken before them, or deploy a release that includes them.',
    );
  if (delta.foreign.length > 0)
    results.push({
      id: 'migrations.unknown',
      level: 'warn',
      detail: `The database records ${delta.foreign.length} migration(s) that neither the running release nor ${target.tag} has; they came from another build, and ${target.tag} runs beside them as the running release does.`,
    });

  // Images: what each needs, in pull order, counting a layer shared by two images once.
  const known = new Set(facts.knownLayers);
  const ordered = [...facts.images].sort((a, b) => orderOf(a.ref) - orderOf(b.ref));
  for (const image of ordered) {
    const id = `images.${image.service.replace(/[^a-z0-9]+/g, '_')}`;
    if (!image.published) {
      if (image.local === null)
        fail(
          id,
          `${image.ref} is not on this engine, and it is built here rather than published.`,
          'Build it, or run bun run melete upgrade for an installation that builds its images.',
        );
      else results.push({ id, level: 'ok', detail: `${image.ref} is on this engine.` });
      continue;
    }
    if (image.remote === null) {
      if (image.local !== null)
        results.push({ id, level: 'ok', detail: `${image.ref} is on this engine.` });
      else fail(id, image.remoteError ?? `The registry did not describe ${image.ref}.`);
      continue;
    }
    if (image.local !== null && sameContent(image.remote, image.local)) {
      results.push({ id, level: 'ok', detail: `${image.ref} is on this engine already.` });
      continue;
    }
    const bytes = downloadBytes(image.remote, known);
    for (const layer of image.remote.layers) known.add(layer.diffId);
    plan.pulls.push({ ref: image.ref, service: image.service, bytes });
    results.push({
      id,
      level: 'ok',
      detail:
        bytes === 0
          ? `${image.ref}: every layer is here; the pull only names it.`
          : `${image.ref}: about ${mb(bytes)} to download.`,
    });
  }
  plan.downloadBytes = plan.pulls.reduce((total, pull) => total + pull.bytes, 0);

  // Backup before a switch that runs migrations.
  plan.backupNeeded =
    (!delta.known || delta.pending.length > 0) &&
    !(target.tag === facts.from.tag && plan.pulls.length === 0);
  let backupOnDockerDisk = 0;
  if (!plan.backupNeeded)
    results.push({
      id: 'backup.database',
      level: 'ok',
      detail: `${target.tag} adds no migrations (${facts.migrations.recorded?.length ?? 0} recorded), so the database is not backed up first.`,
    });
  else if (facts.backup.kind === 'skip')
    results.push({
      id: 'backup.database',
      level: 'warn',
      detail: `${target.tag} runs ${runs(delta)}, and --skip-backup was given.`,
    });
  else if (facts.backup.kind === 'ssh')
    results.push({
      id: 'backup.database',
      level: 'ok',
      detail: `The database is streamed to ${facts.backup.location} before the switch, with nothing kept on this disk.`,
    });
  else if (facts.databaseBytes === null)
    fail(
      'backup.database',
      'The database size could not be measured, so the backup before the migrations cannot be planned.',
      'Start postgres, or pass --backup-to ssh://host:/path or --skip-backup.',
    );
  else {
    const needed = facts.databaseBytes + BACKUP_MARGIN_BYTES;
    if (facts.backup.sameDiskAsDocker !== false) backupOnDockerDisk = needed;
    if (facts.backup.sameDiskAsDocker === false && (facts.backup.freeBytes ?? 0) < needed)
      fail(
        'backup.database',
        `${facts.backup.location} has ${mb(facts.backup.freeBytes ?? 0)} free; the dump needs about ${mb(needed)}.`,
        'Free space there, set backup.dir in deploy/melete.deploy.json, or pass --backup-to ssh://host:/path.',
      );
    else
      results.push({
        id: 'backup.database',
        level: 'ok',
        detail: `${target.tag} runs ${runs(delta)}; the database (about ${mb(facts.databaseBytes)}) is dumped to ${facts.backup.location} first.`,
      });
  }

  // Disk: every pull and an on-disk backup must fit above the floor.
  const floor = facts.config.disk.min_free_mb * MB;
  const margin = facts.config.disk.pull_margin_mb * MB;
  plan.neededBytes =
    (plan.downloadBytes > 0 ? Math.ceil(plan.downloadBytes * PULL_FACTOR) + margin : 0) +
    backupOnDockerDisk;
  if (facts.freeBytes === null)
    fail(
      'disk.pull_estimate',
      'The free space where Docker keeps its images could not be measured, so the update cannot be sized.',
      'Run bun run melete doctor for the reason.',
    );
  else if (facts.freeBytes - plan.neededBytes < floor)
    fail(
      'disk.pull_estimate',
      `${mb(facts.freeBytes)} free; the update needs about ${mb(plan.neededBytes)} and the floor keeps ${facts.config.disk.min_free_mb} MB.`,
      'Free space first: docker image prune -f removes images no container uses and no tag names. disk.min_free_mb in deploy/melete.deploy.json sets the floor.',
    );
  else
    results.push({
      id: 'disk.pull_estimate',
      level: 'ok',
      detail: `${mb(facts.freeBytes)} free; the update needs about ${mb(plan.neededBytes)}, leaving at least ${facts.config.disk.min_free_mb} MB.`,
    });

  plan.refused = results.some((result) => result.level === 'fail');
  plan.current =
    !plan.refused &&
    target.tag === facts.from.tag &&
    plan.pulls.length === 0 &&
    (facts.mode !== 'checkout' || target.revision === facts.head);
  return plan;
}

const quote = (value: string) =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
export const shellLine = (command: readonly string[]) => command.map(quote).join(' ');

export type RestoreContext = {
  root: string;
  project: string;
  /** `docker compose -f ... --profile ...` for the installation. */
  compose: readonly string[];
  /** The services that write, stopped before the database is replaced. */
  writers: readonly string[];
  /** The backup set holding database.dump; null when none is known. */
  backupDir: string | null;
  /** Where to go back to: the image tag and, when known, the commit. */
  previous: { tag: string; revision: string | null } | null;
  /** Restoring onto a machine that never ran this installation: no journal volume yet. */
  freshHost: boolean;
  /** The newest restriction journal archive, for a fresh host. */
  journalArchive: string | null;
};

/**
 * The commands that put the database back to a backup, as shell lines. Only the
 * database volume is replaced: the restriction journal stays the newest one, and
 * the service replays it at startup, so nothing forgotten after the backup
 * comes back.
 */
export function restoreSteps(context: RestoreContext): string[] {
  const compose = shellLine(context.compose);
  const dump = context.backupDir ? `${context.backupDir}/database.dump` : '<backup>/database.dump';
  return [
    `cd ${quote(context.root)}`,
    '# Stop everything that writes. Never add --volumes: the volumes are the installation.',
    `${compose} stop ${context.writers.join(' ')}`,
    ...(context.previous
      ? [
          `# Return the checkout and the images to ${context.previous.tag}.`,
          ...(context.previous.revision
            ? [`git -c advice.detachedHead=false checkout --detach ${context.previous.revision}`]
            : []),
          `bun run melete set MELETE_IMAGE_TAG=${context.previous.tag}`,
        ]
      : []),
    `${compose} down`,
    `# Replace only the database volume. Keep ${context.project}_restrictions and every other volume:`,
    '# the newer journal is replayed at startup, so nothing forgotten since the backup comes back.',
    `docker volume rm ${context.project}_pgdata`,
    `${compose} up -d --no-build --wait postgres`,
    `${compose} exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' < ${quote(dump)}`,
    ...(context.freshHost && context.journalArchive
      ? [
          '# A new machine has no journal yet: put back the newest one before the service starts.',
          `${compose} create melete`,
          `${compose} cp -a - melete:/data < ${quote(context.journalArchive)}`,
        ]
      : []),
    '# Start only after the restore has finished.',
    `${compose} up -d --no-build --wait`,
    'bun run melete status',
  ];
}
