import { expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS } from '@melete/contracts/attachments';
import { queueOf, refusal } from './attachments.ts';

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

test('ten files picked at once upload no more at a time than the service takes', async () => {
  const run = queueOf(ATTACHMENT_LIMITS.uploads_at_once);
  let running = 0;
  let most = 0;
  const started: number[] = [];
  const results = await Promise.all(
    Array.from({ length: ATTACHMENT_LIMITS.per_message }, (_, index) =>
      run(async () => {
        started.push(index);
        running++;
        most = Math.max(most, running);
        await new Promise((done) => setTimeout(done, 5 + (index % 3) * 3));
        running--;
        return index;
      }),
    ),
  );
  expect(most).toBe(ATTACHMENT_LIMITS.uploads_at_once);
  expect(started).toEqual(results);
  expect(results).toEqual(Array.from({ length: ATTACHMENT_LIMITS.per_message }, (_, i) => i));
});

test('a failed upload frees its place for the next one', async () => {
  const run = queueOf(1);
  const first = run(async () => {
    throw new Error('offline');
  });
  const second = run(async () => 'sent');
  await expect(first).rejects.toThrow('offline');
  expect(await second).toBe('sent');
});
