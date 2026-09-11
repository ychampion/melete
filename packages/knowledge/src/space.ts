/**
 * A space is one git repository. Creating it, committing a record into it,
 * undoing a commit, and reading a record's history are the whole of the storage
 * layer: there is no audit table and no undo table, because the commit is both.
 *
 * Every write goes through here, so every write is attributable. A commit made
 * for an agent carries a `Melete-Proposed-By:` trailer, and one a person let
 * through carries `Melete-Approved-By:` as well.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  defaultGitignore,
  defaultLog,
  defaultSchema,
  type IndexEntry,
  logLine,
  renderIndex,
} from './catalog.ts';
import {
  APPROVED_BY_TRAILER,
  commitMessage,
  git,
  isGitRepo,
  PROPOSED_BY_TRAILER,
  runGit,
} from './git.ts';
import { resolveInSpace, type SpacePaths, spacePaths } from './layout.ts';
import { ensureSpaceDirs, loadSpace } from './store.ts';

export type CommitAttribution = {
  /** Who asked for the write: an agent name, or `user` when a person typed it. */
  proposedBy: string;
  /** Who let it through: a person, or the policy that auto-applied it. */
  approvedBy?: string;
  /** The one-line commit subject. A plain sentence, not a code comment. */
  subject?: string;
  /** Injected so a test can pin the log timestamps. */
  now?: () => Date;
};

export type SpaceCommit = {
  sha: string;
  subject: string;
  /** Paths relative to the space root that this commit changed. */
  changed: string[];
  /** False when the write left the tree byte-identical and nothing was committed. */
  committed: boolean;
};

export type HistoryEntry = {
  sha: string;
  /** ISO-8601, from the author date. */
  at: string;
  subject: string;
  proposedBy: string | null;
  approvedBy: string | null;
};

const FIELD = String.fromCharCode(0x1f);
const RECORD = String.fromCharCode(0x1e);

const HISTORY_FORMAT = [
  '%H',
  '%aI',
  '%s',
  `%(trailers:key=${PROPOSED_BY_TRAILER},valueonly,separator=%x2c)`,
  `%(trailers:key=${APPROVED_BY_TRAILER},valueonly,separator=%x2c)`,
].join(FIELD);

const CATALOG_FILES = ['index.md', 'log.md'];

const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Fail loudly rather than writing outside the space a caller was given. */
function insideSpace(paths: SpacePaths, relativePath: string): string {
  const absolute = resolveInSpace(paths, relativePath);
  if (!absolute) {
    throw new Error(`path "${relativePath}" resolves outside the space root ${paths.root}`);
  }
  return absolute;
}

/** Regenerate `index.md` from the files on disk. Returns the bytes written. */
export function refreshCatalog(paths: SpacePaths): string {
  const contents = loadSpace(paths);
  const entries: IndexEntry[] = contents.records.map((record) => ({
    id: record.frontmatter.id,
    path: record.path,
    title: record.frontmatter.title,
    type: record.frontmatter.type,
    status: record.frontmatter.status,
    tags: record.frontmatter.tags,
  }));
  const rendered = renderIndex(entries);
  writeFileSync(paths.index, rendered, 'utf8');
  return rendered;
}

/**
 * Create a space: the directory layout, the two generated files, the schema a
 * person then owns, and a git repository with one commit in it. Safe to call
 * on a space that already exists.
 */
export async function initSpace(spacesRoot: string, space: string): Promise<SpacePaths> {
  const paths = ensureSpaceDirs(spacesRoot, space);
  mkdirSync(paths.proposed, { recursive: true });
  mkdirSync(dirname(paths.indexDb), { recursive: true });

  const seeds: Array<[string, () => string]> = [
    [paths.schema, () => defaultSchema(space)],
    [paths.log, defaultLog],
    [`${paths.root}/.gitignore`, defaultGitignore],
  ];
  for (const [file, make] of seeds) {
    if (!existsSync(file)) writeFileSync(file, make(), 'utf8');
  }
  if (!existsSync(paths.index)) refreshCatalog(paths);

  if (!isGitRepo(paths.root)) {
    await git(paths.root, ['init', '--quiet']);
    await git(paths.root, ['add', '--', '.']);
    await git(paths.root, [
      'commit',
      '--quiet',
      '-m',
      commitMessage(`Create the ${space} space`, { [PROPOSED_BY_TRAILER]: 'melete' }),
    ]);
  }
  return paths;
}

/** Open a space that already exists. Refuses one that was never initialised. */
export function openSpace(spacesRoot: string, space: string): SpacePaths {
  const paths = spacePaths(spacesRoot, space);
  if (!existsSync(paths.root)) throw new Error(`no space at ${paths.root}`);
  if (!isGitRepo(paths.root)) {
    throw new Error(`${paths.root} is not a git repository; run initSpace first`);
  }
  return paths;
}

