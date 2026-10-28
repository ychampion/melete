/**
 * The board routes: a room's board, its live stream, and the boards of every
 * room the signed-in person is in. The service decides what each person may
 * see; this only asks.
 */
import type { paths } from '@melete/client';
import { readSse } from '@melete/client';
import { client, type Result } from '../experience/adapter.ts';
import { call } from '../experience/call.ts';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<P, M extends keyof P> = P[M] extends { responses: infer R }
  ? R extends Record<200, unknown>
    ? Json<R[200]>
    : never
  : never;

export type BoardList = Ok<paths['/rooms/{id}/board'], 'get'>;
export type BoardItem = BoardList['items'][number];
export type BoardAnswered = Ok<paths['/rooms/{id}/board/{itemId}/answer'], 'post'>;

const room = (id: string) => `/rooms/${encodeURIComponent(id)}/board`;
const item = (id: string, itemId: string) => `${room(id)}/${encodeURIComponent(itemId)}`;

export const boardApi = {
  list: (roomId: string): Promise<Result<BoardList>> => call<BoardList>(room(roomId)),
  /** Every room the person is in; `mine` keeps what waits on them, a window what is dated in it. */
  across: (query: { mine?: boolean; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.mine) params.set('mine', '1');
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    const tail = params.toString();
    return call<BoardList>(`/board${tail ? `?${tail}` : ''}`);
  },
  claim: (roomId: string, itemId: string) =>
    call<{ item: BoardItem }>(`${item(roomId, itemId)}/claim`, { method: 'POST' }),
  done: (roomId: string, itemId: string) =>
    call<{ item: BoardItem }>(`${item(roomId, itemId)}/done`, { method: 'POST' }),
  answer: (roomId: string, itemId: string, answer: string) =>
    call<BoardAnswered>(`${item(roomId, itemId)}/answer`, { method: 'POST', body: { answer } }),
};

/** Put changed items into a list by id, keeping the newest version of each. */
export function mergeItems(current: readonly BoardItem[], changed: readonly BoardItem[]) {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of changed) {
    const held = byId.get(entry.id);
    if (!held || held.seq <= entry.seq) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** When an item happens: when it starts, or else when it is due. */
export const itemWhen = (entry: BoardItem) => entry.starts_at ?? entry.due_at ?? entry.ends_at;

/** What following a board yields: changed items, that it (re)opened, or that it ended for good. */
export type BoardSignal =
  | { type: 'items'; items: BoardItem[] }
  | { type: 'open' }
  | { type: 'gone' }
  | { type: 'signed_out' };

/**
 * Follow a room's board live, resuming from the last change seen after a
 * drop. A 403 or 404 means the person is no longer in the room, and following
 * ends there. Where the stream cannot be opened, it reads the board again
 * every few seconds instead.
 */
export async function* followBoard(
  roomId: string,
  signal: AbortSignal,
  pollMs = 3000,
): AsyncGenerator<BoardSignal, void, void> {
  let cursor = 0;
  let attempt = 0;
  while (!signal.aborted) {
    attempt += 1;
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 2), 8000)));
      if (signal.aborted) return;
    }
    let body: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await client.options.fetch(
        `${client.options.baseUrl}${room(roomId)}/events`,
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
      if (response.status === 401) {
        yield { type: 'signed_out' };
        return;
      }
      if (response.ok && response.body) body = response.body;
    } catch {
      if (signal.aborted) return;
    }
    if (!body) {
      // No stream: read the whole board, as often as a stream would matter.
      const listed = await boardApi.list(roomId);
      if (signal.aborted) return;
      if (listed.data) {
        yield { type: 'items', items: listed.data.items };
        attempt = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    attempt = 1;
    yield { type: 'open' };
    try {
      for await (const raw of readSse(body)) {
        if (raw.comment) continue;
        let frame: { seq: number; kind: string; item: BoardItem };
        try {
          frame = JSON.parse(raw.data);
        } catch {
          continue;
        }
        if (typeof frame.seq !== 'number' || frame.seq <= cursor || frame.kind !== 'item') continue;
        cursor = frame.seq;
        yield { type: 'items', items: [frame.item] };
      }
    } catch {
      if (signal.aborted) return;
    }
  }
}
