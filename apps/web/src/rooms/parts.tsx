/**
 * Small pieces every rooms screen draws: a person's label, which always
 * carries the room's handle for them after their name, and their avatar.
 */
import { Avatar } from '../design/primitives.tsx';
import { initialsOf, splitLabel } from './reduce.ts';

const TONES = ['blue', 'sage', 'sand', 'lilac'] as const;

/** One tint per person, picked from their id so it stays the same everywhere. */
export function toneOf(id: string): (typeof TONES)[number] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length] ?? 'blue';
}

/** `Name <handle>`, with the handle set quieter; read aloud and copied, it is the whole label. */
export function Who({ label, strong = true }: { label: string; strong?: boolean }) {
  const { name, handle } = splitLabel(label);
  return (
    <span className="who">
      <span className="who-name" data-strong={strong ? 'true' : undefined}>
        {name}
      </span>
      {handle ? <span className="who-handle">{` <${handle}>`}</span> : null}
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
