/**
 * The gateway's view of the files people sent: a picture's small copy and a
 * PDF's bytes, for the job a request belongs to and nothing else.
 */
import type { Sql } from 'postgres';
import type { GatewayAttachments, ModelFile } from '../gateway/attachments.ts';
import { type BlobKey, type BlobStore, readBlob } from '../storage/blob.ts';
import { sniffImage } from './store.ts';

export function gatewayAttachments(
  sql: Sql,
  store: BlobStore,
  vision: (provider: string, model: string) => Promise<boolean>,
): GatewayAttachments {
  return {
    vision,
    async files(jobId, ids, kinds) {
      const found = new Map<string, ModelFile>();
      if (!ids.length) return found;
      // The job's own files, or its conversation's when the job runs under one.
      const rows = await sql<
        {
          id: string;
          kind: string;
          name: string;
          media_type: string;
          size: number;
          blob_key: string;
          preview_key: string | null;
          pages: number | null;
        }[]
      >`select a.id, a.kind, a.name, a.media_type, a.size, a.blob_key, a.preview_key, a.pages
        from attachment a
        where a.id = any(${[...ids]})
          and a.job_id in (select id from job where id = ${jobId}
            union select experience_parent_id from job where id = ${jobId} and experience_parent_id is not null)`;
      for (const row of rows) {
        if (row.kind === 'image' && kinds.image && row.preview_key) {
          const data = await readBlob(store, row.preview_key as BlobKey).catch(missing(row.id));
          const mediaType = data ? sniffImage(data) : null;
          if (data && mediaType)
            found.set(row.id, {
              id: row.id,
              kind: 'image',
              name: row.name,
              mediaType,
              data,
              pages: null,
            });
        } else if (row.kind === 'pdf' && kinds.pdf && row.size <= kinds.maxPdfBytes) {
          const data = await readBlob(store, row.blob_key as BlobKey).catch(missing(row.id));
          if (data)
            found.set(row.id, {
              id: row.id,
              kind: 'pdf',
              name: row.name,
              mediaType: 'application/pdf',
              data,
              pages: row.pages,
            });
        }
      }
      return found;
    },
  };
}

/** A file whose bytes could not be read keeps its text in the request; the operator hears why. */
const missing = (id: string) => (error: unknown) => {
  console.error(
    `attachment ${id}: its bytes could not be read for a model request: ${error instanceof Error ? error.message : String(error)}`,
  );
  return null;
};
