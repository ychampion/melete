/**
 * `melete deploy [--tag <tag>] [--dry-run] [--checkout | --allow-compose-mismatch]
 *   [--skip-backup | --backup-to ssh://host:/path] [--wait-timeout <seconds>]`
 *
 * Updates an installation that runs the published images, without building
 * anything. Until the images are all in place, every step either passes or
 * stops with exit 2 and the running stack exactly as it was:
 *
 *   1. take the lock and run `check`;
 *   2. resolve the tag: a moving tag such as `main` is pinned to the commit
 *      tag it names now, so nothing moves under the update. The images must
 *      come from the checkout's commit, or --checkout checks that commit out
 *      once the images are here, or --allow-compose-mismatch accepts the gap;
 *   3. plan: the images whose content differs from what the engine has, the
 *      layers they need, and the disk that takes (compressed size x 2.2 plus
 *      the pull margin), refused unless the floor still holds after it;
 *   4. back up the database when the target adds migrations;
 *   5. pull one image at a time, measuring the disk after each, and stop at the
 *      first failure or the first breach of the floor;
 *   6. switch: check out the commit if asked, then write MELETE_IMAGE_TAG.
 *
 * Then it starts the new images, restarts the service so it picks up the new
 * engine image, checks health, migrations and status, and only then removes
 * the stack's images that no tag names any more. Each run is appended to
 * deploy/.melete/history.jsonl. A failure after the switch exits 3 and prints
 * how to go back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withSetting } from '../../../../deploy/scripts/set-env.ts';
import {
  type Check,
  freeSpace,
  gatherStatus,
  judgeStatus,
  webPort,
} from '../../../../deploy/scripts/status.ts';
import {
  ENV_FILE_MODE,
  type FileReplacer,
  fileReplacer,
  replaceFile,
} from '../../../../deploy/scripts/tailscale-origin.ts';
import type { Context } from '../context.ts';
import { composeCommand, composeFiles, DEPLOY_FILE, type DeployConfig } from '../deploy-config.ts';
import { appendHistory, type HistoryEntry } from '../history.ts';
import {
  imagesInRepositories,
  inspectLocal,
  inspectRemote,
  type RemoteImage,
  registryArchitecture,
  repositoryOf,
} from '../images.ts';
import {
  type ComposeDocument,
  envImageTag,
  type Installation,
  readInstallation,
} from '../installation.ts';
import { interpolateDocument } from '../interpolate.ts';
import { LockRefusal, withLock } from '../lock.ts';
import {
  type BackupTarget,
  type CheckoutMode,
  type DeployFacts,
  type DeployPlan,
  type ImageTarget,
  judgeDeploy,
  migrationDelta,
} from '../plan.ts';
import { EXIT, type ExitCode, type Result, report } from '../schema.ts';
import { BackupRefusal, expandHome, parseSshTarget, takeBackup } from './backup.ts';
import { judgeCheck } from './check.ts';
import { contractAfter } from './set.ts';
import { diskFloors, statusComposeArgs } from './status.ts';

const MB = 1024 ** 2;
const JOURNAL = 'apps/melete/drizzle/meta/_journal.json';

export const DEPLOY_USAGE =
  'Usage: bun run melete deploy [--tag <tag>] [--dry-run] [--checkout | --allow-compose-mismatch] [--skip-backup | --backup-to ssh://host:/path] [--wait-timeout <seconds>]';

export class DeployRefusal extends Error {}

export type DeployOptions = {
  tag: string | null;
  dryRun: boolean;
  checkout: boolean;
  allowMismatch: boolean;
  skipBackup: boolean;
  backupTo: string | null;
  waitSeconds: number;
  /** Set by rollback: the branch to return to when it points at the target commit. */
  branch?: string | null;
  command?: 'deploy' | 'rollback';
  /** Set by rollback: recorded migrations the target ran beside before the deploy it undoes. */
  accepted?: number[];
};

