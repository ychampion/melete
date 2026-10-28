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

/** A label as one string, as the open room shows it. */
export function useNameOf(): (label: string) => string {
  const names = useContext(RoomNamesContext);
  return (label) => nameText(shownName(label, names));
}

/** A person's name, with what tells them from another of the same name set quieter after it. */
export function Who({ label, strong = true }: { label: string; strong?: boolean }) {
  const { name, tell } = shownName(label, useContext(RoomNamesContext));
  return (
    <span className="who">
      <span className="who-name" data-strong={strong ? 'true' : undefined}>
        {name}
      </span>
      {tell ? <span className="who-handle">{` (${tell})`}</span> : null}
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
