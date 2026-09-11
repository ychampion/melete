/**
 * The directory layout of one space. One space is one git repository and one
 * full-text index; nothing reads across spaces, and the paths here are the only
 * way anything inside the package names a file.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SPACE_LAYOUT } from '@melete/contracts';

export type SpacePaths = {
  space: string;
  /**
   * The directory the spaces live in. Carried on the handle because the lint
   * needs it to check that a record's `space` equals its directory, and a
   * caller that has to reconstruct it by trimming the space name off the root
   * gets it wrong the first time a space is named something awkward.
   */
  spacesRoot: string;
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
    spacesRoot,
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
 * Where a path really leads, following symlinks. For a path that does not exist
 * yet, the nearest parent that does, which is where it would be created.
 */
function realLocation(target: string): string | null {
  let candidate = target;
  for (;;) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/**
 * Resolve a record path inside a space, refusing anything that escapes it.
 * Isolation is structural: a path that leaves the space root is an error here,
 * not a permission check somewhere later.
 *
 * Comparing the text of two paths is not enough, because a symlink is a path
 * that leads somewhere its own name does not admit to. A shared space is a git
 * repository and git stores symlinks, so one can arrive in a space without
 * anybody here putting it there. The second check asks the filesystem where the
 * path actually goes.
 */
export function resolveInSpace(paths: SpacePaths, relativePath: string): string | null {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) return null;
  const absolute = resolve(paths.root, relativePath);
  const back = relative(paths.root, absolute);
  if (back === '' || back.startsWith('..') || back.startsWith(`..${sep}`)) return null;

  // The root itself may be reached through a symlink, which is ordinary on
  // macOS where the temporary directory is one, so both sides are resolved.
  if (existsSync(paths.root)) {
    const realRoot = realLocation(paths.root);
    const realTarget = realLocation(absolute);
    if (!realRoot || !realTarget) return null;
    const fromRoot = relative(realRoot, realTarget);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  }
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
