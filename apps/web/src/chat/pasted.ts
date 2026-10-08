/**
 * Which stretches of a draft the person pasted rather than typed. Each paste
 * becomes a mark over the text it put in, and the marks follow every change to
 * the draft: an edit before a mark moves it, an edit inside, across or right
 * next to one widens it to take the edit in, and a mark whose text is deleted
 * stays where it was, so text put back there (an undo, a retype) is marked
 * again. A mark only ever keeps or grows; when the draft is replaced in a way
 * the marks cannot follow, the whole draft is marked. The service reads its
 * own shape of a paste whatever the marks say; they can only add to it.
 */
export type PastedSpan = { start: number; end: number };

/** The most marks a message carries; past that, one mark over the whole message. */
const LIMIT = 50;

/** The one place two texts differ: the removed [start, removedEnd) of `prev`, put in as [start, insertedEnd) of `next`. */
function difference(prev: string, next: string) {
  let start = 0;
  const shorter = Math.min(prev.length, next.length);
  while (start < shorter && prev[start] === next[start]) start++;
  let tail = 0;
  while (tail < shorter - start && prev[prev.length - 1 - tail] === next[next.length - 1 - tail])
    tail++;
  return { start, removedEnd: prev.length - tail, insertedEnd: next.length - tail };
}

/**
 * The marks after the draft changes from `prev` to `next`. With `pasting`, the
 * text the change put in was pasted and is marked too.
 */
export function followDraft(
  marks: readonly PastedSpan[],
  prev: string,
  next: string,
  pasting = false,
): PastedSpan[] {
  if (prev === next) return [...marks];
  const { start, removedEnd, insertedEnd } = difference(prev, next);
  const delta = next.length - prev.length;
  const moved = marks.map((mark): PastedSpan => {
    // Wholly before the change, with a gap: as it was.
    if (mark.end < start) return mark;
    // Wholly after the change, with a gap: moved by what the change added or took.
    if (mark.start > removedEnd) return { start: mark.start + delta, end: mark.end + delta };
    // Inside, across or touching: widened to take the change in.
    return {
      start: Math.min(mark.start, start),
      end: Math.max(mark.end > removedEnd ? mark.end + delta : insertedEnd, insertedEnd),
    };
  });
  if (pasting) moved.push({ start, end: insertedEnd });
  return merged(moved, next.length);
}

/** Overlapping or touching marks made one, held to the text, never more than the limit. */
function merged(marks: PastedSpan[], length: number): PastedSpan[] {
  const sorted = marks
    .map((mark) => ({
      start: Math.max(0, Math.min(length, mark.start)),
      end: Math.max(0, Math.min(length, mark.end)),
    }))
    .map((mark) => (mark.end < mark.start ? { start: mark.start, end: mark.start } : mark))
    .sort((a, b) => a.start - b.start);
  const out: PastedSpan[] = [];
  for (const mark of sorted) {
    const last = out.at(-1);
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
    else out.push({ ...mark });
  }
  return out.length > LIMIT ? [{ start: 0, end: length }] : out;
}

/** The whole draft, marked: what to keep when the draft is replaced and it had a paste in it. */
export function wholeDraft(marks: readonly PastedSpan[], draft: string): PastedSpan[] {
  return marks.length && draft.length ? [{ start: 0, end: draft.length }] : [];
}

/**
 * The marks to send with a message: against the text as sent, which is the
 * draft trimmed. Marks left empty by a deletion mark nothing.
 */
export function sentSpans(marks: readonly PastedSpan[], draft: string): PastedSpan[] {
  const lead = draft.length - draft.trimStart().length;
  const length = draft.trim().length;
  return merged(
    marks.map((mark) => ({ start: mark.start - lead, end: mark.end - lead })),
    length,
  ).filter((mark) => mark.end > mark.start);
}
