/**
 * Files a person hands the agent in chat: pictures, PDFs, Word documents,
 * spreadsheets and text files.
 *
 * A file is uploaded on its own first, before the message that carries it, so
 * the message box can show it while the person is still writing. It is kept
 * in the service's blob store, in the person's space, and belongs to the chat
 * the message is sent in; deleting the chat deletes it. It never lands in a
 * folder the agent can write to unless the agent saves a copy there itself.
 *
 * What the model is given: the words of a document as text (pages marked for
 * a PDF, rows for a spreadsheet), and a picture as a picture only when the
 * model reads pictures. A file's content is untrusted data, never
 * instructions, whatever it says.
 *
 * Every limit here is one the interface states in a sentence when a file is
 * refused.
 */
import { z } from 'zod';
import { MAX_IMAGE_ENCODED_BYTES } from './model-vision.ts';

export const ATTACHMENT_LIMITS = {
  /** The largest file one upload may carry. */
  file_bytes: 20 * 1024 * 1024,
  /** The most files one message may carry. */
  per_message: 10,
  /**
   * The uploads one person may have under way at once. The service refuses
   * more; the message box queues the rest so a person never sees that refusal.
   */
  uploads_at_once: 3,
  /**
   * The largest copy of a picture the model is shown: its base64 text fits the
   * gateway's per-picture limit exactly. The browser makes this copy (at most
   * `VISION_IMAGE_MAX_EDGE` on its longest side); the service checks it.
   */
  model_image_bytes: Math.floor((MAX_IMAGE_ENCODED_BYTES * 3) / 4),
  /** How much of a message's files' text goes into the model's prompt with it. */
  prompt_characters: 48_000,
  /** The most text kept from one file, for the prompt and for later reads. */
  stored_characters: 1_000_000,
  /** The longest file name kept. */
  name_characters: 200,
} as const;

/** What the service makes of a file it accepts. */
export const ATTACHMENT_KINDS = ['image', 'pdf', 'docx', 'xlsx', 'csv', 'text'] as const;
export const attachmentKind = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKind>;

/** The media types each kind is stored as, the first being the one a file is given. */
const MEDIA_TYPES: Record<AttachmentKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv'],
  text: ['text/plain', 'text/markdown'],
};

const EXTENSIONS: Record<string, { kind: AttachmentKind; type: string }> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  webp: { kind: 'image', type: 'image/webp' },
  gif: { kind: 'image', type: 'image/gif' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  docx: { kind: 'docx', type: MEDIA_TYPES.docx[0] as string },
  xlsx: { kind: 'xlsx', type: MEDIA_TYPES.xlsx[0] as string },
  csv: { kind: 'csv', type: 'text/csv' },
  txt: { kind: 'text', type: 'text/plain' },
  text: { kind: 'text', type: 'text/plain' },
  md: { kind: 'text', type: 'text/markdown' },
  markdown: { kind: 'text', type: 'text/markdown' },
};

/** The `accept` list for a file picker: every type and extension above. */
export const ATTACHMENT_ACCEPT = [
  ...Object.values(MEDIA_TYPES).flat(),
  ...Object.keys(EXTENSIONS).map((extension) => `.${extension}`),
].join(',');

/**
 * What kind of file this is and the media type it is kept as, from its name and
 * the type the browser gave it, or null for a file Melete does not read. A
 * browser often gives no type for Markdown or CSV, so the name decides then.
 * The bytes are checked again where they are read.
 */
export function attachmentKindFor(
  name: string,
  mediaType: string,
): { kind: AttachmentKind; type: string } | null {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  for (const kind of ATTACHMENT_KINDS) if (MEDIA_TYPES[kind].includes(type)) return { kind, type };
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return EXTENSIONS[extension] ?? null;
}

/** A sentence naming what Melete reads, for a file it refused. */
export const ATTACHMENT_TYPES_SENTENCE =
  'Melete can read pictures (PNG, JPEG, WebP, GIF), PDFs, Word documents (.docx), spreadsheets (.xlsx, .csv) and text files (.txt, .md).';

/** A size for a person to read: "340 KB", "4.2 MB". */
export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** The sentence a file over the size limit is refused with. */
export function attachmentTooLarge(name: string, bytes: number): string {
  const limit = attachmentSize(ATTACHMENT_LIMITS.file_bytes);
  const size = attachmentSize(bytes);
  return `Files can be up to ${limit}. ${name} is ${size === limit ? 'larger' : size}.`;
}

/** One file as the person sees it: on a sent message, or in the box before sending. */
export const attachmentView = z.strictObject({
  id: z.string().min(1).max(240),
  name: z.string().min(1).max(ATTACHMENT_LIMITS.name_characters),
  media_type: z.string().min(1).max(200),
  kind: attachmentKind,
  size: z.number().int().nonnegative(),
  /** Pages in a PDF, sheets in a spreadsheet; null for other kinds. */
  pages: z.number().int().nonnegative().nullable(),
  /** Whether a small copy of the picture can be shown as a thumbnail. */
  has_preview: z.boolean(),
  /** Whether any text could be read from it. Always false for a picture. */
  has_text: z.boolean(),
  created_at: z.string(),
});
export type AttachmentView = z.infer<typeof attachmentView>;

export const attachmentResponse = z.strictObject({ attachment: attachmentView });

/** Which copy of a file to read: the file itself, or the small copy a picture has. */
export const attachmentContentQuery = z.strictObject({
  variant: z.enum(['original', 'preview']).optional(),
});
