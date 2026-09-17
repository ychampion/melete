/**
 * Upgrade a running Compose installation to a tagged release. The procedure is
 * docs/UPGRADING.md; this file is that document as one ordered plan:
 *
 *   preflight -> stop the writers -> back up -> switch the tree -> rebuild and
 *   tag the images -> start -> wait for health and for every migration
 *
 * and it always ends by printing the exact rollback for this run. Nothing here
 * removes a volume. The plan, the preflight judgement and the rollback text are
 * pure functions, and every command goes through an injected runner, so the
 * tests exercise the procedure without Docker.
 *
 *   bun run deploy/scripts/upgrade.ts <tag> [--dry-run] [--browser]
 *     [--backup-dir /absolute/parent] [--wait-timeout seconds]
 */
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type CommandOutput,
  HOST_DOCKER_COMMANDS,
  type HostDockerOutputs,
  judgeHostDocker,
} from '../../apps/melete/src/runtime/docker-engine.ts';

export const USAGE =
  'Usage: bun run deploy/scripts/upgrade.ts <tag> [--dry-run] [--browser] [--backup-dir /absolute/parent] [--wait-timeout seconds]';

const GIB = 1024 ** 3;
/** The README's floor for the filesystem that holds Docker's data. */
const MIN_DOCKER_FREE_BYTES = 8 * GIB;
const MIN_BACKUP_FREE_BYTES = 1 * GIB;
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const IMAGES = ['melete-service', 'melete-web', 'melete-runtime'] as const;
const OPERATOR_CONFIGURATION = 'deploy/config/';

export type UpgradeOptions = {
  tag: string;
  /** The directory this run creates; its parent must exist. */
  backupDir: string;
  repositoryRoot: string;
  /** Include deploy/docker-compose.browser.yml in every Compose command. */
  browser: boolean;
  waitTimeoutSeconds: number;
};

export type UpgradeContext = UpgradeOptions & {
  project: string;
  fromCommit: string;
  /** Null when the installation runs from a detached commit. */
  fromBranch: string | null;
  /** `git describe` of the running tree; also the tag its images are kept under. */
  fromVersion: string;
};

export type RunOptions = { stdoutFile?: string; stdinFile?: string; timeoutMs?: number };
export type CommandRunner = (
  command: readonly string[],
  options?: RunOptions,
) => Promise<CommandOutput>;

export type PlanStep = RunOptions & {
  phase: 'backup' | 'switch' | 'build' | 'start' | 'verify';
  title: string;
  command: readonly string[];
  /** Repeat the command until the new journal's migrations are all recorded. */
  until?: 'journal-recorded';
};

export function parseArguments(
  argv: readonly string[],
  now: Date,
  home: string,
  repositoryRoot: string,
): UpgradeOptions & { dryRun: boolean } {
  const fail = (): never => {
    throw new Error(USAGE);
  };
  let tag: string | undefined;
  let parent = join(home, 'melete-backups');
  let dryRun = false;
  let browser = false;
  let waitTimeoutSeconds = 300;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--browser') browser = true;
    else if (argument === '--backup-dir') {
      index += 1;
      const value = argv[index];
      if (!value || !isAbsolute(value)) fail();
      else parent = value;
    } else if (argument === '--wait-timeout') {
      index += 1;
      const value = argv[index] ?? '';
      if (!/^[1-9]\d{1,4}$/.test(value)) fail();
      waitTimeoutSeconds = Number(value);
    } else if (TAG.test(argument) && tag === undefined) tag = argument;
    else fail();
  }
  if (tag === undefined) return fail();
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
  return {
    tag,
    dryRun,
    browser,
    waitTimeoutSeconds,
    repositoryRoot,
    backupDir: join(parent, `upgrade-${tag}-${stamp}`).replaceAll('\\', '/'),
  };
}

const composeArguments = (browser: boolean) => [
  'docker',
  'compose',
  '-f',
  'deploy/docker-compose.yml',
  ...(browser ? ['-f', 'deploy/docker-compose.browser.yml'] : []),
];

const inPostgres = (script: string) => ['exec', '-T', 'postgres', 'sh', '-c', script];
const MIGRATION_COUNT =
  'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "select count(*) from drizzle.__drizzle_migrations"';

