import { expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS } from '@melete/contracts/attachments';
import { BROWSER_UPLOADS_AT_ONCE, queueOf, refusal } from './attachments.ts';

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

const runTen = async (limit: number) => {
  const run = queueOf(() => limit);
  let running = 0;
  let most = 0;
  const started: number[] = [];
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
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
  return { most, started, results };
};

test('where the operator limits uploads at once, ten files picked together wait their turn', async () => {
  const { most, started, results } = await runTen(3);
  expect(most).toBe(3);
  expect(started).toEqual(results);
  expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i));
});

test('with no limit set, a few run together for the browser, and every file is taken', async () => {
  const { most, results } = await runTen(BROWSER_UPLOADS_AT_ONCE);
  expect(most).toBe(BROWSER_UPLOADS_AT_ONCE);
  expect(results).toHaveLength(10);
});

test('the limits an operator sets are the ones the box refuses by', () => {
  const limits = { file_bytes: 1024 * 1024, per_message: 2, uploads_at_once: null };
  expect(refusal(file('a.txt', 'text/plain', 5), 2, limits)).toBe(
    'A message can carry up to 2 files.',
  );
  expect(refusal(file('big.pdf', 'application/pdf', 2 * 1024 * 1024), 0, limits)).toBe(
    'Files can be up to 1 MB. big.pdf is 2 MB.',
  );
  expect(refusal(file('a.txt', 'text/plain', 5), 12, { ...limits, per_message: 50 })).toBeNull();
});

test('a failed upload frees its place for the next one', async () => {
  const run = queueOf(() => 1);
  const first = run(async () => {
    throw new Error('offline');
  });
  const second = run(async () => 'sent');
  await expect(first).rejects.toThrow('offline');
  expect(await second).toBe('sent');
});
