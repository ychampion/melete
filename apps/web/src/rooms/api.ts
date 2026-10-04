/**
 * The rooms routes, through the same typed client as the rest of the app.
 * Every call names its room in the path; the service checks, on each one,
 * that the signed-in person is in that room now.
 */

import type { paths } from '@melete/client';
import { errorMessage, readSse } from '@melete/client';
import { client, type Result } from '../experience/adapter.ts';
import { plainError } from '../experience/plain.ts';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<P, M extends keyof P> = P[M] extends { responses: infer R }
  ? R extends Record<200, unknown>
    ? Json<R[200]>
    : R extends Record<201, unknown>
      ? Json<R[201]>
      : never
  : never;

export type RoomList = Ok<paths['/rooms'], 'get'>;
export type RoomSummary = RoomList['rooms'][number];
export type RoomDetail = Ok<paths['/rooms/{id}'], 'get'>;
export type RoomMember = RoomDetail['members'][number];
export type Person = Ok<paths['/people'], 'get'>['people'][number];
export type ThreadList = Ok<paths['/rooms/{id}/threads'], 'get'>;
export type RoomThread = ThreadList['threads'][number];
export type ThreadView = Ok<paths['/rooms/{id}/threads/{threadId}'], 'get'>;
export type RoomMessage = ThreadView['messages'][number];
export type RoomRequest = ThreadView['requests'][number];
export type Posted = Ok<paths['/rooms/{id}/threads/{threadId}/messages'], 'post'>;
export type Me = Ok<paths['/me'], 'get'>['owner'];
export type RoomPolicy = RoomDetail['policy'];
export type RoomPermission = NonNullable<RoomRequest['permissions']>[number];
export type RoomMemory = Ok<paths['/rooms/{id}/memory'], 'get'>;
export type RoomMemoryItem = RoomMemory['items'][number];
export type RoomShare = RoomMemory['shares'][number];
export type InviteList = Ok<paths['/rooms/{id}/invites'], 'get'>;
export type RoomInvite = InviteList['invites'][number];
export type InviteCreated = Ok<paths['/rooms/{id}/invites'], 'post'>;
export type InviteView = Ok<paths['/invites/view'], 'post'>;
export type Handoff = Ok<paths['/handoffs'], 'get'>['handoffs'][number];
export type RoomConnection = Ok<paths['/rooms/{id}/connections'], 'get'>['connections'][number];

/** One frame of a thread's live stream; its `seq` resumes the stream. */
export type RoomFrame =
  | { seq: number; kind: 'message'; message: RoomMessage }
  | { seq: number; kind: 'request'; request_job_id: string; event: unknown };

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';
const api = client.api;

async function call<T>(
  run: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
): Promise<Result<T> & { status?: number }> {
  try {
    const outcome = await run();
    if (outcome.data !== undefined)
      return { data: outcome.data as T, error: null, unavailable: null };
    return {
      data: null,
      error: plainError(errorMessage(outcome.error, OFFLINE)),
      unavailable: null,
      unauthorized: outcome.response?.status === 401,
      ...(outcome.response ? { status: outcome.response.status } : {}),
    };
  } catch {
    return { data: null, error: OFFLINE, unavailable: null };
  }
}

const room = (id: string) => ({ params: { path: { id } } });
const thread = (id: string, threadId: string) => ({ params: { path: { id, threadId } } });

