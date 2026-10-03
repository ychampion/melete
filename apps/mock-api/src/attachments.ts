/**
 * Files in chat, without a blob store: the routes answer as the service does,
 * in shape and in refusals, and keep what is uploaded in memory. A message
 * that names uploaded files carries them on its turn.
 */
import { randomUUID } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES_SENTENCE,
  type AttachmentView,
  attachmentKindFor,
  attachmentResponse,
  attachmentTooLarge,
  DEFAULT_ATTACHMENT_LIMITS,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { ExperienceMock } from './experience.ts';

export type MockAttachment = {
  view: AttachmentView;
  bytes: Uint8Array;
  preview: Uint8Array | null;
  sent: boolean;
};

export function mountAttachmentsMock(app: Hono, experience: ExperienceMock): void {
  const fail = (
    c: Context,
    status: 400 | 401 | 404 | 409 | 413 | 415,
    code: string,
    message: string,
  ) => c.json({ error: { code, message } }, status);
  const signedOut = (c: Context) =>
    experience.signedOut ? fail(c, 401, 'unauthorized', 'A session is required.') : null;

  // A self-hosted install by default: one person's share is half of the service's 16.
  app.get(
    '/attachments/limits',
    (c) => signedOut(c) ?? c.json({ ...DEFAULT_ATTACHMENT_LIMITS, uploads_at_once: 8 }),
  );

  app.post('/attachments', async (c) => {
    const refused = signedOut(c);
    if (refused) return refused;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File))
      return fail(c, 400, 'invalid_request', 'Send the file in the field named file.');
    const name =
      file.name.split(/[\\/]/).pop()?.slice(0, ATTACHMENT_LIMITS.name_characters) || 'file';
    const kind = attachmentKindFor(name, file.type);
    if (!kind) {
      const extension = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1];
      return fail(
        c,
        415,
        'attachment_type',
        `${extension ? `Melete can't read .${extension.toLowerCase()} files.` : `Melete can't read ${name}.`} ${ATTACHMENT_TYPES_SENTENCE}`,
      );
    }
    if (file.size === 0) return fail(c, 400, 'attachment_empty', `${name} is empty.`);
    if (file.size > ATTACHMENT_LIMITS.file_bytes)
      return fail(c, 413, 'attachment_too_large', attachmentTooLarge(name, file.size));
    const preview = form?.get('preview');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const small =
      preview instanceof File
        ? new Uint8Array(await preview.arrayBuffer())
        : kind.kind === 'image' && bytes.length <= ATTACHMENT_LIMITS.model_image_bytes
          ? bytes
          : null;
    const view = attachmentResponse.shape.attachment.parse({
      id: `file_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
      name,
      media_type: kind.type,
      kind: kind.kind,
      size: bytes.length,
      pages: kind.kind === 'pdf' ? Math.max(1, countPages(bytes)) : null,
      has_preview: kind.kind === 'image' && small !== null,
      has_text: kind.kind !== 'image',
      created_at: new Date().toISOString(),
    });
    experience.attachments.set(view.id, { view, bytes, preview: small, sent: false });
    return c.json(attachmentResponse.parse({ attachment: view }), 201);
  });

  app.get('/attachments/:id/content', (c) => {
    const refused = signedOut(c);
    if (refused) return refused;
    const entry = experience.attachments.get(c.req.param('id'));
    const preview = c.req.query('variant') === 'preview';
    const bytes = entry ? (preview ? entry.preview : entry.bytes) : null;
    if (!entry || !bytes) return fail(c, 404, 'not_found', 'No such file.');
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': preview ? sniff(bytes) : entry.view.media_type,
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(entry.view.name)}`,
      },
    });
  });

  app.delete('/attachments/:id', (c) => {
    const refused = signedOut(c);
    if (refused) return refused;
    const entry = experience.attachments.get(c.req.param('id'));
    if (!entry) return fail(c, 404, 'not_found', 'No such file.');
    if (entry.sent)
      return fail(
        c,
        409,
        'attachment_sent',
        'This file was sent in a chat. Deleting the chat deletes it.',
      );
    experience.attachments.delete(entry.view.id);
    return c.json({ ok: true });
  });
}

function countPages(bytes: Uint8Array): number {
  return (
    Buffer.from(bytes)
      .toString('latin1')
      .match(/\/Type\s*\/Page(?![a-z])/g)?.length ?? 0
  );
}

function sniff(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}
