/**
 * Uploading a file for a message, reading it back, and taking back one not
 * sent yet. The space and the person come from the session, never from the
 * request. How many uploads one person may have under way, or start in a
 * while, is limited only where the operator sets a limit.
 */
import {
  ATTACHMENT_LIMITS,
  attachmentContentQuery,
  attachmentResponse,
  attachmentSize,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { SpaceResolver } from '../api/reactions.ts';
import { type LimitStore, MemoryLimitStore } from '../ops/limiter.ts';
import { requestPrincipal } from '../principals/authority.ts';
import { attachmentLimitsView } from './limits.ts';
import type { AttachmentScope, AttachmentService } from './store.ts';

/** Room for the small copy of a picture and the form's own framing. */
const FORM_OVERHEAD = ATTACHMENT_LIMITS.model_image_bytes + 64 * 1024;

export function mountAttachments(
  app: Hono,
  attachments: AttachmentService,
  resolveSpace: SpaceResolver,
  /** Where upload counts are kept, shared by every instance; left out, this process counts. */
  limits: LimitStore = new MemoryLimitStore(),
): void {
  const { fileBytes, uploadsAtOnce, uploadRate } = attachments.settings;
  const underWay = new Map<string, number>();
  /** A fixed window: how many uploads this person started in it. True with no limit set. */
  const counted = async (key: string) => {
    if (!uploadRate) return true;
    return limits.update<{ count: number; started: number }, boolean>(
      'attachment-upload',
      key,
      Date.now(),
      (state) => {
        const now = Date.now();
        const live =
          state && now - state.started < uploadRate.windowMs ? state : { count: 0, started: now };
        if (live.count >= uploadRate.count)
          return { state: live, expiresAt: live.started + uploadRate.windowMs, result: false };
        const next = { count: live.count + 1, started: live.started };
        return { state: next, expiresAt: next.started + uploadRate.windowMs, result: true };
      },
    );
  };
  const scopeFor = async (c: Context): Promise<AttachmentScope> => {
    const scope = await resolveSpace(c);
    if (!scope) throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
    return { spaceId: scope.spaceId, principalId: requestPrincipal() ?? null };
  };

  app.get('/attachments/limits', async (c) => {
    await scopeFor(c);
    return c.json(attachmentLimitsView(attachments.settings));
  });

  app.post('/attachments', async (c) => {
    const scope = await scopeFor(c);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > fileBytes + FORM_OVERHEAD)
      throw new ServiceError(
        'attachment_too_large',
        `Files can be up to ${attachmentSize(fileBytes)}.`,
        413,
      );
    if (!/^multipart\/form-data/i.test(c.req.header('content-type') ?? ''))
      throw new ServiceError('invalid_request', 'Send the file as multipart/form-data.', 400);
    const who = `${scope.spaceId}:${scope.principalId ?? 'owner'}`;
    // Checked and counted together, before anything is awaited: parallel
    // uploads cannot all pass the check while none has been counted yet.
    const now = underWay.get(who) ?? 0;
    if (uploadsAtOnce !== null && now >= uploadsAtOnce)
      throw new ServiceError(
        'attachment_busy',
        `You can upload ${uploadsAtOnce} files at a time. Wait for one to finish, then try again.`,
        429,
      );
    underWay.set(who, now + 1);
    try {
      if (!(await counted(who)))
        throw new ServiceError(
          'attachment_rate',
          'You have uploaded a lot of files in the last few minutes. Try again shortly.',
          429,
        );
      return await receive(c, scope);
    } finally {
      const left = (underWay.get(who) ?? 1) - 1;
      if (left > 0) underWay.set(who, left);
      else underWay.delete(who);
    }
  });

  const receive = async (c: Context, scope: AttachmentScope) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ServiceError('invalid_request', 'The upload could not be read.', 400);
    }
    const file = form.get('file');
    if (!(file instanceof Blob))
      throw new ServiceError('invalid_request', 'Send the file in the field named file.', 400);
    const preview = form.get('preview');
    const view = await attachments.upload(scope, {
      // An empty part can arrive as a bare blob, with no name.
      name: file instanceof File && typeof file.name === 'string' ? file.name : '',
      mediaType: file.type ?? '',
      bytes: new Uint8Array(await file.arrayBuffer()),
      preview: preview instanceof Blob ? new Uint8Array(await preview.arrayBuffer()) : null,
    });
    return c.json(attachmentResponse.parse({ attachment: view }), 201);
  };

  app.get('/attachments/:id/content', async (c) => {
    const scope = await scopeFor(c);
    const query = attachmentContentQuery.safeParse(c.req.query());
    if (!query.success) throw new ServiceError('invalid_request', 'Unknown variant.', 400);
    const { row, bytes, mediaType } = await attachments.content(
      scope,
      c.req.param('id'),
      query.data.variant ?? 'original',
    );
    const inline = mediaType.startsWith('image/') || mediaType === 'application/pdf';
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        // A file someone sent is shown, never run: no script, no frames, no plugins.
        'content-security-policy':
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      },
    });
  });

  app.delete('/attachments/:id', async (c) => {
    await attachments.remove(await scopeFor(c), c.req.param('id'));
    return c.json({ ok: true as const });
  });
}
