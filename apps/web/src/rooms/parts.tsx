/**
 * Small pieces every rooms screen draws: a person's name, set apart from
 * someone else's of the same name in the room (see `names.ts`), and their
 * avatar.
 */
import { createContext, useContext } from 'react';
import { Avatar } from '../design/primitives.tsx';
import { nameText, type RoomNames, shownName } from './names.ts';
import { initialsOf } from './reduce.ts';

const TONES = ['blue', 'sage', 'sand', 'lilac'] as const;

/** One tint per person, picked from their id so it stays the same everywhere. */
export function toneOf(id: string): (typeof TONES)[number] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length] ?? 'blue';
}

/** The names of the open room's people; outside a room, a label shows its name alone. */
export const RoomNamesContext = createContext<RoomNames | null>(null);

type NameOptions = { id?: string; trust?: boolean };

/** A label as one string, as the open room shows it; `trust` always adds the tell. */
export function useNameOf(): (label: string, options?: NameOptions) => string {
  const names = useContext(RoomNamesContext);
  return (label, options) => nameText(shownName(label, names, options));
}

/**
 * A person's name, with their tell set quieter after it where it shows (see
 * `names.ts`). Hovered, or read aloud, every name carries its tell.
 */
export function Who({
  label,
  id,
  strong = true,
  trust = false,
}: {
  label: string;
  id?: string;
  strong?: boolean;
  /** Who it is matters here, as for who may answer a permission: the tell always shows. */
  trust?: boolean;
}) {
  const { name, tell, code } = shownName(label, useContext(RoomNamesContext), { id, trust });
  return (
    <span className="who" title={nameText({ name, tell: code })}>
      <span className="who-name" data-strong={strong ? 'true' : undefined}>
        {name}
      </span>
      {tell ? (
        <span className="who-handle">{` <${tell}>`}</span>
      ) : code ? (
        <span className="sr-only">{` <${code}>`}</span>
      ) : null}
    </span>
  );
}

export function PersonAvatar({
  id,
  label,
  size = 28,
}: {
  id: string;
  label: string;
  size?: number;
}) {
  return <Avatar initials={initialsOf(label)} size={size} tone={toneOf(id)} />;
}
