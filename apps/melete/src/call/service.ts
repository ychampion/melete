/**
 * Calls: a live voice conversation with the chat's agent, spoken through
 * ElevenLabs Speech Engine (docs/VOICE.md, "Calls").
 *
 * Starting a call asks ElevenLabs for a token for one call, which is all the
 * browser receives. The provider's id for that call is remembered for a few
 * minutes against the conversation and the person; when ElevenLabs opens its
 * WebSocket to this service and names the call, the call is bound to that
 * conversation, once. A call nobody started from here, or one started too long
 * ago, is not taken.
 *
 * An operator may cap the minutes one person spends on calls in a month. Left
 * unset, calls are not capped.
 */
import { randomUUID } from 'node:crypto';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import {
  type CallVoice,
  callUpstreamUrl,
  elevenLabsSpeechEngine,
} from '../connectors/speech-engine.ts';
import type { Env } from '../env.ts';
import type { CallScope } from './chat.ts';
import { type CallChat, CallSession, type CallTiming } from './session.ts';
import { CALL_UPSTREAM_PATH, SPEECH_ENGINE_AUTH_HEADER } from './upstream-path.ts';

/** Seconds of calls per person in the window the monthly cap counts. */
export interface CallUsage {
  /** Seconds the person has spent on calls in the last 30 days. */
  used(principalId: string): Promise<number>;
  /** A call began; the id its time is written under. */
  begin(principalId: string): Promise<string>;
  record(id: string, seconds: number, ended: boolean): Promise<void>;
}

export class PostgresCallUsage implements CallUsage {
  constructor(private readonly sql: Sql) {}

  async used(principalId: string) {
    const [row] = await this.sql<
      { seconds: number }[]
    >`select coalesce(sum(seconds), 0)::int as seconds
      from call_usage where principal_id = ${principalId}
        and started_at > now() - interval '30 days'`;
    return Number(row?.seconds ?? 0);
  }

  async begin(principalId: string) {
    const id = randomUUID();
    await this.sql`delete from call_usage where principal_id = ${principalId}
      and started_at < now() - interval '31 days'`;
    await this.sql`insert into call_usage (id, principal_id) values (${id}, ${principalId})`;
    return id;
  }

  async record(id: string, seconds: number, ended: boolean) {
    await this.sql`update call_usage set seconds = ${Math.max(0, Math.round(seconds))},
      ended_at = case when ${ended} then now() else null end where id = ${id}`;
  }
}

/**
 * Voice for calls, from the operator's settings: an ElevenLabs key and a
 * public https:// address ElevenLabs can reach. Without both there are no calls.
 */
export function callVoiceFromEnv(env: Env): CallVoice | null {
  const wsUrl = callUpstreamUrl(env.MELETE_PUBLIC_URL);
  if (!env.ELEVENLABS_API_KEY || !wsUrl) return null;
  return elevenLabsSpeechEngine({
    apiKey: env.ELEVENLABS_API_KEY,
    ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
    ...(env.ELEVENLABS_STREAMING_MODEL ? { streamingModel: env.ELEVENLABS_STREAMING_MODEL } : {}),
    ...(env.ELEVENLABS_SPEECH_ENGINE_ID ? { engineId: env.ELEVENLABS_SPEECH_ENGINE_ID } : {}),
    wsUrl,
    name: `Melete calls (${new URL(wsUrl).host})`,
  });
}

type Pending = { scope: CallScope; expiresAt: number; secondsLeft: number | null };

/** Per upstream connection: its call, and how its time is kept. */
export type Upstream = {
  session?: CallSession;
  usage?: { id: string; startedAt: number; timer?: ReturnType<typeof setInterval> };
  cutoff?: ReturnType<typeof setTimeout>;
};

export type CallServiceDeps = {
  voice: CallVoice;
  /** The conversation a bound call speaks into. */
  chat: (scope: CallScope, since: Date) => CallChat;
  usage?: CallUsage;
  /** Minutes per person per 30 days; undefined is uncapped. */
  monthlyMinutes?: number;
  timing?: Partial<CallTiming>;
  now?: () => number;
};

/** The WebSocket handler of a server with no calls: nothing is upgraded, so it only closes. */
export const NO_CALLS: WebSocketHandler<Upstream> = {
  open: (socket) => socket.close(1008, 'no calls here'),
  message: () => {},
};

/** How often a call's time so far is written down, so a crash loses little of it. */
const USAGE_TICK_MS = 30_000;

