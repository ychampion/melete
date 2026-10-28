/**
 * Files in the message box: chosen with the paperclip, dropped on the box or
 * pasted into it. Each is checked here first (what kind it is, how large) so a
 * refusal is a plain sentence at once, then uploaded on its own. The limits
 * come from the service; where the operator limits uploads at once, the rest
 * wait their turn, and otherwise a few run together; the message
 * names the uploaded files when it is sent. A picture also gets a copy made
 * here, large enough to read its small print, which is what a model that reads
 * pictures is shown.
 */
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES_SENTENCE,
  type AttachmentKind,
  type AttachmentLimits,
  type AttachmentView,
  attachmentKindFor,
  attachmentTooLarge,
  DEFAULT_ATTACHMENT_LIMITS,
} from '@melete/contracts/attachments';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL, client, type Result } from '../experience/adapter.ts';
import { assistantName, instanceName } from '../experience/instance.ts';

export type PendingFile = {
  /** This box's own name for the file, stable while it uploads. */
  key: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** A local picture to show while it uploads, for a picture. */
  thumb: string | null;
  /** `retrying` waits to be tried again on its own; `failed` has stopped trying. */
  state: 'uploading' | 'ready' | 'retrying' | 'failed';
  view: AttachmentView | null;
  error: string | null;
};

const offline = () => `Couldn’t reach ${instanceName()}. Check that the service is running.`;
const tryingAgain = () => `Couldn’t reach ${instanceName()}. Trying again…`;

/**
 * How long an upload that could not reach the service waits before each new
 * try, in milliseconds: long enough for the service to come back after a
 * restart, and then it stops and says so.
 */
export const UPLOAD_RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/**
 * Uploads run together when the service sets no limit: enough to keep a
 * picked handful moving without the browser opening a dozen at once.
 */
export const BROWSER_UPLOADS_AT_ONCE = 4;

/** Why this file cannot be attached, in a sentence; null when it can. */
export function refusal(
  file: File,
  already: number,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): string | null {
  if (already >= limits.per_message)
    return `A message can carry up to ${limits.per_message} files.`;
  if (!attachmentKindFor(file.name, file.type)) {
    const extension = /\.([A-Za-z0-9]{1,10})$/.exec(file.name)?.[1];
    return `${extension ? `${assistantName()} can't read .${extension.toLowerCase()} files.` : `${assistantName()} can't read ${file.name || 'that file'}.`} ${ATTACHMENT_TYPES_SENTENCE}`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > limits.file_bytes)
    return attachmentTooLarge(file.name, file.size, limits.file_bytes);
  return null;
}

/**
 * The address of a file sent, or about to be sent, or of a picture's small
 * copy. `base` names where the file lives when it is not the person's own
 * chat: a room's files are under `/rooms/{id}`.
 */
export const attachmentUrl = (id: string, preview = false, base = '') =>
  `${API_BASE_URL}${base}/attachments/${encodeURIComponent(id)}/content${preview ? '?variant=preview' : ''}`;

/**
 * The qualities a copy is tried at, at each size, best first. Detail goes in
 * quality before it goes in pixels: a smaller picture loses the small print of
 * a receipt or a page first, and a model then reads it wrong.
 */
const COPY_QUALITIES = [0.85, 0.75, 0.65, 0.5, 0.4] as const;
/** How much smaller each size tried is than the one before, when no quality fits. */
const COPY_SHRINK = 0.8;

/** Encodes the picture at a size; null when it cannot. */
export type CopyEncoder = (
  width: number,
  height: number,
  type: 'image/png' | 'image/jpeg',
  quality: number,
) => Promise<Blob | null>;

/**
 * The copy a model is shown: at most `model_image_edge` on its longest side and
 * `model_image_bytes` in size. A screenshot or other PNG stays lossless when it
 * fits; otherwise a JPEG, at the best quality that fits, at the full size before
 * any smaller one. Null when no copy fits.
 */
