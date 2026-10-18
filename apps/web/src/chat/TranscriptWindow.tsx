/**
 * A long transcript drawn a window at a time. Turns near the view are drawn
 * as usual; turns far from it keep only their height, so a chat of a thousand
 * turns holds the work of a few dozen and scrolls like a short one. Turns not
 * read yet start at a line that reads them once it comes near.
 */
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';

/** Past this many turns on screen, turns far from the view are drawn as space of their height. */
export const WINDOW_FROM = 40;
/** How far beyond the view, above and below, turns stay drawn. */
const WINDOW_MARGIN = '1200px 0px';
/** How close to the view the start of what was read may come before more is read. */
const READ_AHEAD = '600px 0px 0px';
/** A guess at a turn's height before it was ever drawn. */
export const UNDRAWN_HEIGHT = 240;

/** One turn in the transcript. A turn holding the keyboard focus is never let go. */
export function TurnSlot({
  turnId,
  words,
  root,
  windowed,
  near: startsNear,
  children,
}: {
  /** The turn, named on the slot so it can be found while it is not drawn. */
  turnId: string;
  /**
   * What the person asked and the answer, as plain text. A turn not drawn
   * keeps these, so find in page and a screen reader still reach it.
   */
  words?: { asked: string; answered: string };
  /** The scrolling transcript. */
  root: RefObject<HTMLDivElement | null>;
  /** Whether the transcript is long enough to draw only near the view. */
  windowed: boolean;
  /**
   * Drawn before the first look at where it is: the newest turns, and older
   * ones as they go in above, so the view is held against their real height.
   */
  near: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A turn drawn before the transcript grew long stays drawn until it is seen to be far.
  const [near, setNear] = useState(() => startsNear || !windowed);
  const height = useRef<number | null>(null);
  useEffect(() => {
    if (!windowed) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting) {
          setNear(true);
          return;
        }
        if (node.contains(document.activeElement)) return;
        height.current = node.getBoundingClientRect().height || height.current;
        setNear(false);
      },
      { root: root.current, rootMargin: WINDOW_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [windowed, root]);
  const drawn = !windowed || near;
  return (
    <div
      ref={ref}
      className="turn-slot"
      data-slot={turnId}
      data-drawn={drawn ? undefined : 'false'}
      style={drawn ? undefined : { height: height.current ?? UNDRAWN_HEIGHT }}
    >
      {drawn ? children : words ? <TurnWords words={words} /> : null}
    </div>
  );
}

/**
 * A turn far from the view, as plain words: two paragraphs where the drawn
 * turn has dozens of elements. The browser skips laying it out until it is
 * near (`content-visibility`), and the turn is drawn in full before then.
 */
function TurnWords({ words }: { words: { asked: string; answered: string } }) {
  return (
    <div className="turn-words">
      {words.asked ? <p>{words.asked}</p> : null}
      {words.answered ? <p>{words.answered}</p> : null}
    </div>
  );
}

/**
 * Where the turns read so far begin, when older ones are on the service.
 * Coming near it reads them; it is also a button, for a keyboard, and for
 * trying again when a read failed.
 */
export function OlderTurns({
  root,
  loading,
  error,
  onLoad,
}: {
  root: RefObject<HTMLDivElement | null>;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  // A failed read waits for the person; it is not tried again on its own.
  const stopped = loading || error !== null;
  useEffect(() => {
    const node = ref.current;
    if (stopped || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current();
      },
      { root: root.current, rootMargin: READ_AHEAD },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [stopped, root]);
  return (
    <button
      ref={ref}
      type="button"
      className="previous-messages"
      aria-busy={loading}
      // Not disabled while reading, so a keyboard user's focus stays where it was.
      aria-disabled={loading || undefined}
      onClick={() => {
        if (!loading) onLoad();
      }}
    >
      {loading
        ? 'Reading earlier messages…'
        : error
          ? 'Couldn’t read the earlier messages. Try again'
          : 'Earlier messages'}
    </button>
  );
}
