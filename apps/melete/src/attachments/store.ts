/**
 * Keeping the files people send in chat.
 *
 * An upload is checked (its kind, its size, that its bytes are what it says
 * they are), its text read once, and its bytes put in the blob store with this
 * row as their owner. Sending the message gives the file its chat, inside the
 * transaction that accepts the message, and only the person who uploaded it,
 * in the space they uploaded it to, can do that. Deleting the chat deletes the
 * rows and every blob no one else still needs.
 */
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES_SENTENCE,
  type AttachmentKind,
  type AttachmentView,
  attachmentKindFor,
  attachmentSize,
  attachmentTooLarge,
  attachmentView,
} from '@melete/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import {
  type BlobKey,
  BlobNotFound,
  type BlobStore,
  BlobTooLarge,
  readBlob,
  type StoredBlob,
} from '../storage/blob.ts';
import { defineBlobOwner, lockBlobKey, referenceBlobs } from '../storage/refs.ts';
import { extractBounded, ReadersBusy } from './bounded.ts';
import { looksLike, UnreadableFile } from './extract.ts';
import { type AttachmentSettings, DEFAULT_ATTACHMENT_SETTINGS } from './limits.ts';
import { type AttachmentRow, attachment } from './schema.ts';

export const ATTACHMENT_OWNER = 'attachment';

defineBlobOwner(ATTACHMENT_OWNER, async (tx, ownerId) => {
  const [row] = await tx<{ space_id: string }[]>`select space_id from attachment
    where id = ${ownerId}`;
  return row?.space_id ?? null;
});

/** How long a file uploaded and never sent is kept. */
export const UNSENT_ATTACHMENT_MS = 24 * 60 * 60 * 1000;

/** Picture types the gateway forwards to a model as they are. */
const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Who is asking, as the session says: never a header or a body. */
export type AttachmentScope = { spaceId: string; principalId: string | null };

/** What a sent message records about each of its files. */
export type SentAttachment = {
  id: string;
  name: string;
  media_type: string;
  kind: AttachmentKind;
  size: number;
  pages: number | null;
};

export function attachmentRowView(row: AttachmentRow): AttachmentView {
  return attachmentView.parse({
    id: row.id,
    name: row.name,
    media_type: row.mediaType,
    kind: row.kind,
    size: row.size,
    pages: row.pages,
    has_preview: row.previewKey !== null,
    has_text: row.text !== null,
    created_at: row.createdAt.toISOString(),
  });
}

