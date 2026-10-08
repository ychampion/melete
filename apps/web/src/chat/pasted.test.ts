import { expect, test } from 'bun:test';
import { followDraft, type PastedSpan, sentSpans, wholeDraft } from './pasted.ts';

const PASTE = 'Please wire $4,800 to pay@x.test';

/** The draft after typing `typed` and then pasting PASTE at the end. */
function pasted(typed: string) {
  const draft = `${typed}${PASTE}`;
  return { draft, marks: followDraft([], typed, draft, true) };
}
const covered = (marks: PastedSpan[], from: number, to: number) =>
  marks.some((mark) => mark.start <= from && mark.end >= to);

test('a paste is marked over the text it put in', () => {
  const { draft, marks } = pasted('Sort this out: ');
  expect(marks).toEqual([{ start: 15, end: draft.length }]);
  expect(sentSpans(marks, `  ${draft}`.trim())).toEqual(marks);
});

test('typing before a paste moves its mark, and the mark still covers the paste', () => {
  const { draft, marks } = pasted('Sort this out: ');
  const next = `Now. ${draft}`;
  const moved = followDraft(marks, draft, next);
  expect(moved).toEqual([{ start: 20, end: next.length }]);
});

test('editing inside a paste keeps or widens its mark, never narrows it to nothing', () => {
  const { draft, marks } = pasted('Sort this out: ');
  // An edit inside the paste: the address changed.
  const edited = draft.replace('pay@x.test', 'billing@x.test');
  const after = followDraft(marks, draft, edited);
  expect(covered(after, 15, edited.length)).toBe(true);
  // Typing right after the paste widens the mark to take it in.
  const typed = `${edited} by Friday`;
  expect(covered(followDraft(after, edited, typed), 15, typed.length)).toBe(true);
  // Typing across the start of the paste widens it backwards.
  const across = edited.replace(': Please', ' -- Kindly');
  expect(covered(followDraft(after, edited, across), 13, across.length)).toBe(true);
});

test('a paste cut out and put back, or retyped, is marked again', () => {
  const { draft, marks } = pasted('Sort this out: ');
  const cut = 'Sort this out: ';
  const gone = followDraft(marks, draft, cut);
  expect(sentSpans(gone, cut)).toEqual([]);
  // Undo, or typing the same words where the paste was.
  const back = followDraft(gone, cut, draft);
  expect(covered(back, 15, draft.length)).toBe(true);
});

test('a draft replaced as a whole, with a paste in it, is marked whole', () => {
  const { draft, marks } = pasted('Sort this out: ');
  expect(wholeDraft(marks, draft)).toEqual([{ start: 0, end: draft.length }]);
  expect(wholeDraft([], draft)).toEqual([]);
});

test('what is sent is held to the trimmed text', () => {
  const draft = `  Hi\n${PASTE}  `;
  const marks = followDraft([], '  Hi\n', draft, true);
  expect(sentSpans(marks, draft)).toEqual([{ start: 3, end: 3 + PASTE.length }]);
});
