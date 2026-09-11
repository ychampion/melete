/**
 * Reading a space off disk: walk the knowledge directory, parse every record,
 * report the ones that do not validate, and build the index the space is
 * searched through.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
    if (statSync(full).isDirectory()) {
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
  const contents = loadSpace(paths);
  const index = SpaceIndex.open(paths);
  index.rebuild(contents.records.map(toIndexed));
  return { index, contents };
}

/**
 * Rebuild an index a caller already holds open. The job that is running keeps
 * its handle; what it can see changes underneath it.
 */
export function rebuild(paths: SpacePaths, index: SpaceIndex): SpaceContents {
  const contents = loadSpace(paths);
  index.rebuild(contents.records.map(toIndexed));
  return contents;
}

/**
 * Create the directories a new space needs. This is the filesystem half only;
 * `initSpace` in space.ts adds the generated files and the git repository, and
 * is what a caller outside this package should use.
 */
export function ensureSpaceDirs(spacesRoot: string, space: string): SpacePaths {
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
