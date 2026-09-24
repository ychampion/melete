/**
 * Deciding, once. A permission or a question is answered by one request: a
 * second press while the first is still in flight (a repeated Enter, a number
 * key pressed again, a double tap) is refused rather than sent. The keys a
 * decision card answers to are read here too, so Home, chat and the phone
 * share one reading of them.
 */
import { useRef, useState } from 'react';

/** The calls in flight, one per decision id. */
export class InFlight {
  private readonly live = new Set<string>();

  constructor(private readonly changed: () => void = () => {}) {}

  has(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * Start `call` for `id` unless one is already running for it. Returns the
   * call's promise, or null when it was refused. The id is free again once
   * the call settles, so a failed decision can be tried again.
   */
  run<T>(id: string, call: () => Promise<T>): Promise<T> | null {
    if (this.live.has(id)) return null;
    this.live.add(id);
    this.changed();
    const free = () => {
      this.live.delete(id);
      this.changed();
    };
    return call().then(
      (value) => {
        free();
        return value;
      },
      (error: unknown) => {
        free();
        throw error;
      },
    );
  }
}

/** An InFlight that re-renders its component when a call starts or settles. */
export function useInFlight(): InFlight {
  const [, setTick] = useState(0);
  const ref = useRef<InFlight | null>(null);
  if (ref.current === null) ref.current = new InFlight(() => setTick((n) => n + 1));
  return ref.current;
}

export type KeyIntent =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'read' }
  | { kind: 'answer'; optionId: string }
  | { kind: 'own' };

export type KeyPress = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** The card itself has focus, not a button or field inside it. */
  onCard: boolean;
  /** Focus is in a text field inside the card; typing there is not a key. */
  inField: boolean;
};

export type CardKeys = {
  allow?: boolean;
  deny?: boolean;
  read?: boolean;
  /** A question's options, in the order their number keys run. */
  options?: readonly { id: string }[];
  /** A question with a field for the person's own answer, on the key after the options. */
  own?: boolean;
};

/**
 * What a key does on a focused decision card. Enter allows only when the card
 * itself has focus, so Enter on a focused button still presses that button.
 */
export function decisionKey(press: KeyPress, card: CardKeys): KeyIntent | null {
  if (press.metaKey || press.ctrlKey || press.altKey || press.inField) return null;
  const key = press.key.toLowerCase();
  if (key === 'enter') return card.allow && press.onCard ? { kind: 'allow' } : null;
  if (key === 'd') return card.deny ? { kind: 'deny' } : null;
  if (key === 'r') return card.read ? { kind: 'read' } : null;
  const n = Number(press.key);
  if (!Number.isInteger(n) || n < 1) return null;
  const option = card.options?.[n - 1];
  if (option) return { kind: 'answer', optionId: option.id };
  if (card.own && n === (card.options?.length ?? 0) + 1) return { kind: 'own' };
  return null;
}

/** Read a DOM key event on a card into a KeyPress. */
export function pressOf(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget;
  currentTarget: EventTarget;
}): KeyPress {
  const target = event.target as Element;
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    onCard: event.target === event.currentTarget,
    inField:
      typeof target.closest === 'function' &&
      target.closest('input, textarea, select, [role="dialog"]') !== null,
  };
}