/** Every command of the upgrade, in the order it runs, relative to the repository root. */
export function upgradePlan(context: UpgradeContext): PlanStep[] {
  const compose = composeArguments(context.browser);
  const backup = (name: string) => `${context.backupDir}/${name}`;
  const writers = ['melete', 'runtime', 'web', ...(context.browser ? ['browser'] : [])];
  const archives = ['database.dump', 'data.tar', 'work.tar', 'restrictions.tar', 'deploy.env'];
  return [
    {
      phase: 'backup',
      title: 'Create a private backup directory',
      command: ['mkdir', '-m', '700', context.backupDir],
    },
    {
      phase: 'backup',
      title: 'Stop everything that writes, so the database and the volumes agree',
      command: [...compose, 'stop', ...writers],
    },
    {
      phase: 'backup',
      title: 'Dump the database in custom format',
      command: [
        ...compose,
        ...inPostgres('exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom'),
      ],
      stdoutFile: backup('database.dump'),
    },
    {
      phase: 'backup',
      title: 'Check that the dump is a readable archive',
      command: [...compose, 'exec', '-T', 'postgres', 'pg_restore', '--list'],
      stdinFile: backup('database.dump'),
      stdoutFile: backup('database.contents'),
    },
    {
      phase: 'backup',
      title: 'Keep the configuration, including the keys that open the sealed credentials',
      command: ['cp', '-p', 'deploy/.env', backup('deploy.env')],
    },
    {
      phase: 'backup',
      title: 'Keep the operator configuration directory',
      command: ['cp', '-a', 'deploy/config', backup('config')],
    },
    {
      phase: 'backup',
      title: 'Archive spaces, artifacts and the current restriction journal',
      command: [...compose, 'cp', '-a', 'melete:/data', '-'],
      stdoutFile: backup('data.tar'),
    },
    {
      phase: 'backup',
      title: 'Archive the job workspaces',
      command: [...compose, 'cp', '-a', 'melete:/work', '-'],
      stdoutFile: backup('work.tar'),
    },
    {
      phase: 'backup',
      title: 'Keep the restriction journal on its own, apart from the database snapshot',
      command: [...compose, 'cp', '-a', 'melete:/data/restrictions', '-'],
      stdoutFile: backup('restrictions.tar'),
    },
    {
      phase: 'backup',
      title: 'Record checksums of the backup',
      command: ['sha256sum', ...archives.map(backup)],
      stdoutFile: backup('SHA256SUMS'),
    },
    {
      phase: 'backup',
      title: 'Make the backup private',
      command: ['chmod', '600', ...[...archives, 'database.contents', 'SHA256SUMS'].map(backup)],
    },
    ...IMAGES.map(
      (image): PlanStep => ({
        phase: 'backup',
        title: `Keep the running ${image} image for a rollback without a rebuild`,
        command: ['docker', 'tag', `${image}:local`, `${image}:${context.fromVersion}`],
      }),
    ),
    {
      phase: 'switch',
      title: `Check out ${context.tag}`,
      command: [
        'git',
        '-c',
        'advice.detachedHead=false',
        'checkout',
        '--detach',
        `refs/tags/${context.tag}`,
      ],
    },
    {
      phase: 'switch',
      title: "Install the release's locked dependencies for the host scripts",
      command: ['bun', 'install', '--frozen-lockfile'],
    },
    {
      phase: 'switch',
      title: "Run the release's own Compose boundary check",
      command: ['bun', 'run', 'compose:check'],
    },
    {
      phase: 'build',
      title: 'Build the release images as :local',
      command: [...compose, 'build'],
      timeoutMs: 60 * 60_000,
    },
    ...IMAGES.map(
      (image): PlanStep => ({
        phase: 'build',
        title: `Tag ${image} with the release version`,
        command: ['docker', 'tag', `${image}:local`, `${image}:${context.tag}`],
      }),
    ),
    {
      phase: 'start',
      title: 'Start the release and wait for every health check',
      command: [
        ...compose,
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        String(context.waitTimeoutSeconds),
      ],
      timeoutMs: (context.waitTimeoutSeconds + 120) * 1000,
    },
    {
      phase: 'verify',
      title: "Wait until every migration in the release's journal is recorded",
      command: [...compose, ...inPostgres(MIGRATION_COUNT)],
      until: 'journal-recorded',
    },
  ];
}

