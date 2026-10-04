/**
 * Uploading a file for a message, reading it back, and taking back one not
 * sent yet. The space and the person come from the session, never from the
 * request. The whole service always bounds the uploads it holds in flight, by
 * number and by bytes, since each is held in memory while it is read; past
 * that, an upload is asked to come back in a moment. One person may hold at
 * most half of either, so nobody can keep everyone else out; the client reads
 * that number from `GET /attachments/limits` and queues to it. How many one
 * person may start in a while is limited only where the operator sets it.
 */
import { attachmentContentQuery, attachmentResponse, attachmentSize } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { SpaceResolver } from '../api/reactions.ts';
import { type LimitStore, MemoryLimitStore } from '../ops/limiter.ts';
import { requestPrincipal } from '../principals/authority.ts';
import {
  attachmentLimitsView,
  personUploadsAtOnce,
  UPLOAD_FORM_OVERHEAD,
  uploadBounds,
} from './limits.ts';
import type { AttachmentScope, AttachmentService } from './store.ts';

export function mountAttachments(
  app: Hono,
  attachments: AttachmentService,
  resolveSpace: SpaceResolver,
  /** Where upload counts are kept, shared by every instance; left out, this process counts. */
  limits: LimitStore = new MemoryLimitStore(),
): void {
  const { fileBytes, uploadRate, serverUploads } = attachments.settings;
  // Room for at least one file at the largest size, whatever the setting, and
  // one person's share of what the service holds: half, never less than one file.
  const { largest, bytes: byteBudget, personBytes } = uploadBounds(attachments.settings);
  const personUploads = personUploadsAtOnce(attachments.settings);
  /** Each person's uploads in flight, and the bytes they declared. */
  const underWay = new Map<string, { count: number; bytes: number }>();
  /** Every upload this service holds in flight, from everyone, and the bytes they declared. */
  const held = { count: 0, bytes: 0 };
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
    if (declared > fileBytes + UPLOAD_FORM_OVERHEAD)
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
    const mine = underWay.get(who) ?? { count: 0, bytes: 0 };
    // A body without a declared length is counted at the most it may be.
    const bytes = declared > 0 ? declared : largest;
    if (mine.count >= personUploads)
      throw new ServiceError(
        'attachment_busy',
        `You can upload ${personUploads} files at a time. Wait for one to finish, then try again.`,
        429,
      );
    if (mine.bytes + bytes > personBytes)
      throw new ServiceError(
        'attachment_busy',
        'Melete is still reading your other files. Wait for one to finish, then try again.',
        429,
      );
    if (held.count >= serverUploads || held.bytes + bytes > byteBudget)
      throw new ServiceError(
        'attachment_server_busy',
        'Melete is busy reading other files. Try again in a moment.',
        503,
      );
    held.count++;
    held.bytes += bytes;
    underWay.set(who, { count: mine.count + 1, bytes: mine.bytes + bytes });
    try {
      if (!(await counted(who)))
        throw new ServiceError(
          'attachment_rate',
          'You have uploaded a lot of files in the last few minutes. Try again shortly.',
          429,
        );
      return await receive(c, scope);
    } finally {
      held.count--;
      held.bytes -= bytes;
      const left = underWay.get(who) ?? { count: 1, bytes };
      if (left.count > 1) underWay.set(who, { count: left.count - 1, bytes: left.bytes - bytes });
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
