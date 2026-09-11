import type { SchedulingClass } from '@melete/contracts';

type Pending = { execute: () => Promise<void>; cancel: () => void };
const classes: SchedulingClass[] = ['interactive', 'background', 'quiet'];
/** Each nonempty class gets the next free slot in turn; inference itself remains bounded. */
export class FairScheduler {
  private readonly queues: Record<SchedulingClass, Pending[]> = {
    interactive: [],
    background: [],
    quiet: [],
  };
  private active = 0;
  private cursor = 0;
  private closed = false;
  private readonly idleWaiters = new Set<() => void>();
  constructor(readonly capacity = 2) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Scheduler capacity must be positive');
  }
  get pendingCounts() {
    return {
      interactive: this.queues.interactive.length,
      background: this.queues.background.length,
      quiet: this.queues.quiet.length,
    };
  }
  get activeCount() {
    return this.active;
  }
  run<T>(scheduling: SchedulingClass, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Scheduler stopped'));
    return new Promise<T>((resolve, reject) => {
      this.queues[scheduling].push({
        cancel: () => reject(new Error('Scheduler stopped')),
        execute: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.drain();
    });
  }
  private drain() {
    while (!this.closed && this.active < this.capacity) {
      let next: Pending | undefined;
      for (let offset = 0; offset < classes.length; offset++) {
        const index = (this.cursor + offset) % classes.length;
        const candidate = classes[index];
        if (!candidate || !this.queues[candidate].length) continue;
        next = this.queues[candidate].shift();
        this.cursor = (index + 1) % classes.length;
        break;
      }
      if (!next) break;
      this.active++;
      void next.execute().finally(() => {
        this.active--;
        this.drain();
        if (!this.active) for (const resolve of this.idleWaiters) resolve();
      });
    }
  }
  close() {
    this.closed = true;
    for (const scheduling of classes)
      for (const pending of this.queues[scheduling].splice(0)) pending.cancel();
  }
  async idle() {
    if (!this.active) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    this.idleWaiters.clear();
  }
}