/** The commands that return this installation to where it started, as shell lines. */
export function rollbackSteps(context: UpgradeContext): string[] {
  const compose = renderCommand({ command: composeArguments(context.browser) });
  const back = context.fromBranch
    ? `git checkout ${context.fromBranch}`
    : `git checkout --detach ${context.fromCommit}`;
  return [
    `cd ${quote(context.repositoryRoot)}`,
    `# Stop the release. Never add --volumes: the volumes are the installation.`,
    `${compose} down`,
    `# Return the tree, its dependencies and the preserved images to ${context.fromVersion}.`,
    back,
    'bun install --frozen-lockfile',
    ...IMAGES.map((image) => `docker tag ${image}:${context.fromVersion} ${image}:local`),
    `cp -p ${quote(`${context.backupDir}/deploy.env`)} deploy/.env`,
    `# Replace only the database volume. Keep ${context.project}_restrictions and every other`,
    `# volume as they are now: the newer removal journal is replayed at startup, so nothing`,
    `# forgotten since the backup comes back. Do not unpack restrictions.tar over it.`,
    `docker volume rm ${context.project}_pgdata`,
    `${compose} up -d --wait postgres`,
    `${compose} exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' < ${quote(`${context.backupDir}/database.dump`)}`,
    `# Start only after the restore has finished, then check health and any waiting approval.`,
    `${compose} up -d --wait --wait-timeout ${context.waitTimeoutSeconds}`,
    `${compose} ps`,
  ];
}

export type PreflightFacts = {
  tag: string;
  /** `git status --porcelain` of the repository. */
  status: string;
  tagCommit: string | null;
  headCommit: string;
  /** The target tag descends from the running commit. */
  targetContainsHead: boolean;
  /** deploy/config differs between the running commit and the target. */
  configChangedInTarget: boolean;
  envFile: boolean;
  docker: HostDockerOutputs;
  postgresRunning: boolean;
  serviceContainer: boolean;
  dockerRootFreeBytes: number | null;
  backupFreeBytes: number | null;
  /** Database plus /data plus /work; null when the stopped stack could not be measured. */
  backupEstimateBytes: number | null;
};

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/** One line per reason not to start; an empty list means the upgrade may begin. */
export function judgePreflight(facts: PreflightFacts): string[] {
  const problems: string[] = [];
  const changed = facts.status
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim());
  const foreign = changed.filter((path) => !path.startsWith(OPERATOR_CONFIGURATION));
  if (foreign.length > 0)
    problems.push(
      `The working tree is not clean (${foreign.join(', ')}). Commit, stash or remove these first; only ${OPERATOR_CONFIGURATION} may carry local edits.`,
    );
  if (changed.length > foreign.length && facts.configChangedInTarget)
    problems.push(
      `${OPERATOR_CONFIGURATION} has local edits and ${facts.tag} also changes it. Merge the release's version by hand, then run the upgrade again.`,
    );
  if (!facts.tagCommit)
    problems.push(
      `The tag ${facts.tag} does not exist in this clone. Run \`git fetch --tags origin\` and check the name.`,
    );
  else if (facts.tagCommit === facts.headCommit)
    problems.push(`This installation is already at ${facts.tag}; there is nothing to upgrade.`);
  else if (!facts.targetContainsHead)
    problems.push(
      `${facts.tag} does not contain the running commit ${facts.headCommit.slice(0, 12)}. Moving to an older or unrelated release would run old code against a newer database; restore a backup instead.`,
    );
  if (!facts.envFile)
    problems.push(
      'deploy/.env is missing. The upgrade keeps an installation; it does not create one.',
    );
  problems.push(...judgeHostDocker(facts.docker));
  if (!facts.postgresRunning)
    problems.push(
      'The postgres service is not running, so the database cannot be dumped. Start the stack and wait for it to be healthy.',
    );
  if (!facts.serviceContainer)
    problems.push(
      'The melete service has no container, so its volumes cannot be archived. Start the stack first.',
    );
  if (facts.dockerRootFreeBytes === null)
    problems.push("The free space on Docker's data filesystem could not be measured.");
  else if (facts.dockerRootFreeBytes < MIN_DOCKER_FREE_BYTES)
    problems.push(
      `Docker's data filesystem has ${gib(facts.dockerRootFreeBytes)} free; rebuilding the images needs at least ${gib(MIN_DOCKER_FREE_BYTES)}.`,
    );
  // The archives are not compressed, so they need the measured size and a margin.
  const needed = Math.max(
    MIN_BACKUP_FREE_BYTES,
    Math.ceil((facts.backupEstimateBytes ?? 0) * 1.2) + 256 * 1024 ** 2,
  );
  if (facts.backupFreeBytes === null)
    problems.push(
      'The free space for the backup directory could not be measured; its parent must exist.',
    );
  else if (facts.backupFreeBytes < needed)
    problems.push(
      `The backup directory's filesystem has ${gib(facts.backupFreeBytes)} free; this backup needs about ${gib(needed)}.`,
    );
  return problems;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./^{}-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A shell line an operator could paste, including the redirections the runner performs. */
