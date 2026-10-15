import type { SchedulingClass } from '@melete/contracts';

type Pending = {
  /** Whose turn it is; work given no person is held as one person of its own. */
  person: string;
  execute: () => Promise<void>;
  cancel: () => void;
};
const classes: SchedulingClass[] = ['interactive', 'background', 'quiet'];
/** Stands for every piece of work given no person. */
const NOBODY = '\u0000nobody';
type Share = 'interactive' | 'background';
/** Chats draw on a person's whole limit; background and quiet work on all of it but one slot. */
const shareOf = (scheduling: SchedulingClass): Share =>
  scheduling === 'interactive' ? 'interactive' : 'background';

/**
 * Each nonempty class gets the next free slot in turn; inference itself remains
 * bounded. Within a class the slot goes to the person running the fewest
 * attempts, and among people running as many, to the one whose last start is
 * longest ago, so one person's queue of chats or routines cannot keep everyone
 * else waiting. With `perPerson` set, nobody runs more than that many at once
 * while their further work waits. Routines and other background work leave
 * one of those slots to the person's chats, so their own routines never hold
 * back their chat (with a limit of 1 that slot is the only one, and a chat
 * waits for a routine of theirs to finish). Work given no person waits its
 * turn and is held to the limit as one person.
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
  /** Attempts running now, by person and share. */
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
  private runningIn(share: Share, person: string): number {
    return this.running.get(`${share}:${person}`) ?? 0;
  }
  /** How many routines and other background work one person may run at once. */
  private get backgroundLimit(): number {
    return this.perPerson > 1 ? this.perPerson - 1 : this.perPerson;
  }
  /** Whether this person's own limit lets work of this share start now. */
  private mayStart(share: Share, person: string): boolean {
    const total = this.runningIn('interactive', person) + this.runningIn('background', person);
    if (total >= this.perPerson) return false;
    return share === 'interactive' || this.runningIn('background', person) < this.backgroundLimit;
  }
  /** How many attempts this person is running now: all of them, or those of one share. */
  activeFor(person: string | undefined, scheduling?: SchedulingClass): number {
    const key = person ?? NOBODY;
    return scheduling
      ? this.runningIn(shareOf(scheduling), key)
      : this.runningIn('interactive', key) + this.runningIn('background', key);
  }
  /**
   * What would hold this person's next attempt of this class back, if
   * anything: their own limit reached (`person`), or every slot taken
   * (`installation`).
   */
  waitReason(
    person?: string,
    scheduling: SchedulingClass = 'interactive',
  ): 'installation' | 'person' | null {
    if (!this.mayStart(shareOf(scheduling), person ?? NOBODY)) return 'person';
    if (this.active >= this.capacity) return 'installation';
    return null;
  }
  /**
   * Whether work of this class for this person would wait for their own limit
   * even after everything of theirs already waiting ahead of it had started.
   */
  heldByOwnLimit(scheduling: SchedulingClass, person?: string): boolean {
    if (this.perPerson === Number.POSITIVE_INFINITY) return false;
    const key = person ?? NOBODY;
    let background = this.runningIn('background', key);
    let total = this.runningIn('interactive', key) + background;
    for (const candidate of classes)
      for (const pending of this.queues[candidate])
        if (pending.person === key) {
          total++;
          if (shareOf(candidate) === 'background') background++;
        }
    if (total >= this.perPerson) return true;
    return shareOf(scheduling) === 'background' && background >= this.backgroundLimit;
  }
  run<T>(scheduling: SchedulingClass, operation: () => Promise<T>, person?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Scheduler stopped'));
    return new Promise<T>((resolve, reject) => {
      this.queues[scheduling].push({
        person: person ?? NOBODY,
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
  private pick(queue: Pending[], share: Share): number {
    let best = -1;
    let bestRunning = 0;
    let bestStarted = 0;
    for (let index = 0; index < queue.length; index++) {
      const person = queue[index]?.person;
      if (person === undefined || !this.mayStart(share, person)) continue;
      const running = this.runningIn('interactive', person) + this.runningIn('background', person);
      const started = this.lastStarted.get(person) ?? -1;
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
      let share: Share = 'interactive';
      for (let offset = 0; offset < classes.length; offset++) {
        const index = (this.cursor + offset) % classes.length;
        const candidate = classes[index];
        if (!candidate) continue;
        const queue = this.queues[candidate];
        const place = this.pick(queue, shareOf(candidate));
        if (place === -1) continue;
        next = queue.splice(place, 1)[0];
        share = shareOf(candidate);
        this.cursor = (index + 1) % classes.length;
        break;
      }
      if (!next) break;
      const key = `${share}:${next.person}`;
      this.active++;
      this.running.set(key, (this.running.get(key) ?? 0) + 1);
      this.lastStarted.set(next.person, this.started);
      this.started++;
      void next.execute().finally(() => {
        this.active--;
        const left = (this.running.get(key) ?? 1) - 1;
        if (left > 0) this.running.set(key, left);
        else this.running.delete(key);
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
