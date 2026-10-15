import { expect, test } from 'bun:test';
import { ATTACHMENT_LIMITS } from '@melete/contracts/attachments';
import { NEW_CHAT_AGAIN, newChat } from '../router.ts';
import {
  BROWSER_UPLOADS_AT_ONCE,
  fitForModel,
  nextUploadTry,
  queueOf,
  refusal,
  UPLOAD_RETRY_DELAYS,
  uploadResult,
} from './attachments.ts';

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

test('twelve files from one person, queued to the share the service gives, are never refused', async () => {
  // A service that holds 8 per person and refuses the next, as the real one does.
  const share = 8;
  let held = 0;
  const serve = async () => {
    if (held >= share) return 429;
    held++;
    await new Promise((done) => setTimeout(done, 5));
    held--;
    return 201;
  };
  const run = queueOf(() => share);
  const results = await Promise.all(Array.from({ length: 12 }, () => run(serve)));
  expect(results).toEqual(Array(12).fill(201));
});

/** A stand-in encoder: bytes grow with the pixels and the quality, as a JPEG's do. */
const encoder = (perPixel: number) => {
  const tried: { width: number; height: number; type: string; quality: number }[] = [];
  const encode = async (width: number, height: number, type: string, quality: number) => {
    tried.push({ width, height, type, quality });
    const size = Math.round(width * height * perPixel * (type === 'image/png' ? 3 : quality));
    return { size } as Blob;
  };
  return { encode, tried };
};

test('a phone photo is shown to the model at 2048 pixels, giving up quality before size', async () => {
  expect(ATTACHMENT_LIMITS.model_image_edge).toBe(2048);
  expect(ATTACHMENT_LIMITS.model_image_bytes).toBe(1024 * 1024);
  // A 4032×3024 photo whose best-quality copy at full size is too large.
  const { encode, tried } = encoder(0.4);
  const copy = await fitForModel(4032, 3024, encode);
  expect(copy).not.toBeNull();
  const chosen = tried.at(-1);
  expect(chosen).toMatchObject({ width: 2048, height: 1536, type: 'image/jpeg' });
  // Every copy tried on the way was at the full size.
  expect(tried.every((step) => step.width === 2048)).toBe(true);
  expect(chosen?.quality).toBeLessThan(0.85);
});

test('only a picture no quality can fit is made smaller, and a small one is never enlarged', async () => {
  const big = encoder(5);
  await fitForModel(4000, 1000, big.encode);
  expect(big.tried[0]).toMatchObject({ width: 2048, height: 512, quality: 0.85 });
  expect(big.tried.at(-1)?.width).toBeLessThan(2048);
  const small = encoder(0.1);
  await fitForModel(800, 600, small.encode);
  expect(small.tried).toEqual([{ width: 800, height: 600, type: 'image/jpeg', quality: 0.85 }]);
});

test('a screenshot stays lossless when it fits, and becomes a JPEG when it does not', async () => {
  const fits = encoder(0.05);
  await fitForModel(2560, 1600, fits.encode, { lossless: true });
  expect(fits.tried).toEqual([{ width: 2048, height: 1280, type: 'image/png', quality: 1 }]);
  const tooBig = encoder(0.3);
  await fitForModel(2560, 1600, tooBig.encode, { lossless: true });
  expect(tooBig.tried[0]?.type).toBe('image/png');
  expect(tooBig.tried.at(-1)).toMatchObject({ width: 2048, type: 'image/jpeg' });
});

test('an upload the service never answered is tried again a few times; a refusal is not', () => {
  const unreachable = uploadResult(null, null);
  expect(unreachable.unavailable).toContain('reach Melete');
  expect(uploadResult(502, null).unavailable).not.toBeNull();
  expect(UPLOAD_RETRY_DELAYS.map((_, tried) => nextUploadTry(unreachable, tried))).toEqual([
    ...UPLOAD_RETRY_DELAYS,
  ]);
  expect(nextUploadTry(unreachable, UPLOAD_RETRY_DELAYS.length)).toBeUndefined();
  const refused = uploadResult(413, { error: { message: 'Files can be up to 20 MB.' } });
  expect(refused).toMatchObject({ error: 'Files can be up to 20 MB.', unavailable: null });
  expect(nextUploadTry(refused, 0)).toBeUndefined();
});

test('asking for a new chat while one is open says so, so a file that never uploaded is dropped', () => {
  const said: string[] = [];
  const place = globalThis as unknown as { window?: unknown };
  const before = place.window;
  const location = { hash: '#/chat/new' };
  place.window = { location, dispatchEvent: (event: Event) => said.push(event.type) };
  try {
    newChat();
    expect(said).toEqual([NEW_CHAT_AGAIN]);
    expect(location.hash).toBe('#/chat/new');
    location.hash = '#/chat/c_1';
    newChat();
    expect(location.hash).toBe('/chat/new');
    expect(said).toHaveLength(1);
  } finally {
    place.window = before;
  }
});

test('code and data files go into the box as text files', () => {
  expect(refusal(file('script.py', 'text/x-python', 200), 0)).toBeNull();
  expect(refusal(file('data.json', 'application/json', 200), 0)).toBeNull();
  expect(refusal(file('index.ts', 'video/mp2t', 200), 0)).toBeNull();
  expect(refusal(file('config.yaml', '', 200), 0)).toBeNull();
});