export const roomsApi = {
  me: () => call<{ owner: Me }>(() => api.GET('/me')),
  rename: (display_name: string | null) =>
    call<{ owner: Me & { display_name: string | null } }>(() =>
      api.PATCH('/me', { body: { display_name } }),
    ),
  list: () => call<RoomList>(() => api.GET('/rooms')),
  create: (name: string, purpose: string) =>
    call<RoomDetail>(() =>
      api.POST('/rooms', { body: purpose.trim() ? { name, purpose } : { name } }),
    ),
  detail: (id: string) => call<RoomDetail>(() => api.GET('/rooms/{id}', room(id))),
  /** The accounts in the room's space; owners also see those kept for their own work. */
  connections: (id: string) =>
    call<{ connections: RoomConnection[] }>(() => api.GET('/rooms/{id}/connections', room(id))),
  people: (query: string) =>
    call<{ people: Person[] }>(() =>
      api.GET('/people', { params: { query: query.trim() ? { query } : {} } }),
    ),
  addMember: (id: string, principal_id: string) =>
    call<{ member: RoomMember }>(() =>
      api.POST('/rooms/{id}/members', { ...room(id), body: { principal_id } }),
    ),
  /** An owner removes someone, or a person removes themselves to leave. */
  removeMember: (id: string, principalId: string) =>
    call<{ removed: string }>(() =>
      api.DELETE('/rooms/{id}/members/{principalId}', {
        params: { path: { id, principalId } },
      }),
    ),
  threads: (id: string) => call<ThreadList>(() => api.GET('/rooms/{id}/threads', room(id))),
  startThread: (id: string, text: string, askAgent: boolean, key: string) =>
    call<Posted>(() =>
      api.POST('/rooms/{id}/threads', {
        ...room(id),
        body: { text, ask_agent: askAgent, submission_id: key },
      }),
    ),
  thread: (id: string, threadId: string) =>
    call<ThreadView>(() => api.GET('/rooms/{id}/threads/{threadId}', thread(id, threadId))),
  post: (id: string, threadId: string, text: string, key: string) =>
    call<Posted>(() =>
      api.POST('/rooms/{id}/threads/{threadId}/messages', {
        ...thread(id, threadId),
        body: { text, submission_id: key },
      }),
    ),
  stop: (id: string, jobId: string) =>
    call<{ request: RoomRequest }>(() =>
      api.POST('/rooms/{id}/requests/{jobId}/stop', { params: { path: { id, jobId } } }),
    ),
  presence: (id: string) =>
    call<{ present: string[] }>(() => api.POST('/rooms/{id}/presence', room(id))),

  /* ---------- how the room works, and who answers its permissions ---------- */
  setPolicy: (id: string, change: Partial<RoomPolicy>) =>
    call<{ policy: RoomPolicy }>(() =>
      api.PUT('/rooms/{id}/policy', { ...room(id), body: change }),
    ),
  /** Answer a permission for exactly the content the card shows. */
  answer: (id: string, permission: RoomPermission, option: 'allow_once' | 'deny') =>
    call<{ status: 'ok'; option: 'allow_once' | 'deny' }>(() =>
      api.POST('/rooms/{id}/approvals/{approvalId}', {
        params: { path: { id, approvalId: permission.id } },
        body: { option, version: permission.version, payload_hash: permission.payload_hash ?? '' },
      }),
    ),

  /* ---------- what the room remembers, and what people shared into it ---------- */
  memory: (id: string) => call<RoomMemory>(() => api.GET('/rooms/{id}/memory', room(id))),
  forget: (id: string, claimId: string) =>
    call<{ forgotten: string }>(() =>
      api.POST('/rooms/{id}/memory/{claimId}/forget', { params: { path: { id, claimId } } }),
    ),
  deleteMessage: (id: string, messageId: string) =>
    call<{ message: RoomMessage }>(() =>
      api.DELETE('/rooms/{id}/messages/{messageId}', { params: { path: { id, messageId } } }),
    ),
  share: (id: string, claimId: string, membersOnly: boolean) =>
    call<{ share: RoomShare }>(() =>
      api.POST('/rooms/{id}/shares', {
        ...room(id),
        body: { claim_id: claimId, members_only: membersOnly },
      }),
    ),
  withdrawShare: (id: string, shareId: string) =>
    call<{ withdrawn: string }>(() =>
      api.DELETE('/rooms/{id}/shares/{shareId}', { params: { path: { id, shareId } } }),
    ),

  /* ---------- guests ---------- */
  invites: (id: string) => call<InviteList>(() => api.GET('/rooms/{id}/invites', room(id))),
  invite: (id: string, email: string, days: number) =>
    call<InviteCreated>(() =>
      api.POST('/rooms/{id}/invites', {
        ...room(id),
        body: { email, expires_in_days: days },
      }),
    ),
  withdrawInvite: (id: string, inviteId: string) =>
    call<{ invite: RoomInvite }>(() =>
      api.DELETE('/rooms/{id}/invites/{inviteId}', { params: { path: { id, inviteId } } }),
    ),
  viewInvite: (token: string) =>
    call<InviteView>(() => api.POST('/invites/view', { body: { token } })),
  acceptInvite: (token: string, password: string | null, displayName: string | null) =>
    call<{ room_id: string }>(() =>
      api.POST('/invites/accept', {
        body: {
          token,
          ...(password ? { password } : {}),
          ...(displayName?.trim() ? { display_name: displayName.trim() } : {}),
        },
      }),
    ),

  /* ---------- tasks a room hands the person, on their own Home ---------- */
  decideHandoff: (handoff: Handoff, decision: 'accept' | 'decline') =>
    call<{ handoff: Handoff }>(() =>
      api.POST('/handoffs/{id}', {
        params: { path: { id: handoff.id } },
        body:
          decision === 'accept'
            ? { decision: 'accept', task_hash: handoff.task_hash }
            : { decision: 'decline' },
      }),
    ),
  handoffResult: (handoff: Handoff, decision: 'share' | 'keep') =>
    call<{ handoff: Handoff }>(() =>
      api.POST('/handoffs/{id}/result', {
        params: { path: { id: handoff.id } },
        body:
          decision === 'share'
            ? { decision: 'share', result_hash: handoff.result_hash ?? '' }
            : { decision: 'keep' },
      }),
    ),
};

