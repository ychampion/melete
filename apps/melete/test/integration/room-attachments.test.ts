/**
 * Photos in a room: a member uploads one to the room and posts it with a
 * message. Everyone in the room reads it, nobody else does, and someone
 * removed stops reading it at once. An ask that carries a photo hands it to
 * the room's request, whose model reads it as a picture; where the room's
 * model reads none, the ask says so plainly instead of leaving the model to
 * guess. The room's request is offered Melete's built-in skills.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action,
  attachmentResponse,
  type DispatchResult,
  roomDetail,
  roomMessageResponse,
  roomThreadView,
} from '@melete/contracts';
import { loadSkills } from '@melete/skills';
import { TINY_PNG } from '../../src/attachments/fixtures.ts';
import { gatewayAttachments } from '../../src/attachments/model.ts';
import { AttachmentService } from '../../src/attachments/store.ts';
import { filesManifest } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { loadEnv } from '../../src/env.ts';
import { withAttachedFiles } from '../../src/gateway/attachments.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import type { GatewayPrincipal } from '../../src/gateway/types.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { buildAttemptSkeleton } from '../../src/jobs/bundle.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { ROOM_READS_NO_PICTURES, roomReadsPictures } from '../../src/rooms/pictures.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

/** A model Melete's catalog reads as text only. */
const PROVIDER = 'fireworks';
const MODEL = 'accounts/fireworks/models/deepseek-v4-pro-0813';
const env = loadEnv({
  MELETE_PREVIEW_MULTIPLAYER: 'true',
  NODE_ENV: 'test',
  MELETE_DEFAULT_PROVIDER: PROVIDER,
  MELETE_DEFAULT_MODEL: MODEL,
});

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'melete-room-files-'));
const store = new LocalBlobStore(join(directory, 'blobs'));
const registry = new ConnectorRegistry();
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner =
  handle && jobs
    ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
        key: 'room-files-fixture-signing-key-32-bytes',
        liveConnectionScopes: true,
        loadCatalog: new RuntimeCatalog(handle.db, registry).forAttempt,
      })
    : null;
