/**
 * A picture sent in chat is read once and its reading kept with it, so the
 * next prompt shows the reading where the picture is not shown. A reading that
 * fails keeps the prompt as it was.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PictureCall, PictureReader } from '../../src/attachments/reading.ts';
import { readSentPictures } from '../../src/attachments/reading.ts';
import {
  type MessageFile,
  PICTURE_NOT_SHOWN,
  PICTURE_READ,
  withFiles,
} from '../../src/attachments/render.ts';
import { newId } from '../../src/ids.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const spaceId = newId('sp');
const jobId = newId('job');
const otherJob = newId('job');

afterAll(async () => {
  await handle?.close();
});

beforeAll(async () => {
  if (!handle) return;
  await handle.sql`insert into space (id, name, git_path) values (${spaceId}, 'Personal', ${`/spaces/${spaceId}`})`;
  for (const id of [jobId, otherJob])
    await handle.sql`insert into job (id, space_id, title, objective) values (${id}, ${spaceId}, 'Chat', 'Chat')`;
});

async function sentFile(kind: 'image' | 'pdf', job: string | null, text: string | null = null) {
  if (!handle) throw new Error('no database');
  const id = newId('file');
  await handle.sql`insert into attachment
      (id, space_id, principal_id, job_id, name, media_type, kind, size, blob_key, preview_key, text)
    values (${id}, ${spaceId}, null, ${job}, ${kind === 'image' ? 'bill.png' : 'lease.pdf'},
      ${kind === 'image' ? 'image/png' : 'application/pdf'}, ${kind}, 100,
      ${`sha256:${'a'.repeat(64)}`}, ${kind === 'image' ? `sha256:${'b'.repeat(64)}` : null}, ${text})`;
  return id;
}

async function stored(id: string): Promise<string | null> {
  if (!handle) throw new Error('no database');
  const [row] = await handle.sql<{ text: string | null }[]>`select text from attachment
    where id = ${id}`;
  return row?.text ?? null;
}

function scripted(answer: (call: PictureCall) => Awaited<ReturnType<PictureReader['read']>>) {
  const calls: PictureCall[] = [];
  const reader: PictureReader = {
    read: async (call) => {
      calls.push(call);
      return answer(call);
    },
    close: async () => {},
  };
  return { reader, calls };
}

const photo = (id: string): MessageFile => ({
  id,
  name: 'bill.png',
  kind: 'image',
  size: 100,
  pages: null,
});

test.skipIf(!handle)(
  "a sent picture's reading is kept with it and shown in the next prompt",
  async () => {
    if (!handle) return;
    const picture = await sentFile('image', jobId);
    const pdf = await sentFile('pdf', jobId, 'Rent is due.');
    const elsewhere = await sentFile('image', otherJob);
    const lines: string[] = [];
    const { reader, calls } = scripted(() => ({
      ok: true,
      reading: 'Text in the picture:\nAmount due $84.20',
      model: 'fake/fake-scripted-v1',
    }));
    const read = await readSentPictures({
      sql: handle.sql,
      reader,
      jobId,
      ids: [picture, pdf, elsewhere],
      log: (line) => lines.push(line),
    });
    // Only this job's picture: not its PDF, not another job's picture.
    expect(read).toBe(1);
    expect(calls.map((call) => [call.fileId, call.jobId, call.spaceId])).toEqual([
      [picture, jobId, spaceId],
    ]);
    expect(await stored(picture)).toBe('Text in the picture:\nAmount due $84.20');
    expect(await stored(elsewhere)).toBeNull();
    expect(await stored(pdf)).toBe('Rent is due.');
    const prompt = withFiles(
      'Is this right?',
      [photo(picture)],
      new Map([[picture, await stored(picture)]]),
    );
    expect(prompt).toContain(`${PICTURE_READ}\nText in the picture:\nAmount due $84.20`);
    expect(prompt).not.toContain(PICTURE_NOT_SHOWN);
    // Read once: a picture with a reading is not read again.
    expect(
      await readSentPictures({ sql: handle.sql, reader, jobId, ids: [picture], log: () => {} }),
    ).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
  },
);

test.skipIf(!handle)(
  'a picture whose reading fails keeps today’s sentence, and the log says why',
  async () => {
    if (!handle) return;
    const picture = await sentFile('image', jobId);
    const lines: string[] = [];
    const { reader } = scripted(() => ({ ok: false, reason: 'kept_private' }));
    expect(
      await readSentPictures({
        sql: handle.sql,
        reader,
        jobId,
        ids: [picture],
        log: (line) => lines.push(line),
      }),
    ).toBe(0);
    expect(await stored(picture)).toBeNull();
    expect(lines).toEqual([
      `attachment ${picture}: the picture was not read (kept_private); its prompt says so`,
    ]);
    const prompt = withFiles(
      'Is this right?',
      [photo(picture)],
      new Map([[picture, await stored(picture)]]),
    );
    expect(prompt).toContain(PICTURE_NOT_SHOWN);
  },
);