export function renderCommand(step: { command: readonly string[] } & RunOptions): string {
  return [
    step.command.map(quote).join(' '),
    ...(step.stdinFile ? [`< ${quote(step.stdinFile)}`] : []),
    ...(step.stdoutFile ? [`> ${quote(step.stdoutFile)}`] : []),
  ].join(' ');
}

export type UpgradeDependencies = {
  run: CommandRunner;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Entries in the checked-out tree's migration journal; read after the switch. */
  journalEntries: () => Promise<number>;
  /** deploy/.env as key-value pairs; the values are only used to name the project and redact. */
  environment: () => Promise<Record<string, string> | null>;
};

export type UpgradeResult = {
  status: 'planned' | 'refused' | 'upgraded' | 'failed-before-switch' | 'failed-after-switch';
  context: UpgradeContext;
};

function availableBytes(df: CommandOutput): number | null {
  const fields = df.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const kilobytes = Number(fields[3]);
  return df.code === 0 && Number.isFinite(kilobytes) && fields.length >= 6
    ? kilobytes * 1024
    : null;
}

/** Read-only questions about the repository, the host and the running stack. */
export async function gatherPreflight(
  options: UpgradeOptions,
  { run, environment }: Pick<UpgradeDependencies, 'run' | 'environment'>,
): Promise<{ facts: PreflightFacts; context: UpgradeContext; secrets: string[] }> {
  const compose = composeArguments(options.browser);
  const text = async (command: readonly string[]) => {
    const result = await run(command);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const target = `refs/tags/${options.tag}`;
  const status = (await run(['git', 'status', '--porcelain'])).stdout;
  const tagCommit = await text(['git', 'rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  const headCommit = (await text(['git', 'rev-parse', 'HEAD'])) ?? '';
  const fromBranch = await text(['git', 'symbolic-ref', '-q', '--short', 'HEAD']);
  const described = await text(['git', 'describe', '--tags', '--always']);
  const targetContainsHead =
    tagCommit !== null &&
    (await run(['git', 'merge-base', '--is-ancestor', 'HEAD', target])).code === 0;
  const configChangedInTarget =
    tagCommit !== null &&
    (await run(['git', 'diff', '--quiet', 'HEAD', target, '--', OPERATOR_CONFIGURATION])).code !==
      0;
  const values = await environment();
  const docker: HostDockerOutputs = {
    engine: await run(HOST_DOCKER_COMMANDS.engine),
    compose: await run(HOST_DOCKER_COMMANDS.compose),
  };
  const dockerRoot = await text(['docker', 'info', '--format', '{{.DockerRootDir}}']);
  const dockerRootFreeBytes = dockerRoot
    ? availableBytes(await run(['df', '-Pk', dockerRoot]))
    : null;
  const backupFreeBytes = availableBytes(await run(['df', '-Pk', dirname(options.backupDir)]));
  const postgresRunning = Boolean(await text([...compose, 'ps', '-q', 'postgres']));
  const serviceContainer = Boolean(await text([...compose, 'ps', '-a', '-q', 'melete']));
  // Sizes are an estimate for the disk check; an unmeasurable stack is caught above.
  const volumes = await text([...compose, 'exec', '-T', 'melete', 'du', '-sk', '/data', '/work']);
  const database = await text([
    ...compose,
    ...inPostgres(
      'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "select pg_database_size(current_database())"',
    ),
  ]);
  const volumeBytes = (volumes ?? '')
    .split('\n')
    .reduce((total, line) => total + (Number(line.trim().split(/\s+/)[0]) || 0) * 1024, 0);
  const backupEstimateBytes =
    volumes !== null && database !== null && /^\d+$/.test(database)
      ? volumeBytes + Number(database)
      : null;
  const fromVersion = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(described ?? '')
    ? (described as string)
    : `g${headCommit.slice(0, 12)}`;
  return {
    facts: {
      tag: options.tag,
      status,
      tagCommit,
      headCommit,
      targetContainsHead,
      configChangedInTarget,
      envFile: values !== null,
      docker,
      postgresRunning,
      serviceContainer,
      dockerRootFreeBytes,
      backupFreeBytes,
      backupEstimateBytes,
    },
    context: {
      ...options,
      project: /^[a-z0-9][a-z0-9_-]*$/.test(values?.COMPOSE_PROJECT_NAME ?? '')
        ? (values?.COMPOSE_PROJECT_NAME as string)
        : 'melete',
      fromCommit: headCommit,
      fromBranch,
      fromVersion,
    },
    secrets: Object.entries(values ?? {})
      .filter(([key, value]) => value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|_URL$/.test(key))
      .map(([, value]) => value),
  };
}

export function renderPlan(context: UpgradeContext, plan: PlanStep[]): string[] {
  return [
    `Upgrade ${context.fromVersion} -> ${context.tag} (Compose project ${context.project})`,
    `Backup directory: ${context.backupDir}`,
    '',
    ...plan.flatMap((step, index) => [
      `${String(index + 1).padStart(2)}. [${step.phase}] ${step.title}`,
      `    ${renderCommand(step)}`,
    ]),
    '',
    `To return to ${context.fromVersion} after this upgrade:`,
    ...rollbackSteps(context).map((line) => `    ${line}`),
  ];
}

const MIGRATION_POLLS = 60;
const MIGRATION_POLL_MS = 2000;

export async function runUpgrade(
  options: UpgradeOptions & { dryRun: boolean },
  dependencies: UpgradeDependencies,
): Promise<UpgradeResult> {
  const { run, log, sleep, journalEntries } = dependencies;
  const { dryRun, ...upgrade } = options;
  const { facts, context, secrets } = await gatherPreflight(upgrade, dependencies);
  const redact = (message: string) =>
    secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), message);
  const plan = upgradePlan(context);
  const problems = judgePreflight(facts);
  if (problems.length > 0) {
    log(`Preflight found ${problems.length} problem(s); nothing was changed:`);
    for (const problem of problems) log(`  - ${problem}`);
  } else log('Preflight passed: clean tree, known tag, supported Docker, enough disk.');
  if (dryRun) {
    log('Dry run: nothing below was executed.');
    for (const line of renderPlan(context, plan)) log(line);
    return { status: problems.length > 0 ? 'refused' : 'planned', context };
  }
  if (problems.length > 0) return { status: 'refused', context };

  let switched = false;
  let stopped = false;
  let reached = 0;
  try {
    for (const [index, step] of plan.entries()) {
      reached = index;
      log(`[${index + 1}/${plan.length}] ${step.title}`);
      log(`    ${renderCommand(step)}`);
      if (step.until === 'journal-recorded') {
        const expected = await journalEntries();
        let recorded = Number.NaN;
        for (let poll = 0; poll < MIGRATION_POLLS && recorded !== expected; poll += 1) {
          if (poll > 0) await sleep(MIGRATION_POLL_MS);
          const result = await run(step.command, step);
          recorded = result.code === 0 ? Number(result.stdout.trim()) : Number.NaN;
        }
        if (recorded !== expected)
          throw new Error(
            `${Number.isNaN(recorded) ? 0 : recorded} of ${expected} migrations are recorded; the release did not finish migrating.`,
          );
        log(`    ${recorded} of ${expected} migrations recorded.`);
        continue;
      }
      const result = await run(step.command, step);
      if (step.command.includes('stop')) stopped = true;
      if (result.code !== 0)
        throw new Error(
          `${renderCommand(step)} exited ${result.code}: ${result.stderr.trim().slice(-2000)}`,
        );
      // Only a checkout that succeeded has changed the tree.
      if (step.phase === 'switch') switched = true;
    }
  } catch (error) {
    log(`Upgrade failed: ${redact(error instanceof Error ? error.message : String(error))}`);
    if (!switched) {
      // The tree, the images' :local tags and the database are untouched.
      if (stopped) {
        const restart = await run(
          [
            ...composeArguments(context.browser),
            'up',
            '-d',
            '--wait',
            '--wait-timeout',
            String(context.waitTimeoutSeconds),
          ],
          { timeoutMs: (context.waitTimeoutSeconds + 120) * 1000 },
        );
        log(
          restart.code === 0
            ? 'The previous release was started again; nothing was upgraded.'
            : `The previous release did not start again: ${redact(restart.stderr.trim().slice(-2000))}`,
        );
      }
      log(`Any partial backup is in ${context.backupDir}.`);
      return { status: 'failed-before-switch', context };
    }
    // Migrations may already have run, so the old code must not be started
    // against this database. The operator decides: fix and continue, or roll back.
    log(`The tree is at ${context.tag}. The stack was left as it is.`);
    log('Commands that were not completed:');
    for (const step of plan.slice(reached)) log(`    ${renderCommand(step)}`);
    log(`To return to ${context.fromVersion}:`);
    for (const line of rollbackSteps(context)) log(`    ${line}`);
    return { status: 'failed-after-switch', context };
  }
  log(`Upgraded to ${context.tag}. The backup is in ${context.backupDir}; keep it until the`);
  log('release has run to your satisfaction, and keep restrictions.tar independently of it.');
  log(`To return to ${context.fromVersion}:`);
  for (const line of rollbackSteps(context)) log(`    ${line}`);
  return { status: 'upgraded', context };
}

/** Binary-safe: a dump or an archive goes straight to its file, never through a string. */
export const spawnRunner =
  (cwd: string): CommandRunner =>
  async (command, options = {}) => {
    let file: number | undefined;
    try {
      // Exclusive and private: a backup never overwrites an earlier one.
      if (options.stdoutFile) file = openSync(options.stdoutFile, 'wx', 0o600);
      const child = Bun.spawn([...command], {
        cwd,
        stdin: options.stdinFile ? Bun.file(options.stdinFile) : 'ignore',
        stdout: file ?? 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          file === undefined ? new Response(child.stdout as ReadableStream).text() : '',
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : 'failed' };
    } finally {
      if (file !== undefined) closeSync(file);
    }
  };

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, '../..');
  let options: ReturnType<typeof parseArguments>;
  try {
    options = parseArguments(process.argv.slice(2), new Date(), homedir(), repositoryRoot);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : USAGE}\n`);
    process.exit(2);
  }
  const result = await runUpgrade(options, {
    run: spawnRunner(repositoryRoot),
    log: (line) => process.stdout.write(`${line}\n`),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    journalEntries: async () =>
      (
        JSON.parse(
          await readFile(join(repositoryRoot, 'apps/melete/drizzle/meta/_journal.json'), 'utf8'),
        ) as { entries: unknown[] }
      ).entries.length,
    environment: async () => {
      const source = await readFile(join(repositoryRoot, 'deploy/.env'), 'utf8').catch(() => null);
      if (source === null) return null;
      return Object.fromEntries(
        source.split('\n').flatMap((line) => {
          const match = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line.trim());
          return match?.[1] ? [[match[1], (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')]] : [];
        }),
      );
    },
  });
  process.exit(result.status === 'planned' || result.status === 'upgraded' ? 0 : 1);
}