export class CallService {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly deps: CallServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Seconds the person may still call this month, or null when calls are not capped. */
  private async secondsLeft(principalId: string): Promise<number | null> {
    const cap = this.deps.monthlyMinutes;
    if (cap === undefined) return null;
    const used = this.deps.usage ? await this.deps.usage.used(principalId) : 0;
    return Math.max(0, cap * 60 - used);
  }

  /** A token for one call into this conversation. */
  async start(scope: CallScope, signal?: AbortSignal) {
    const left = await this.secondsLeft(scope.principalId);
    if (left !== null && left < 1)
      throw new ServiceError(
        'call_monthly_limit',
        'You have used this month’s call minutes. They free up as older calls pass 30 days.',
        429,
      );
    const started = await this.deps.voice.start(signal);
    const at = this.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(id);
    this.pending.set(started.conversationId, {
      scope,
      expiresAt: started.expiresAt.getTime(),
      secondsLeft: left,
    });
    return {
      token: started.token,
      expires_at: started.expiresAt.toISOString(),
      minutes_left: left === null ? null : Math.floor(left / 60),
    };
  }

  /** The call ElevenLabs names, taken once, while its token is still good. */
  private claim(conversationId: string): Pending | null {
    const entry = this.pending.get(conversationId);
    if (!entry) return null;
    this.pending.delete(conversationId);
    return entry.expiresAt > this.now() ? entry : null;
  }

  /**
   * The upstream WebSocket, for the API server: answered only for a request
   * that proves it is from ElevenLabs. Anything else on the path is refused;
   * any other path is not this route's.
   */
  upgrade(
    request: Request,
    server: Pick<Server<Upstream>, 'upgrade'>,
  ): Response | undefined | null {
    if (new URL(request.url).pathname !== CALL_UPSTREAM_PATH) return null;
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('A call connects with a WebSocket.\n', { status: 400 });
    if (!this.deps.voice.verify(request.headers.get(SPEECH_ENGINE_AUTH_HEADER)))
      return new Response('Not a call this service started.\n', { status: 401 });
    return server.upgrade(request, { data: {} })
      ? undefined
      : new Response('The call could not connect.\n', { status: 400 });
  }

  readonly websocket: WebSocketHandler<Upstream> = {
    open: (socket) => {
      socket.data.session = new CallSession(
        {
          send: (reply) => {
            socket.send(JSON.stringify(reply));
          },
          close: () => socket.close(1000, 'call ended'),
        },
        (id) => this.bindCall(socket, id),
        this.deps.timing,
        { onEnded: () => void this.finish(socket) },
      );
    },
    message: (socket, message) => {
      void socket.data.session?.receive(
        typeof message === 'string' ? message : Buffer.from(message).toString('utf8'),
      );
    },
    close: (socket) => {
      socket.data.session?.closedByPeer();
      void this.finish(socket);
    },
  };

  private async bindCall(socket: ServerWebSocket<Upstream>, id: string): Promise<CallChat | null> {
    const call = this.claim(id);
    if (!call) return null;
    const since = new Date(this.now());
    const usage = this.deps.usage;
    if (usage) {
      const usageId = await usage.begin(call.scope.principalId).catch(() => null);
      if (usageId) {
        const record = { id: usageId, startedAt: this.now() } as NonNullable<Upstream['usage']>;
        record.timer = setInterval(() => {
          void usage.record(usageId, (this.now() - record.startedAt) / 1000, false).catch(() => {});
        }, USAGE_TICK_MS);
        record.timer.unref?.();
        socket.data.usage = record;
      }
    }
    // A capped person's call ends when their minutes do.
    if (call.secondsLeft !== null) {
      socket.data.cutoff = setTimeout(
        () => socket.close(1000, 'call minutes used'),
        call.secondsLeft * 1000,
      );
      socket.data.cutoff.unref?.();
    }
    return this.deps.chat(call.scope, since);
  }

  private async finish(socket: ServerWebSocket<Upstream>) {
    if (socket.data.cutoff) clearTimeout(socket.data.cutoff);
    const usage = socket.data.usage;
    socket.data.usage = undefined;
    if (!usage) return;
    if (usage.timer) clearInterval(usage.timer);
    await this.deps.usage
      ?.record(usage.id, (this.now() - usage.startedAt) / 1000, true)
      .catch(() => process.stderr.write('call: call time could not be recorded\n'));
  }
}
