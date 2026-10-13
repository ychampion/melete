import type { SchedulingClass } from '@melete/contracts';

type Pending = { person: string | undefined; execute: () => Promise<void>; cancel: () => void };
const classes: SchedulingClass[] = ['interactive', 'background', 'quiet'];

/**
 * Each nonempty class gets the next free slot in turn; inference itself remains
 * bounded. Within a class the slot goes to the person running the fewest
 * attempts, and among people running as many, to the one whose last start is
 * longest ago, so one person's queue of chats or routines cannot keep everyone
 * else waiting. With `perPerson` set, nobody runs more than that many at once
 * while their other work waits. Work given no person keeps its place in line.
 */
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
  /** Attempts running now, by person. */
  private readonly running = new Map<string, number>();
  /** When each person last got a slot, as a count of slots given. */
  private readonly lastStarted = new Map<string, number>();
  private started = 0;
  constructor(
    readonly capacity = 2,
    readonly perPerson = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Scheduler capacity must be positive');
    if (perPerson !== Number.POSITIVE_INFINITY && (!Number.isInteger(perPerson) || perPerson < 1))
      throw new Error('A per-person limit must be positive');
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
  /** How many attempts this person is running now. */
  activeFor(person: string): number {
    return this.running.get(person) ?? 0;
  }
  /**
   * What would hold this person's next attempt back, if anything: every slot
   * taken (`installation`), or their own limit reached (`person`).
   */
  waitReason(person?: string): 'installation' | 'person' | null {
    if (this.active >= this.capacity) return 'installation';
    if (person !== undefined && this.activeFor(person) >= this.perPerson) return 'person';
    return null;
  }
  run<T>(scheduling: SchedulingClass, operation: () => Promise<T>, person?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Scheduler stopped'));
    return new Promise<T>((resolve, reject) => {
      this.queues[scheduling].push({
        person,
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
  /** The place in a class's queue of the work to start next, or -1 when none may start. */
  private pick(queue: Pending[]): number {
    let best = -1;
    let bestRunning = 0;
    let bestStarted = 0;
    for (let index = 0; index < queue.length; index++) {
      const person = queue[index]?.person;
      const running = person === undefined ? 0 : this.activeFor(person);
      if (running >= this.perPerson) continue;
      const started =
        person === undefined ? Number.NEGATIVE_INFINITY : (this.lastStarted.get(person) ?? -1);
      if (
        best === -1 ||
        running < bestRunning ||
        (running === bestRunning && started < bestStarted)
      ) {
        best = index;
        bestRunning = running;
        bestStarted = started;
      }
    }
    return best;
  }
  private drain() {
    while (!this.closed && this.active < this.capacity) {
      let next: Pending | undefined;
      for (let offset = 0; offset < classes.length; offset++) {
        const index = (this.cursor + offset) % classes.length;
        const candidate = classes[index];
        if (!candidate) continue;
        const queue = this.queues[candidate];
        const place = this.pick(queue);
        if (place === -1) continue;
        next = queue.splice(place, 1)[0];
        this.cursor = (index + 1) % classes.length;
        break;
      }
      if (!next) break;
      const { person } = next;
      this.active++;
      if (person !== undefined) {
        this.running.set(person, this.activeFor(person) + 1);
        this.lastStarted.set(person, this.started);
      }
      this.started++;
      void next.execute().finally(() => {
        this.active--;
        if (person !== undefined) {
          const left = this.activeFor(person) - 1;
          if (left > 0) this.running.set(person, left);
          else this.running.delete(person);
        }
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
