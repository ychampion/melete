/**
 * Settings, voice, computers, deadlines, the session's files, attachments and
 * the source of a needs-you item answer for the space the session is in. A request that names a different space in
 * x-melete-space, even a room the person is in, is refused rather than
 * answered for the session's space as if it were the one asked about.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentService } from '../../src/attachments/store.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space, spaceMembership } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { SituationService } from '../../src/situations/service.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'space-header-fixture-key-32-bytes' })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const situations = jobs && triggers ? new SituationService({ jobs, triggers }) : null;
const registry = new ConnectorRegistry();
const root = await mkdtemp(join(tmpdir(), 'melete-space-header-'));
const app =
  handle && jobs && triggers && situations
    ? createApp({
        db: handle.db,
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_SPACES_DIR: join(root, 'spaces'),
          MELETE_WORK_DIR: join(root, 'work'),
        }),
        sql: handle.sql,
        jobs,
        triggers,
        situations,
        attachments: new AttachmentService(handle.sql, new LocalBlobStore(join(root, 'blobs'))),
        registry,
        checkDatabase: async () => 'ok',
      })
    : null;
const personal = newId('sp');
const room = newId('sp');
const theirs = newId('sp');
const ownerId = newId('own');
const otherId = newId('own');
const token = randomBytes(32).toString('base64url');
const inRoom = randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'header-routes@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.sql`insert into principal (id, email) values (${otherId}, 'other-routes@example.test')`;
  await handle.db.insert(space).values([
    { id: personal, name: 'Personal', gitPath: join(root, 'spaces', personal) },
    {
      id: room,
      name: 'Trip',
      kind: 'room',
      ownerPrincipalId: otherId,
      gitPath: join(root, 'spaces', room),
    },
    {
      id: theirs,
      name: 'Personal',
      ownerPrincipalId: otherId,
      gitPath: join(root, 'spaces', theirs),
    },
  ]);
  await handle.db.insert(spaceMembership).values([
    { principalId: otherId, spaceId: room, role: 'owner' },
    { principalId: ownerId, spaceId: room, role: 'member' },
  ]);
  await handle.db.insert(session).values({
    tokenHash: digest(token),
    ownerId,
    spaceId: personal,
    expiresAt: new Date(Date.now() + 600000),
  });
  // The same person, signed in to the room itself.
  const [membership] = await handle.sql`select generation from space_membership
    where space_id = ${room} and principal_id = ${ownerId}`;
  await handle.sql`insert into session (token_hash, owner_id, principal_id, space_id,
      membership_generation, expires_at)
    values (${digest(inRoom)}, ${ownerId}, ${ownerId}, ${room}, ${membership?.generation},
      now() + interval '1 hour')`;
}
const withDb = app ? describe : describe.skip;

type Call = readonly [method: string, path: string, body?: unknown];

async function request([method, path, body]: Call, header?: string, cookie = token) {
  if (!app) throw new Error('Postgres unavailable');
  // A form sets its own multipart content type.
  const form = body instanceof FormData;
  return app.request(path, {
    method,
    headers: {
      Cookie: `melete_session=${cookie}`,
      ...(header ? { 'x-melete-space': header } : {}),
      ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  });
}

async function refused(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: 'scope_denied',
      message: 'This works only in the space you are signed in to.',
    },
  });
}

/** Status and error code: two answers to the same request agree on both. */
async function outcome(response: Response) {
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    code = undefined;
  }
  return { status: response.status, code };
}

const deadline = {
  file: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
  title: 'Get the contract signed',
  due_at: new Date(Date.now() + 3_600_000).toISOString(),
  by: 'others',
};

function upload() {
  const form = new FormData();
  form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
  return form;
}

const calls: Record<string, Call[]> = {
  devices: [
    ['GET', '/devices'],
    ['POST', '/devices/pairings', {}],
  ],
  voice: [
    ['GET', '/voice'],
    ['POST', `/conversations/${newId('job')}/voice/speech`, { text: 'hello' }],
  ],
  privacy: [
    ['GET', '/privacy/settings'],
    ['PUT', '/privacy/settings', {}],
    ['POST', '/privacy/preview', { text: 'hello' }],
    ['GET', `/conversations/${newId('job')}/privacy`],
  ],
  situations: [['POST', '/situations/deadlines', deadline]],
  'session files': [
    ['GET', '/files'],
    ['GET', `/artifacts/${newId('art')}/content`],
    ['GET', `/files/${newId('act')}/content`],
    ['GET', `/screenshots/${newId('act')}`],
    ['GET', `/messages/${newId('msg')}/reactions`],
  ],
  attachments: [
    ['GET', '/attachments/limits'],
    ['POST', '/attachments', upload()],
    ['GET', `/attachments/${newId('file')}/content`],
    ['DELETE', `/attachments/${newId('file')}`],
  ],
  'needs-you': [['POST', `/needs-you/${newId('tri')}/source`, {}]],
};

withDb('a space named in x-melete-space', () => {
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30000);

  for (const [group, list] of Object.entries(calls))
    for (const call of list) {
      const [method, path] = call;
      test(`${group}: ${method} ${path}: a room the person is in is refused, not answered for their own space`, async () => {
        const own = await outcome(await request(call));
        expect(await outcome(await request(call, personal))).toEqual(own);
        await refused(await request(call, room));
        // Another person's own space is still refused as theirs.
        expect((await request(call, theirs)).status).toBe(403);
      }, 30000);

      test(`${group}: ${method} ${path}: signed in to the room, naming the room is answered as without it`, async () => {
        const plain = await outcome(await request(call, undefined, inRoom));
        expect(await outcome(await request(call, room, inRoom))).toEqual(plain);
        await refused(await request(call, personal, inRoom));
      }, 30000);
    }
});
