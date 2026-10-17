/**
 * How much each person keeps, read from records: what their work saved, moved,
 * deleted and restored, and what they sent in chat; a member's files in a
 * shared space count against that member; and past the operator's limit, a
 * save or an upload is refused with what they use and how to free space.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@melete/contracts';
import { ServiceError } from '../../src/api/errors.ts';
import { DEFAULT_ATTACHMENT_SETTINGS } from '../../src/attachments/limits.ts';
import { AttachmentService } from '../../src/attachments/store.ts';
import { recordGeneratedArtifact } from '../../src/broker/artifacts.ts';
import { newId } from '../../src/ids.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import {
  chargedPerson,
  recordStoredFiles,
  restoreStoredFiles,
  storageRefusal,
  storageUsed,
  trashStoredFile,
} from '../../src/storage/per-person.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const blobRoot = await mkdtemp(join(tmpdir(), 'melete-storage-'));
afterAll(async () => {
  await handle?.close();
  await rm(blobRoot, { recursive: true, force: true });
});

const MB = 1024 * 1024;

async function person() {
  if (!handle) throw new Error('Postgres unavailable');
  const id = newId('own');
  await handle.sql`insert into principal (id, email) values (${id}, ${`${id}@example.test`})`;
  return id;
}

async function spaceOf(owner: string, kind: 'personal' | 'room' = 'personal') {
  if (!handle) throw new Error('Postgres unavailable');
  const id = newId('sp');
  await handle.sql`insert into space (id, name, kind, owner_principal_id, git_path)
    values (${id}, 'Space', ${kind}, ${owner}, ${`test/${id}`})`;
  return id;
}

async function jobIn(
  spaceId: string,
  principalId: string,
  room?: { requestedBy: string },
): Promise<string> {
  if (!handle) throw new Error('Postgres unavailable');
  const id = newId('job');
  await handle.sql`insert into job (id, space_id, title, objective, state, kind, principal_id,
      audience, requested_by_principal_id)
    values (${id}, ${spaceId}, 'Work', 'Work', 'running', 'chat', ${principalId},
      ${room ? 'room' : 'principal'}, ${room?.requestedBy ?? null})`;
  return id;
}

/** A succeeded step's receipt landing, as the broker lands it. */
async function landed(
  job: { id: string; space_id: string },
  kind: string,
  payload: Record<string, JsonValue>,
  detail: Record<string, JsonValue>,
) {
  if (!handle) throw new Error('Postgres unavailable');
  await handle.sql.begin((tx) =>
    recordStoredFiles(tx, job, { kind, canonical_payload: payload }, { detail }),
  );
}