export async function fitForModel(
  width: number,
  height: number,
  encode: CopyEncoder,
  options: { lossless?: boolean; maxBytes?: number; maxEdge?: number } = {},
): Promise<Blob | null> {
  const maxBytes = options.maxBytes ?? ATTACHMENT_LIMITS.model_image_bytes;
  let scale = Math.min(
    1,
    (options.maxEdge ?? ATTACHMENT_LIMITS.model_image_edge) / Math.max(width, height),
  );
  for (let round = 0; round < 6; round++) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (round === 0 && options.lossless) {
      const png = await encode(w, h, 'image/png', 1);
      if (png && png.size <= maxBytes) return png;
    }
    for (const quality of COPY_QUALITIES) {
      const blob = await encode(w, h, 'image/jpeg', quality);
      if (blob && blob.size <= maxBytes) return blob;
    }
    scale *= COPY_SHRINK;
  }
  return null;
}

/**
 * The copy of a picture a model is shown (see `fitForModel`). Null when the
 * browser cannot draw the picture; the service then uses the picture itself if
 * it is small enough.
 */
export async function modelCopy(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    // The photo the right way up, as the camera recorded it.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    return await fitForModel(
      bitmap.width,
      bitmap.height,
      async (width, height, type, quality) => {
        let drawn = canvas;
        if (!drawn || drawn.width !== width || drawn.height !== height) {
          drawn = document.createElement('canvas');
          drawn.width = width;
          drawn.height = height;
          const context = drawn.getContext('2d');
          if (!context) return null;
          // A transparent picture gets a white ground rather than black.
          context.fillStyle = '#fff';
          context.fillRect(0, 0, width, height);
          context.imageSmoothingQuality = 'high';
          context.drawImage(bitmap, 0, 0, width, height);
          canvas = drawn;
        }
        const ready = drawn;
        return new Promise<Blob | null>((done) => ready.toBlob(done, type, quality));
      },
      { lossless: file.type === 'image/png' },
    );
  } finally {
    bitmap.close();
  }
}

/** Upload one file, with a picture's small copy beside it. */
export async function uploadAttachment(
  file: File,
  preview: Blob | null,
  base = '',
): Promise<Result<AttachmentView>> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (preview) form.append('preview', preview, 'preview.jpg');
  try {
    const { 'content-type': _ignored, ...headers } = (client.options.headers ?? {}) as Record<
      string,
      string
    >;
    const response = await client.options.fetch(`${API_BASE_URL}${base}/attachments`, {
      method: 'POST',
      headers,
      credentials: client.options.credentials,
      body: form,
    });
    const body = (await response.json().catch(() => null)) as UploadAnswer;
    return uploadResult(response.status, body);
  } catch {
    return uploadResult(null, null);
  }
}

type UploadAnswer = { attachment?: AttachmentView; error?: { message?: string } } | null;

/**
 * What an upload's answer means: the file, a refusal that says why, or the
 * service out of reach (no answer, or one from a service that is down), which
 * is tried again. A service that is up but failing says why in its own words,
 * shown once the tries are spent.
 */
export function uploadResult(status: number | null, body: UploadAnswer): Result<AttachmentView> {
  if (status !== null && status < 300 && body?.attachment)
    return { data: body.attachment, error: null, unavailable: null };
  if (status !== null && status < 500 && body?.error?.message)
    return { data: null, error: body.error.message, unavailable: null };
  return { data: null, error: null, unavailable: body?.error?.message || offline() };
}

/** How long to wait before trying an upload again after `tried` tries; undefined to stop. */
export function nextUploadTry(result: Result<AttachmentView>, tried: number): number | undefined {
  return result.unavailable ? UPLOAD_RETRY_DELAYS[tried] : undefined;
}

/** A file's state after a try that did not upload it, and how long until the next try. */
export function afterFailedTry(
  result: Result<AttachmentView>,
  tried: number,
): { state: PendingFile['state']; error: string | null; wait: number | undefined } {
  const wait = nextUploadTry(result, tried);
  return wait === undefined
    ? { state: 'failed', error: result.error ?? result.unavailable, wait }
    : { state: 'retrying', error: tryingAgain(), wait };
}

/** The line under the box about its files; null when there is nothing to say. */
export function fileNote(
  problem: string | null,
  files: readonly Pick<PendingFile, 'state'>[],
): string | null {
  if (problem) return problem;
  return files.some((file) => file.state === 'failed')
    ? 'A file didn’t upload. Remove it to send, or attach it again.'
    : null;
}

