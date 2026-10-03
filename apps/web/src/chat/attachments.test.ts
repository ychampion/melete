import { expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS } from '@melete/contracts/attachments';
import { refusal } from './attachments.ts';

const file = (name: string, type: string, size: number) =>
  ({ name, type, size }) as unknown as File;

test('a file the box cannot take is refused in a sentence before anything uploads', () => {
  expect(refusal(file('photo.jpg', 'image/jpeg', 2_000), 0)).toBeNull();
  expect(refusal(file('notes.md', '', 20), 0)).toBeNull();
  expect(refusal(file('archive.zip', 'application/zip', 20), 0)).toStartWith(
    "Melete can't read .zip files.",
  );
  expect(refusal(file('empty.txt', 'text/plain', 0), 0)).toBe('empty.txt is empty.');
  expect(refusal(file('scan.pdf', 'application/pdf', ATTACHMENT_LIMITS.file_bytes + 1), 0)).toBe(
    'Files can be up to 20 MB. scan.pdf is larger.',
  );
  expect(refusal(file('one-more.txt', 'text/plain', 5), ATTACHMENT_LIMITS.per_message)).toBe(
    `A message can carry up to ${ATTACHMENT_LIMITS.per_message} files.`,
  );
});
