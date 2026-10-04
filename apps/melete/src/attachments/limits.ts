/**
 * What files this installation takes, from the operator's settings. The size
 * of one file and the files per message have defaults; uploads per person are
 * not limited unless the operator sets a limit, so a self-hosted install never
 * refuses a person for uploading. docs/DEPLOYMENT.md, "Attachments".
 *
 * Two bounds protect the service itself rather than share it out between
 * people, so they are always on: how many uploads the whole service holds in
 * flight, and how many bytes they may hold between them. The bounds on reading
 * a file (time, memory, pages, archive size) are not here: they protect the
 * service from crafted files and are not settings.
 */
import { ATTACHMENT_LIMITS, type AttachmentLimits } from '@melete/contracts';
import type { Env } from '../env.ts';

export type AttachmentSettings = {
  /** The largest file one upload may carry. */
  fileBytes: number;
  /** The most files one message may carry. */
  perMessage: number;
  /** Uploads one person may have under way at once; null is no limit. */
  uploadsAtOnce: number | null;
  /** Uploads one person may start in a window; null is no limit. */
  uploadRate: { count: number; windowMs: number } | null;
  /** Uploads the whole service holds in flight at once, from everyone. */
  serverUploads: number;
  /** Bytes those uploads may hold between them while they are read. */
  serverUploadBytes: number;
};

/** Uploads the service holds in flight at once when the operator sets nothing. */
export const SERVER_UPLOADS_DEFAULT = 16;
/** Their bytes between them, in MB, when the operator sets nothing. */
export const SERVER_UPLOAD_MB_DEFAULT = 384;

/** Room in one upload for the small copy of a picture and the form's own framing. */
export const UPLOAD_FORM_OVERHEAD = ATTACHMENT_LIMITS.model_image_bytes + 64 * 1024;

/**
 * What the service holds in flight, from everyone and for one person: one
 * person's share is half of each, never less than one file at the largest size.
 */
export function uploadBounds(settings: AttachmentSettings) {
  const largest = settings.fileBytes + UPLOAD_FORM_OVERHEAD;
  const bytes = Math.max(settings.serverUploadBytes, largest);
  const personBytes = Math.max(Math.floor(bytes / 2), largest);
  return { largest, bytes, personBytes };
}

/** An installation whose operator has set nothing. */
export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  fileBytes: ATTACHMENT_LIMITS.file_bytes,
  perMessage: ATTACHMENT_LIMITS.per_message,
  uploadsAtOnce: null,
  uploadRate: null,
  serverUploads: SERVER_UPLOADS_DEFAULT,
  serverUploadBytes: SERVER_UPLOAD_MB_DEFAULT * 1024 * 1024,
};

export function attachmentSettingsFromEnv(env: Env): AttachmentSettings {
  return {
    fileBytes: env.MELETE_ATTACHMENT_MAX_MB * 1024 * 1024,
    perMessage: env.MELETE_ATTACHMENTS_PER_MESSAGE,
    uploadsAtOnce: env.MELETE_ATTACHMENT_UPLOADS_AT_ONCE ?? null,
    uploadRate: env.MELETE_ATTACHMENT_UPLOADS_PER_WINDOW
      ? {
          count: env.MELETE_ATTACHMENT_UPLOADS_PER_WINDOW,
          windowMs: env.MELETE_ATTACHMENT_UPLOAD_WINDOW_MINUTES * 60 * 1000,
        }
      : null,
    serverUploads: env.MELETE_ATTACHMENT_SERVER_UPLOADS,
    serverUploadBytes: env.MELETE_ATTACHMENT_SERVER_UPLOAD_MB * 1024 * 1024,
  };
}

/**
 * Uploads one person may have in flight at once. Whatever the operator sets,
 * nobody may hold more than half of what the service holds, so one person
 * uploading a lot never keeps everyone else out. This is fairness, not a
 * quota: the client queues to this number and never sees it refused.
 */
export function personUploadsAtOnce(settings: AttachmentSettings): number {
  const { largest, personBytes } = uploadBounds(settings);
  // Files at the largest size that fit one person's share of the bytes.
  const share = Math.min(Math.floor(settings.serverUploads / 2), Math.floor(personBytes / largest));
  return Math.max(1, Math.min(settings.uploadsAtOnce ?? share, share));
}

/** The settings as `GET /attachments/limits` gives them to a client. */
export function attachmentLimitsView(settings: AttachmentSettings): AttachmentLimits {
  return {
    file_bytes: settings.fileBytes,
    per_message: settings.perMessage,
    uploads_at_once: personUploadsAtOnce(settings),
  };
}
