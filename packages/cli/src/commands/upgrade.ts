/**
 * `melete upgrade <version> [--dry-run] [--backup-dir <path>] [--wait-timeout <seconds>]`:
 * the upgrade for an installation that builds its images here. It runs
 * deploy/scripts/upgrade.ts, the procedure in docs/UPGRADING.md, with the
 * overlay files the deploy contract names, under the deployment lock, and
 * records the run in deploy/.melete/history.jsonl. An installation that runs
 * published images updates with `melete deploy` instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '../../../../deploy/scripts/provider-settings.ts';
import type { Context } from '../context.ts';
import { appendHistory } from '../history.ts';
import { envImageTag, readInstallation } from '../installation.ts';
import { LockRefusal, withLock } from '../lock.ts';
import { EXIT, type ExitCode } from '../schema.ts';
import { journalCount } from './deploy.ts';

export const UPGRADE_USAGE =
  'Usage: bun run melete upgrade <version> [--dry-run] [--backup-dir /absolute/parent] [--wait-timeout seconds]';

export async function runUpgrade(context: Context, args: readonly string[]): Promise<ExitCode> {
  const version = args.find((arg) => !arg.startsWith('-') && /^v\d+\.\d+\.\d+/.test(arg));
  if (
    !version ||
    args.some((arg) => arg === '--repository' || arg === '--browser' || arg === '--tailscale')
  ) {
    context.err(
      `${UPGRADE_USAGE}\nThe overlay files and the repository come from deploy/melete.deploy.json and --deploy-dir.\n`,
    );
    return EXIT.refused;
  }
  const installation = readInstallation(context.deployDir, context.machine.platform);
  const { config } = installation;
  if (config.images.registry !== null) {
    context.err(
      'This installation runs published images; update it with bun run melete deploy --tag <tag>.\n',
    );
    return EXIT.refused;
  }
  const dryRun = args.includes('--dry-run');
  const command = [
    process.execPath,
    join(context.deployDir, 'scripts', 'upgrade.ts'),
    ...args,
    '--repository',
    context.root,
    ...(config.overlays.includes('browser') ? ['--browser'] : []),
    ...(config.overlays.includes('tailscale') ? ['--tailscale'] : []),
  ];
  const run = async () => {
    const before = { tag: envImageTag(installation.env ?? {}), revision: head(context) };
    const migrations = journalCount(context, null);
    const code = await context.attach(command);
    if (!dryRun) {
      let tag = before.tag;
      try {
        tag = envImageTag(parseEnvFile(readFileSync(join(context.deployDir, '.env'), 'utf8')));
      } catch {}
      appendHistory(context.deployDir, {
        at: context.now().toISOString(),
        command: 'upgrade',
        from: before,
        to: { tag: tag === before.tag ? version : tag, revision: head(context) },
        checkout: null,
        migrations: { from: migrations, to: journalCount(context, null) },
        backup: null,
        result: code === 0 ? 'deployed' : 'failed',
        detail: code === 0 ? `upgraded to ${version}` : `upgrade.ts exited ${code}`,
      });
    }
    // upgrade.ts says which step stopped it and prints the rollback; its exit 1 covers both.
    return code === 0 ? EXIT.ok : code === 2 ? EXIT.refused : EXIT.failed;
  };
  if (dryRun) return await run();
  try {
    return await withLock(context.deployDir, 'upgrade', run);
  } catch (error) {
    if (error instanceof LockRefusal) {
      context.err(`${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}

function head(context: Context): string | null {
  const output = context.run(['git', '-C', context.root, 'rev-parse', 'HEAD']);
  return output.code === 0 ? output.stdout.trim() : null;
}
