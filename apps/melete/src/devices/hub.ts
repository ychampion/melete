/**
 * Where work for a connected computer waits until its companion collects it.
 *
 * The companion holds one long poll open to the service; nothing on the
 * computer listens. A request is queued here, handed to the next poll, and
 * answered by a separate post. Three outcomes are kept apart, because they
 * mean different things to the broker:
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
import { DEVICE_LIMITS, type DeviceRequest, type DeviceResult } from '@melete/contracts';

export type DeviceCallOutcome =
  | { kind: 'reply'; reply: DeviceResult }
  | {
      kind: 'not_delivered';
      reason: 'offline' | 'not_collected' | 'disconnected' | 'capability_off';
    }
  | { kind: 'no_answer' };

type Pending = {
  deviceId: string;
  request: DeviceRequest;
  delivered: boolean;
  settle: (outcome: DeviceCallOutcome) => void;
};

export class DeviceHub {
  private readonly queues = new Map<string, Pending[]>();
  private readonly byId = new Map<string, Pending>();
  private readonly waiters = new Map<string, () => void>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The companion was heard from just now. */
  touch(deviceId: string): void {
    this.seen.set(deviceId, this.now());
  }

  lastSeen(deviceId: string): number | undefined {
    return this.seen.get(deviceId);
  }

  /** A poll is open, or one ended recently enough that the next is surely on its way. */
  online(deviceId: string): boolean {
    if (this.waiters.has(deviceId)) return true;
    const seen = this.seen.get(deviceId);
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
  ): Promise<DeviceCallOutcome> {
    if (!this.online(deviceId))
      return Promise.resolve({ kind: 'not_delivered', reason: 'offline' });
    if (this.byId.has(request.id))
      return Promise.resolve({ kind: 'not_delivered', reason: 'not_collected' });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending: Pending = {
        deviceId,
        request: { ...request, deadline: this.now() + timeoutMs },
        delivered: false,
        settle: (outcome) => {
          if (!this.byId.has(request.id)) return;
          this.byId.delete(request.id);
          const queue = this.queues.get(deviceId);
          if (queue) {
            const left = queue.filter((entry) => entry !== pending);
            if (left.length) this.queues.set(deviceId, left);
            else this.queues.delete(deviceId);
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
      this.queues.set(deviceId, [...(this.queues.get(deviceId) ?? []), pending]);
      timer = setTimeout(expire, timeoutMs);
      if (signal?.aborted) expire();
      else signal?.addEventListener('abort', expire, { once: true });
      this.waiters.get(deviceId)?.();
    });
  }

  /**
   * The companion's long poll: whatever is queued now, or the first request to
   * arrive within `waitMs`, or nothing. A second poll for the same computer
   * ends the first one empty.
   */
  async poll(deviceId: string, waitMs: number, signal?: AbortSignal): Promise<DeviceRequest[]> {
    this.touch(deviceId);
    const take = () => {
      const queue = this.queues.get(deviceId) ?? [];
      const ready = queue.filter((entry) => !entry.delivered);
      for (const entry of ready) entry.delivered = true;
      return ready.map((entry) => entry.request);
    };
    const now = take();
    if (now.length) return now;
    this.waiters.get(deviceId)?.();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        if (this.waiters.get(deviceId) === done) this.waiters.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.set(deviceId, done);
      if (signal?.aborted) done();
      else signal?.addEventListener('abort', done, { once: true });
    });
    this.touch(deviceId);
    // A request that arrived while the poll was being closed by a newer poll is
    // left for that newer poll rather than handed to a connection that is gone.
    return signal?.aborted ? [] : take();
  }

  /** The companion's answer. False when nothing by that id is waiting for this computer. */
  settle(deviceId: string, requestId: string, reply: DeviceResult): boolean {
    this.touch(deviceId);
    const pending = this.byId.get(requestId);
    if (!pending || pending.deviceId !== deviceId || !pending.delivered) return false;
    pending.settle({ kind: 'reply', reply });
    return true;
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

  /** The computer lost access: nothing more is handed to it, and what waited is answered now. */
  disconnect(deviceId: string): void {
    for (const pending of [...this.byId.values()])
      if (pending.deviceId === deviceId)
        pending.settle(
          pending.delivered
            ? { kind: 'no_answer' }
            : { kind: 'not_delivered', reason: 'disconnected' },
        );
    this.waiters.get(deviceId)?.();
    this.seen.delete(deviceId);
  }
}

/** The service is one process, so one hub serves its API and its broker. */
export const sharedDeviceHub = new DeviceHub();
