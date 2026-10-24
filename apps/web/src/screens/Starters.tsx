/**
 * Starter tasks on a new person's Home: a few one-tap requests, each showing
 * something Melete can do with nothing connected. A tap writes the request
 * into the composer to edit; nothing is sent until the person sends it.
 * They go once the person has a few chats, or when put away, which holds on
 * every device.
 */
import { Icon } from '../design/icons.tsx';
import type { Starter } from '../experience/types.ts';

/** Where the cursor goes once a starter is in the box: over its blank, or at the end. */
export function starterSelection(starter: Pick<Starter, 'text' | 'select'>): {
  start: number;
  end: number;
} {
  const { text, select } = starter;
  if (select && select.start >= 0 && select.end <= text.length && select.start <= select.end)
    return select;
  return { start: text.length, end: text.length };
}

export function StarterList({
  starters,
  disabled = false,
  onPick,
  onDismiss,
}: {
  starters: Starter[];
  disabled?: boolean;
  onPick: (starter: Starter) => void;
  onDismiss: () => void;
}) {
  if (!starters.length) return null;
  return (
    <section className="starters" aria-labelledby="starters-head">
      <div className="starters-head">
        <h2 id="starters-head" className="starters-title">
          Try one to start
        </h2>
        <button type="button" className="starters-hide" onClick={onDismiss}>
          Hide these
        </button>
      </div>
      <ul className="starters-list">
        {starters.map((starter) => (
          <li key={starter.id}>
            <button
              type="button"
              className="starter"
              disabled={disabled}
              onClick={() => onPick(starter)}
              title={starter.text}
            >
              <Icon name={starter.icon} size={16} />
              <span>{starter.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