describe.skipIf(!handle)('storage per person', () => {
  test('writes, moves, deletes and restores are counted from their receipts', async () => {
    if (!handle) return;
    const me = await person();
    const space = await spaceOf(me);
    const job = { id: await jobIn(space, me), space_id: space };
    await landed(
      job,
      'files.write',
      { path: 'draft.md', area: 'work', content: 'x' },
      { path: 'draft.md', area: 'work', bytes: 100 },
    );
    await landed(
      job,
      'files.write',
      { path: 'plan.md', area: 'artifacts', content: 'x' },
      { path: 'plan.md', area: 'artifacts', bytes: 1000 },
    );
    expect(await storageUsed(handle.sql, me)).toBe(1100);

    // Saving over a file counts its new size, not both.
    await landed(
      job,
      'files.write',
      { path: 'plan.md', area: 'artifacts', content: 'x' },
      { path: 'plan.md', area: 'artifacts', bytes: 400 },
    );
    expect(await storageUsed(handle.sql, me)).toBe(500);

    // A move from the chat folder into the Files carries its bytes.
    await landed(
      job,
      'files.move',
      { from: 'draft.md', to: 'kept/draft.md', to_area: 'artifacts' },
      { from: 'draft.md', to: 'kept/draft.md', area: 'work', to_area: 'artifacts' },
    );
    const places = await handle.sql`select place, bytes::int as bytes from stored_file
      where space_id = ${space} and trash_id is null order by place`;
    expect(places.map((row) => [row.place, row.bytes])).toEqual([
      ['files:kept/draft.md', 100],
      ['files:plan.md', 400],
    ]);

    // A folder deleted into the trash stops counting; restoring it counts it again.
    await landed(
      job,
      'files.delete',
      { path: 'kept', area: 'artifacts' },
      { path: 'kept', area: 'artifacts', deleted: 'folder', trash_id: 'del_kept' },
    );
    expect(await storageUsed(handle.sql, me)).toBe(400);
    await landed(job, 'files.restore', { trash_id: 'del_kept' }, { trash_id: 'del_kept' });
    expect(await storageUsed(handle.sql, me)).toBe(500);

    // The Files page does the same for a file it deletes and puts back.
    await trashStoredFile(handle.sql, space, { place: 'files:plan.md' }, 'del_page');
    expect(await storageUsed(handle.sql, me)).toBe(100);
    await restoreStoredFiles(handle.sql, space, 'del_page');
    expect(await storageUsed(handle.sql, me)).toBe(500);

    // A chat's own folder goes with the chat.
    await landed(
      job,
      'files.write',
      { path: 'scratch.txt', content: 'x' },
      { path: 'scratch.txt', area: 'work', bytes: 50 },
    );
    expect(await storageUsed(handle.sql, me)).toBe(550);
    const other = { id: await jobIn(space, me), space_id: space };
    await landed(
      other,
      'files.write',
      { path: 'scratch.txt', content: 'x' },
      { path: 'scratch.txt', area: 'work', bytes: 7 },
    );
    await handle.sql`delete from job where id = ${other.id}`;
    expect(await storageUsed(handle.sql, me)).toBe(550);
  });

  test('a generated recording lands through the same path every receipt takes', async () => {
    if (!handle) return;
    const me = await person();
    const space = await spaceOf(me);
    const jobId = await jobIn(space, me);
    const actionId = newId('act');
    const hash = 'a'.repeat(64);
    await handle.sql.begin((tx) =>
      recordGeneratedArtifact(
        tx,
        { id: jobId, space_id: space } as Parameters<typeof recordGeneratedArtifact>[1],
        {
          id: actionId,
          kind: 'audio.synthesize',
          canonical_payload: {},
        } as unknown as Parameters<typeof recordGeneratedArtifact>[2],
        {
          action_id: actionId,
          connection_id: 'conn_audio',
          external_ref: hash,
          detail: {
            kind: 'artifact',
            path: 'artifacts/hello.wav',
            mime: 'audio/wav',
            bytes: 3 * MB,
            content_hash: hash,
          },
          received_at: new Date().toISOString(),
          late: false,
        },
      ),
    );
    expect(await storageUsed(handle.sql, me)).toBe(3 * MB);
  });

  test("a member's files in a shared space count against the member, not the owner", async () => {
    if (!handle) return;
    const owner = await person();
    const member = await person();
    const roomPrincipal = newId('own');
    await handle.sql`insert into principal (id, email, kind)
      values (${roomPrincipal}, ${`${roomPrincipal}@room.test`}, 'room')`;
    const room = await spaceOf(owner, 'room');
    const asked = await jobIn(room, roomPrincipal, { requestedBy: member });
    expect(await chargedPerson(handle.sql, asked)).toBe(member);
    await landed(
      { id: asked, space_id: room },
      'files.write',
      { path: 'notes.md', area: 'artifacts', content: 'x' },
      { path: 'notes.md', area: 'artifacts', bytes: 2 * MB },
    );
    expect(await storageUsed(handle.sql, member)).toBe(2 * MB);
    expect(await storageUsed(handle.sql, owner)).toBe(0);
    // The room's own work, asked by nobody, counts against the space's owner.
    const own = await jobIn(room, roomPrincipal);
    expect(await chargedPerson(handle.sql, own)).toBe(owner);
  });

  test('past the limit a save is refused with what is used and how to free space', async () => {
    if (!handle) return;
    const me = await person();
    const space = await spaceOf(me);
    const jobId = await jobIn(space, me);
    await landed(
      { id: jobId, space_id: space },
      'files.write',
      { path: 'big.bin', area: 'artifacts', content: 'x' },
      { path: 'big.bin', area: 'artifacts', bytes: 9 * MB },
    );
    const write = (content: string, path = 'more.txt') => ({
      kind: 'files.write',
      jobId,
      spaceId: space,
      payload: { path, area: 'artifacts', content },
    });
    // Off unless set.
    expect(await storageRefusal(handle.sql, null, write('x'.repeat(2 * MB)))).toBeNull();
    const quota = 10 * MB;
    expect(await storageRefusal(handle.sql, quota, write('x'.repeat(MB / 2)))).toBeNull();
    const refused = await storageRefusal(handle.sql, quota, write('x'.repeat(2 * MB)));
    expect(refused).toContain('they are using 9 MB of the 10 MB');
    expect(refused).toContain('this would add 2 MB');
    expect(refused).toContain('deleting files they no longer need in Files');
    // Saving a smaller version over one's own file frees space, so it goes ahead.
    expect(await storageRefusal(handle.sql, quota, write('x'.repeat(MB), 'big.bin'))).toBeNull();
    // A step whose size is known only once it runs goes ahead until the limit is reached.
    const recording = {
      kind: 'audio.synthesize',
      jobId,
      spaceId: space,
      payload: { text: 'hello' },
    };
    expect(await storageRefusal(handle.sql, quota, recording)).toBeNull();
    expect(await storageRefusal(handle.sql, 9 * MB, recording)).toContain('nothing was saved');
    // Reading and deleting are never refused.
    expect(
      await storageRefusal(handle.sql, MB, {
        kind: 'files.delete',
        jobId,
        spaceId: space,
        payload: { path: 'big.bin', area: 'artifacts' },
      }),
    ).toBeNull();
  });

  test('an upload past the limit is refused, counting files already sent', async () => {
    if (!handle) return;
    const me = await person();
    const space = await spaceOf(me);
    const store = new LocalBlobStore(blobRoot);
    const attachments = new AttachmentService(handle.sql, store, {
      ...DEFAULT_ATTACHMENT_SETTINGS,
      storagePerPerson: 1024,
    });
    const scope = { spaceId: space, principalId: me };
    await attachments.upload(scope, {
      name: 'first.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('a'.repeat(700)),
    });
    expect(await storageUsed(handle.sql, me)).toBe(700);
    const refused = await attachments
      .upload(scope, {
        name: 'second.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('b'.repeat(400)),
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe('storage_full');
    expect((refused as ServiceError).message).toContain('You are using 700 bytes of the 1 KB');
    expect((refused as ServiceError).message).toContain('second.txt is 400 bytes');
    // With no limit set, the same upload goes through.
    const open = new AttachmentService(handle.sql, store);
    await open.upload(scope, {
      name: 'second.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('b'.repeat(400)),
    });
    expect(await storageUsed(handle.sql, me)).toBe(1100);
  });
});
