/**
 * Reading a space off disk: walk the knowledge directory, parse every record,
 * report the ones that do not validate, and build the index the space is
 * searched through.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { type ParsedRecord, parseRecord } from './frontmatter.ts';
import { type IndexedRecord, SpaceIndex } from './fts.ts';
import { type SpacePaths, spacePaths } from './layout.ts';

export type LoadedRecord = ParsedRecord & {
  /** Relative to the space root, always with forward slashes. */
  path: string;
  absolutePath: string;
};

export type LoadFailure = {
  path: string;
  issues: string[];
};

export type SpaceContents = {
  records: LoadedRecord[];
  failures: LoadFailure[];
};

const listMarkdown = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // A record is a file in this space, never a pointer out of it. A symlink
    // committed into a shared space would otherwise read another space into
    // this one, which is the isolation the index handle exists to guarantee.
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
};

/** Read every record in a space. A bad file is reported, never thrown. */
export function loadSpace(paths: SpacePaths): SpaceContents {
  const records: LoadedRecord[] = [];
  const failures: LoadFailure[] = [];

  for (const absolutePath of listMarkdown(paths.knowledge)) {
    const rel = relative(paths.root, absolutePath).split('\\').join('/');
    const parsed = parseRecord(readFileSync(absolutePath, 'utf8'));
    if (!parsed.ok) {
      failures.push({ path: rel, issues: parsed.issues });
      continue;
    }
    records.push({ ...parsed.record, path: rel, absolutePath });
  }

  return { records, failures };
}

export const toIndexed = (record: LoadedRecord): IndexedRecord => ({
  id: record.frontmatter.id,
  path: record.path,
  title: record.frontmatter.title,
  tags: record.frontmatter.tags,
  body: record.body,
  status: record.frontmatter.status,
  type: record.frontmatter.type,
});

/**
 * Build the index for a space from the files on disk. Derived and disposable:
 * deleting the index file costs nothing but the time to run this again.
 */
export function buildIndex(paths: SpacePaths): { index: SpaceIndex; contents: SpaceContents } {
  const index = SpaceIndex.open(paths);
  return { index, contents: rebuild(paths, index) };
}

/**
 * Rebuild an index a caller already holds open. The job that is running keeps
 * its handle; what it can see changes underneath it.
 */
export function rebuild(paths: SpacePaths, index: SpaceIndex): SpaceContents {
  const contents = loadSpace(paths);
  index.rebuild(contents.records.map(toIndexed));
  index.setFingerprint(sourceFingerprint(paths));
  return contents;
}

/**
 * A cheap description of the files an index is derived from: every record's
 * path, its size, and when it was last written. Reading it costs one stat per
 * file rather than a parse, which is what makes it affordable on the way into
 * a search.
 *
 * It can be fooled by a write that lands inside the filesystem's timestamp
 * resolution and leaves the file exactly as long as it was. That is not how a
 * person edits prose, and every write through the mediator sets the fingerprint
 * directly, so this is a safety net for hand edits rather than a guarantee
 * against an adversary with write access to the space.
 */
export function sourceFingerprint(paths: SpacePaths): string {
  const hash = createHash('sha256');
  for (const file of listMarkdown(paths.knowledge)) {
    const stats = statSync(file);
    const relativePath = relative(paths.root, file).split('\\').join('/');
    hash.update(`${relativePath}|${stats.size}|${stats.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

/** Say that this index matches the files as they are now. */
export const markIndexFresh = (paths: SpacePaths, index: SpaceIndex): void =>
  index.setFingerprint(sourceFingerprint(paths));

/**
 * Open a space's index, bringing it in step with the files first.
 *
 * The Markdown is the system of record and a person is meant to open it in
 * whatever editor they like, so the index has to notice that they did. Without
 * this, a record edited or deleted by hand keeps coming back from a search
 * until something else happens to rebuild.
 */
export function openIndex(paths: SpacePaths): { index: SpaceIndex; rebuilt: boolean } {
  const index = SpaceIndex.open(paths);
  if (index.fingerprint() === sourceFingerprint(paths)) return { index, rebuilt: false };
  rebuild(paths, index);
  return { index, rebuilt: true };
}

/**
 * What a space may be called. A space name becomes a directory name and the
 * value of every record's `space` field, so it has to be something that means
 * the same thing in a path, in frontmatter, and in a lint message.
 */
export const SPACE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Create the directories a new space needs. This is the filesystem half only;
 * `initSpace` in space.ts adds the generated files and the git repository, and
 * is what a caller outside this package should use.
 *
 * The name is checked here because this is where a space first becomes a
 * directory. A caller that takes the name from a person, which the API will,
 * would otherwise be one string away from creating a space somewhere else
 * entirely.
 */
export function ensureSpaceDirs(spacesRoot: string, space: string): SpacePaths {
  if (!SPACE_NAME.test(space)) {
    throw new Error(
      `"${space}" is not a usable space name: lowercase letters, digits, dot, dash and underscore, starting with a letter or digit`,
    );
  }
  const paths = spacePaths(spacesRoot, space);
  for (const dir of [paths.root, paths.knowledge, paths.raw, paths.artifacts, paths.skills]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export const knownIds = (contents: SpaceContents): Set<string> =>
  new Set(contents.records.map((r) => r.frontmatter.id));

export const byId = (
  contents: SpaceContents,
): Map<string, LoadedRecord & { frontmatter: KnowledgeFrontmatter }> =>
  new Map(contents.records.map((r) => [r.frontmatter.id, r]));
