/**
 * Files in the message box: chosen with the paperclip, dropped on the box or
 * pasted into it. Each is checked here first (what kind it is, how large) so a
 * refusal is a plain sentence at once, then uploaded on its own. The limits
 * come from the service; where the operator limits uploads at once, the rest
 * wait their turn, and otherwise a few run together; the message
 * names the uploaded files when it is sent. A picture also gets a small copy,
 * made here, which is what a model that reads pictures is shown.
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

export type PendingFile = {
  /** This box's own name for the file, stable while it uploads. */
  key: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** A local picture to show while it uploads, for a picture. */
  thumb: string | null;
  state: 'uploading' | 'ready' | 'failed';
  view: AttachmentView | null;
  error: string | null;
};

/** The longest side of the copy of a picture a model is shown. */
const MODEL_EDGE = 1280;
const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

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
    return `${extension ? `Melete can't read .${extension.toLowerCase()} files.` : `Melete can't read ${file.name || 'that file'}.`} ${ATTACHMENT_TYPES_SENTENCE}`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > limits.file_bytes)
    return attachmentTooLarge(file.name, file.size, limits.file_bytes);
  return null;
}

/** The address of a file sent, or about to be sent, or of a picture's small copy. */
export const attachmentUrl = (id: string, preview = false) =>
  `${API_BASE_URL}/attachments/${encodeURIComponent(id)}/content${preview ? '?variant=preview' : ''}`;

/**
 * A JPEG of the picture at most MODEL_EDGE on its longest side, made smaller
 * until it fits what one model request may carry. Null when the browser cannot
 * draw the picture; the service then uses the picture itself if it is small.
 */
export async function modelCopy(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    let scale = Math.min(1, MODEL_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let round = 0; round < 6; round++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      // A transparent picture gets a white ground rather than black.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const blob = await new Promise<Blob | null>((done) =>
          canvas.toBlob(done, 'image/jpeg', quality),
        );
        if (blob && blob.size <= ATTACHMENT_LIMITS.model_image_bytes) return blob;
      }
      scale *= 0.7;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/** Upload one file, with a picture's small copy beside it. */
export async function uploadAttachment(
  file: File,
  preview: Blob | null,
): Promise<Result<AttachmentView>> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (preview) form.append('preview', preview, 'preview.jpg');
  try {
    const { 'content-type': _ignored, ...headers } = (client.options.headers ?? {}) as Record<
      string,
      string
    >;
    const response = await client.options.fetch(`${API_BASE_URL}/attachments`, {
      method: 'POST',
      headers,
      credentials: client.options.credentials,
      body: form,
    });
    const body = (await response.json().catch(() => null)) as {
      attachment?: AttachmentView;
      error?: { message?: string };
    } | null;
    if (!response.ok || !body?.attachment)
      return { data: null, error: body?.error?.message ?? OFFLINE, unavailable: null };
    return { data: body.attachment, error: null, unavailable: null };
  } catch {
    return { data: null, error: OFFLINE, unavailable: null };
  }
}

/** Take back an uploaded file that was not sent. Failing quietly is fine: it is swept after a day. */
export async function removeAttachment(id: string): Promise<void> {
  try {
    await client.options.fetch(`${API_BASE_URL}/attachments/${encodeURIComponent(id)}`, {
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

/** The files in one message box, as they upload. */
export function useAttachments() {
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

  // Local pictures are let go when the box goes.
  useEffect(
    () => () => {
      for (const file of live.current) if (file.thumb) URL.revokeObjectURL(file.thumb);
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
          // A file taken out while it waited is never sent.
          const result = await queued(async () =>
            kept(pending.key) ? uploadAttachment(file, preview) : null,
          );
          if (!result) return;
          if (!kept(pending.key)) {
            // Removed while it uploaded.
            if (result.data) void removeAttachment(result.data.id);
            return;
          }
          if (result.data) update(pending.key, { state: 'ready', view: result.data });
          else update(pending.key, { state: 'failed', error: result.error });
        })();
    },
    [update, limits],
  );

  const remove = useCallback((key: string) => {
    const file = live.current.find((entry) => entry.key === key);
    if (!file) return;
    gone.current.add(key);
    if (file.thumb) URL.revokeObjectURL(file.thumb);
    if (file.view) void removeAttachment(file.view.id);
    setFiles((current) => current.filter((entry) => entry.key !== key));
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
  return { files, problem, add, remove, clear, restore, uploading, ready, setProblem };
}

export type AttachmentsControl = ReturnType<typeof useAttachments>;
