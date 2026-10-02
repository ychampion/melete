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
import { lastDeployed, readHistory } from '../history.ts';
import { readInstallation } from '../installation.ts';
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
  const last = lastDeployed(readHistory(context.deployDir));
  if (last === null) {
    context.err(
      'No deploy is recorded in deploy/.melete/history.jsonl, so there is no earlier release to go back to.\n',
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

  const installation = readInstallation(context.deployDir, context.machine.platform);
  const compose = composeCommand(context.deployDir, installation.config);
  // Against the release being left, which is the one whose migrations may have run.
  const delta = migrationDelta({
    recorded: recordedMigrations(context, compose),
    current: last.to.revision
      ? journalWhens(context, last.to.revision)
      : journalWhens(context, null),
    target: previous.revision ? journalWhens(context, previous.revision) : null,
  });
  if (!delta.known || delta.behind.length > 0 || delta.skipped.length > 0) {
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
      : `The database records ${delta.behind.length + delta.skipped.length} migration(s) that ${tag} does not know`;
    const where = last.backup
      ? `The backup taken before the deploy is ${last.backup}${last.backup.startsWith('ssh://') ? '; copy it back to this machine first' : ''}.`
      : 'No backup was recorded with that deploy; use your newest backup from before it.';
    const text = `${reason}, so going back means restoring the database. Nothing was changed.\n${where}\nRestore, from the installation's checkout:\n${steps.map((line) => `    ${line}`).join('\n')}\n`;
    if (json)
      context.out(
        `${JSON.stringify({ command: 'rollback', ok: false, outcome: 'restore_needed', to: { tag, revision: previous.revision }, backup: last.backup, steps }, null, 2)}\n`,
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
    },
    json,
    dependencies,
  );
}
