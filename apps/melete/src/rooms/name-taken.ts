import { nameSkeleton } from '@melete/contracts/name-skeleton';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { principal, spaceMembership } from '../db/schema.ts';

type Reads = Pick<Database, 'select' | 'selectDistinct'>;

/**
 * Whether a name reads as the name of someone a person shares a space with:
 * their chosen name, or the part before the @ of their email, read alike (see
 * `nameSkeleton`: case, spacing, invisible characters, fullwidth forms and
 * Cyrillic, Greek, Lisu or Cherokee letters that pass for Latin ones aside).
 * A name is how a room tells people apart at a glance; the handle after it is
 * what settles it for the room's agent, and people see a tell after a name
 * wherever it matters who someone is. `among` is the person renaming, who is
 * compared with everyone in every space they are in now, or the space someone
 * is joining, leaving out `except`, the person joining. Everyone a space has
 * had counts, members, guests and people who have left alike, so a name cannot
 * be taken over once its owner leaves. A room's own account carries the room's
 * name and is no one's, so it never counts: otherwise anyone could learn the
 * names of rooms they are not in.
 */
export async function nameTaken(
  db: Reads,
  name: string,
  among: { person: string } | { space: string; except?: string },
): Promise<boolean> {
  const wanted = nameSkeleton(name);
  // Everyone in each space the person is in now, or in the space being joined.
  const within =
    'person' in among
      ? and(
          inArray(
            spaceMembership.spaceId,
            db
              .select({ id: spaceMembership.spaceId })
              .from(spaceMembership)
              .where(
                and(
                  eq(spaceMembership.principalId, among.person),
                  isNull(spaceMembership.revokedAt),
                ),
              ),
          ),
          ne(principal.id, among.person),
        )
      : and(
          eq(spaceMembership.spaceId, among.space),
          among.except ? ne(principal.id, among.except) : undefined,
        );
  // Read alike is not something SQL can compare, so the names are folded here.
  const rows = await db
    .selectDistinct({ displayName: principal.displayName, email: principal.email })
    .from(spaceMembership)
    .innerJoin(principal, eq(principal.id, spaceMembership.principalId))
    .where(and(within, ne(principal.kind, 'room')));
  return rows.some(
    (row) =>
      (row.displayName !== null && nameSkeleton(row.displayName) === wanted) ||
      nameSkeleton(row.email.split('@')[0] ?? '') === wanted,
  );
}

/**
 * Whether someone who already has an account would join a room under a name
 * that reads as the name of someone the room has had. A rename only compares
 * with the rooms a person is in, so the room they join is compared when they
 * join it, whether an owner adds them or they take an invite.
 */
export function nameClashesIn(
  db: Reads,
  person: { id: string; displayName: string | null },
  spaceId: string,
): Promise<boolean> {
  return person.displayName
    ? nameTaken(db, person.displayName, { space: spaceId, except: person.id })
    : Promise.resolve(false);
}
