/**
 * `melete rollback [--dry-run] [--wait-timeout <seconds>]`: back to the images
 * the stack ran before the last deploy, as deploy/.melete/history.jsonl
 * records them.
 *
 * When that deploy ran no migrations, the previous images are deployed again
 * with the same steps and refusals as `deploy`, and the checkout returns with
 * them when the deploy moved it. When it did, the older release cannot run on
 * the newer database: rollback prints the restore from the backup taken before
 * the deploy, and exits 3 without changing anything, because replacing the
 * database is the operator's call.
 */
import type { Context } from '../context.ts';
import { composeCommand } from '../deploy-config.ts';
import { lastSwitched, readHistory } from '../history.ts';
import {
  envImageTag,
  readInstallation,
  shellOverrideMessage,
  shellOverrides,
} from '../installation.ts';
import { migrationDelta, restoreSteps } from '../plan.ts';
import { EXIT, type ExitCode } from '../schema.ts';
import { writersOf } from './backup.ts';
import {
  type DeployDependencies,
  immutableTag,
  journalWhens,
  recordedMigrations,
  runDeploy,
} from './deploy.ts';
import { verifyBackup } from './restore.ts';

export const ROLLBACK_USAGE =
  'Usage: bun run melete rollback [--dry-run] [--wait-timeout <seconds>]';

export async function runRollback(
  context: Context,
  args: readonly string[],
  json: boolean,
  dependencies?: DeployDependencies,
): Promise<ExitCode> {
  let dryRun = false;
  let waitSeconds = 300;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--wait-timeout' && /^[1-9]\d{1,4}$/.test(args[index + 1] ?? '')) {
      waitSeconds = Number(args[index + 1]);
      index += 1;
    } else {
      context.err(`${arg} is not a rollback option. ${ROLLBACK_USAGE}\n`);
      return EXIT.refused;
    }
  }
  const last = lastSwitched(readHistory(context.deployDir));
  if (last === null) {
    context.err(
      'No deploy that changed the stack is recorded in deploy/.melete/history.jsonl, so there is no earlier release to go back to.\n',
    );
    return EXIT.refused;
  }
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const env = installation.env ?? {};
  const overridden = shellOverrides(context.environment, env);
  if (overridden.length > 0) {
    context.err(`${shellOverrideMessage(overridden)}\n`);
    return EXIT.refused;
  }
  // Only the run history knows about can be undone: if something else moved the stack
  // since, going back to that run's starting point would skip what came after.
  const running = envImageTag(env);
  if (running !== last.to.tag) {
    context.err(
      `deploy/.env runs ${running}, but the last recorded run switched the stack to ${last.to.tag}; something changed it since, outside melete deploy. Nothing was changed. Deploy the release you want with bun run melete deploy --tag <tag>.\n`,
    );
    return EXIT.refused;
  }
  const previous = last.from;
  const tag = immutableTag(previous.tag) ? previous.tag : (previous.revision?.slice(0, 7) ?? null);
  if (tag === null) {
    context.err(
      `The last deploy started from ${previous.tag}, and the commit it named was not recorded, so it cannot be found again. Deploy the release you want with bun run melete deploy --tag <tag>.\n`,
    );
    return EXIT.refused;
  }

  const compose = composeCommand(context.deployDir, installation.config);
  // Migrations recorded before the run were there while the previous release ran, so it
  // runs beside them again. Everything recorded since, by that run or anything after it,
  // that the previous release lacks, means going back is a restore.
  const recorded = recordedMigrations(context, compose);
  const previousJournal = previous.revision ? journalWhens(context, previous.revision) : null;
  const before = last.migrations.before;
  const delta = migrationDelta({
    recorded,
    current: last.to.revision
      ? journalWhens(context, last.to.revision)
      : journalWhens(context, null),
    target: previousJournal,
    ...(before !== null ? { accepted: before } : {}),
  });
  const since =
    before !== null && recorded !== null && previousJournal !== null
      ? recorded.filter((when) => !before.includes(when) && !previousJournal.includes(when))
      : [];
  const unknown = new Set([...delta.behind, ...delta.skipped, ...since]);
  if (!delta.known || unknown.size > 0) {
    const steps = restoreSteps({
      root: context.root,
      project: installation.config.project,
      compose,
      writers: writersOf(installation.config),
      backupDir: last.backup?.startsWith('ssh://') ? null : last.backup,
      previous: { tag, revision: last.checkout ? last.checkout.from : null },
      freshHost: false,
      journalArchive: null,
    });
    const reason = !delta.known
      ? `The database's migrations could not be compared with ${tag}'s`
      : `The database records ${unknown.size} migration(s), run since ${tag} was running, that ${tag} does not know`;
    let where: string;
    if (!last.backup)
      where = `No backup was recorded with that run; use your newest backup taken before ${last.at}.`;
    else if (last.backup.startsWith('ssh://'))
      where = `The backup taken before that run is ${last.backup}; copy it back to this machine first.`;
    else {
      const problems = await verifyBackup(context, last.backup);
      where =
        problems.length === 0
          ? `The backup taken before that run is ${last.backup}, and it matches its SHA256SUMS.`
          : `The backup recorded with that run, ${last.backup}, cannot be used: ${problems.join('; ')}. Use your newest sound backup taken before ${last.at}.`;
    }
    const text = `${reason}, so going back means restoring the database. Nothing was changed.\n${where}\nRestore, from the installation's checkout:\n${steps.map((line) => `    ${line}`).join('\n')}\n`;
    if (json)
      context.out(
        `${JSON.stringify({ command: 'rollback', ok: false, outcome: 'restore_needed', to: { tag, revision: previous.revision }, backup: last.backup, detail: where, steps }, null, 2)}\n`,
      );
    else context.out(text);
    return dryRun ? EXIT.ok : EXIT.partial;
  }

  return await runDeploy(
    context,
    {
      tag,
      dryRun,
      checkout: last.checkout !== null,
      allowMismatch: last.checkout === null,
      skipBackup: false,
      backupTo: null,
      waitSeconds,
      branch: last.checkout?.branch ?? null,
      command: 'rollback',
      ...(before !== null ? { accepted: before } : {}),
    },
    json,
    dependencies,
  );
}