export function deployOptions(args: readonly string[]): DeployOptions {
  const options: DeployOptions = {
    tag: null,
    dryRun: false,
    checkout: false,
    allowMismatch: false,
    skipBackup: false,
    backupTo: null,
    waitSeconds: 300,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('-'))
        throw new DeployRefusal(`${arg} needs a value. ${DEPLOY_USAGE}`);
      index += 1;
      return next;
    };
    if (arg === '--tag') {
      const tag = value();
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag) || tag === 'local')
        throw new DeployRefusal(`${tag} is not a published image tag.`);
      options.tag = tag;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--checkout') options.checkout = true;
    else if (arg === '--allow-compose-mismatch') options.allowMismatch = true;
    else if (arg === '--skip-backup') options.skipBackup = true;
    else if (arg === '--backup-to') {
      const target = value();
      parseSshTarget(target);
      options.backupTo = target;
    } else if (arg === '--wait-timeout') {
      const seconds = value();
      if (!/^[1-9]\d{1,4}$/.test(seconds))
        throw new DeployRefusal('--wait-timeout takes a number of seconds, 10 or more.');
      options.waitSeconds = Number(seconds);
    } else throw new DeployRefusal(`${arg} is not a deploy option. ${DEPLOY_USAGE}`);
  }
  if (options.checkout && options.allowMismatch)
    throw new DeployRefusal('Pass --checkout or --allow-compose-mismatch, not both.');
  if (options.skipBackup && options.backupTo)
    throw new DeployRefusal('Pass --skip-backup or --backup-to, not both.');
  return options;
}

/** A tag that names one build forever: a commit's short sha or a version. */
export const immutableTag = (tag: string) => /^([0-9a-f]{7,40}|v\d+\.\d+\.\d+\S*)$/.test(tag);

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim() ?? '';

function git(context: Context, args: string[], timeoutMs?: number) {
  return context.run(['git', '-C', context.root, ...args], timeoutMs);
}

/** The journal's entry times at a commit, or in the working tree when no commit is given. */
export function journalWhens(context: Context, revision: string | null): number[] | null {
  let text: string | null = null;
  if (revision === null) {
    const path = join(context.root, JOURNAL);
    text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  } else {
    const shown = git(context, ['show', `${revision}:${JOURNAL}`]);
    text = shown.code === 0 ? shown.stdout : null;
  }
  try {
    const entries = (JSON.parse(text ?? '') as { entries?: { when?: unknown }[] }).entries;
    if (!Array.isArray(entries)) return null;
    const whens = entries.map((entry) => Number(entry.when));
    return whens.every(Number.isFinite) ? whens : null;
  } catch {
    return null;
  }
}

export const journalCount = (context: Context, revision: string | null): number | null =>
  journalWhens(context, revision)?.length ?? null;

/** The migrations the database has recorded, by journal time; null when it did not answer. */
export function recordedMigrations(context: Context, compose: readonly string[]): number[] | null {
  const output = context.run([
    ...compose,
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "select created_at from drizzle.__drizzle_migrations order by created_at"',
  ]);
  if (output.code !== 0) return null;
  const lines = output.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.every((line) => /^\d+$/.test(line)) ? lines.map(Number) : null;
}

export function databaseBytes(context: Context, compose: readonly string[]): number | null {
  const output = context.run([
    ...compose,
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "select pg_database_size(current_database())"',
  ]);
  const text = output.stdout.trim();
  return output.code === 0 && /^\d+$/.test(text) ? Number(text) : null;
}

