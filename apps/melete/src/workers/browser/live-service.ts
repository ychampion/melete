/**
 * The service half of a person's live view: frames down one Server-Sent Events stream, input up
 * as ordinary same-origin posts. Nothing here is stored. A live id is held in memory only and is
 * bound to the principal, the session, the control epoch and the address it was opened from;
 * every request re-checks all four and the person's authority for the job behind them.
 */
import { randomBytes } from 'node:crypto';
import {
  LIVE_PRESENCE,
  type LiveDown,
  type LiveEndCode,
  type LiveOpen,
  liveClose,
  liveId,
  liveOpen,
  liveScope,
  liveUp,
  SSE_KEEPALIVE,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ServiceError } from '../../api/errors.ts';
import type { RequestSource } from '../../api/listener.ts';
import type { BrowserWorkerClient } from './client.ts';
import type { BrowserSessionService } from './routes.ts';
import { BrowserFault } from './sessions.ts';

type Presence = Record<keyof typeof LIVE_PRESENCE, number>;
export type BrowserLivePresence = Partial<Presence>;
export type BrowserLiveServiceOptions = {
  now?: () => number;
  /** Shorter windows for tests; a request never chooses these. */
  presence?: BrowserLivePresence;
  /** How long one worker long poll waits for something to relay. */
  pullMs?: number;
};

/** What an attached viewer can be given. Frames are written through and never kept. */
type Stream = { write: (event: LiveDown) => void; keepalive: () => void; close: () => void };

type Channel = {
  id: string;
  /** The worker's own live id, which no browser is ever given. */
  workerId: string;
  sessionId: string;
  spaceId: string;
  principalId: string;
  epoch: number;
  peer: string;
  /** The highest frame sequence the person says they have painted. */
  ack: number;
  lastInputAt: number;
  askedStillThere: boolean;
  stream?: Stream;
  /** A stream that has attached once wants a repaint when it comes back. */
  attached: boolean;
  detachedAt: number;
  queued: LiveDown[];
  /** The relay of the viewer that was attached, so a new one never starts beside it. */
  relay?: Promise<void>;
  closing?: LiveEndCode;
  ended: boolean;
  endWritten: boolean;
  timer?: ReturnType<typeof setInterval>;
};

const QUEUE_LIMIT = 32;

