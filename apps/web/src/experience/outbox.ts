/**
 * Messages on their way to the service. Each one keeps the request that sends
 * it, and that request carries the message's own idempotency key, so a retry
 * resends the same message rather than a new one: the service answers a key it
 * has already seen with the turn it already made. One request runs at a time
 * per message, so Retry pressed twice, or Retry on the bubble and on the toast
 * together, sends once.
 */
import { InFlight } from './decide.ts';

export class Outbox {
  private readonly pending = new Map<string, () => Promise<boolean>>();
  private readonly flight: InFlight;

  constructor(changed: () => void = () => {}) {
    this.flight = new InFlight(changed);
  }

  /** Send the message drawn as `localId`; `post` resolves true once the service has it. */
  send(localId: string, post: () => Promise<boolean>): Promise<boolean> {
    this.pending.set(localId, post);
    return this.retry(localId) ?? Promise.resolve(false);
  }

  /**
   * Send a message that did not go, with its first request. Null when there is
   * nothing to resend or a send of it is already in flight.
   */
  retry(localId: string): Promise<boolean> | null {
    const post = this.pending.get(localId);
    if (!post) return null;
    const run = this.flight.run(localId, post);
    if (!run) return null;
    return run.then((sent) => {
      if (sent) this.pending.delete(localId);
      return sent;
    });
  }

  /** Whether a send of this message is in flight now. */
  sending(localId: string): boolean {
    return this.flight.has(localId);
  }
}
