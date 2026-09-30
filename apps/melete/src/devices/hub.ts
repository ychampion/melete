/**
 * Where work for a connected computer waits until the computer collects it.
 *
 * The companion holds one long poll open to the service; nothing on the
 * computer listens. A request is queued here, handed to the next poll, and
 * answered by a separate post. Each computer has two channels: `main`, which
 * the companion itself answers, and `browser`, which the companion's browser
 * bridge answers while the browser extension is switched on. Each channel has
 * its own poll, queue and presence.
 *
 * Three outcomes are kept apart, because they mean different things to the
 * broker:
 *
 * - `not_delivered`: the computer never collected the request (it is offline,
 *   was disconnected, or what the request needs was turned off while it
 *   waited). Nothing happened there, and saying so is exact.
 * - `no_answer`: the computer collected it and no answer came back in time.
 *   It may have run, so the action is `unknown` and never sent again blindly.
 * - `reply`: the computer's own answer.
 *
 * The hub is in memory and belongs to the one service process. A restart
 * forgets what was waiting: an undelivered request is then a timeout of a
 * dispatch that never left, and a delivered one is `unknown`, which is the
 * truth.
 */
import {
  DEVICE_LIMITS,
  type DeviceChannel,
  type DeviceRequest,
  type DeviceResult,
} from '@melete/contracts';

export type DeviceCallOutcome =
  | { kind: 'reply'; reply: DeviceResult }
  | {
      kind: 'not_delivered';
      reason: 'offline' | 'not_collected' | 'disconnected' | 'capability_off';
    }
  | { kind: 'no_answer' };

type Pending = {
  deviceId: string;
  key: string;
  request: DeviceRequest;
  delivered: boolean;
  settle: (outcome: DeviceCallOutcome) => void;
};

const keyOf = (deviceId: string, channel: DeviceChannel) =>
  channel === 'main' ? deviceId : `${deviceId}#${channel}`;

export type OnlineListener = (deviceId: string, channel: DeviceChannel) => void;