/** One live event as a stream frame. Only frames carry an id, so a reconnect resumes from one. */
export function liveFrame(event: LiveDown): string {
  const id = event.type === 'frame' ? `id: ${event.seq}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The address a request is from, as the listener resolved it; a header never says. */
export function requestPeer(c: Context): string {
  const source = c.env as RequestSource | undefined;
  return source?.clientAddress ?? source?.remoteAddress ?? 'unknown';
}

/** Browser reads of the stream must come from this API, as its writes already must. */
function sameOrigin(c: Context): boolean {
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin;
}

export class BrowserLiveService {
  private readonly byId = new Map<string, Channel>();
  private readonly bySession = new Map<string, Channel>();
  private readonly now: () => number;
  private readonly presence: Presence;
  private readonly pullMs: number;
  private readonly tickMs: number;

  constructor(
    private readonly sessions: BrowserSessionService,
    options: BrowserLiveServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.presence = { ...LIVE_PRESENCE, ...options.presence };
    this.pullMs = options.pullMs ?? 1000;
    this.tickMs = Math.max(
      20,
      Math.floor(
        Math.min(
          this.presence.still_there_ms,
          this.presence.idle_close_ms,
          this.presence.reconnect_ms,
        ) / 4,
      ),
    );
  }

  /** One channel per session: a second viewer is refused while the first one may still return. */
  async open(sessionId: string, principalId: string, peer: string): Promise<LiveOpen> {
    const binding = await this.sessions.steerable(sessionId, principalId);
    if (binding.control !== 'human') throw new BrowserFault('not_human_control');
    const current = this.bySession.get(sessionId);
    if (current && !current.ended) {
      if (
        current.epoch === binding.control_epoch &&
        (current.stream !== undefined ||
          this.now() - current.detachedAt < this.presence.reconnect_ms)
      )
        throw new BrowserFault('live_taken');
      await this.finish(current, 'closed');
    }
    const worker = await this.sessions.workers.get(binding.space_id);
    const opened = await worker.liveOpen(sessionId, binding.control_epoch);
    const channel: Channel = {
      id: randomBytes(32).toString('base64url'),
      workerId: opened.live_id,
      sessionId,
      spaceId: binding.space_id,
      principalId,
      epoch: binding.control_epoch,
      peer,
      ack: 0,
      lastInputAt: this.now(),
      askedStillThere: false,
      attached: false,
      detachedAt: this.now(),
      queued: [],
      ended: false,
      endWritten: false,
    };
    this.byId.set(channel.id, channel);
    this.bySession.set(sessionId, channel);
    channel.timer = setInterval(() => void this.tick(channel), this.tickMs);
    channel.timer.unref();
    return { ...opened, live_id: channel.id };
  }

  /**
   * The frames of one live view. Nothing is buffered for a reconnect, so nothing is replayed:
   * a returning viewer is repainted from the page as it is now.
   */
  async frames(
    c: Context,
    sessionId: string,
    liveId: string,
    lastEventId: number,
  ): Promise<Response> {
    const channel = await this.bound(c, sessionId, liveId);
    this.detach(channel);
    // One relay per channel: a pull still in flight for the viewer that left would otherwise
    // take the repainted frame this one is waiting for.
    await channel.relay;
    if (channel.ended) throw new BrowserFault('live_closed');
    channel.ack = Math.max(channel.ack, lastEventId);
    const repaint = channel.attached;
    channel.attached = true;
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    let attached: Stream | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The viewer is gone; the relay notices on its next turn.
          }
        };
        const stream: Stream = {
          write: (event) => send(liveFrame(event)),
          keepalive: () => send(SSE_KEEPALIVE),
          close: () => {
            try {
              controller.close();
            } catch {
              // Already closed by the viewer leaving.
            }
          },
        };
        attached = stream;
        channel.stream = stream;
        channel.detachedAt = 0;
        const leave = () => {
          if (channel.stream === stream) this.detach(channel);
        };
        signal.addEventListener('abort', leave, { once: true });
        if (signal.aborted) leave();
        for (const queued of channel.queued.splice(0)) stream.write(queued);
        channel.relay = this.relay(channel, stream, repaint);
      },
      cancel: () => {
        if (channel.stream === attached) this.detach(channel);
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  }

  async input(
    c: Context,
    sessionId: string,
    body: unknown,
  ): Promise<{ accepted: number; refused?: string }> {
    const request = liveUp.parse(body);
    const channel = await this.bound(c, sessionId, request.live_id);
    channel.ack = Math.max(channel.ack, request.ack_through);
    // Only the person's own events count as presence; an acknowledgement is the panel's doing.
    if (request.events.length) this.present(channel);
    const worker = await this.worker(channel);
    return worker
      .liveInput(channel.workerId, request.ack_through, request.events)
      .catch(async (error: unknown) => {
        if (error instanceof BrowserFault && error.reason === 'slow_down')
          await this.finish(channel, 'slow_down');
        throw error;
      });
  }

  async allow(c: Context, sessionId: string, body: unknown): Promise<{ site_scope: string[] }> {
    const request = liveScope.parse(body);
    const channel = await this.bound(c, sessionId, request.live_id);
    this.present(channel);
    const worker = await this.worker(channel);
    return worker.liveScope(channel.workerId, request.host);
  }

  async close(c: Context, sessionId: string, body: unknown): Promise<{ closed: true }> {
    const request = liveClose.parse(body);
    const channel = await this.bound(c, sessionId, request.live_id);
    await this.finish(channel, 'closed');
    return { closed: true };
  }

  /** Control has changed hands, so any channel of that session belongs to the epoch before it. */
  ended(sessionId: string): void {
    const channel = this.bySession.get(sessionId);
    if (channel && !channel.ended) void this.finish(channel, 'epoch_changed');
  }

  private async worker(channel: Channel): Promise<BrowserWorkerClient> {
    return this.sessions.workers.get(channel.spaceId);
  }

  /**
   * The live id names a channel; the request must be the same person, at the same address, for
   * the same session, under the same epoch, and they must still be allowed to steer that job.
   */
  private async bound(c: Context, sessionId: string, liveId: string): Promise<Channel> {
    if (!sameOrigin(c)) throw new BrowserFault('origin_refused');
    const principalId = c.get('owner').id;
    const binding = await this.sessions.steerable(sessionId, principalId);
    const channel = this.byId.get(liveId);
    if (!channel || channel.ended || channel.sessionId !== sessionId)
      throw new BrowserFault('live_closed');
    if (channel.principalId !== principalId || channel.peer !== requestPeer(c))
      throw new BrowserFault('not_you');
    if (binding.control !== 'human' || binding.control_epoch !== channel.epoch) {
      await this.finish(channel, 'epoch_changed');
      throw new BrowserFault('epoch_changed');
    }
    return channel;
  }

  private present(channel: Channel): void {
    channel.lastInputAt = this.now();
    channel.askedStillThere = false;
  }

  /**
   * Relays one attached viewer. Authority is read again before every poll, so a revoked
   * membership or a new epoch stops the stream without waiting for the person to act.
   */
  private async relay(channel: Channel, stream: Stream, repaint: boolean): Promise<void> {
    let fresh = repaint;
    try {
      while (channel.stream === stream && !channel.ended) {
        const binding = await this.sessions
          .steerable(channel.sessionId, channel.principalId)
          .catch(() => undefined);
        if (channel.stream !== stream || channel.ended) return;
        if (binding?.control !== 'human' || binding.control_epoch !== channel.epoch) {
          await this.finish(channel, binding ? 'epoch_changed' : 'session_not_found');
          return;
        }
        const worker = await this.worker(channel);
        const { events } = await worker.livePull(channel.workerId, channel.ack, this.pullMs, fresh);
        fresh = false;
        if (channel.stream !== stream || channel.ended) return;
        if (!events.length) stream.keepalive();
        for (const event of events) {
          if (event.type === 'ended') {
            await this.finish(channel, channel.closing ?? event.code);
            return;
          }
          stream.write(event);
        }
      }
    } catch {
      // The worker refused or is gone: the view ends rather than hanging open on nothing.
      if (!channel.ended) await this.finish(channel, 'session_not_found');
    }
  }

  private async tick(channel: Channel): Promise<void> {
    if (channel.ended) return;
    const now = this.now();
    if (!channel.stream && now - channel.detachedAt >= this.presence.reconnect_ms) {
      await this.finish(channel, 'closed');
      return;
    }
    const idle = now - channel.lastInputAt;
    if (idle >= this.presence.idle_close_ms) {
      await this.finish(channel, 'live_idle');
      return;
    }
    if (idle >= this.presence.still_there_ms && !channel.askedStillThere) {
      channel.askedStillThere = true;
      this.push(channel, { type: 'notice', code: 'still_there' });
    }
  }

  private push(channel: Channel, event: LiveDown): void {
    if (channel.stream) {
      channel.stream.write(event);
      return;
    }
    channel.queued.push(event);
    if (channel.queued.length > QUEUE_LIMIT) channel.queued.shift();
  }

  private detach(channel: Channel): void {
    const stream = channel.stream;
    channel.stream = undefined;
    if (!stream) return;
    channel.detachedAt = this.now();
    stream.close();
  }

  /** The channel is over. The person keeps control of the browser until they hand it back. */
  private async finish(channel: Channel, code: LiveEndCode): Promise<void> {
    const first = !channel.ended;
    channel.ended = true;
    channel.closing = code;
    clearInterval(channel.timer);
    if (this.byId.get(channel.id) === channel) this.byId.delete(channel.id);
    if (this.bySession.get(channel.sessionId) === channel) this.bySession.delete(channel.sessionId);
    if (!channel.endWritten) {
      channel.endWritten = true;
      channel.stream?.write({ type: 'ended', code });
    }
    this.detach(channel);
    if (!first) return;
    const worker = await this.worker(channel).catch(() => undefined);
    await worker?.liveClose(channel.workerId).catch(() => {});
  }
}

const STATUS: Record<string, ContentfulStatusCode> = {
  session_not_found: 404,
  live_closed: 410,
  not_you: 403,
  origin_refused: 403,
  slow_down: 429,
};

function refused(error: unknown): never {
  if (error instanceof BrowserFault)
    throw new ServiceError(
      error.reason,
      `The live browser view could not continue: ${error.reason}.`,
      STATUS[error.reason] ?? 409,
    );
  throw error;
}

/** Mounted after the existing owner session and same-origin middleware, beside the control routes. */
export function mountBrowserLive(app: Hono, sessions: BrowserSessionService) {
  const live = sessions.live;
  const id = (c: Context) => c.req.param('id') ?? '';
  app.post('/browser/sessions/:id/live', async (c) => {
    const opened = await live
      .open(id(c), c.get('owner').id, requestPeer(c))
      .catch((error: unknown) => refused(error));
    return c.json(liveOpen.parse(opened));
  });
  app.get('/browser/sessions/:id/live/frames', async (c) => {
    // `Last-Event-ID` is what the browser resumes with; the query is for clients that cannot set it.
    const resume = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0);
    return live
      .frames(
        c,
        id(c),
        liveId.parse(c.req.query('live_id')),
        Number.isSafeInteger(resume) && resume > 0 ? resume : 0,
      )
      .catch((error: unknown) => refused(error));
  });
  for (const [path, call] of [
    ['input', (c: Context, body: unknown) => live.input(c, id(c), body)],
    ['scope', (c: Context, body: unknown) => live.allow(c, id(c), body)],
    ['close', (c: Context, body: unknown) => live.close(c, id(c), body)],
  ] as const) {
    app.post(`/browser/sessions/:id/live/${path}`, async (c) =>
      c.json(await call(c, await c.req.json()).catch((error: unknown) => refused(error))),
    );
  }
}
