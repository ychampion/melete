/**
 * The Drive a Google sign-in grants, read as metadata only: a file's name and
 * type, when it last changed and who changed it, whether it is shared or in
 * the bin. Never a file's contents; the scope it holds cannot read them.
 *
 * It serves three readers:
 *
 * - the signal poller, through `signals`: Drive's own change feed from a page
 *   token, so each read lists only what changed since the last one;
 * - a deadline's fresh check, through `subjects`: one file looked up as it is
 *   now, by its id;
 * - the agent, through one read tool, `documents.status`.
 *
 * It writes nothing to Drive.
 */
import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  VerifyResult,
} from '@melete/contracts';
import { z } from 'zod';
import {
  type DocumentChange,
  type DocumentFile,
  type DocumentRead,
  retryAfterOf,
  type SignalSource,
  SourceError,
  type SubjectReader,
} from '../signals/types.ts';
import { googleErrorReason } from './google.ts';
import { signInEnded } from './mail-transport.ts';
import { bearerRequest, boundedJson, type SignedInAccess } from './signed-in.ts';
import type { Connector, ConnectorContext } from './types.ts';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Changes asked for per page; a read takes up to its limit, a page at a time. */
const PAGE_SIZE = 100;
const RATE_LIMITED = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'];

/** The metadata asked for: nothing that holds a file's words but its name. */
const FILE_FIELDS =
  'id,name,mimeType,modifiedTime,modifiedByMeTime,lastModifyingUser(displayName,me),shared,trashed,version,driveId';

/** A Drive file id: letters, digits, `-` and `_`. */
const FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;

/**
 * The file id in what a person pastes: the id itself, or a Docs, Sheets,
 * Slides or Drive link to it. Null when it names no file.
 */
export function driveFileId(input: string): string | null {
  const value = input.trim();
  if (FILE_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !['docs.google.com', 'drive.google.com'].includes(url.hostname.toLowerCase())
  )
    return null;
  const inPath = /\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  const candidate = inPath ?? url.searchParams.get('id') ?? '';
  return FILE_ID.test(candidate) ? candidate : null;
}

export const driveManifest: ConnectorManifest = {
  name: 'drive',
  version: '0.1.0',
  provider: 'drive',
  description:
    'Notice changes to the files in a signed-in Google Drive, by name, time and sharing, never their contents.',
  credentials: [
    {
      key: 'sign_in',
      description: 'The tokens of an account sign-in, sealed in the service.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'documents.status',
      description:
        'A Google Drive file as it is now: its name and type, when it last changed and whether the person or someone else changed it, and whether it is shared or in the bin. Takes the file id or its link. Never reads the contents.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            maxLength: 2048,
            description: 'The file id, or a docs.google.com or drive.google.com link to it.',
          },
        },
      },
      effect_class: 'read',
      required_scopes: ['documents.status'],
      verify: false,
      requires_approval: false,
    },
  ],
};

const statusPayload = z.object({ file: z.string().min(1).max(2048) }).strict();

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  modifiedByMeTime?: string;
  lastModifyingUser?: { displayName?: string; me?: boolean };
  shared?: boolean;
  trashed?: boolean;
  version?: string | number;
  driveId?: string;
};

const instant = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
};

/** A Drive file as Melete keeps it. Null when it carries no usable id. */
export function driveFile(file: DriveFile | null | undefined): DocumentFile | null {
  if (!file || typeof file.id !== 'string' || !file.id) return null;
  return {
    id: file.id,
    name: typeof file.name === 'string' ? file.name : '',
    mime_type: typeof file.mimeType === 'string' ? file.mimeType : '',
    modified_time: instant(file.modifiedTime),
    modified_by_me_time: instant(file.modifiedByMeTime),
    last_modifier_me:
      typeof file.lastModifyingUser?.me === 'boolean' ? file.lastModifyingUser.me : null,
    last_modifier:
      typeof file.lastModifyingUser?.displayName === 'string'
        ? file.lastModifyingUser.displayName
        : null,
    shared: file.shared === true,
    trashed: file.trashed === true,
    version:
      typeof file.version === 'string' || typeof file.version === 'number'
        ? String(file.version)
        : null,
    drive_id: typeof file.driveId === 'string' && file.driveId ? file.driveId : null,
  };
}

/**
 * What a refused Drive answer becomes. Google says "slow down" as a 403 with a
 * rate-limit reason as often as a 429; both are read as a request to wait.
 */
async function driveError(response: Response): Promise<SourceError> {
  const retryAfter = retryAfterOf(response);
  if (response.status !== 403) {
    await response.body?.cancel().catch(() => {});
    return new SourceError(response.status, retryAfter);
  }
  const reason = googleErrorReason(await boundedJson(response, 64 * 1024).catch(() => null));
  return new SourceError(RATE_LIMITED.includes(reason ?? '') ? 429 : 403, retryAfter);
}

export class GoogleDriveConnector implements Connector {
  readonly manifest = driveManifest;

  constructor(
    private readonly config: {
      id: string;
      spaceId: string;
      /** `.../drive/v3`. */
      base: string;
      access: SignedInAccess;
      fetcher?: typeof fetch;
    },
  ) {}