/**
 * The address an invite opens. The service gives a full link when it knows its
 * public address; otherwise the path, which opens on this same page's address.
 */
export function inviteLink(created: { link: string | null; path: string }, origin: string): string {
  if (created.link) return created.link;
  return `${origin.replace(/\/+$/, '')}${created.path.startsWith('/') ? '' : '/'}${created.path}`;
}

/** What following a thread yields: a frame, or that the stream (re)opened or ended for good. */
export type ThreadSignal =
  | { type: 'frame'; frame: RoomFrame }
  | { type: 'open' }
  | { type: 'gone' }
  | { type: 'signed_out' };

/**
 * Follow a thread's live frames, resuming from the last seq seen after a drop.
 * A 403 or 404 means the person is no longer in the room (or the thread is
 * gone), and following ends there rather than retrying.
 */
export async function* followThread(
  roomId: string,
  threadId: string,
  signal: AbortSignal,
): AsyncGenerator<ThreadSignal, void, void> {
  let cursor = 0;
  let attempt = 0;
  while (!signal.aborted) {
    attempt += 1;
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 2), 8000)));
      if (signal.aborted) return;
    }
    let body: ReadableStream<Uint8Array>;
    try {
      const response = await client.options.fetch(
        `${client.options.baseUrl}/rooms/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(threadId)}/events`,
        {
          headers: {
            ...client.options.headers,
            Accept: 'text/event-stream',
            ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
          },
          credentials: client.options.credentials,
          signal,
        },
      );
      if (response.status === 403 || response.status === 404) {
        yield { type: 'gone' };
        return;
      }
      // A session that ended needs a new sign-in; retrying cannot bring it back.
      if (response.status === 401) {
        yield { type: 'signed_out' };
        return;
      }
      if (!response.ok || !response.body) continue;
      body = response.body;
    } catch {
      if (signal.aborted) return;
      continue;
    }
    attempt = 1;
    yield { type: 'open' };
    try {
      for await (const raw of readSse(body)) {
        if (raw.comment) continue;
        let frame: RoomFrame;
        try {
          frame = JSON.parse(raw.data) as RoomFrame;
        } catch {
          continue;
        }
        if (typeof frame.seq !== 'number' || frame.seq <= cursor) continue;
        cursor = frame.seq;
        yield { type: 'frame', frame };
      }
    } catch {
      if (signal.aborted) return;
    }
  }
}