/**
 * Open the original of a room's file on purpose (`POST .../original`): in a
 * room that shows only what needs you, the open is noted in its activity
 * before the file is sent. Answers the file and the name it was sent under.
 */
export async function openOriginal(
  id: string,
  base: string,
): Promise<Result<{ blob: Blob; name: string }>> {
  try {
    const response = await client.options.fetch(
      `${API_BASE_URL}${base}/attachments/${encodeURIComponent(id)}/original`,
      {
        method: 'POST',
        headers: client.options.headers as Record<string, string>,
        credentials: client.options.credentials,
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as UploadAnswer;
      return response.status < 500 && body?.error?.message
        ? { data: null, error: body.error.message, unavailable: null }
        : { data: null, error: null, unavailable: body?.error?.message || offline() };
    }
    const named = /filename\*=UTF-8''([^;]+)/i.exec(
      response.headers.get('content-disposition') ?? '',
    );
    let name = 'original';
    try {
      if (named?.[1]) name = decodeURIComponent(named[1]);
    } catch {
      // A name that does not decode is not needed to save the file.
    }
    return { data: { blob: await response.blob(), name }, error: null, unavailable: null };
  } catch {
    return { data: null, error: null, unavailable: offline() };
  }
}

/** Take back an uploaded file that was not sent. Failing quietly is fine: it is swept after a day. */
export async function removeAttachment(id: string, base = ''): Promise<void> {
  try {
    await client.options.fetch(`${API_BASE_URL}${base}/attachments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: client.options.headers as Record<string, string>,
      credentials: client.options.credentials,
    });
  } catch {
    // Swept by the service later.
  }
}

/**
 * Runs the tasks given to it, at most `limit()` at a time, in the order given;
 * the rest wait for a place. Shared by every box on the page, since the
 * service counts one person's uploads, not one box's.
 */
export function queueOf(limit: () => number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (running >= limit()) return;
    const start = waiting.shift();
    if (!start) return;
    running++;
    start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
}

/** What this installation takes, once read; the defaults until then. */
let limitsNow: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS;
let limitsRead: Promise<AttachmentLimits> | null = null;

/** Read the installation's limits once per page; the defaults if it cannot be reached. */
export function attachmentLimits(): Promise<AttachmentLimits> {
  limitsRead ??= (async () => {
    try {
      const response = await client.options.fetch(`${API_BASE_URL}/attachments/limits`, {
        headers: client.options.headers as Record<string, string>,
        credentials: client.options.credentials,
      });
      if (response.ok) limitsNow = (await response.json()) as AttachmentLimits;
      else limitsRead = null;
    } catch {
      limitsRead = null;
    }
    return limitsNow;
  })();
  return limitsRead;
}

const queued = queueOf(() => limitsNow.uploads_at_once ?? BROWSER_UPLOADS_AT_ONCE);

let counter = 0;

/** The files in one message box, as they upload: to the person's own chat, or under `base`. */
export function useAttachments(base = '') {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [limits, setLimits] = useState(limitsNow);
  useEffect(() => {
    let current = true;
    void attachmentLimits().then((read) => {
      if (current) setLimits(read);
    });
    return () => {
      current = false;
    };
  }, []);
  const live = useRef(files);
  live.current = files;
  /** Files taken out of the box; one still waiting or uploading is then let go. */
  const gone = useRef(new Set<string>());
  /** Tries of uploads waiting for the service to come back, so they stop with the box. */
  const retries = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Local pictures, and tries still waiting, are let go when the box goes.
  useEffect(
    () => () => {
      for (const file of live.current) if (file.thumb) URL.revokeObjectURL(file.thumb);
      for (const timer of retries.current.values()) clearTimeout(timer);
    },
    [],
  );

  const update = useCallback((key: string, change: Partial<PendingFile>) => {
    setFiles((current) =>
      current.map((file) => (file.key === key ? { ...file, ...change } : file)),
    );
  }, []);

  const add = useCallback(
    (chosen: readonly File[]) => {
      let count = live.current.length;
      const problems: string[] = [];
      const accepted: { file: File; pending: PendingFile }[] = [];
      for (const file of chosen) {
        const why = refusal(file, count, limits);
        if (why) {
          problems.push(why);
          continue;
        }
        count++;
        const kind = attachmentKindFor(file.name, file.type)?.kind ?? 'text';
        counter += 1;
        accepted.push({
          file,
          pending: {
            key: `file-${Date.now()}-${counter}`,
            name: file.name || 'Pasted picture',
            size: file.size,
            kind,
            thumb: kind === 'image' ? URL.createObjectURL(file) : null,
            state: 'uploading',
            view: null,
            error: null,
          },
        });
      }
      // One sentence at a time: the first refusal says what to change.
      setProblem(problems[0] ?? null);
      if (!accepted.length) return;
      setFiles((current) => [...current, ...accepted.map((entry) => entry.pending)]);
      const kept = (key: string) => !gone.current.has(key);
      for (const { file, pending } of accepted)
        void (async () => {
          const preview = pending.kind === 'image' ? await modelCopy(file) : null;
          const attempt = async (tried: number): Promise<void> => {
            retries.current.delete(pending.key);
            if (!kept(pending.key)) return;
            if (tried > 0) update(pending.key, { state: 'uploading', error: null });
            // A file taken out while it waited is never sent.
            const result = await queued(async () =>
              kept(pending.key) ? uploadAttachment(file, preview, base) : null,
            );
            if (!result) return;
            if (!kept(pending.key)) {
              // Removed while it uploaded.
              if (result.data) void removeAttachment(result.data.id, base);
              return;
            }
            if (result.data) {
              update(pending.key, { state: 'ready', view: result.data });
              return;
            }
            // The service could not be reached: tried again a few times on its own.
            const { wait, ...change } = afterFailedTry(result, tried);
            update(pending.key, change);
            if (wait !== undefined)
              retries.current.set(
                pending.key,
                setTimeout(() => void attempt(tried + 1), wait),
              );
          };
          await attempt(0);
        })();
    },
    [update, limits, base],
  );

  const remove = useCallback(
    (key: string) => {
      const file = live.current.find((entry) => entry.key === key);
      if (!file) return;
      gone.current.add(key);
      clearTimeout(retries.current.get(key));
      retries.current.delete(key);
      if (file.thumb) URL.revokeObjectURL(file.thumb);
      if (file.view) void removeAttachment(file.view.id, base);
      setFiles((current) => current.filter((entry) => entry.key !== key));
      setProblem(null);
    },
    [base],
  );

  /** Take out every file that did not upload, as a new chat starts without them. */
  const dropFailed = useCallback(() => {
    const notUploaded = (file: PendingFile) => file.state === 'failed' || file.state === 'retrying';
    for (const file of live.current) {
      if (!notUploaded(file)) continue;
      gone.current.add(file.key);
      clearTimeout(retries.current.get(file.key));
      retries.current.delete(file.key);
      if (file.thumb) URL.revokeObjectURL(file.thumb);
    }
    setFiles((current) => current.filter((entry) => !notUploaded(entry)));
    setProblem(null);
  }, []);

  /** Empty the box after a send; the files now belong to the message. */
  const clear = useCallback(() => {
    for (const file of live.current) if (file.thumb) URL.revokeObjectURL(file.thumb);
    setFiles([]);
    setProblem(null);
  }, []);

  /** Put files back after a send that failed, so nothing is lost. */
  const restore = useCallback((views: readonly AttachmentView[]) => {
    setFiles(
      views.map((view) => ({
        key: `file-${view.id}`,
        name: view.name,
        size: view.size,
        kind: view.kind,
        thumb: null,
        state: 'ready',
        view,
        error: null,
      })),
    );
  }, []);

  const uploading = files.some((file) => file.state === 'uploading');
  const ready = files.flatMap((file) => (file.state === 'ready' && file.view ? [file.view] : []));
  return {
    files,
    problem,
    add,
    remove,
    dropFailed,
    clear,
    restore,
    uploading,
    ready,
    setProblem,
  };
}

export type AttachmentsControl = ReturnType<typeof useAttachments>;
