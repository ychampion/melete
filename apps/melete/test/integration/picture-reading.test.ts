/**
 * A picture sent in chat is read once and its reading kept with it, so the
 * next prompt shows the reading where the picture is not shown. A reading that
 * fails keeps the prompt as it was. The turn the message starts waits a short,
 * bounded while for the reading, and goes ahead without it when it is slower.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentResponse, attachmentResponse, conversationResponse } from '@melete/contracts';
import { TINY_PNG } from '../../src/attachments/fixtures.ts';
import type { PictureAnswer, PictureCall, PictureReader } from '../../src/attachments/reading.ts';
import {
  PICTURE_READING_WAIT_MS,
  PictureReadings,
  readSentPictures,
} from '../../src/attachments/reading.ts';
import {
  type MessageFile,
  PICTURE_NOT_SHOWN,
  PICTURE_READ,
  withFiles,
} from '../../src/attachments/render.ts';
import { AttachmentService } from '../../src/attachments/store.ts';
import { session } from '../../src/db/auth-schema.ts';
import { owner } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const spaceId = newId('sp');
const jobId = newId('job');
const otherJob = newId('job');

/**
 * The service as it runs a chat: a message with a picture is accepted, its
 * reading starts, and the runner claims the turn the message started. The
 * bound is shorter here than the service's own, so a test can pass it.
 */
const BOUND_MS = 3_000;
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const readings = new PictureReadings(BOUND_MS);
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'picture-reading-test-signing-key-32b!',
      scopes: [],
      readings: (job) => readings.settled(job),
    })
  : null;
/** What reading a picture does in the test now running. */
let reading: (call: PictureCall) => Promise<PictureAnswer> = async () => ({
  ok: false,
  reason: 'no_model',
});
/** Each reading started, settled or not. */
const started: Promise<number>[] = [];
const submissions = jobs ? new SubmissionService(jobs) : null;
if (handle && submissions)
  submissions.onFilesSent = (job, ids, words) => {
    const read = readSentPictures({
      sql: handle.sql,
      reader: { read: (call) => reading(call), close: async () => {} },
      jobId: job,
      ids,
      words,
      log: () => {},
    });
    started.push(read);
    readings.track(job, read);
  };
const blobRoot = await mkdtemp(join(tmpdir(), 'melete-picture-reading-'));
const app =
  handle && jobs && runner && submissions
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test' }),
        jobs,
        runner,
        submissions,
        sql: handle.sql,
        attachments: new AttachmentService(handle.sql, new LocalBlobStore(blobRoot)),
        checkDatabase: async () => 'ok',
      })
    : null;
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');

afterAll(async () => {
  await Promise.allSettled(started);
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
  await rm(blobRoot, { recursive: true, force: true });
}, 30_000);

beforeAll(async () => {
  if (!handle) return;
  await handle.sql`insert into space (id, name, git_path) values (${spaceId}, 'Personal', ${`/spaces/${spaceId}`})`;
  for (const id of [jobId, otherJob])
    await handle.sql`insert into job (id, space_id, title, objective) values (${id}, ${spaceId}, 'Chat', 'Chat')`;
  await handle.db.insert(owner).values({ id: ownerId, email: 'pictures@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600_000),
  });
});

function request(path: string, method = 'GET', body?: unknown) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** A new chat, and a message in it with a photo; answers the chat and the photo's id. */
async function sentPhoto(words: string) {
  if (!app) throw new Error('Postgres unavailable');
  const persona = agentResponse.parse(
    await (await request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'Bills', agent_id: persona.id })
    ).json(),
  ).conversation;
  const form = new FormData();
  form.append('file', new File([TINY_PNG], 'bill.png', { type: 'image/png' }));
  const uploaded = await app.request('/attachments', {
    method: 'POST',
    headers: { Cookie: `melete_session=${token}` },
    body: form,
  });
  expect(uploaded.status).toBe(201);
  const photo = attachmentResponse.parse(await uploaded.json()).attachment;
  const sent = await request(`/conversations/${chat.id}/messages`, 'POST', {
    text: words,
    attachments: [photo.id],
  });
  expect(sent.status).toBe(200);
  return { chatId: chat.id, photoId: photo.id };
}

/** The first turn's claim, as the runner makes it when the message's wake arrives. */
async function firstTurn(chatId: string) {
  if (!jobs || !runner) throw new Error('Postgres unavailable');
  const row = await jobs.get(chatId);
  const claimed = await runner.claim({
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'input',
  });
  if (!claimed) throw new Error('Expected the turn to be claimed');
  return claimed.bundle.inputs.new_user_messages.at(-1)?.content ?? '';
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('the wait for a reading is bounded at about nine seconds', () => {
  expect(PICTURE_READING_WAIT_MS).toBeGreaterThanOrEqual(8_000);
  expect(PICTURE_READING_WAIT_MS).toBeLessThanOrEqual(10_000);
});

test.skipIf(!handle)(
  'a slow reading that finishes inside the bound reaches the first turn',
  async () => {
    if (!handle) return;
    const words: string[] = [];
    reading = async (call) => {
      words.push(call.words ?? '');
      await later(1_000);
      return { ok: true, reading: 'Text in the picture:\nAmount due $84.20', model: 'fake/v1' };
    };
    const { chatId, photoId } = await sentPhoto('Is this bill right?');
    const content = await firstTurn(chatId);
    expect(content).toContain(`${PICTURE_READ}\nText in the picture:\nAmount due $84.20`);
    expect(content).not.toContain(PICTURE_NOT_SHOWN);
    // The reading was told what the message said, to read it for a sensitive topic.
    expect(words).toEqual(['Is this bill right?']);
    expect(await stored(photoId)).toBe('Text in the picture:\nAmount due $84.20');
  },
  30_000,
);

test.skipIf(!handle)(
  'a reading that misses the bound leaves the first turn as it was, and is kept for the next',
  async () => {
    if (!handle) return;
    let done = () => {};
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    reading = async () => {
      await later(BOUND_MS + 1_500);
      done();
      return { ok: true, reading: 'Text in the picture:\nLate', model: 'fake/v1' };
    };
    const { chatId, photoId } = await sentPhoto('What does this say?');
    const before = Date.now();
    const content = await firstTurn(chatId);
    // It waited no longer than the bound, and went ahead without an error.
    expect(Date.now() - before).toBeLessThan(BOUND_MS + 1_000);
    expect(content).toContain(PICTURE_NOT_SHOWN);
    expect(content).not.toContain(PICTURE_READ);
    await finished;
    await Promise.allSettled(started);
    expect(await stored(photoId)).toBe('Text in the picture:\nLate');
  },
  30_000,
);

test.skipIf(!handle)(
  'a reading that fails does not hold the first turn',
  async () => {
    if (!handle) return;
    reading = async () => {
      throw new Error('provider unreachable');
    };
    const { chatId } = await sentPhoto('And this one?');
    const before = Date.now();
    const content = await firstTurn(chatId);
    expect(Date.now() - before).toBeLessThan(BOUND_MS);
    expect(content).toContain(PICTURE_NOT_SHOWN);
  },
  30_000,
);
