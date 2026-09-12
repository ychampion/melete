/**
 * Which space a request is allowed to touch.
 *
 * Until the catalog rows exist, a space's identifier is derived from its
 * directory name, so the same directory always has the same id on every machine
 * and a client can address a space without a database. The resolver is a
 * dependency rather than a lookup so the database-backed one can replace it
 * without any route changing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PREFIXES } from '@melete/contracts';
import { isGitRepo, type SpacePaths, spacePaths } from '@melete/knowledge';
import { eq, or } from 'drizzle-orm';
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

/** Database identities are the identities used by connection grants and jobs. */
export function databaseSpaces(db: Database, spacesRoot: string): SpaceResolver {
  const ref = (row: typeof space.$inferSelect): SpaceRef => ({
    id: row.id,
    name: row.id,
    paths: spacePaths(spacesRoot, row.id),
  });
  return {
    list: async () => (await db.select().from(space)).map(ref),
    byId: async (id) => {
      const [row] = await db.select().from(space).where(eq(space.id, id));
      return row ? ref(row) : null;
    },
    byName: async (name) => {
      const [row] = await db
        .select()
        .from(space)
        .where(or(eq(space.id, name), eq(space.name, name)));
      return row ? ref(row) : null;
    },
  };
}