/** What is staged for the next commit, measured against the last one. */
async function stagedPaths(paths: SpacePaths): Promise<string[]> {
  const staged = await runGit(paths.root, ['diff', '--cached', '--name-only']);
  return staged.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function commitStaged(
  paths: SpacePaths,
  subject: string,
  attribution: CommitAttribution,
): Promise<SpaceCommit> {
  const changed = await stagedPaths(paths);
  if (changed.length === 0) {
    return { sha: await headSha(paths), subject, changed: [], committed: false };
  }

  await git(paths.root, [
    'commit',
    '--quiet',
    '-m',
    commitMessage(subject, {
      [PROPOSED_BY_TRAILER]: attribution.proposedBy,
      [APPROVED_BY_TRAILER]: attribution.approvedBy,
    }),
  ]);
  const sha = (await git(paths.root, ['rev-parse', 'HEAD'])).trim();
  return { sha, subject, changed, committed: true };
}

async function stageCatalog(paths: SpacePaths, note: string, at: Date): Promise<void> {
  refreshCatalog(paths);
  appendFileSync(paths.log, logLine(at, note), 'utf8');
  await git(paths.root, ['add', '--', ...CATALOG_FILES]);
}

/**
 * Write a record and commit it, with the catalog and the chronicle in the same
 * commit so the space is never half-updated. An identical write commits
 * nothing and says so rather than making an empty commit.
 */
export async function commitRecord(
  paths: SpacePaths,
  relativePath: string,
  content: string,
  attribution: CommitAttribution,
): Promise<SpaceCommit> {
  const absolute = insideSpace(paths, relativePath);
  const posix = toPosix(relativePath);
  const subject = attribution.subject ?? `Write ${posix}`;

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  await git(paths.root, ['add', '--', posix]);

  // A write that leaves the record exactly as the last commit had it is not an
  // event. Stopping here keeps the chronicle free of lines saying nothing
  // happened, and makes no empty commit.
  if ((await stagedPaths(paths)).length === 0) {
    return { sha: await headSha(paths), subject, changed: [], committed: false };
  }

  const now = attribution.now ?? (() => new Date());
  await stageCatalog(paths, `${subject} (proposed by ${attribution.proposedBy})`, now());
  return commitStaged(paths, subject, attribution);
}

/**
 * Remove a record and commit the removal. This is deletion, not retraction: the
 * text is gone from the working tree, and the caller drops the index row in the
 * same operation so it is gone from the only derived copy too.
 */
export async function commitRemoval(
  paths: SpacePaths,
  relativePath: string,
  attribution: CommitAttribution,
): Promise<SpaceCommit> {
  const absolute = insideSpace(paths, relativePath);
  const posix = toPosix(relativePath);
  const subject = attribution.subject ?? `Delete ${posix}`;

  if (existsSync(absolute)) rmSync(absolute);
  await git(paths.root, ['add', '--all', '--', posix]);
  if ((await stagedPaths(paths)).length === 0) {
    return { sha: await headSha(paths), subject, changed: [], committed: false };
  }

  const now = attribution.now ?? (() => new Date());
  await stageCatalog(paths, `${subject} (requested by ${attribution.proposedBy})`, now());
  return commitStaged(paths, subject, attribution);
}

/**
 * Undo one commit by making another. History is not rewritten: what happened
 * stays visible, and the reversal is itself attributable.
 */
export async function revert(
  paths: SpacePaths,
  sha: string,
  attribution: CommitAttribution = { proposedBy: 'user' },
): Promise<SpaceCommit> {
  const run = await runGit(paths.root, ['revert', '--no-edit', '--no-commit', sha]);
  if (run.code !== 0) {
    await runGit(paths.root, ['revert', '--quit']);
    await runGit(paths.root, ['reset', '--hard', 'HEAD']);
    throw new Error(
      `reverting ${sha} would not apply cleanly, so nothing was changed: ${
        run.stderr.trim() || run.stdout.trim()
      }`,
    );
  }
  const now = attribution.now ?? (() => new Date());
  const subject = attribution.subject ?? `Revert ${sha.slice(0, 12)}`;
  await stageCatalog(paths, `${subject} (requested by ${attribution.proposedBy})`, now());
  return commitStaged(paths, subject, attribution);
}

/** Every commit that touched one record, newest first, with who asked for it. */
export async function history(paths: SpacePaths, relativePath: string): Promise<HistoryEntry[]> {
  const posix = toPosix(relativePath);
  const run = await runGit(paths.root, [
    'log',
    '--follow',
    `--format=${HISTORY_FORMAT}${RECORD}`,
    '--',
    posix,
  ]);
  if (run.code !== 0) return [];

  return run.stdout
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\r?\n/, '').trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha = '', at = '', subject = '', proposedBy = '', approvedBy = ''] =
        chunk.split(FIELD);
      return {
        sha,
        at,
        subject,
        proposedBy: proposedBy.trim() || null,
        approvedBy: approvedBy.trim() || null,
      };
    });
}

/** The current commit. */
export const headSha = async (paths: SpacePaths): Promise<string> =>
  (await git(paths.root, ['rev-parse', 'HEAD'])).trim();

/**
 * A file as it was at the last commit, or null when the commit does not have
 * it. The lint uses this to see which status a record is moving from.
 */
export async function readAtHead(paths: SpacePaths, relativePath: string): Promise<string | null> {
  const run = await runGit(paths.root, ['show', `HEAD:${toPosix(relativePath)}`]);
  return run.code === 0 ? run.stdout : null;
}

/** The file as it is now, or the empty string when it does not exist yet. */
export function readWorkingTree(paths: SpacePaths, relativePath: string): string {
  const absolute = resolveInSpace(paths, relativePath);
  if (!absolute || !existsSync(absolute)) return '';
  return readFileSync(absolute, 'utf8');
}
