/**
 * Which space a request is allowed to touch.
 *
 * Deployments use the owner's Postgres catalog IDs. The filesystem resolver is
 * retained for standalone tools and fixtures that have no database catalog.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ID_PREFIXES, prefixedId, spaceAudience } from '@melete/contracts';
import { initSpace, isGitRepo, type SpacePaths, spacePaths } from '@melete/knowledge';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { space } from '../db/schema.ts';
import { stableUlid } from './ids.ts';

export type SpaceRef = {
  /** `sp_` and a ULID, as the contract requires. */
  id: string;
  /** The directory name, which is also the value of every record's `space`. */
  name: string;
  paths: SpacePaths;
};

export type SpaceResolver = {
  /** The space a request may touch, or null when the id names none. */
  byId: (spaceId: string) => Promise<SpaceRef | null>;
  byName: (name: string) => Promise<SpaceRef | null>;
  list: () => Promise<SpaceRef[]>;
};

/** The provisional identifier of a space, derived from its name. */
export const spaceIdFor = (name: string): string =>
  `${ID_PREFIXES.space}_${stableUlid(`space:${name}`)}`;

const refFor = (spacesRoot: string, name: string): SpaceRef => ({
  id: spaceIdFor(name),
  name,
  paths: spacePaths(spacesRoot, name),
});

/**
 * Spaces as they are on disk: one directory per space under the spaces root,
 * each of them its own git repository.
 */
export function filesystemSpaces(spacesRoot: string): SpaceResolver {
  const names = (): string[] => {
    if (!existsSync(spacesRoot)) return [];
    return readdirSync(spacesRoot)
      .filter((entry) => {
        const full = join(spacesRoot, entry);
        return statSync(full).isDirectory() && isGitRepo(full);
      })
      .sort();
  };

  const list = async (): Promise<SpaceRef[]> => names().map((name) => refFor(spacesRoot, name));

  return {
    list,
    byName: async (name) => (names().includes(name) ? refFor(spacesRoot, name) : null),
    byId: async (spaceId) => {
      const name = names().find((candidate) => spaceIdFor(candidate) === spaceId);
      return name ? refFor(spacesRoot, name) : null;
    },
  };
}

/** A catalog repository cannot redirect either Git or derived storage elsewhere. */
function hasSymlink(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && hasSymlink(join(directory, entry.name))) return true;
  }
  return false;
}

/**
 * The authenticated singleton owner owns the database catalog. A request can
 * select a catalog ID, but cannot supply a directory or discover unlisted repos.
 * Missing repositories initialize lazily, including spaces created after boot.
 */
export function databaseSpaces(db: Database, spacesRoot: string): SpaceResolver {
  const root = resolve(spacesRoot);
  const pending = new Map<string, Promise<SpaceRef | null>>();
  const idSchema = prefixedId(ID_PREFIXES.space);
  const open = async (row: typeof space.$inferSelect): Promise<SpaceRef | null> => {
    // Shared spaces resolve like personal ones; membership decides access per
    // request. An audience the contract does not know is a corrupt row.
    if (
      !idSchema.safeParse(row.id).success ||
      !spaceAudience.safeParse(row.audience).success ||
      !isAbsolute(row.gitPath)
    )
      return null;
    // Setup records one direct child named by its immutable ID. Display names
    // may change, and a corrupt catalog path must never open another space.
    const expected = join(root, row.id);
    if (resolve(row.gitPath) !== expected) return null;
    mkdirSync(root, { recursive: true });
    const realRoot = realpathSync(root);
    const confined = () => {
      if (!existsSync(expected)) {
        // existsSync follows links, so also refuse a dangling link.
        try {
          return !lstatSync(expected).isSymbolicLink();
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
          throw error;
        }
      }
      const entry = lstatSync(expected);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      if (realpathSync(expected) !== join(realRoot, row.id) || hasSymlink(expected)) return false;
      const gitDirectory = join(expected, '.git');
      return !existsSync(gitDirectory) || lstatSync(gitDirectory).isDirectory();
    };
    if (!confined()) return null;
    const paths = await initSpace(root, row.id);
    if (!confined()) return null;
    return { id: row.id, name: row.id, paths };
  };
  const reference = (row: typeof space.$inferSelect) => {
    const previous = pending.get(row.id);
    if (previous) return previous;
    const result = open(row);
    pending.set(row.id, result);
    void result.finally(() => pending.delete(row.id)).catch(() => {});
    return result;
  };
  const byId = async (id: string) => {
    if (!idSchema.safeParse(id).success) return null;
    const [row] = await db.select().from(space).where(eq(space.id, id)).limit(1);
    return row ? reference(row) : null;
  };
  return {
    byId,
    byName: byId,
    list: async () => {
      const rows = await db
        .select()
        .from(space)
        .where(eq(space.audience, 'owner'))
        .orderBy(space.id);
      const refs = await Promise.all(rows.map(reference));
      return refs.filter((ref): ref is SpaceRef => ref !== null);
    },
  };
}
