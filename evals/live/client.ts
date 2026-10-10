/**
 * A client for a live install, speaking the same HTTP API the web app does:
 * sign in with a session cookie, open a chat, send a message, follow the chat's
 * event stream, answer permissions and questions, stop, and delete. It holds no
 * credential beyond the session cookie it was given, and never logs one.
 */
import type {
  ExperienceEvent,
  ExperienceReceipt,
  PermissionCard,
  ResultCard,
  RunView,
  UsageResponse,
} from '@melete/contracts';
import { readSse } from '../../packages/client/src/sse.ts';

export type Question = {
  id: string;
  conversation_id: string | null;
  text: string;
  options: { id: string; label: string }[];
  free_text: boolean;
};

export type Turn = { id: string; answer: string; status: string; created_at: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`${status} ${path}: ${message}`);
  }
}

export class LiveClient {
  private cookies = new Map<string, string>();
  base: string;

  constructor(url: string) {
    // The web app serves the API under /api beside itself; a bare service URL works too.
    this.base = url.replace(/\/+$/, '');
  }

  private header(): Record<string, string> {
    return this.cookies.size
      ? { cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
      : {};
  }

  private keep(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair?.indexOf('=') ?? -1;
      if (pair && at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...this.header(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    this.keep(response);
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message =
        (data as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
      throw new ApiError(response.status, path, message);
    }
    if ((data as { status?: string } | null)?.status === 'not_available')
      throw new ApiError(
        response.status,
        path,
        `not available: ${(data as { reason?: string }).reason ?? ''}`,
      );
    return data as T;
  }

  /** Resolves the API root: `<url>/api` when the URL is the web app, else the URL itself. */
  async locate(): Promise<{ version: string | null }> {
    for (const candidate of [`${this.base}/api`, this.base]) {
      try {
        const response = await fetch(`${candidate}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) continue;
        const health = (await response.json()) as { status?: string; version?: string };
        if (health.status) {
          this.base = candidate;
          return { version: health.version ?? null };
        }
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error('No Melete API answered at that address.');
  }

  async signIn(email: string, password: string) {
    await this.request('POST', '/login', { email, password });
    if (!this.cookies.has('melete_session')) throw new Error('Sign-in set no session.');
  }

  async spaces(): Promise<{ id: string; name: string; kind: string }[]> {
    return (
      await this.request<{ spaces: { id: string; name: string; kind: string }[] }>('GET', '/spaces')
    ).spaces;
  }

  async createChat(title: string): Promise<string> {
    const { conversation } = await this.request<{ conversation: { id: string } }>(
      'POST',
      '/conversations',
      { title },
    );
    return conversation.id;
  }

  async send(conversation: string, text: string, key: string): Promise<string> {
    const accepted = await this.request<{ turn_id: string }>(
      'POST',
      `/conversations/${encodeURIComponent(conversation)}/messages`,
      { text },
      { 'Idempotency-Key': key },
    );
    return accepted.turn_id;
  }

  async turns(conversation: string): Promise<Turn[]> {
    return (
      await this.request<{ turns: Turn[] }>(
        'GET',
        `/conversations/${encodeURIComponent(conversation)}/messages`,
      )
    ).turns;
  }

  async receipts(conversation: string): Promise<ExperienceReceipt[]> {
    return (
      await this.request<{ receipts: ExperienceReceipt[] }>(
        'GET',
        `/conversations/${encodeURIComponent(conversation)}/receipts`,
      )
    ).receipts;
  }

  async cards(conversation: string): Promise<ResultCard[]> {
    return (
      await this.request<{ cards: ResultCard[] }>(
        'GET',
        `/conversations/${encodeURIComponent(conversation)}/cards`,
      )
    ).cards;
  }

  async status(conversation: string): Promise<string> {
    return (
      await this.request<{ conversation: { status: string } }>(
        'GET',
        `/conversations/${encodeURIComponent(conversation)}`,
      )
    ).conversation.status;
  }

  async stop(conversation: string) {
    await this.request('POST', `/conversations/${encodeURIComponent(conversation)}/stop`);
  }

  async deleteChat(conversation: string) {
    await this.request(
      'DELETE',
      `/conversations/${encodeURIComponent(conversation)}?forget_memory=true`,
    );
  }

  async permissions(): Promise<PermissionCard[]> {
    return (await this.request<{ permissions: PermissionCard[] }>('GET', '/permissions'))
      .permissions;
  }

  async decide(permission: PermissionCard, option: 'allow_once' | 'deny') {
    await this.request('POST', `/permissions/${encodeURIComponent(permission.id)}`, {
      option,
      version: permission.version,
    });
  }

  async questions(): Promise<Question[]> {
    return (await this.request<{ questions: Question[] }>('GET', '/quick-answers')).questions;
  }

  async answer(question: Question, text: string) {
    const body =
      question.free_text || question.options.length === 0
        ? { text }
        : { option_id: (question.options[0] as { id: string }).id };
    await this.request('POST', `/quick-answers/${encodeURIComponent(question.id)}`, body);
  }

  async runs(conversation: string): Promise<RunView[]> {
    return (
      await this.request<{ runs: RunView[] }>(
        'GET',
        `/runs?conversation_id=${encodeURIComponent(conversation)}`,
      )
    ).runs;
  }

  async takeOver(surface: 'browser' | 'sandbox', session: string) {
    await this.request('POST', `/${surface}/sessions/${encodeURIComponent(session)}/takeover`);
  }

  async handBack(surface: 'browser' | 'sandbox', session: string) {
    await this.request('POST', `/${surface}/sessions/${encodeURIComponent(session)}/handback`);
  }

  /** The model new chats run on, from the install's settings; null when they cannot be read. */
  async activeModel(): Promise<{ provider: string; model: string; vision: boolean } | null> {
    try {
      const settings = await this.request<{
        active?: { provider: string; model: string; vision: boolean } | null;
      }>('GET', '/model-settings');
      const active = settings.active;
      return active
        ? { provider: active.provider, model: active.model, vision: active.vision }
        : null;
    } catch {
      return null;
    }
  }

  async stopRun(run: string) {
    await this.request('POST', `/runs/${encodeURIComponent(run)}/stop`);
  }

  /** This account's model spend this month, in dollars, as the install estimates it. */
  async spend(): Promise<number | null> {
    try {
      const usage = await this.request<UsageResponse>('GET', '/usage');
      return usage.person?.month.usd ?? null;
    } catch {
      return null;
    }
  }

  async connections(): Promise<{ id: string; label?: string; name?: string; status?: string }[]> {
    return (
      await this.request<{ connections: { id: string; label?: string; name?: string }[] }>(
        'GET',
        '/experience/connections',
      )
    ).connections;
  }

  /** Installs a connection from a kind's fixed fields and values, as the app's form does. */
  async installConnection(body: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ connection: { id: string } }>('POST', '/connections', body);
    return result.connection.id;
  }

  async revokeConnection(id: string) {
    const current = await this.request<{ connection: { generation?: number } }>(
      'GET',
      `/connections/${encodeURIComponent(id)}`,
    );
    await this.request('POST', `/connections/${encodeURIComponent(id)}/lifecycle`, {
      kind: 'revoke',
      expected_generation: current.connection.generation ?? 0,
    });
  }

  /**
   * Follows a chat's events from `since`, reconnecting after a drop, until the
   * signal aborts. Each event is handed over once, in sequence order.
   */
  async *follow(
    conversation: string,
    since: number,
    signal: AbortSignal,
  ): AsyncGenerator<ExperienceEvent, void, void> {
    let cursor = since;
    let attempt = 0;
    while (!signal.aborted) {
      if (attempt++ > 0) await Bun.sleep(Math.min(500 * 2 ** (attempt - 2), 8000));
      if (signal.aborted) return;
      let body: ReadableStream<Uint8Array> | null = null;
      try {
        const response = await fetch(
          `${this.base}/conversations/${encodeURIComponent(conversation)}/events?since=${cursor}`,
          {
            headers: {
              ...this.header(),
              accept: 'text/event-stream',
              ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
            },
            signal,
          },
        );
        if (!response.ok || !response.body) continue;
        body = response.body;
      } catch {
        if (signal.aborted) return;
        continue;
      }
      try {
        for await (const frame of readSse(body)) {
          if (frame.comment || !frame.data) continue;
          let event: ExperienceEvent;
          try {
            event = JSON.parse(frame.data) as ExperienceEvent;
          } catch {
            continue;
          }
          if (typeof event.seq !== 'number' || event.seq <= cursor) continue;
          cursor = event.seq;
          yield event;
        }
      } catch {
        if (signal.aborted) return;
      }
    }
  }
}