/** The images the active services run at a tag, read from the Compose files' text. */
export function targetImages(
  texts: readonly string[],
  env: Record<string, string>,
  config: DeployConfig,
  tag: string,
): { ref: string; service: string; published: boolean }[] {
  const values = { ...env, MELETE_IMAGE_TAG: tag };
  const services = new Map<string, { image?: string; profiles?: string[]; build?: unknown }>();
  for (const text of texts) {
    const document = interpolateDocument(parse(text) as ComposeDocument, values);
    for (const [name, definition] of Object.entries(document.services ?? {}))
      services.set(name, { ...services.get(name), ...(definition as object) });
  }
  const seen = new Set<string>();
  const images: { ref: string; service: string; published: boolean }[] = [];
  for (const [service, definition] of services) {
    const active =
      !definition.profiles?.length ||
      definition.profiles.some((profile) => (config.profiles as string[]).includes(profile));
    if (!active) continue;
    const ref = definition.image ?? `${config.project}-${service}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const builtHere = !definition.image || /^melete-[a-z]+:local$/.test(ref);
    images.push({ ref, service, published: !builtHere });
  }
  return images;
}

export type Gathered = {
  facts: DeployFacts;
  compose: string[];
  /** Release images by reference, as the registry describes them. */
  remotes: Map<string, RemoteImage>;
  dockerRoot: string | null;
};

/** Everything the plan judges, read without changing the installation. */
export function gatherDeploy(
  context: Context,
  installation: Installation,
  options: DeployOptions,
): Gathered {
  const { config } = installation;
  const env = installation.env ?? {};
  const run = context.run;
  const compose = composeCommand(context.deployDir, config);
  const registry = config.images.registry ?? '';
  const fromTag = envImageTag(env);
  const serviceRef = (tag: string) => `${registry}/melete-service:${tag}`;
  const info = run(['docker', 'info', '--format', '{{json .}}']);
  let engine: { Architecture?: string; DockerRootDir?: string } = {};
  try {
    engine = JSON.parse(info.stdout);
  } catch {}
  const architecture = registryArchitecture(engine.Architecture);
  const dockerRoot = engine.DockerRootDir ?? null;

  const fromLocal = inspectLocal(run, [serviceRef(fromTag)]).get(serviceRef(fromTag));
  const requested = options.tag ?? config.images.tag;
  let target: DeployFacts['target'];
  const remote = inspectRemote(run, serviceRef(requested), architecture);
  if ('error' in remote) target = { error: remote.error };
  else if (immutableTag(requested)) target = { tag: requested, revision: remote.revision };
  else if (remote.revision === null)
    target = {
      error: `${serviceRef(requested)} carries no revision label, so it cannot be pinned to a commit tag. Pass a commit or version tag with --tag.`,
    };
  else {
    // Pin a moving tag: a pull of `main` would move the tag the running stack names.
    const pinned = remote.revision.slice(0, 7);
    const exact = inspectRemote(run, serviceRef(pinned), architecture);
    target =
      'error' in exact || exact.digest !== remote.digest
        ? {
            error: `${requested} names commit ${pinned}, but ${serviceRef(pinned)} is ${'error' in exact ? 'not in the registry' : 'a different image'}; pass a commit or version tag with --tag.`,
          }
        : { tag: pinned, revision: remote.revision };
  }

  const headOutput = git(context, ['rev-parse', 'HEAD']);
  const head = headOutput.code === 0 ? headOutput.stdout.trim() : null;
  const revision = 'error' in target ? null : target.revision;
  const mode: CheckoutMode = options.checkout
    ? 'checkout'
    : options.allowMismatch
      ? 'allow-mismatch'
      : 'none';
  const has = (commit: string) => git(context, ['cat-file', '-e', `${commit}^{commit}`]).code === 0;
  let revisionAvailable = revision !== null && has(revision);
  if (revision !== null && !revisionAvailable && mode === 'checkout') {
    git(context, ['fetch', '--quiet', 'origin'], 300_000);
    revisionAvailable = has(revision);
  }
  const status = git(context, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path && !path.startsWith('deploy/config/'));

  // The images come from the Compose files the target commit carries, when it is here.
  const files = composeFiles(context.deployDir, config);
  const fromTarget =
    revision !== null && revisionAvailable && revision !== head && mode === 'checkout';
  const texts = files.map((file) => {
    if (fromTarget) {
      const shown = git(context, ['show', `${revision}:deploy/${file.split(/[\\/]/).at(-1)}`]);
      if (shown.code === 0) return shown.stdout;
    }
    return readFileSync(file, 'utf8');
  });
  const tag = 'error' in target ? fromTag : target.tag;
  const wanted = 'error' in target ? [] : targetImages(texts, env, config, tag);
  const local = inspectLocal(
    run,
    wanted.map((image) => image.ref),
  );
  const remotes = new Map<string, RemoteImage>();
  const images: ImageTarget[] = wanted.map((image) => {
    const release = image.published && image.ref.startsWith(`${registry}/melete-`);
    const here = local.get(image.ref) ?? null;
    let found: RemoteImage | null = null;
    let remoteError: string | null = null;
    if (release || (image.published && here === null)) {
      const described =
        image.ref === serviceRef(tag) && !('error' in remote) && remote.ref === image.ref
          ? remote
          : inspectRemote(run, image.ref, architecture);
      if ('error' in described) remoteError = described.error;
      else {
        found = described;
        remotes.set(image.ref, described);
      }
    }
    return { ...image, local: here, remote: found, remoteError };
  });
  const repositories = [
    ...new Set(images.filter((image) => image.published).map((image) => repositoryOf(image.ref))),
  ];
  const knownLayers = new Set(
    imagesInRepositories(run, repositories).flatMap((image) => image.layers),
  );

  const freeBytes = freeSpace(
    run,
    images.map((image) => ({ name: image.ref, present: image.local !== null })),
  );
  const backup: BackupTarget = options.skipBackup
    ? { kind: 'skip' }
    : options.backupTo
      ? { kind: 'ssh', location: options.backupTo }
      : (() => {
          const dir = expandHome(config.backup.dir);
          return {
            kind: 'dir' as const,
            location: dir,
            freeBytes: context.freeAt(dir),
            sameDiskAsDocker: dockerRoot ? context.sameDisk(dir, dockerRoot) : null,
          };
        })();

  return {
    facts: {
      config,
      from: { tag: fromTag, revision: fromLocal?.revision ?? null },
      requested,
      target,
      head,
      mode,
      dirty,
      revisionAvailable,
      images,
      knownLayers,
      freeBytes,
      migrations: {
        recorded: recordedMigrations(context, compose),
        current: journalWhens(context, head),
        target: revision !== null && revisionAvailable ? journalWhens(context, revision) : null,
        ...(options.accepted ? { accepted: options.accepted } : {}),
      },
      databaseBytes: databaseBytes(context, compose),
      backup,
    },
    compose,
    remotes,
    dockerRoot,
  };
}

/** Prints each result as it lands, unless the caller wants JSON at the end. */
class Steps {
  readonly results: Result[] = [];
  constructor(
    private readonly context: Context,
    private readonly json: boolean,
  ) {}
  add(...results: Result[]) {
    this.results.push(...results);
    if (this.json) return;
    for (const result of results)
      this.context.out(
        `  ${result.level.padEnd(4)}  ${result.id}  ${result.detail}\n${result.fix ? `        -> ${result.fix}\n` : ''}`,
      );
  }
  say(text: string) {
    if (!this.json) this.context.out(`${text}\n`);
  }
}

export type Outcome = 'current' | 'planned' | 'deployed' | 'refused' | 'failed';

export type DeployDependencies = {
  file: FileReplacer;
  /** Status, with its API answers from the given fetch. */
  status: (context: Context, installation: Installation) => Promise<Check[]>;
};

export const realStatus = async (context: Context, installation: Installation) =>
  judgeStatus(
    await gatherStatus(
      context.root,
      statusComposeArgs(context.deployDir, installation.config),
      context.run,
      async (url) => {
        try {
          const response = await context.fetch(url, { signal: AbortSignal.timeout(5_000) });
          return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      },
    ),
    diskFloors(installation.config),
  );

const DEFAULT_DEPENDENCIES: DeployDependencies = { file: fileReplacer, status: realStatus };

const HEALTH_POLLS = 24;
const POLL_MS = 5_000;

/**
 * Removes the stack's own images that no tag names any more. Only images whose
 * recorded registry digests all belong to the stack's repositories are touched;
 * an image another project pulled or built is never a candidate, and `docker
 * image rm` without --force leaves anything a container still uses.
 */
export function pruneStackImages(context: Context, repositories: readonly string[]): Result {
  const listed = context.run([
    'docker',
    'images',
    '--filter',
    'dangling=true',
    '--no-trunc',
    '--format',
    '{{.ID}}',
  ]);
  if (listed.code !== 0)
    return {
      id: 'prune.dangling',
      level: 'warn',
      detail: `docker images did not answer: ${lastLine(listed.stderr)}`,
    };
  const ids = [...new Set(listed.stdout.split(/\s+/).filter(Boolean))];
  const ours = [...inspectLocal(context.run, ids).entries()]
    .filter(
      ([, image]) =>
        image.repoDigests.length > 0 &&
        image.repoDigests.every((digest) => repositories.includes(repositoryOf(digest))),
    )
    .map(([id]) => id);
  if (ours.length === 0)
    return {
      id: 'prune.dangling',
      level: 'ok',
      detail: 'No replaced image of this stack to remove.',
    };
  const removed = ours.filter((id) => context.run(['docker', 'image', 'rm', id]).code === 0);
  return {
    id: 'prune.dangling',
    level: 'ok',
    detail: `Removed ${removed.length} replaced image(s) of this stack${removed.length < ours.length ? `; ${ours.length - removed.length} still in use stay` : ''}.`,
  };
}

export async function runDeploy(
  context: Context,
  args: readonly string[] | DeployOptions,
  json: boolean,
  dependencies: DeployDependencies = DEFAULT_DEPENDENCIES,
): Promise<ExitCode> {
  let options: DeployOptions;
  try {
    options = Array.isArray(args) ? deployOptions(args) : (args as DeployOptions);
  } catch (error) {
    if (!(error instanceof DeployRefusal || error instanceof BackupRefusal)) throw error;
    context.err(`${error.message}\n`);
    return EXIT.refused;
  }
  const command = options.command ?? 'deploy';
  const steps = new Steps(context, json);
  let outcome: Outcome = 'refused';
  let code: ExitCode = EXIT.refused;
  const finish = (extra: Record<string, unknown> = {}) => {
    const value = { ...report(command, steps.results), outcome, ...extra };
    if (json) context.out(`${JSON.stringify(value, null, 2)}\n`);
    else
      steps.say(
        {
          current: `${command}: the stack already runs this; nothing to do.`,
          planned: `${command}: planned; nothing was changed (--dry-run).`,
          deployed: `${command}: done.`,
          refused: `${command}: refused. Nothing was changed.`,
          failed: `${command}: did not finish. See above for what to do.`,
        }[outcome],
      );
    return code;
  };

  const act = async (): Promise<ExitCode> => {
    const installation = readInstallation(context.deployDir, context.machine.platform);
    if (installation.loaded.kind !== 'found') {
      steps.add({
        id: 'deploy.contract',
        level: 'fail',
        detail: `deploy needs ${DEPLOY_FILE} for its disk floors and images.`,
        fix: 'Run bun run melete init --adopt to write it from the running stack.',
      });
      return finish();
    }
    const checked = judgeCheck(installation);
    const failedChecks = checked.filter((result) => result.level === 'fail');
    steps.add(
      failedChecks.length === 0
        ? {
            id: 'deploy.check',
            level: 'ok',
            detail: `bun run melete check passes (${checked.length} rules).`,
          }
        : {
            id: 'deploy.check',
            level: 'fail',
            detail: `bun run melete check fails: ${failedChecks.map((result) => result.id).join(', ')}`,
            fix: 'Run bun run melete check for each rule and its fix.',
          },
    );
    if (failedChecks.length > 0) return finish();
    if (installation.config.images.registry === null) {
      steps.add({
        id: 'deploy.published_images',
        level: 'fail',
        detail: 'This installation builds its images here, and deploy only runs published images.',
        fix: 'Update it with bun run melete upgrade <version>, or set MELETE_IMAGE_TAG to a published tag.',
      });
      return finish();
    }

    const gathered = gatherDeploy(context, installation, options);
    const { facts, compose } = gathered;
    const plan: DeployPlan = judgeDeploy(facts);
    steps.add(...plan.results);
    const target = 'error' in facts.target ? null : facts.target;
    const branchBefore = currentBranch(context);
    const entry = (
      result: HistoryEntry['result'],
      detail: string,
      backup: string | null = null,
    ): HistoryEntry => ({
      at: context.now().toISOString(),
      command,
      from: facts.from,
      to: target ?? { tag: facts.requested, revision: null },
      checkout:
        facts.mode === 'checkout' &&
        target?.revision &&
        facts.head &&
        target.revision !== facts.head
          ? { from: facts.head, branch: branchBefore, to: target.revision }
          : null,
      migrations: {
        from: facts.migrations.recorded?.length ?? null,
        to: facts.migrations.target?.length ?? null,
        ran: migrationDelta(facts.migrations).known
          ? migrationDelta(facts.migrations).pending
          : null,
      },
      backup,
      result,
      detail,
    });
    const summary = {
      from: facts.from,
      to: target,
      pulls: plan.pulls,
      needed_mb: Math.ceil(plan.neededBytes / MB),
    };
    if (plan.refused) {
      if (!options.dryRun)
        appendHistory(
          context.deployDir,
          entry(
            'refused',
            plan.results
              .filter((r) => r.level === 'fail')
              .map((r) => r.id)
              .join(', '),
          ),
        );
      outcome = 'refused';
      code = EXIT.refused;
      return finish(summary);
    }
    if (plan.current || !target) {
      outcome = 'current';
      code = EXIT.ok;
      return finish(summary);
    }
    if (options.dryRun) {
      steps.say(
        plan.pulls.length === 0
          ? 'Nothing to pull.'
          : `Would pull, in this order: ${plan.pulls.map((pull) => pull.ref).join(', ')}`,
      );
      outcome = 'planned';
      code = EXIT.ok;
      return finish(summary);
    }

    const refuse = (detail: string) => {
      appendHistory(context.deployDir, entry('refused', detail));
      outcome = 'refused';
      code = EXIT.refused;
      return finish(summary);
    };

    // The status before anything changes: afterwards, only what got worse counts against the deploy.
    const before = await dependencies.status(context, installation);

    // 4. Backup.
    let backupLocation: string | null = null;
    if (plan.backupNeeded && facts.backup.kind !== 'skip') {
      const taken = await takeBackup(
        context,
        installation.config,
        facts.backup.kind === 'ssh'
          ? { kind: 'ssh', target: parseSshTarget(facts.backup.location) }
          : { kind: 'dir', dir: facts.backup.location },
        false,
      );
      steps.add(...taken.results);
      if (!taken.ok) return refuse(`the backup to ${taken.location} failed`);
      backupLocation = taken.location;
      steps.add({ id: 'backup.location', level: 'ok', detail: taken.location });
    }

    // 5. Pull, one image at a time.
    const floor = installation.config.disk.min_free_mb * MB;
    const pulled: string[] = [];
    for (const pull of plan.pulls) {
      steps.say(`Pulling ${pull.ref} ...`);
      const output = context.run(['docker', 'pull', '--quiet', pull.ref], 60 * 60_000);
      const id = `pull.${pull.service.replace(/[^a-z0-9]+/g, '_')}`;
      if (output.code !== 0) {
        steps.add({
          id,
          level: 'fail',
          detail: `docker pull ${pull.ref} failed: ${lastLine(output.stderr) || `exit ${output.code}`}`,
          fix:
            pulled.length > 0
              ? `Already pulled, unused until a deploy succeeds: ${pulled.join(', ')}.`
              : undefined,
        });
        return refuse(`pulling ${pull.ref} failed`);
      }
      pulled.push(pull.ref);
      const free = freeSpace(
        context.run,
        facts.images.map((image) => ({ name: image.ref, present: true })),
      );
      if (free === null || free < floor) {
        steps.add({
          id,
          level: 'fail',
          detail: `After ${pull.ref}, ${free === null ? 'the free space could not be measured' : `${Math.floor(free / MB)} MB is free, below the floor of ${installation.config.disk.min_free_mb} MB`}.`,
          fix: `Nothing runs on the pulled images (${pulled.join(', ')}); docker image rm them to get the space back.`,
        });
        return refuse('the disk floor was reached while pulling');
      }
      steps.add({ id, level: 'ok', detail: `${pull.ref}; ${Math.floor(free / MB)} MB free.` });
    }

    // 6. Switch.
    const envPath = join(context.deployDir, '.env');
    const contractPath = join(context.deployDir, DEPLOY_FILE);
    const moveCheckout =
      facts.mode === 'checkout' && target.revision !== null && target.revision !== facts.head;
    if (moveCheckout && target.revision) {
      const branch = options.branch ?? null;
      const branchHead = branch
        ? git(context, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
        : null;
      const onto =
        branch && branchHead?.code === 0 && branchHead.stdout.trim() === target.revision
          ? ['checkout', '--quiet', branch]
          : ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', target.revision];
      const moved = git(context, onto);
      if (moved.code !== 0) {
        steps.add({
          id: 'switch.checkout',
          level: 'fail',
          detail: `git checkout failed: ${lastLine(moved.stderr)}`,
        });
        return refuse('git checkout failed');
      }
      steps.add({
        id: 'switch.checkout',
        level: 'ok',
        detail: `The checkout is at ${target.revision.slice(0, 12)}.`,
      });
    }
    try {
      const envText = withSetting(readFileSync(envPath, 'utf8'), 'MELETE_IMAGE_TAG', target.tag);
      const contract = contractAfter(readFileSync(contractPath, 'utf8'), envText);
      await replaceFile(envPath, envText, dependencies.file, ENV_FILE_MODE);
      if (contract !== null) await replaceFile(contractPath, contract, dependencies.file, 0o644);
    } catch (error) {
      const back =
        moveCheckout && facts.head
          ? git(
              context,
              branchBefore
                ? ['checkout', '--quiet', branchBefore]
                : ['checkout', '--quiet', '--detach', facts.head],
            )
          : null;
      steps.add({
        id: 'switch.image_tag',
        level: 'fail',
        detail: `MELETE_IMAGE_TAG could not be written: ${error instanceof Error ? error.message : error}`,
        ...(back && back.code !== 0
          ? {
              fix: `The checkout stayed at ${target.revision?.slice(0, 12)}; run git checkout ${branchBefore ?? facts.head} to put it back.`,
            }
          : {}),
      });
      if (back && back.code !== 0) {
        appendHistory(context.deployDir, entry('failed', 'the image tag could not be written'));
        outcome = 'failed';
        code = EXIT.partial;
        return finish(summary);
      }
      return refuse('the image tag could not be written');
    }
    steps.add({
      id: 'switch.image_tag',
      level: 'ok',
      detail: `MELETE_IMAGE_TAG=${target.tag} (was ${facts.from.tag}).`,
    });
    // Computers made before published images name melete-sandbox:local; it follows the new image.
    const sandbox = facts.images.find((image) => /\/melete-sandbox:[^/]+$/.test(image.ref));
    if (
      installation.config.profiles.includes('sandbox') &&
      sandbox &&
      context.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'melete-sandbox:local'])
        .code === 0
    ) {
      const tagged = context.run(['docker', 'tag', sandbox.ref, 'melete-sandbox:local']);
      steps.add({
        id: 'switch.sandbox_local',
        level: tagged.code === 0 ? 'ok' : 'warn',
        detail:
          tagged.code === 0
            ? `melete-sandbox:local follows ${sandbox.ref}.`
            : `melete-sandbox:local still names the old computer image: ${lastLine(tagged.stderr)}`,
      });
    }

    const pending = migrationDelta(facts.migrations).pending.length;
    const failed = (id: string, detail: string) => {
      steps.add({
        id,
        level: 'fail',
        detail,
        fix: `See ${compose.join(' ')} logs --tail=100. To go back: bun run melete rollback${pending > 0 ? ` (it prints the database restore, from ${backupLocation ?? 'your backup'}, because migrations may have run)` : ''}.`,
      });
      appendHistory(context.deployDir, entry('failed', detail, backupLocation));
      outcome = 'failed';
      code = EXIT.partial;
      return finish(summary);
    };

    // 7 and 8. Start, then restart the service so it resolves the new engine image.
    const up = [
      ...compose,
      'up',
      '-d',
      '--no-build',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      String(options.waitSeconds),
    ];
    const upTimeout = (options.waitSeconds + 120) * 1000;
    steps.say('Starting the new images ...');
    const started = context.run(up, upTimeout);
    if (started.code !== 0)
      return failed('start.up', `The stack did not become healthy: ${lastLine(started.stderr)}`);
    steps.add({ id: 'start.up', level: 'ok', detail: 'Every service is up and healthy.' });
    const restarted = context.run([...compose, 'restart', 'melete'], upTimeout);
    const again = restarted.code === 0 ? context.run(up, upTimeout) : restarted;
    if (again.code !== 0)
      return failed(
        'start.restart',
        `The service did not come back healthy after its restart: ${lastLine(again.stderr)}`,
      );
    steps.add({
      id: 'start.restart',
      level: 'ok',
      detail: 'The service restarted on the new engine image.',
    });

    // 9. Verify.
    const healthUrl = `http://127.0.0.1:${webPort(installation.env)}/api/health`;
    let health: Record<string, unknown> | null = null;
    for (let poll = 0; poll < HEALTH_POLLS; poll += 1) {
      if (poll > 0) await context.sleep(POLL_MS);
      try {
        const response = await context.fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
        health = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
      } catch {
        health = null;
      }
      if (health?.status === 'ok') break;
    }
    if (health?.status !== 'ok')
      return failed(
        'verify.health',
        `${healthUrl} reports ${health === null ? 'nothing' : `${String(health.status)} (database ${String(health.database ?? 'unknown')})`}.`,
      );
    steps.add({
      id: 'verify.health',
      level: 'ok',
      detail: `${healthUrl}: ok, database ${String(health.database ?? 'ok')}.`,
    });
    const expected = facts.migrations.target;
    if (expected !== null) {
      let missing: number[] = expected;
      for (let poll = 0; poll < HEALTH_POLLS; poll += 1) {
        if (poll > 0) await context.sleep(POLL_MS);
        const recorded = new Set(recordedMigrations(context, compose) ?? []);
        missing = expected.filter((when) => !recorded.has(when));
        if (missing.length === 0) break;
      }
      if (missing.length > 0)
        return failed(
          'verify.migrations',
          `The database has not recorded ${missing.length} of the ${expected.length} migrations in ${target.tag}'s journal.`,
        );
      steps.add({
        id: 'verify.migrations',
        level: 'ok',
        detail: `Every one of the ${expected.length} migrations in the journal is recorded.`,
      });
    }
    const after = await dependencies.status(context, installation);
    const failing = (checks: Check[]) =>
      new Set(checks.filter((check) => check.level === 'fail').map((check) => check.name));
    const was = failing(before);
    const worse = after.filter((check) => check.level === 'fail' && !was.has(check.name));
    if (worse.length > 0)
      return failed(
        'verify.status',
        `Status got worse: ${worse.map((check) => `${check.name}: ${check.detail}`).join('; ')}`,
      );
    const still = after.filter((check) => check.level === 'fail');
    steps.add(
      still.length === 0
        ? { id: 'verify.status', level: 'ok', detail: 'bun run melete status reports ready.' }
        : {
            id: 'verify.status',
            level: 'warn',
            detail: `No check got worse; these failed before the deploy too: ${still.map((check) => check.name).join(', ')}.`,
            fix: 'Run bun run melete status for each one.',
          },
    );

    // 10. Only now, with the service restarted, remove what the update replaced.
    const repositories = [
      ...new Set(
        facts.images.filter((image) => image.published).map((image) => repositoryOf(image.ref)),
      ),
    ];
    steps.add(pruneStackImages(context, repositories));
    const free = freeSpace(
      context.run,
      facts.images.map((image) => ({ name: image.ref, present: true })),
    );
    if (free !== null)
      steps.add({
        id: 'disk.free_mb',
        level: free >= floor ? 'ok' : 'warn',
        detail: `${Math.floor(free / MB)} MB free after the update; the floor is ${installation.config.disk.min_free_mb} MB.`,
      });

    appendHistory(context.deployDir, entry('deployed', '', backupLocation));
    outcome = 'deployed';
    code = EXIT.ok;
    return finish(summary);
  };

  if (options.dryRun) return await act();
  try {
    return await withLock(context.deployDir, command, act);
  } catch (error) {
    if (error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}

function currentBranch(context: Context): string | null {
  const output = git(context, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return output.code === 0 ? output.stdout.trim() || null : null;
}
