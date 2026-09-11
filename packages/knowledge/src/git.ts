/**
 * Plain git, run as a subprocess. No library: a space is an ordinary git
 * repository a person can open in any tool, and the commit is the audit record
 * and the undo, so the fewer layers between us and it the better.
 *
 * Every invocation passes its own identity and its own configuration. A space
 * repository must behave the same on an operator's laptop as in a container,
 * which means it can never inherit whatever the host's global git config says
 * about line endings, signing, or the default branch name.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The author and committer of every commit Melete makes inside a space. */
export const SPACE_IDENTITY = { name: 'melete', email: 'melete@localhost' } as const;

/** Names the agent that asked for the write. Present on every mediated commit. */
export const PROPOSED_BY_TRAILER = 'Melete-Proposed-By';
/** Names the person or policy that let it through. */
export const APPROVED_BY_TRAILER = 'Melete-Approved-By';

export type GitRun = {
  code: number;
  stdout: string;
  stderr: string;
};

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly run: GitRun,
  ) {
    super(`git ${args.join(' ')} failed (${run.code}): ${run.stderr.trim() || run.stdout.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * Configuration forced on every call:
 * - the Melete identity, so a container with no git config still commits;
 * - `core.autocrlf=false`, so a record's bytes survive a round trip on Windows;
 * - no signing, so a commit never blocks on a passphrase prompt;
 * - `main` as the initial branch, so the name does not depend on git's version.
 */
const FORCED_CONFIG = [
  '-c',
  `user.name=${SPACE_IDENTITY.name}`,
  '-c',
  `user.email=${SPACE_IDENTITY.email}`,
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'advice.detachedHead=false',
];

const CLEAN_ENV = {
  // Reading the host's global or system config would let a machine-wide
  // setting change what lands in a person's memory. Both are turned off.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  // A space repository has no remote, so nothing should ever ask for a password.
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
};

/** Run git and hand back the result. Never throws for a non-zero exit. */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  const proc = Bun.spawn(['git', ...FORCED_CONFIG, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...CLEAN_ENV },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run git and throw when it fails, for the paths where failure is a bug. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const run = await runGit(cwd, args);
  if (run.code !== 0) throw new GitError(args, run);
  return run.stdout;
}

/** A directory is a space repository when it has its own `.git`. */
export const isGitRepo = (dir: string): boolean => existsSync(join(dir, '.git'));

/** Does this repository have any commits yet? A fresh `git init` has none. */
export async function hasCommits(dir: string): Promise<boolean> {
  const run = await runGit(dir, ['rev-parse', '--verify', 'HEAD']);
  return run.code === 0;
}

export const shortSha = (sha: string): string => sha.slice(0, 12);

/**
 * Build a commit message: one plain sentence, a blank line, then the trailers
 * that say who asked and who allowed it.
 */
export function commitMessage(
  subject: string,
  trailers: Readonly<Record<string, string | undefined>>,
): string {
  const lines = Object.entries(trailers)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}: ${value.replace(/\r?\n/g, ' ')}`);
  const oneLine = subject.replace(/\r?\n/g, ' ').trim() || 'Update a knowledge record';
  return lines.length === 0 ? `${oneLine}\n` : `${oneLine}\n\n${lines.join('\n')}\n`;
}
