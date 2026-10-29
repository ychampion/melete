/** Mail pictures use the same storage and model previews as files sent in chat. */
import type { AttachmentView } from '@melete/contracts';
import type { Sql } from 'postgres';
import type { MailReadOptions } from '../connectors/email.ts';
import type { ConnectorContext } from '../connectors/types.ts';
import type { BlobStore } from '../storage/blob.ts';
import { type AttachmentSettings, DEFAULT_ATTACHMENT_SETTINGS } from './limits.ts';
import { type AttachmentScope, AttachmentService } from './store.ts';

/** The persistence boundary, with job ownership rechecked when an upload is bound. */
export type MailImagePersistence = {
  scope(ctx: ConnectorContext): Promise<AttachmentScope | null>;
  upload(
    scope: AttachmentScope,
    file: { name: string; mediaType: string; bytes: Uint8Array },
  ): Promise<Pick<AttachmentView, 'id' | 'kind' | 'has_preview'>>;
  bind(ctx: ConnectorContext, scope: AttachmentScope, id: string): Promise<boolean>;
  discard(ids: readonly string[]): Promise<void>;
};

/** Keep one picture only if its requesting job still has the ownership read before upload. */
export function createMailImageReader(
  persistence: MailImagePersistence,
): NonNullable<MailReadOptions['image']> {
  return async (ctx, file) => {
    ctx.signal?.throwIfAborted();
    const scope = await persistence.scope(ctx);
    if (!scope || scope.spaceId !== ctx.space_id) throw new Error('Mail picture job unavailable');
    const uploaded = await persistence.upload(scope, {
      name: file.name,
      mediaType: file.media_type,
      bytes: file.content,
    });
    try {
      ctx.signal?.throwIfAborted();
      if (uploaded.kind !== 'image' || !uploaded.has_preview)
        throw new Error('Mail picture has no copy within the model image limit');
      if (!(await persistence.bind(ctx, scope, uploaded.id)))
        throw new Error('Mail picture job changed while the file was read');
      return uploaded.id;
    } catch (error) {
      // Failure to clean up leaves an unsent upload for the ordinary collector.
      await persistence.discard([uploaded.id]).catch(() => {});
      throw error;
    }
  };
}

export function mailImageReader(
  sql: Sql,
  store: BlobStore,
  settings: AttachmentSettings = DEFAULT_ATTACHMENT_SETTINGS,
): NonNullable<MailReadOptions['image']> {
  const attachments = new AttachmentService(sql, store, settings);
  return createMailImageReader({
    async scope(ctx) {
      const [job] = await sql<{ principal_id: string | null }[]>`select principal_id from job
        where id = ${ctx.job_id} and space_id = ${ctx.space_id}`;
      return job ? { spaceId: ctx.space_id, principalId: job.principal_id } : null;
    },
    upload: (scope, file) => attachments.upload(scope, file),
    bind: (ctx, scope, id) =>
      sql.begin(async (tx) => {
        const [job] = await tx`select id from job
          where id = ${ctx.job_id} and space_id = ${ctx.space_id}
            and principal_id is not distinct from ${scope.principalId}
          for update`;
        if (!job) return false;
        const [bound] = await tx`update attachment set job_id = ${ctx.job_id}, sent_at = now()
          where id = ${id} and space_id = ${ctx.space_id}
            and principal_id is not distinct from ${scope.principalId}
            and job_id is null and room_message_id is null
          returning id`;
        return Boolean(bound);
      }),
    discard: async (ids) => {
      await attachments.deleteUnsent(ids);
    },
  });
}
