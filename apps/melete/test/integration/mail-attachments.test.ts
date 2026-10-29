/** Mail pictures stay with the job that read them and follow normal file storage rules. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TINY_PNG } from '../../src/attachments/fixtures.ts';
import { DEFAULT_ATTACHMENT_SETTINGS } from '../../src/attachments/limits.ts';
import { mailImageReader } from '../../src/attachments/mail.ts';
import { gatewayAttachments } from '../../src/attachments/model.ts';
import { AttachmentService } from '../../src/attachments/store.ts';
import { mailContext } from '../../src/connectors/mail-fixtures.ts';
import { newId } from '../../src/ids.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const directory = await mkdtemp(join(tmpdir(), 'melete-mail-files-'));
const store = new LocalBlobStore(directory);
const withDb = handle ? describe : describe.skip;

afterAll(async () => {
  await handle?.close();
  await rm(directory, { recursive: true, force: true });
});

const file = {
  id: '1',
  name: 'statement.png',
  media_type: 'image/png',
  size: TINY_PNG.length,
  content: Buffer.from(TINY_PNG),
};

async function fixture() {
  if (!handle) throw new Error('Postgres unavailable');
  const personId = newId('own');
  const spaceId = newId('sp');
  const parentId = newId('job');
  const jobId = newId('job');
  const siblingId = newId('job');
  await handle.sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
  await handle.sql`insert into space (id, name, git_path, owner_principal_id)
    values (${spaceId}, 'Personal', ${spaceId}, ${personId})`;
  for (const id of [parentId, jobId, siblingId])
    await handle.sql`insert into job (id, space_id, principal_id, title, objective, experience_parent_id)
      values (${id}, ${spaceId}, ${personId}, 'Read mail', 'Read an attached statement',
        ${id === parentId ? null : parentId})`;
  return {
    sql: handle.sql,
    personId,
    parentId,
    siblingId,
    ctx: { ...mailContext(), job_id: jobId, space_id: spaceId },
  };
}

withDb('stored mail pictures', () => {
  test('a picture is bound to the requesting child job and cannot flow back to its parent or sibling', async () => {
    const { sql, personId, parentId, siblingId, ctx } = await fixture();
    const id = await mailImageReader(sql, store)(ctx, file);
    const [row] =
      await sql`select job_id, principal_id, sent_at, blob_key, preview_key from attachment
      where id = ${id}`;
    expect(row).toMatchObject({ job_id: ctx.job_id, principal_id: personId });
    expect(row?.sent_at).not.toBeNull();
    expect(row?.preview_key).toBe(row?.blob_key);
    const refs =
      await sql`select key from blob_ref where owner_kind = 'attachment' and owner_id = ${id}`;
    expect(refs).toHaveLength(1);
    const source = gatewayAttachments(sql, store, async () => true);
    const kinds = { image: true, pdf: false, maxPdfBytes: 0 };
    const own = await source.files(ctx.job_id, [id], kinds);
    expect(own.get(id)?.data).toEqual(TINY_PNG);
    expect((await source.files(parentId, [id], kinds)).size).toBe(0);
    expect((await source.files(siblingId, [id], kinds)).size).toBe(0);
    await sql`update attachment set created_at = now() - interval '2 days' where id = ${id}`;
    const attachments = new AttachmentService(sql, store);
    expect(await attachments.sweepUnsent({ spaceId: ctx.space_id, principalId: personId })).toBe(0);
    expect((await source.files(ctx.job_id, [id], kinds)).has(id)).toBe(true);
  });

  test('a request in another space stores nothing', async () => {
    const { sql, ctx } = await fixture();
    await expect(
      mailImageReader(sql, store)({ ...ctx, space_id: newId('sp') }, file),
    ).rejects.toThrow();
    const [row] =
      await sql`select count(*)::int as count from attachment where space_id = ${ctx.space_id}`;
    expect(row?.count).toBe(0);
  });

  test('mail pictures use the upload size and storage quota checks', async () => {
    for (const settings of [
      { ...DEFAULT_ATTACHMENT_SETTINGS, fileBytes: 1 },
      { ...DEFAULT_ATTACHMENT_SETTINGS, storagePerPerson: 1 },
    ]) {
      const { sql, ctx } = await fixture();
      await expect(mailImageReader(sql, store, settings)(ctx, file)).rejects.toThrow();
      const [row] =
        await sql`select count(*)::int as count from attachment where space_id = ${ctx.space_id}`;
      expect(row?.count).toBe(0);
    }
  });
});
