/**
 * How a person's name reads in a room. The service labels everyone
 * `Name <handle>`, and the handle is made from the room as well as the
 * person, so one person carries a different one in every room. On screen a
 * person goes by their name and a tell after it in angle brackets: the part of
 * their email before the @ when the reader can see emails, or else a short
 * code made from their account, which stays theirs in every room. A chosen
 * name cannot hold `<`, `>` or `@`, so no name can carry a tell of its own.
 *
 * Where it matters who someone is (who may answer a permission, who answered
 * it, who asked, the room's people) the tell always shows. Elsewhere a name
 * shows alone, unless two of the people the room knows of, there now or not,
 * have names that read alike (`clashSkeleton`, which also reads I, l, 1 and |
 * as one letter and rn as m); then each shows its tell.
 */
import { clashSkeleton } from '@melete/contracts/name-skeleton';
import { splitLabel } from './reduce.ts';

/** A person as the service names them in a room: their id and its label. */
export type LabelledPerson = { principal_id: string; display_name: string; email?: string | null };

type Entry = { name: string; code: string; clash: boolean };

/** How each person a room knows of is shown, keyed by the service's label. */
export type RoomNames = ReadonlyMap<string, Entry>;

/** A name as shown: `tell` is drawn after it; `code` is the tell it has when one is asked for. */
export type ShownName = { name: string; tell: string | null; code: string | null };

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

/**
 * How everyone a room knows of is shown: its members, and `others` named in
 * what is on screen, such as the authors of a thread, who may since have left.
 */
export function roomNames(
  members: readonly LabelledPerson[],
  others: readonly LabelledPerson[] = [],
): RoomNames {
  const people = new Map<string, LabelledPerson>();
  for (const person of [...members, ...others])
    if (!people.has(person.principal_id)) people.set(person.principal_id, person);
  const groups = new Map<string, LabelledPerson[]>();
  for (const person of people.values()) {
    const key = clashSkeleton(splitLabel(person.display_name).name);
    groups.set(key, [...(groups.get(key) ?? []), person]);
  }
  const shown = new Map<string, Entry>();
  for (const group of groups.values()) {
    // A person's email before the @ when the reader sees it, else their account's code;
    // two in one group whose emails start the same both fall back to the code.
    const locals = group.map(
      (person) => person.email?.split('@')[0]?.trim().toLocaleLowerCase('en-US') || null,
    );
    const unique = (local: string | null) =>
      local !== null && locals.indexOf(local) === locals.lastIndexOf(local);
    group.forEach((person, index) => {
      const local = locals[index] ?? null;
      shown.set(person.display_name, {
        name: splitLabel(person.display_name).name,
        code: local !== null && unique(local) ? local : accountCode(person.principal_id),
        clash: group.length > 1,
      });
    });
  }
  return shown;
}

/**
 * A label as shown. `trust` marks a place where who it is matters: the tell
 * always shows there. A label the room does not know of has the code of its
 * account when its id is given, else the room's handle from the label.
 */
export function shownName(
  label: string,
  names: RoomNames | null,
  { id, trust = false }: { id?: string; trust?: boolean } = {},
): ShownName {
  const entry = names?.get(label);
  if (entry)
    return { name: entry.name, tell: entry.clash || trust ? entry.code : null, code: entry.code };
  const { name, handle } = splitLabel(label);
  const code = id ? accountCode(id) : handle;
  return { name, tell: trust ? code : null, code };
}

/** A shown name as one string: "Sam", or "Sam <sam.okafor>" with its tell. */
export const nameText = ({ name, tell }: Pick<ShownName, 'name' | 'tell'>) =>
  tell ? `${name} <${tell}>` : name;