const attachments = handle ? new AttachmentService(handle.sql, store) : null;
const app =
  handle && jobs && runner && attachments
    ? createApp({
        env: { ...env, MELETE_SPACES_DIR: directory },
        db: handle.db,
        sql: handle.sql,
        jobs,
        runner,
        registry,
        attachments,
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
const password = 'a-long-enough-password';

function database() {
  if (!handle || !app || !jobs || !runner) throw new Error('Postgres unavailable');
  return { ...handle, app, jobs, runner };
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function send(cookie: string, path: string, method = 'GET', body?: unknown) {
  return database().app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function ok<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await response;
  const text = await answered.text();
  expect([answered.status, text.slice(0, 300)]).toEqual([status, text.slice(0, 300)]);
  return JSON.parse(text) as T;
}
async function login(email: string) {
  return sessionCookie(
    await database().app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
}
const submission = () => `s${randomBytes(8).toString('hex')}`;

type Person = { id: string; cookie: string };
let alice: Person;
let bob: Person;
let carol: Person;

async function makeRoom(members: Person[]) {
  const made = roomDetail.parse(
    await ok(
      send(alice.cookie, '/rooms', 'POST', { name: `Home ${randomBytes(4).toString('hex')}` }),
      201,
    ),
  );
  for (const member of members)
    await ok(
      send(alice.cookie, `/rooms/${made.room.id}/members`, 'POST', { principal_id: member.id }),
      201,
    );
  return made.room.id;
}
/** A photo uploaded to the room by `person`, not posted yet. */
async function upload(person: Person, roomId: string, name = 'letter.png') {
  const form = new FormData();
  form.append('file', new File([TINY_PNG], name, { type: 'image/png' }));
  const response = await database().app.request(`/rooms/${roomId}/attachments`, {
    method: 'POST',
    headers: { Cookie: person.cookie },
    body: form,
  });
  return attachmentResponse.parse(await ok(response, 201)).attachment;
}
function startThread(person: Person, roomId: string, text: string, files: string[], ask = false) {
  return send(person.cookie, `/rooms/${roomId}/threads`, 'POST', {
    text,
    ask_agent: ask,
    attachments: files,
    submission_id: submission(),
  });
}
const content = (person: Person, roomId: string, fileId: string) =>
  send(person.cookie, `/rooms/${roomId}/attachments/${fileId}/content`);

/** Whether the room's model reads pictures, in the owner's word. */
async function modelReadsPictures(reads: boolean) {
  const { sql } = database();
  await sql`delete from model_vision`;
  await sql`insert into model_vision (provider, model, supports_vision, owner_id)
    values (${PROVIDER}, ${MODEL}, ${reads}, ${alice.id})`;
}
/** Run one attempt of a request the way the runner claims it. */
async function claim(jobId: string) {
  const { sql, runner } = database();
  const [row] = await sql`select lease_epoch, state_version from job where id = ${jobId}`;
  const claimed = await runner.claim({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
  if (!claimed) throw new Error(`Request ${jobId} could not be claimed`);
  return claimed;
}
function filesConnector() {
  return {
    manifest: filesManifest,
    async execute(action: Action): Promise<DispatchResult> {
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          late: false,
          received_at: new Date().toISOString(),
          detail: {},
        },
      };
    },
    async verify() {
      return { decision: 'unsupported' as const, reason: 'fixture' };
    },
    async health() {
      return { status: 'ok' as const, detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
}

withDb('photos in a room', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }, 30_000);

  beforeAll(async () => {
    const { app } = database();
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password }),
    });
    expect(setup.status).toBe(201);
    alice = {
      id: ((await setup.json()) as { owner: { id: string } }).owner.id,
      cookie: sessionCookie(setup),
    };
    const people: Person[] = [];
    for (const name of ['bob', 'carol']) {
      const made = await ok<{ principal: { id: string } }>(
        send(alice.cookie, '/principals', 'POST', { email: `${name}@example.test`, password }),
        201,
      );
      people.push({ id: made.principal.id, cookie: await login(`${name}@example.test`) });
    }
    [bob, carol] = people as [Person, Person];
  }, 60_000);

  test('a member reads a photo posted in the room; someone not in it, or removed from it, reads nothing', async () => {
    const roomId = await makeRoom([bob]);
    const photo = await upload(bob, roomId);
    // Before it is posted, only its uploader reads it.
    expect((await content(bob, roomId, photo.id)).status).toBe(200);
    expect((await content(alice, roomId, photo.id)).status).toBe(404);

    const posted = roomMessageResponse.parse(
      await ok(startThread(bob, roomId, 'The school sent this', [photo.id]), 201),
    );
    expect(posted.message.attachments?.map((file) => file.id)).toEqual([photo.id]);
    const thread = roomThreadView.parse(
      await ok(send(alice.cookie, `/rooms/${roomId}/threads/${posted.thread.id}`)),
    );
    expect(thread.messages[0]?.attachments?.map((file) => [file.id, file.kind])).toEqual([
      [photo.id, 'image'],
    ]);
    // Everyone in the room reads it, bytes and all.
    const read = await content(alice, roomId, photo.id);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(TINY_PNG);
    expect((await content(bob, roomId, photo.id)).status).toBe(200);
    // Someone who is not in the room reads nothing, by the room's route or their own.
    expect((await content(carol, roomId, photo.id)).status).toBe(404);
    expect((await send(carol.cookie, `/attachments/${photo.id}/content`)).status).toBe(404);
    // Nor can they upload into it.
    const form = new FormData();
    form.append('file', new File([TINY_PNG], 'x.png', { type: 'image/png' }));
    const intruder = await database().app.request(`/rooms/${roomId}/attachments`, {
      method: 'POST',
      headers: { Cookie: carol.cookie },
      body: form,
    });
    expect(intruder.status).toBe(404);
    // A posted photo cannot be taken back on its own, nor posted again.
    expect(
      (await send(bob.cookie, `/rooms/${roomId}/attachments/${photo.id}`, 'DELETE')).status,
    ).toBe(409);
    expect((await startThread(bob, roomId, 'Again', [photo.id])).status).toBe(409);
    // Someone removed stops reading it at once.
    await ok(send(alice.cookie, `/rooms/${roomId}/members/${bob.id}`, 'DELETE'));
    expect((await content(bob, roomId, photo.id)).status).toBe(404);
    expect((await content(alice, roomId, photo.id)).status).toBe(200);
  }, 60_000);

  test('a file someone else uploaded, or one from their own chat, never rides on a room message', async () => {
    const roomId = await makeRoom([bob]);
    const bobs = await upload(bob, roomId);
    // Alice cannot post Bob's upload.
    expect((await startThread(alice, roomId, 'Look', [bobs.id])).status).toBe(409);
    // Nor a file uploaded to her own space.
    const form = new FormData();
    form.append('file', new File([TINY_PNG], 'mine.png', { type: 'image/png' }));
    const own = attachmentResponse.parse(
      await ok(
        database().app.request('/attachments', {
          method: 'POST',
          headers: { Cookie: alice.cookie },
          body: form,
        }),
        201,
      ),
    ).attachment;
    expect((await startThread(alice, roomId, 'Look', [own.id])).status).toBe(409);
  }, 60_000);

  test('an ask with a photo hands it to the request, and a model that reads pictures is shown it as a picture', async () => {
    await modelReadsPictures(true);
    const roomId = await makeRoom([bob]);
    const photo = await upload(bob, roomId);
    const posted = roomMessageResponse.parse(
      await ok(
        startThread(bob, roomId, 'What does this letter ask us to do?', [photo.id], true),
        201,
      ),
    );
    const jobId = posted.request_job_id;
    expect(jobId).not.toBeNull();
    const { sql, db, jobs } = database();
    const [bound] =
      await sql`select job_id, room_message_id from attachment where id = ${photo.id}`;
    expect(bound).toEqual({ job_id: jobId, room_message_id: posted.message.id });
    // Still the room's to read.
    expect((await content(alice, roomId, photo.id)).status).toBe(200);

    // The request's next prompt names the photo where it was posted.
    const row = await jobs.get(jobId as string);
    const bundle = await serviceTransaction(db, (tx) =>
      buildAttemptSkeleton(
        tx,
        row,
        { id: newId('att'), epoch: 1, revision: row.revision, token: 'fixture-only' },
        { provider: PROVIDER, model: MODEL, fallback: null },
        0,
      ),
    );
    const input = bundle.inputs.new_user_messages.at(-1)?.content ?? '';
    expect(input).toStartWith('What does this letter ask us to do?');
    expect(input).toContain(`[[melete-file ${photo.id} `);

    // At the gateway, a model that reads pictures gets the photo itself.
    const body = { model: MODEL, messages: [{ role: 'user', content: input }] };
    const principal = { jobId, privacy: { kind: 'job' } } as unknown as GatewayPrincipal;
    const outbound = await withAttachedFiles({
      body,
      protocol: 'chat/completions',
      provider: PROVIDER,
      model: MODEL,
      principal,
      route: { kind: 'cloud', private: false },
      source: gatewayAttachments(sql, store, async () => true),
      maxRequestBytes: 8 * 1024 * 1024,
    });
    const parts = (
      outbound.messages as { content: { type: string; image_url?: { url: string } }[] }[]
    )[0]?.content;
    const picture = parts?.find((part) => part.type === 'image_url');
    expect(picture?.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from(TINY_PNG).toString('base64')}`,
    );
    await jobs.cancel(jobId as string);
  }, 60_000);

  test("where the room's model reads no pictures, an ask with a photo says so, whoever asks", async () => {
    await modelReadsPictures(false);
    const roomId = await makeRoom([bob]);
    for (const person of [bob, alice]) {
      const photo = await upload(person, roomId);
      const refused = await startThread(person, roomId, '@Melete what is this?', [photo.id]);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        ROOM_READS_NO_PICTURES,
      );
      // Nothing was posted, and the photo is still the uploader's to post.
      const posted = roomMessageResponse.parse(
        await ok(startThread(person, roomId, 'For the fridge', [photo.id]), 201),
      );
      expect(posted.request_job_id).toBeNull();
      expect(posted.message.attachments?.map((file) => file.id)).toEqual([photo.id]);
    }
    const { sql } = database();
    const [asked] = await sql`select count(*)::int as n from job where space_id = ${roomId}`;
    expect(asked?.n).toBe(0);
  }, 60_000);

  test("a room's request reads photos through the operator's vision model, and only the installation's settings decide", async () => {
    await modelReadsPictures(false);
    const roomId = await makeRoom([bob]);
    const { db, sql } = database();
    const settings = new ModelSettingsService({ db, env });
    const plain = { fast: null, vision: null, fallback: [] };
    const vision = { ...plain, vision: { provider: PROVIDER, model: 'vision-fixture' } };
    expect(await roomReadsPictures(settings, plain, roomId)).toBe(false);
    // The operator's vision model takes every call that carries a picture and answers it itself.
    expect(await roomReadsPictures(settings, vision, roomId)).toBe(true);
    // A member's own word on a model, or their own secondary, is not the room's.
    await sql`insert into model_secondary (principal_id, provider, model)
      values (${bob.id}, ${PROVIDER}, 'vision-fixture')`;
    expect(await roomReadsPictures(settings, plain, roomId)).toBe(false);
    await sql`delete from model_secondary`;
    // The installation's word on its model is.
    await modelReadsPictures(true);
    expect(await roomReadsPictures(settings, plain, roomId)).toBe(true);
  }, 60_000);

  test("a room's request is offered Melete's built-in skills", async () => {
    await modelReadsPictures(true);
    const roomId = await makeRoom([bob]);
    const { sql } = database();
    const [files] = await sql`select id from connection
      where space_id = ${roomId} and provider = 'files' and status = 'active'`;
    if (files && !registry.get(String(files.id)))
      registry.register(String(files.id), filesConnector());
    const builtins = loadSkills({}).skills.filter((skill) => skill.source === 'builtin');
    const mail = builtins.find((skill) => skill.frontmatter.name === 'read-mail-photos');
    const photo = await upload(bob, roomId);
    const text = mail
      ? '@Melete here are photos of the paper mail that came today, what do we need to do?'
      : '@Melete write a draft note to the school and plan a responsibility for it';
    const posted = roomMessageResponse.parse(
      await ok(startThread(bob, roomId, text, [photo.id]), 201),
    );
    const { bundle } = await claim(posted.request_job_id as string);
    const offered = [
      ...bundle.skills.map((skill) => skill.name),
      ...(bundle.skill_index ?? []).map((entry) => entry.name),
    ];
    // Built-ins whose tools the room's request reaches are all there.
    const reached = new Set(bundle.tools.map((tool) => tool.name.split('__')[0]));
    for (const skill of builtins)
      if (
        skill.frontmatter.tools.every((tool) => reached.has(tool)) &&
        !skill.frontmatter.keeps_memory
      )
        expect([skill.frontmatter.name, offered.includes(skill.frontmatter.name)]).toEqual([
          skill.frontmatter.name,
          true,
        ]);
    if (mail) {
      expect(offered).toContain('read-mail-photos');
      expect(bundle.skills.map((skill) => skill.name)).toContain('read-mail-photos');
    } else expect(bundle.skills.map((skill) => skill.name)).toContain('write-a-draft');
    await database().jobs.cancel(posted.request_job_id as string);
  }, 60_000);
});