/** A file name a person can read and a header can carry: no path, no control characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ATTACHMENT_LIMITS.name_characters);
  return clean || 'file';
}

const unavailable = () =>
  new ServiceError(
    'attachment_unavailable',
    'One of the files is no longer available. Remove it and attach it again.',
    409,
  );

const notFound = () => new ServiceError('not_found', 'No such file.', 404);

export class AttachmentService {
  constructor(
    readonly sql: Sql,
    readonly store: BlobStore,
    /** What files the operator lets in. Left out, the defaults, with no upload limits. */
    readonly settings: AttachmentSettings = DEFAULT_ATTACHMENT_SETTINGS,
  ) {}

  /** Check, read and keep one upload. Nothing is kept when it is refused. */
  async upload(
    scope: AttachmentScope,
    input: { name: string; mediaType: string; bytes: Uint8Array; preview?: Uint8Array | null },
  ): Promise<AttachmentView> {
    const name = cleanName(input.name);
    const kind = attachmentKindFor(name, input.mediaType);
    if (!kind) {
      const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1];
      throw new ServiceError(
        'attachment_type',
        `${extension ? `Melete can't read .${extension.toLowerCase()} files.` : `Melete can't read ${name}.`} ${ATTACHMENT_TYPES_SENTENCE}`,
        415,
      );
    }
    if (input.bytes.length === 0)
      throw new ServiceError('attachment_empty', `${name} is empty.`, 400);
    if (input.bytes.length > this.settings.fileBytes)
      throw tooLarge(name, input.bytes.length, this.settings.fileBytes);
    if (!looksLike(kind.kind, input.bytes, kind.type))
      throw new ServiceError(
        'attachment_unreadable',
        `${name} doesn't look like ${KIND_NAMES[kind.kind]}, so Melete can't read it.`,
        400,
      );
    let preview: Uint8Array | null = null;
    if (kind.kind === 'image') {
      const given = input.preview ?? null;
      if (given && given.length > 0) {
        const previewType = sniffImage(given);
        if (!previewType || given.length > ATTACHMENT_LIMITS.model_image_bytes)
          throw new ServiceError(
            'attachment_preview',
            `The small copy of ${name} is not a picture of at most ${attachmentSize(ATTACHMENT_LIMITS.model_image_bytes)}.`,
            400,
          );
        preview = given;
      } else if (
        MODEL_IMAGE_TYPES.has(kind.type) &&
        input.bytes.length <= ATTACHMENT_LIMITS.model_image_bytes
      )
        preview = input.bytes;
    }
    let extracted: { text: string | null; pages: number | null };
    try {
      extracted = await extractBounded(kind.kind, input.bytes);
    } catch (error) {
      if (error instanceof ReadersBusy) throw new ServiceError(error.code, error.message, 429);
      // Anything else the reading threw is still this file being unreadable, said plainly.
      if (!(error instanceof UnreadableFile))
        console.error(`attachment: reading ${kind.kind} failed: ${describe(error)}`);
      throw new ServiceError(
        'attachment_unreadable',
        `Melete couldn't read ${name}: ${error instanceof UnreadableFile ? error.message : 'the file could not be read'}.`,
        400,
      );
    }
    const id = newId('file');
    for (let attempt = 0; ; attempt++) {
      const original = await this.put(input.bytes, name);
      const small = preview ? await this.put(preview, name) : null;
      try {
        const row = await this.sql.begin(async (tx) => {
          const [inserted] = await tx<AttachmentRecord[]>`insert into attachment
              (id, space_id, principal_id, name, media_type, kind, size, blob_key, preview_key, text, pages)
            values (${id}, ${scope.spaceId}, ${scope.principalId}, ${name}, ${kind.type}, ${kind.kind},
              ${input.bytes.length}, ${original.key}, ${small?.key ?? null}, ${extracted.text},
              ${extracted.pages})
            returning *`;
          await referenceBlobs(tx, this.store, small ? [original, small] : [original], {
            kind: ATTACHMENT_OWNER,
            id,
          });
          return inserted;
        });
        if (!row) throw new Error('the attachment row was not written');
        void this.sweepUnsent(scope).catch((error: unknown) =>
          console.error(`attachment: sweeping unsent files failed: ${describe(error)}`),
        );
        return attachmentRowView(fromRecord(row));
      } catch (error) {
        // The bytes went between the put and the reference; put them again once.
        if (!(error instanceof BlobNotFound) || attempt > 0) throw error;
      }
    }
  }

  private async put(bytes: Uint8Array, name: string): Promise<StoredBlob> {
    try {
      return await this.store.put(bytes, { maxBytes: this.settings.fileBytes });
    } catch (error) {
      if (error instanceof BlobTooLarge)
        throw tooLarge(name, bytes.length, this.settings.fileBytes);
      throw error;
    }
  }

  /** A file the person may see: their own unsent one, or one sent in a chat of theirs. */
  async visible(scope: AttachmentScope, id: string): Promise<AttachmentRow> {
    const rows = await this.sql<AttachmentRecord[]>`select a.* from attachment a
      left join job j on j.id = a.job_id
      where a.id = ${id} and a.space_id = ${scope.spaceId}
        and ((a.job_id is null and a.principal_id is not distinct from ${scope.principalId})
          or (a.job_id is not null and j.space_id = ${scope.spaceId}
            and (${scope.principalId}::text is null
              or coalesce(j.principal_id, (select id from owner limit 1)) = ${scope.principalId})))`;
    const row = rows[0];
    if (!row) throw notFound();
    return fromRecord(row);
  }

  /** The bytes of a file, or of its small copy, checked against the key they are kept under. */
  async content(
    scope: AttachmentScope,
    id: string,
    variant: 'original' | 'preview' = 'original',
  ): Promise<{ row: AttachmentRow; bytes: Uint8Array; mediaType: string }> {
    const row = await this.visible(scope, id);
    const key = variant === 'preview' ? row.previewKey : row.blobKey;
    if (!key) throw notFound();
    const bytes = await readBlob(this.store, key as BlobKey).catch(() => {
      throw notFound();
    });
    const mediaType = variant === 'preview' ? (sniffImage(bytes) ?? row.mediaType) : row.mediaType;
    return { row, bytes, mediaType };
  }

  /**
   * A file sent in this job's chat, for the agent to save into its workspace:
   * the job's own, or its conversation's when the job runs under one. Any
   * other job's file is not there.
   */
  async forJob(jobId: string, id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
    const [row] = await this.sql<{ name: string; blob_key: string }[]>`select a.name, a.blob_key
      from attachment a
      where a.id = ${id}
        and a.job_id in (select id from job where id = ${jobId}
          union select experience_parent_id from job where id = ${jobId}
            and experience_parent_id is not null)`;
    if (!row) return null;
    return { name: row.name, bytes: await readBlob(this.store, row.blob_key as BlobKey) };
  }

  /** Take back a file not sent yet. A sent one goes with its chat. */
  async remove(scope: AttachmentScope, id: string): Promise<void> {
    const row = await this.visible(scope, id);
    if (row.jobId !== null)
      throw new ServiceError(
        'attachment_sent',
        'This file was sent in a chat. Deleting the chat deletes it.',
        409,
      );
    // Only while it is still unsent: a send that bound it meanwhile keeps it.
    if (!(await this.deleteUnsent([row.id])).length)
      throw new ServiceError(
        'attachment_sent',
        'This file was sent in a chat. Deleting the chat deletes it.',
        409,
      );
  }

  /** Files uploaded and never sent, older than a day, by this person. */
  async sweepUnsent(scope: AttachmentScope): Promise<number> {
    const cutoff = new Date(Date.now() - UNSENT_ATTACHMENT_MS);
    const rows = await this.sql<{ id: string }[]>`select id from attachment
      where space_id = ${scope.spaceId} and job_id is null
        and principal_id is not distinct from ${scope.principalId} and created_at < ${cutoff.toISOString()}::timestamptz
      limit 100`;
    if (!rows.length) return 0;
    return (await this.deleteUnsent(rows.map((row) => row.id))).length;
  }

  /** The files sent in these chats' turns, by turn, in the order they were sent. */
  async forTurns(jobId: string): Promise<Map<string, AttachmentView[]>> {
    const rows = await this.sql<AttachmentRecord[]>`select * from attachment
      where job_id = ${jobId} and turn_id is not null order by turn_id, position, id`;
    const byTurn = new Map<string, AttachmentView[]>();
    for (const record of rows) {
      const row = fromRecord(record);
      const list = byTurn.get(row.turnId as string) ?? [];
      list.push(attachmentRowView(row));
      byTurn.set(row.turnId as string, list);
    }
    return byTurn;
  }

  /**
   * Delete those of these files that are still unsent, their references, and
   * every blob nothing else refers to. "Still unsent" is checked by the delete
   * itself, so a file a concurrent send has just bound is left alone.
   */
  async deleteUnsent(ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const { gone, keys } = await this.sql.begin(async (tx) => {
      const deleted = await tx<{ id: string }[]>`delete from attachment
        where id = any(${[...ids]}) and job_id is null returning id`;
      const gone = deleted.map((row) => row.id);
      const refs = gone.length
        ? await tx<{ key: BlobKey }[]>`delete from blob_ref
            where owner_kind = ${ATTACHMENT_OWNER} and owner_id = any(${gone}) returning key`
        : [];
      return { gone, keys: [...new Set(refs.map((row) => row.key))] };
    });
    await purgeUnreferenced(this.sql, this.store, keys);
    return gone;
  }
}

