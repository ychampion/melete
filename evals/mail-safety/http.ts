import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RoomStreamFrame, roomThreadView } from '@melete/contracts';

type RoomThreadView = ReturnType<typeof roomThreadView.parse>;

import type { Observation, Warning } from './evidence.ts';
import { type Case, modelRequest } from './generate.ts';

export type Transport = (request: Request) => Promise<Response>;
export class AppHttp {
  readonly base: URL;
  constructor(
    base: string,
    private readonly session: string,
    private readonly transport: Transport = fetch,
  ) {
    this.base = new URL(base);
    if (
      !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== '/' ||
      this.base.search ||
      this.base.hash
    )
      throw new Error('Invalid app origin');
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error('Cross-origin request refused');
    const headers = new Headers(init.headers);
    headers.set('Cookie', this.session);
    const response = await this.transport(
      new Request(url.href, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(30_000),
      }),
    );
    if (response.status >= 300 && response.status < 400) throw new Error('HTTP redirect refused');
    if (response.url && new URL(response.url).origin !== this.base.origin)
      throw new Error('Response origin mismatch');
    return response;
  }
  async json<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new Error(`App HTTP status ${response.status}`);
    return (await response.json()) as T;
  }
}
export type CaseTarget = {
  roomId: string;
  helperLabel: string;
  helperConsent?: boolean;
  mailConnectionId?: string;
  ledgerFile?: string;
  mailbox?: { host: string; port: number; username: string; passwordRef: string; folder: string };
};
export type Accounts = {
  owner: { id: string };
  helper: { id: string };
  outsider: { id: string };
  members?: { id: string }[];
};
export type Clients = { owner: AppHttp; helper: AppHttp; outsider: AppHttp; members?: AppHttp[] };
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Read-only checks. Nothing is reset or removed. */
export async function preflight(
  clients: Clients,
  target: CaseTarget,
  accounts: Accounts,
): Promise<void> {
  const path = `/rooms/${encodeURIComponent(target.roomId)}`;
  for (const role of ['owner', 'helper', 'outsider'] as const) {
    const me = await clients[role].json<{ owner: { id: string } }>('/me');
    if (me.owner.id !== accounts[role].id) throw new Error('Session account mismatch');
  }
  const extra = accounts.members ?? [];
  if (
    extra.length !== (clients.members ?? []).length ||
    new Set([
      accounts.owner.id,
      accounts.helper.id,
      accounts.outsider.id,
      ...extra.map((m) => m.id),
    ]).size !==
      3 + extra.length
  )
    throw new Error('Distinct account sessions required for every member');
  for (const [i, member] of extra.entries()) {
    const me = await clients.members![i]!.json<{ owner: { id: string } }>('/me');
    if (me.owner.id !== member.id) throw new Error('Member session account mismatch');
  }
  const room = await clients.owner.json<{
    room: { my_role: string };
    policy: { agent_turns: string };
    members: { principal_id: string; role: string; display_name: string }[];
  }>(path);
  const helper = room.members.find((m) => m.principal_id === accounts.helper.id);
  if (
    room.room.my_role !== 'owner' ||
    !helper ||
    !['member', 'owner'].includes(helper.role) ||
    helper.display_name !== target.helperLabel ||
    !target.helperConsent ||
    room.members.some(
      (m) =>
        ![accounts.owner.id, accounts.helper.id, ...extra.map((p) => p.id)].includes(
          m.principal_id,
        ),
    ) ||
    extra.some(
      (m) =>
        !room.members.some((p) => p.principal_id === m.id && ['member', 'owner'].includes(p.role)),
    ) ||
    room.members.some((m) => m.principal_id === accounts.outsider.id) ||
    room.policy.agent_turns !== 'asked'
  )
    throw new Error('Invalid disposable room membership or policy');
  const summaries = await clients.owner.json<{ on: boolean }>(
    `/spaces/${encodeURIComponent(target.roomId)}/summaries-only`,
  );
  if (!summaries.on) throw new Error('Source room must be summaries-only');
  for (const client of [clients.owner, clients.helper, ...(clients.members ?? [])]) {
    await client.json(path);
    const board = await client.json<{ items: Warning[] }>(`${path}/board`);
    if (board.items.length) throw new Error('Dirty board; reused case refused');
  }
  const threads = await clients.owner.json<{ threads: unknown[] }>(`${path}/threads`);
  const memory = await clients.owner.json<{ items: unknown[]; shares: unknown[] }>(
    `${path}/memory`,
  );
  if (threads.threads.length || memory.items.length || memory.shares.length)
    throw new Error('Dirty room; reused case refused');
  if (target.mailbox) {
    const connections = await clients.owner.json<{
      connections: { id: string; provider: string; shared_use: string; status: string }[];
    }>(`${path}/connections`);
    if (
      !target.mailConnectionId ||
      !connections.connections.some(
        (c) =>
          c.id === target.mailConnectionId &&
          c.provider === 'imap' &&
          c.shared_use === 'room' &&
          c.status === 'active',
      )
    )
      throw new Error('Isolated IMAP connection missing');
  }
  const outsider = await clients.outsider.request(path);
  if (![403, 404].includes(outsider.status)) throw new Error('Outsider room access was not denied');
}

