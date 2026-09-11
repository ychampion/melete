/**
 * `bun run knowledge:lint <space>` — check one space and say what is wrong with
 * it. Exits non-zero when anything is an error, so it can gate a commit.
 *
 * The argument is the path to a space directory, or a bare space name, which is
 * looked for under MELETE_SPACES_DIR.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { formatFinding } from '../findings.ts';
import { isGitRepo } from '../git.ts';
import { spacePaths } from '../layout.ts';
import { lintSpace } from '../lint.ts';

const USAGE = 'usage: bun run knowledge:lint <space directory | space name>';

export type CliResult = { code: number; output: string };

/** The whole command as a function, so a test can run it without a subprocess. */
export async function runLint(
  argv: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): Promise<CliResult> {
  const target = argv[0];
  if (!target || target === '--help' || target === '-h') {
    return { code: target ? 0 : 2, output: `${USAGE}\n` };
  }

  const spacesRoot = environment.MELETE_SPACES_DIR ?? resolve('spaces');
  const direct = isAbsolute(target) || target.includes('/') || target.includes('\\');
  const root = direct ? resolve(target) : resolve(spacesRoot, target);

  if (!existsSync(root)) {
    return { code: 2, output: `no space at ${root}\n${USAGE}\n` };
  }

  const paths = spacePaths(dirname(root), basename(root));
  const report = await lintSpace(paths, {
    spacesRoot: dirname(root),
    useGit: isGitRepo(root),
  });

  const lines = report.findings.map(formatFinding);
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.length - errors;
  lines.push(
    `${report.space}: ${report.records} record${report.records === 1 ? '' : 's'}, ` +
      `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`,
  );

  return { code: errors > 0 ? 1 : 0, output: `${lines.join('\n')}\n` };
}

if (import.meta.main) {
  const result = await runLint(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exit(result.code);
}
