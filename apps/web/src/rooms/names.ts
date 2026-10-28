/**
 * How a person's name reads in a room. The service labels everyone
 * `Name <handle>`, and the handle is made from the room as well as the
 * person, so one person carries a different one in every room. On screen a
 * person goes by their name alone. Only when two people in the same room go by
 * the same name does each get something after it that stays theirs in every
 * room: the part of their email before the @ when the reader can see emails,
 * or else a short code made from their account.
 */
import { splitLabel } from './reduce.ts';

/** A name as shown, and what sets it apart from someone else's of the same name. */
export type ShownName = { name: string; tell: string | null };

/** The shown name of each label in one room, keyed by the service's label. */
export type RoomNames = ReadonlyMap<string, ShownName>;

/** Two names are the same name whatever their case, spacing or width of letters. */
const sameNameKey = (name: string) =>
  name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

/** No two of these letters read alike. */
const CODE_LETTERS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Four letters from an account id: the same in every room, since only the account goes in. */
export function accountCode(id: string): string {
  let hash = 0x811c9dc5;
  for (const char of id) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  let code = '';
  for (let index = 0; index < 4; index++) {
    code += CODE_LETTERS[hash & 31];
    hash >>>= 5;
  }
  return code;
}

type Member = { principal_id: string; display_name: string; email?: string | null };

/** How each member of a room is shown, from the room's member list. */
export function roomNames(members: readonly Member[]): RoomNames {
  const groups = new Map<string, Member[]>();
  for (const member of members) {
    const key = sameNameKey(splitLabel(member.display_name).name);
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  const shown = new Map<string, ShownName>();
  for (const group of groups.values()) {
    const locals = group.map((member) => member.email?.split('@')[0]?.trim() || null);
    // Emails tell them apart only when every one is known and no two start the same.
    const byEmail =
      locals.every(Boolean) &&
      new Set(locals.map((local) => local?.toLocaleLowerCase('en-US'))).size === group.length;
    group.forEach((member, index) => {
      const { name } = splitLabel(member.display_name);
      const tell =
        group.length < 2
          ? null
          : byEmail
            ? (locals[index] ?? null)
            : accountCode(member.principal_id);
      shown.set(member.display_name, { name, tell });
    });
  }
  return shown;
}

/** A label as shown: from the room's names when it is one of theirs, else its name alone. */
export function shownName(label: string, names: RoomNames | null): ShownName {
  return names?.get(label) ?? { name: splitLabel(label).name, tell: null };
}

/** A shown name as one string: "Sam", or "Sam (sam.okafor)" beside another Sam. */
export const nameText = ({ name, tell }: ShownName) => (tell ? `${name} (${tell})` : name);