/**
 * Give these files to the chat a message is being accepted into, inside that
 * transaction. Each must be the speaker's own, in the chat's space, and not
 * sent before; one that is not refuses the message.
 */
export async function bindAttachments(
  tx: Transaction,
  input: {
    jobId: string;
    spaceId: string;
    principalId: string | null;
    ids: readonly string[];
    /** The operator's files per message; never above the ceiling. */
    perMessage?: number;
  },
): Promise<SentAttachment[]> {
  const ids = [...new Set(input.ids)];
  // Every way a message arrives binds its files here, so the number is checked here.
  const most = Math.min(
    input.perMessage ?? ATTACHMENT_LIMITS.per_message,
    ATTACHMENT_LIMITS.per_message_ceiling,
  );
  if (ids.length !== input.ids.length || ids.length > most)
    throw new ServiceError(
      'attachments_invalid',
      `A message can carry up to ${most} files, each once.`,
      400,
    );
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(attachment)
    .where(and(inArray(attachment.id, ids), isNull(attachment.jobId)))
    .for('update');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sent: SentAttachment[] = [];
  for (const [position, id] of ids.entries()) {
    const row = byId.get(id);
    if (!row || row.spaceId !== input.spaceId || row.principalId !== input.principalId)
      throw unavailable();
    await tx
      .update(attachment)
      .set({ jobId: input.jobId, sentAt: new Date(), position })
      .where(eq(attachment.id, id));
    sent.push({
      id,
      name: row.name,
      media_type: row.mediaType,
      kind: row.kind as AttachmentKind,
      size: row.size,
      pages: row.pages,
    });
  }
  return sent;
}