export async function submitNotice(
  http: AppHttp,
  target: CaseTarget,
  c: Case,
  bytes: Uint8Array,
  submissionId: string,
) {
  const base = `/rooms/${encodeURIComponent(target.roomId)}`;
  let attachment: string | undefined;
  if (c.format === 'image') {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], `${c.id}.png`, { type: 'image/png' }));
    const uploaded = await http.json<{ attachment: { id: string } }>(`${base}/attachments`, {
      method: 'POST',
      body: form,
    });
    attachment = uploaded.attachment.id;
    if (!attachment) throw new Error('Missing attachment ID');
  }
  const posted = await http.json<{ thread: { id: string }; request_job_id: string | null }>(
    `${base}/threads`,
    json({
      ...modelRequest(c, target.helperLabel, attachment),
      submission_id: submissionId,
      title: c.envelope.subject,
    }),
  );
  if (!posted.request_job_id) throw new Error('No room request job');
  return { threadId: posted.thread.id, jobId: posted.request_job_id, attachmentId: attachment };
}

/** Only loopback disposable IMAP APPEND is implemented; there is no sending path. */
export async function appendEmail(
  target: NonNullable<CaseTarget['mailbox']>,
  c: Case,
  bytes: Uint8Array,
): Promise<string> {
  if (
    !['127.0.0.1', '::1'].includes(target.host) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    !target.username ||
    !target.folder
  )
    throw new Error('Explicit disposable local mailbox required');
  const password = process.env[target.passwordRef];
  if (!password) throw new Error('Mailbox credential reference unavailable');
  const module = await import(
    Bun.resolveSync('imapflow', resolve(import.meta.dir, '../../apps/melete'))
  );
  const imap = new module.ImapFlow({
    host: target.host,
    port: target.port,
    secure: false,
    auth: { user: target.username, pass: password },
    logger: false,
    socketTimeout: 20_000,
  });
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock(target.folder);
    try {
      const existing = await imap.search(
        { header: { 'message-id': `<${c.id}@correspondence.example>` } },
        { uid: true },
      );
      const status = await imap.status(target.folder, { messages: true });
      if (existing.length === 1 && status.messages === 1) return String(existing[0]);
      if (status.messages !== 0) throw new Error('Dirty mailbox; reused case refused');
      const result = await imap.append(
        target.folder,
        Buffer.from(bytes),
        [],
        new Date('2026-10-29T09:00:00Z'),
      );
      if (!result || !result.uid) throw new Error('IMAP APPEND has no UID receipt');
      return String(result.uid);
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

/** Cursor survives reconnects. Polling is a bounded, explicitly recorded fallback. */
export async function readFrames(http: AppHttp, path: string, cursor: number, ms = 1000) {
  const frames: RoomStreamFrame[] = [];
  try {
    const response = await http.request(`${path}?after=${cursor}`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) },
      signal: AbortSignal.timeout(ms),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error('No event stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No event body');
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 2_000_000) throw new Error('Event frame too large');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) {
            const frame = JSON.parse(data) as RoomStreamFrame;
            if (!Number.isSafeInteger(frame.seq)) throw new Error('Invalid event cursor');
            if (frame.seq > cursor) {
              frames.push(frame);
              cursor = frame.seq;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { frames, cursor, mode: 'sse' };
  } catch {
    const page = await http.json<{ frames: RoomStreamFrame[]; next_cursor: number }>(
      `${path}?after=${cursor}`,
    );
    if (
      !Array.isArray(page.frames) ||
      !Number.isSafeInteger(page.next_cursor) ||
      page.next_cursor < cursor
    )
      throw new Error('Invalid event page');
    return {
      frames: [...frames, ...page.frames.filter((f) => f.seq > cursor)],
      cursor: page.next_cursor,
      mode: 'bounded-poll-fallback',
    };
  }
}

export async function collect(
  clients: Clients,
  target: CaseTarget,
  accounts: Accounts,
  submitted: { threadId: string; jobId: string },
  c: Case,
  options: {
    timeoutMs?: number;
    cursor?: number;
    surfaces?: string[];
    checkpoint?: (cursor: number, surfaces: string[]) => Promise<void>;
  } = {},
): Promise<Observation> {
  const base = `/rooms/${encodeURIComponent(target.roomId)}`;
  const path = `${base}/threads/${encodeURIComponent(submitted.threadId)}`;
  const expiresAt = Date.now() + (options.timeoutMs ?? 120_000);
  let cursor = options.cursor ?? 0;
  let reconnects = 0;
  let mode = 'sse';
  const surfaces: string[] = [...(options.surfaces ?? [])];
  let owner: RoomThreadView;
  let helper: RoomThreadView;
  let terminal = false;
  let completed = false;
  do {
    const events = await readFrames(
      clients.helper,
      `${path}/events`,
      cursor,
      Math.min(1000, Math.max(1, expiresAt - Date.now())),
    );
    mode = events.mode === 'sse' ? mode : events.mode;
    cursor = events.cursor;
    reconnects++;
    surfaces.push(JSON.stringify(events.frames));
    await options.checkpoint?.(cursor, surfaces);
    owner = await clients.owner.json<RoomThreadView>(path);
    helper = await clients.helper.json<RoomThreadView>(path);
    surfaces.push(JSON.stringify(helper));
    const request = owner.requests.find((r) => r.job_id === submitted.jobId);
    terminal = !!request && ['done', 'failed', 'stopped', 'cancelled'].includes(request.status);
    completed = request?.status === 'done';
    if (terminal || Date.now() >= expiresAt) break;
    await Bun.sleep(Math.min(250, Math.max(1, expiresAt - Date.now())));
  } while (Date.now() < expiresAt);
  // Drain committed terminal events even when they span more than one page.
  if (terminal) {
    let drained = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await clients.helper.json<{ frames: RoomStreamFrame[]; next_cursor: number }>(
        `${path}/events?after=${cursor}`,
      );
      if (
        !Array.isArray(page.frames) ||
        !Number.isSafeInteger(page.next_cursor) ||
        page.next_cursor < cursor
      )
        throw new Error('Invalid terminal event page');
      surfaces.push(JSON.stringify(page.frames));
      if (!page.frames.length) {
        drained = true;
        break;
      }
      if (page.next_cursor <= cursor) throw new Error('Event cursor did not advance');
      cursor = page.next_cursor;
      await options.checkpoint?.(cursor, surfaces);
    }
    if (!drained) throw new Error('Terminal event evidence exceeded bound');
  }
  const ownerBoard = await clients.owner.json<{ items: Warning[] }>(`${base}/board`);
  const helperBoard = await clients.helper.json<{ items: Warning[] }>(`${base}/board`);
  const boardEvents = await clients.helper.json(`${base}/board/events?after=0`);
  surfaces.push(JSON.stringify(boardEvents));
  const memberViews: NonNullable<Observation['memberViews']> = [];
  // Each extra member reads through their own session, including the whole event history.
  for (const [i, client] of (clients.members ?? []).entries()) {
    const view = await client.json(path);
    const board = await client.json<{ items: Warning[] }>(`${base}/board`);
    const memberSurfaces = [
      JSON.stringify(view),
      JSON.stringify(await client.json(`${base}/board/events?after=0`)),
    ];
    let after = 0;
    let drained = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await client.json<{ frames: RoomStreamFrame[]; next_cursor: number }>(
        `${path}/events?after=${after}`,
      );
      if (
        !Array.isArray(page.frames) ||
        !Number.isSafeInteger(page.next_cursor) ||
        page.next_cursor < after
      )
        throw new Error('Invalid member event evidence');
      memberSurfaces.push(JSON.stringify(page.frames));
      if (!page.frames.length) {
        drained = true;
        break;
      }
      if (page.next_cursor <= after) throw new Error('Member event cursor did not advance');
      after = page.next_cursor;
    }
    if (!drained) throw new Error('Member event evidence exceeded bound');
    memberViews.push({
      principalId: accounts.members![i]!.id,
      board: board.items,
      surfaces: memberSurfaces,
    });
  }
  const outsiderStatuses: number[] = [];
  for (const route of [path, `${base}/board`, `${path}/events`, `${base}/board/events`])
    outsiderStatuses.push((await clients.outsider.request(route)).status);
  const request = owner.requests.find((r) => r.job_id === submitted.jobId);
  const receipts = request?.receipts ?? [];
  return {
    id: c.id,
    rawAnswer: request?.turns.at(-1)?.answer ?? '',
    terminal,
    completed,
    jobIds: owner.requests.map((r) => r.job_id),
    actionIds: receipts.filter((r) => r.id.startsWith('act_')).map((r) => r.id),
    receiptIds: receipts.map((r) => r.id),
    boardBefore: [],
    ownerBoard: ownerBoard.items,
    helperBoard: helperBoard.items,
    helperSurfaces: surfaces,
    memberViews,
    expectedMembers: accounts.members?.map((m) => m.id) ?? [],
    outsiderStatuses,
    expectedHelper: accounts.helper.id,
    requiredVisibility: c.scorer.requiredVisibility,
    usage: [],
    settled: false,
    threadId: submitted.threadId,
    transport: { mode, cursor, reconnects },
  };
}

export const readBytes = (directory: string, file: string) => readFile(resolve(directory, file));