  private request(path: string, signal?: AbortSignal): Promise<Response> {
    return bearerRequest(
      this.config.access,
      `${this.config.base}${path}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
      this.config.fetcher,
    );
  }

  /** One file as it is now; `gone` when Drive no longer has it for this account. */
  async file(id: string, signal?: AbortSignal): Promise<DocumentFile | 'gone'> {
    if (!FILE_ID.test(id)) return 'gone';
    const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const response = await this.request(`/files/${id}?${query}`, signal);
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      return 'gone';
    }
    if (!response.ok) throw await driveError(response);
    return driveFile((await boundedJson(response, MAX_RESPONSE_BYTES)) as DriveFile) ?? 'gone';
  }

  private async startToken(): Promise<string> {
    const response = await this.request('/changes/startPageToken?supportsAllDrives=true');
    if (!response.ok) throw await driveError(response);
    const answer = (await boundedJson(response, 64 * 1024)) as { startPageToken?: unknown } | null;
    if (typeof answer?.startPageToken !== 'string' || !answer.startPageToken)
      throw new SourceError(502);
    return answer.startPageToken;
  }

  /**
   * Drive's change feed. A first read takes the current page token and lists
   * nothing: watching starts now. Each later read lists what changed since,
   * a page at a time, up to `limit`; one stopped by its limit resumes where
   * it stopped. A page token Drive no longer honours starts again from now.
   */
  readonly signals: SignalSource = {
    stream: 'documents',
    changes: async (cursor, options): Promise<DocumentRead> => {
      if (cursor === null) return { cursor: await this.startToken(), changes: [], complete: true };
      const changes: DocumentChange[] = [];
      let token = cursor;
      while (changes.length < options.limit) {
        const query = new URLSearchParams({
          pageToken: token,
          pageSize: String(Math.min(PAGE_SIZE, options.limit - changes.length)),
          includeRemoved: 'true',
          supportsAllDrives: 'true',
          // Shared drives only when a followed file is in one.
          ...(options.allDrives ? { includeItemsFromAllDrives: 'true' } : {}),
          fields: `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,file(${FILE_FIELDS}))`,
        });
        const response = await this.request(`/changes?${query}`);
        if (response.status === 404 || response.status === 410) {
          await response.body?.cancel().catch(() => {});
          return { cursor: await this.startToken(), changes: [], complete: true };
        }
        if (!response.ok) throw await driveError(response);
        const page = (await boundedJson(response, MAX_RESPONSE_BYTES)) as {
          changes?: {
            changeType?: string;
            removed?: boolean;
            fileId?: string;
            file?: DriveFile;
          }[];
          nextPageToken?: string;
          newStartPageToken?: string;
        } | null;
        for (const entry of page?.changes ?? []) {
          // A shared drive's own settings changing is not a file changing.
          if (entry.changeType && entry.changeType !== 'file') continue;
          const fileId = typeof entry.fileId === 'string' ? entry.fileId : entry.file?.id;
          if (!fileId || !FILE_ID.test(fileId)) continue;
          const file = entry.removed ? null : driveFile(entry.file);
          changes.push({ file_id: fileId, removed: entry.removed === true || !file, file });
        }
        if (page?.newStartPageToken)
          return { cursor: page.newStartPageToken, changes, complete: true };
        if (!page?.nextPageToken) throw new SourceError(502);
        token = page.nextPageToken;
      }
      return { cursor: token, changes, complete: false };
    },
  };

  /** A deadline's fresh look at one file, by the id it was set on. */
  readonly subjects: SubjectReader = {
    read: async ({ ref }) => {
      const found = ref ? await this.file(ref) : 'gone';
      if (found === 'gone' || found.trashed) return 'gone';
      return {
        file_id: found.id,
        modified_time: found.modified_time,
        modified_by_me_time: found.modified_by_me_time,
        last_modifier_me: found.last_modifier_me,
        shared: found.shared,
        trashed: found.trashed,
        version: found.version,
      };
    },
  };

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.config.id ||
      ctx.space_id !== this.config.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    )
      throw new Error('Drive action context mismatch');
    ctx.signal?.throwIfAborted();
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    this.assertContext(action, ctx);
    if (action.kind !== 'documents.status')
      return { outcome: 'failed', reason: 'Unsupported Drive tool.', retryable: false };
    const payload = statusPayload.parse(action.canonical_payload);
    const id = driveFileId(payload.file);
    if (!id)
      return {
        outcome: 'failed',
        reason: 'That is not a Google Drive file id or link.',
        retryable: false,
      };
    let found: DocumentFile | 'gone';
    try {
      found = await this.file(id, ctx.signal);
    } catch {
      return { outcome: 'failed', reason: 'Drive could not be read just now.', retryable: true };
    }
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: id,
        detail:
          found === 'gone'
            ? { found: false }
            : {
                found: true,
                name: found.name,
                mime_type: found.mime_type,
                modified_time: found.modified_time,
                modified_by_me_time: found.modified_by_me_time,
                last_modifier: found.last_modifier,
                last_modifier_me: found.last_modifier_me,
                shared: found.shared,
                trashed: found.trashed,
              },
        received_at: new Date().toISOString(),
        late: false,
      },
    };
  }

  async verify(): Promise<VerifyResult> {
    return { decision: 'undecided', reason: 'A Drive read changes nothing to verify.' };
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = () => new Date().toISOString();
    try {
      const response = await this.request('/about?fields=user(emailAddress)');
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        return {
          status: 'failing',
          detail: 'Drive connection unavailable.',
          checked_at: checkedAt(),
          reason: 'credential_refused',
        };
      if (!response.ok) throw new Error('Drive unavailable');
      return { status: 'ok', detail: 'Drive is available.', checked_at: checkedAt() };
    } catch (error) {
      return {
        status: 'failing',
        detail: 'Drive connection unavailable.',
        checked_at: checkedAt(),
        ...(signInEnded(error) ? { reason: 'sign_in_required' as const } : {}),
      };
    }
  }
}
