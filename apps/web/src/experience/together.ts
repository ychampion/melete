/**
 * Asks of one kind the work made together are shown, and answered, as one
 * card: the first of them, with the rest listed under it. The service marks
 * them with one `group`; a card that shows a message or a file has none and
 * is always read on its own.
 */
import type { Permission } from './types.ts';

/** What each answer of a folded card names: the asks shown with it, as shown. */
export type Seen = { id: string; version: string };

/**
 * Gathers items whose permissions share a group and a state under the first
 * of them, in order. Each entry is an item and the others folded into it;
 * an item folded into an earlier one is not an entry of its own.
 */
export function foldTogether<T>(
  items: readonly T[],
  permissionOf: (item: T) => Permission | null,
  stateOf: (item: T) => string = () => '',
): { item: T; together: Permission[] }[] {
  const heads = new Map<string, { item: T; together: Permission[] }>();
  const folded: { item: T; together: Permission[] }[] = [];
  for (const item of items) {
    const permission = permissionOf(item);
    const key = permission?.group ? `${permission.group}\u0000${stateOf(item)}` : null;
    const head = key === null ? undefined : heads.get(key);
    if (head && permission) {
      head.together.push(permission);
      continue;
    }
    const entry = { item, together: [] as Permission[] };
    if (key !== null) heads.set(key, entry);
    folded.push(entry);
  }
  return folded;
}

/** The asks answered with a folded card, each at the version shown. */
export const seenTogether = (together: readonly Permission[]): Seen[] =>
  together.map((permission) => ({ id: permission.id, version: permission.version }));

/**
 * A folded card offers what every ask in it offers, and never a standing
 * rule: a rule is made from one ask, and this answers several.
 */
export function foldedOptions(
  permission: Permission,
  together: readonly Permission[],
): Permission['options'] {
  if (!together.length) return permission.options;
  return permission.options.filter(
    (option) => option !== 'always' && together.every((other) => other.options.includes(option)),
  );
}