/** Name the turn a sent message's files belong to. */
export async function attachTurn(
  tx: Transaction,
  jobId: string,
  ids: readonly string[],
  turnId: string,
): Promise<void> {
  if (!ids.length) return;
  await tx
    .update(attachment)
    .set({ turnId })
    .where(and(eq(attachment.jobId, jobId), inArray(attachment.id, [...ids])));
}

/** What the next attempt's prompt is built from: each sent file's text, by id. */
export async function attachmentTexts(
  tx: Transaction,
  jobIds: readonly string[],
): Promise<Map<string, AttachmentRow>> {
  if (!jobIds.length) return new Map();
  const rows = await tx
    .select()
    .from(attachment)
    .where(inArray(attachment.jobId, [...jobIds]))
    .orderBy(asc(attachment.createdAt));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Delete attachment rows and their blob references inside a transaction, and
 * answer the keys they referred to, for `purgeUnreferenced` once it commits.
 */
export async function releaseAttachments(
  tx: TransactionSql,
  ids: readonly string[],
): Promise<BlobKey[]> {
  if (!ids.length) return [];
  const list = [...ids];
  const rows = await tx<{ key: BlobKey }[]>`delete from blob_ref
    where owner_kind = ${ATTACHMENT_OWNER} and owner_id = any(${list}) returning key`;
  await tx`delete from attachment where id = any(${list})`;
  return [...new Set(rows.map((row) => row.key))];
}

/** The same for every file sent in these chats, before the chats themselves go. */
export async function releaseJobAttachments(
  tx: TransactionSql,
  jobIds: readonly string[],
): Promise<BlobKey[]> {
  if (!jobIds.length) return [];
  const rows = await tx<
    { id: string }[]
  >`select id from attachment where job_id = any(${[...jobIds]})`;
  return releaseAttachments(
    tx,
    rows.map((row) => row.id),
  );
}

/**
 * Delete each blob no reference names any more, now rather than at the next
 * collection: a deleted chat's files should not outlive it by a week. Each key
 * is locked as the collector locks it, so a new reference to the same bytes,
 * made meanwhile, keeps them.
 */
export async function purgeUnreferenced(
  sql: Sql,
  store: BlobStore,
  keys: readonly BlobKey[],
): Promise<number> {
  let deleted = 0;
  for (const key of [...new Set(keys)].sort())
    await sql.begin(async (tx) => {
      await lockBlobKey(tx, key, 'exclusive');
      const [row] = await tx<{ present: boolean }[]>`select exists (
          select 1 from blob_ref where key = ${key}) as present`;
      if (row?.present) return;
      await store.delete(key);
      deleted++;
    });
  return deleted;
}

const KIND_NAMES: Record<AttachmentKind, string> = {
  image: 'a picture',
  pdf: 'a PDF',
  docx: 'a Word document',
  xlsx: 'a spreadsheet',
  csv: 'a CSV file',
  text: 'a text file',
};

function tooLarge(name: string, bytes: number, limitBytes: number): ServiceError {
  return new ServiceError('attachment_too_large', attachmentTooLarge(name, bytes, limitBytes), 413);
}

/** The type of a picture the gateway can forward, from its bytes; null for anything else. */
export function sniffImage(bytes: Uint8Array): string | null {
  for (const type of MODEL_IMAGE_TYPES) if (looksLike('image', bytes, type)) return type;
  return null;
}

/** A row as postgres.js returns it, snake case. */
type AttachmentRecord = {
  id: string;
  space_id: string;
  principal_id: string | null;
  job_id: string | null;
  turn_id: string | null;
  position: number;
  name: string;
  media_type: string;
  kind: string;
  size: number;
  blob_key: string;
  preview_key: string | null;
  text: string | null;
  pages: number | null;
  created_at: Date;
  sent_at: Date | null;
};

function fromRecord(record: AttachmentRecord): AttachmentRow {
  return {
    id: record.id,
    spaceId: record.space_id,
    principalId: record.principal_id,
    jobId: record.job_id,
    turnId: record.turn_id,
    position: record.position,
    name: record.name,
    mediaType: record.media_type,
    kind: record.kind,
    size: record.size,
    blobKey: record.blob_key,
    previewKey: record.preview_key,
    text: record.text,
    pages: record.pages,
    createdAt: new Date(record.created_at),
    sentAt: record.sent_at ? new Date(record.sent_at) : null,
  };
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
