import { expect, test } from 'bun:test';
import { NOT_ATTACHED_NOTE, withDeliveryNote } from './delivery-claims.ts';

const saved = (kind: 'files.write' | 'files.move', area = 'artifacts') => ({
  kind,
  receipt: {
    detail:
      kind === 'files.move'
        ? { to: 'list.pdf', to_area: area, content_hash: 'a'.repeat(64) }
        : { path: 'list.pdf', area, content_hash: 'a'.repeat(64) },
  },
});
const ran = { kind: 'exec.run', receipt: { detail: { exit_code: 0 } } };

test('a reply that says a file is attached when none was delivered says it is not there', () => {
  const text = 'Here is the summary. The 56-page PDF is attached.';
  expect(withDeliveryNote(text, [ran])).toBe(`${text}\n\n${NOT_ATTACHED_NOTE}`);
  expect(withDeliveryNote("I've attached the packing list.", [])).toEndWith(NOT_ATTACHED_NOTE);
});

test('a file moved or saved in the turn is attached, and the reply is left alone', () => {
  const text = 'The PDF is attached.';
  expect(withDeliveryNote(text, [ran, saved('files.move')])).toBe(text);
  expect(withDeliveryNote(text, [saved('files.write', 'work')])).toBe(text);
});

test('a reply that does not claim a file, or names the person’s own attachment, is left alone', () => {
  for (const text of [
    'Done: the list is in your Files.',
    'Thanks, I read the PDF you attached.',
    "I read the file you've attached.",
    'The invoice is attached.',
    '- Thanks for Tuesday\n- references attached',
  ])
    expect(withDeliveryNote(text, [ran])).toBe(text);
});

test('a message drafted in the turn may say its own attachment is attached', () => {
  const text = 'Here is the draft:\n\n> Hi Sam, the report is attached.';
  expect(withDeliveryNote(text, [{ kind: 'email.draft', receipt: null }])).toBe(text);
  expect(withDeliveryNote(text, [ran])).toEndWith(NOT_ATTACHED_NOTE);
});

test('the note is added once', () => {
  const once = withDeliveryNote('It is attached.', []);
  expect(withDeliveryNote(once, [])).toBe(once);
});
