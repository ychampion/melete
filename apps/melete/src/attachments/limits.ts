/**
 * What files this installation takes, from the operator's settings. The size
 * of one file and the files per message have defaults; uploads per person are
 * not limited unless the operator sets a limit, so a self-hosted install never
 * refuses a person for uploading. docs/DEPLOYMENT.md, "Attachments".
 *
 * The bounds on reading a file (time, memory, pages, archive size) are not
 * here: they protect the service from crafted files and are not settings.
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
};

/** An installation whose operator has set nothing. */
export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  fileBytes: ATTACHMENT_LIMITS.file_bytes,
  perMessage: ATTACHMENT_LIMITS.per_message,
  uploadsAtOnce: null,
  uploadRate: null,
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
  };
}

/** The settings as `GET /attachments/limits` gives them to a client. */
export function attachmentLimitsView(settings: AttachmentSettings): AttachmentLimits {
  return {
    file_bytes: settings.fileBytes,
    per_message: settings.perMessage,
    uploads_at_once: settings.uploadsAtOnce,
  };
}
