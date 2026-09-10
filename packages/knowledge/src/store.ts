/**
 * Reading a space off disk: walk the knowledge directory, parse every record,
 * report the ones that do not validate, and build the index the space is
 * searched through.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { type ParsedRecord, parseRecord } from './frontmatter.ts';
import { type IndexedRecord, SpaceIndex } from './fts.ts';
import { resolveInSpace, type SpacePaths, spacePaths } from './layout.ts';

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
});

/**
 * Build the index for a space from the files on disk. Derived and disposable:
 * deleting the index file costs nothing but the time to run this again.
 */
export function buildIndex(paths: SpacePaths): { index: SpaceIndex; contents: SpaceContents } {
  const contents = loadSpace(paths);
  const index = SpaceIndex.open(paths.indexDb);
  index.rebuild(contents.records.map(toIndexed));
  return { index, contents };
}

/**
 * Hard deletion: remove the file and drop the row in the same operation, so the
 * text is gone from the only derived copy as well as from the working tree.
 * Retraction is a different thing and keeps both.
 */
export function hardDelete(paths: SpacePaths, index: SpaceIndex, record: LoadedRecord): boolean {
  const target = resolveInSpace(paths, record.path);
  if (!target) return false;
  index.remove(record.frontmatter.id);
  if (existsSync(target)) rmSync(target);
  return true;
}

/** Create the directories a new space needs. */
export function initSpace(spacesRoot: string, space: string): SpacePaths {
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