export class DeviceHub {
  private readonly queues = new Map<string, Pending[]>();
  private readonly byId = new Map<string, Pending>();
  private readonly waiters = new Map<string, () => void>();
  private readonly seen = new Map<string, number>();
  private readonly listeners = new Set<OnlineListener>();
  /** Computers disconnected for good; a poll still open when that happened does not bring them back. */
  private readonly gone = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Called whenever a channel that was not online is heard from. */
  onOnline(listener: OnlineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The computer was heard from just now on this channel. */
  touch(deviceId: string, channel: DeviceChannel = 'main'): void {
    if (this.gone.has(deviceId)) return;
    const was = this.online(deviceId, channel);
    this.seen.set(keyOf(deviceId, channel), this.now());
    if (!was)
      for (const listener of this.listeners) {
        try {
          listener(deviceId, channel);
        } catch {
          // A listener's failure is its own; presence is still recorded.
        }
      }
  }

  lastSeen(deviceId: string): number | undefined {
    return this.seen.get(deviceId);
  }

  /** A poll is open, or one ended recently enough that the next is surely on its way. */
  online(deviceId: string, channel: DeviceChannel = 'main'): boolean {
    const key = keyOf(deviceId, channel);
    if (this.waiters.has(key)) return true;
    const seen = this.seen.get(key);
    return seen !== undefined && this.now() - seen < DEVICE_LIMITS.offline_after_ms;
  }

  /**
   * Queue one request and wait for its outcome. `timeoutMs` counts from now and
   * covers both collection and the answer.
   */
  call(
    deviceId: string,
    request: Omit<DeviceRequest, 'deadline'>,
    timeoutMs: number,
    signal?: AbortSignal,
    channel: DeviceChannel = 'main',
  ): Promise<DeviceCallOutcome> {
    const key = keyOf(deviceId, channel);
    if (!this.online(deviceId, channel))
      return Promise.resolve({ kind: 'not_delivered', reason: 'offline' });
    if (this.byId.has(request.id))
      return Promise.resolve({ kind: 'not_delivered', reason: 'not_collected' });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending: Pending = {
        deviceId,
        key,
        request: { ...request, deadline: this.now() + timeoutMs },
        delivered: false,
        settle: (outcome) => {
          if (!this.byId.has(request.id)) return;
          this.byId.delete(request.id);
          const queue = this.queues.get(key);
          if (queue) {
            const left = queue.filter((entry) => entry !== pending);
            if (left.length) this.queues.set(key, left);
            else this.queues.delete(key);
          }
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', expire);
          resolve(outcome);
        },
      };
      const expire = () =>
        pending.settle(
          pending.delivered
            ? { kind: 'no_answer' }
            : { kind: 'not_delivered', reason: 'not_collected' },
        );
      this.byId.set(request.id, pending);
      this.queues.set(key, [...(this.queues.get(key) ?? []), pending]);
      timer = setTimeout(expire, timeoutMs);
      if (signal?.aborted) expire();
      else signal?.addEventListener('abort', expire, { once: true });
      this.waiters.get(key)?.();
    });
  }

  /**
   * A long poll on one channel: whatever is queued now, or the first request
   * to arrive within `waitMs`, or nothing. A second poll on the same channel
   * ends the first one empty.
   */
  async poll(
    deviceId: string,
    waitMs: number,
    signal?: AbortSignal,
    channel: DeviceChannel = 'main',
  ): Promise<DeviceRequest[]> {
    const key = keyOf(deviceId, channel);
    this.touch(deviceId, channel);
    const take = () => {
      const queue = this.queues.get(key) ?? [];
      const ready = queue.filter((entry) => !entry.delivered);
      for (const entry of ready) entry.delivered = true;
      return ready.map((entry) => entry.request);
    };
    const now = take();
    if (now.length) return now;
    this.waiters.get(key)?.();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        if (this.waiters.get(key) === done) this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.set(key, done);
      if (signal?.aborted) done();
      else signal?.addEventListener('abort', done, { once: true });
    });
    this.touch(deviceId, channel);
    // A request that arrived while the poll was being closed by a newer poll is
    // left for that newer poll rather than handed to a connection that is gone.
    return signal?.aborted ? [] : take();
  }

  /** The computer's answer. False when nothing by that id is waiting for this computer. */
  settle(deviceId: string, requestId: string, reply: DeviceResult): boolean {
    const pending = this.byId.get(requestId);
    if (!pending || pending.deviceId !== deviceId || !pending.delivered) return false;
    pending.settle({ kind: 'reply', reply });
    return true;
  }

  /** The browser bridge said it is going away: its channel is offline at once. */
  leave(deviceId: string, channel: DeviceChannel): void {
    const key = keyOf(deviceId, channel);
    this.seen.delete(key);
    this.waiters.get(key)?.();
  }

  /**
   * Something this computer allowed was turned off. Requests still waiting to
   * be collected that `allowed` no longer covers are withdrawn and answered
   * now, so nothing is handed over after the change. One already collected is
   * the companion's to refuse, which it does by its own settings.
   */
  withdraw(deviceId: string, allowed: (request: DeviceRequest) => boolean): number {
    let withdrawn = 0;
    for (const pending of [...this.byId.values()])
      if (pending.deviceId === deviceId && !pending.delivered && !allowed(pending.request)) {
        pending.settle({ kind: 'not_delivered', reason: 'capability_off' });
        withdrawn++;
      }
    return withdrawn;
  }

  /**
   * The computer lost access: nothing more is handed to it, and what waited is
   * answered now. `forever` is for a revoked computer, which is never online
   * again under this id; a connector being closed and reopened passes false.
   */
  disconnect(deviceId: string, forever = true): void {
    if (forever) this.gone.add(deviceId);
    for (const pending of [...this.byId.values()])
      if (pending.deviceId === deviceId)
        pending.settle(
          pending.delivered
            ? { kind: 'no_answer' }
            : { kind: 'not_delivered', reason: 'disconnected' },
        );
    for (const key of [...this.waiters.keys()])
      if (key === deviceId || key.startsWith(`${deviceId}#`)) this.waiters.get(key)?.();
    for (const key of [...this.seen.keys()])
      if (key === deviceId || key.startsWith(`${deviceId}#`)) this.seen.delete(key);
  }
}

/** The service is one process, so one hub serves its API and its broker. */
export const sharedDeviceHub = new DeviceHub();
