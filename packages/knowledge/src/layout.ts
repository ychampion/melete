/**
 * The directory layout of one space. One space is one git repository and one
 * full-text index; nothing reads across spaces, and the paths here are the only
 * way anything inside the package names a file.
 */
import { join, relative, resolve, sep } from 'node:path';
import { SPACE_LAYOUT } from '@melete/contracts';

export type SpacePaths = {
  space: string;
  root: string;
  schema: string;
  index: string;
  log: string;
  knowledge: string;
  raw: string;
  artifacts: string;
  skills: string;
  indexDb: string;
  proposed: string;
};

/** Resolve every path a space uses from the spaces root and the space name. */
export function spacePaths(spacesRoot: string, space: string): SpacePaths {
  const root = join(spacesRoot, space);
  return {
    space,
    root,
    schema: join(root, SPACE_LAYOUT.schema),
    index: join(root, SPACE_LAYOUT.index),
    log: join(root, SPACE_LAYOUT.log),
    knowledge: join(root, SPACE_LAYOUT.knowledge),
    raw: join(root, SPACE_LAYOUT.raw),
    artifacts: join(root, SPACE_LAYOUT.artifacts),
    skills: join(root, SPACE_LAYOUT.skills),
    indexDb: join(root, ...SPACE_LAYOUT.index_db.split('/')),
    proposed: join(root, SPACE_LAYOUT.proposed),
  };
}

/**
 * Resolve a record path inside a space, refusing anything that escapes it.
 * Isolation is structural: a path that leaves the space root is an error here,
 * not a permission check somewhere later.
 */
export function resolveInSpace(paths: SpacePaths, relativePath: string): string | null {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) return null;
  const absolute = resolve(paths.root, relativePath);
  const back = relative(paths.root, absolute);
  if (back === '' || back.startsWith('..') || back.startsWith(`..${sep}`)) return null;
  return absolute;
}

/** A slug that is safe as a filename and stays readable in a directory listing. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

export const recordPath = (title: string): string =>
  `${SPACE_LAYOUT.knowledge}/${slugify(title)}.md`;
