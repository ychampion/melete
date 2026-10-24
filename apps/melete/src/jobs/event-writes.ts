import type { Transaction } from '../db/transaction.ts';

type Write = {
  operation: (tx: Transaction) => Promise<void>;
  rollback: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** The most callers sharing one turn of the event order lock. */
const BATCH = 64;

/**
 * Writes that arrive together, or while a write is under way, share the next
 * transaction. A caller is acknowledged only after its transaction commits.
 * A failed shared transaction is retried one caller at a time, so one stale
 * attempt cannot discard another attempt's events.
 */
export class EventWrites {
  private readonly waiting: Write[] = [];
  private flushing = false;

  constructor(
    private readonly transaction: (operation: (tx: Transaction) => Promise<void>) => Promise<void>,
    private readonly collectionDelayMs: () => number = () => 0,
  ) {}

  write(operation: Write['operation'], rollback: Write['rollback']): Promise<void> {
    const written = new Promise<void>((resolve, reject) => {
      this.waiting.push({ operation, rollback, resolve, reject });
    });
    if (!this.flushing) {
      this.flushing = true;
      void Promise.resolve().then(() => this.flush());
    }
    return written;
  }

  private async flush(): Promise<void> {
    try {
      while (this.waiting.length) {
        const delay = this.collectionDelayMs();
        // Concurrent attempts collect before each commit, including writes
        // arriving during the previous one. A lone attempt starts immediately.
        if (delay > 0 && this.waiting.length < BATCH)
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        await this.batch(this.waiting.splice(0, BATCH));
      }
    } finally {
      this.flushing = false;
    }
  }

  private async batch(writes: Write[]): Promise<void> {
    const ran: Write[] = [];
    try {
      await this.transaction(async (tx) => {
        for (const write of writes) {
          // Include an operation that fails after changing its in-memory state.
          ran.push(write);
          await write.operation(tx);
        }
      });
      for (const write of writes) write.resolve();
    } catch (error) {
      const rollback = this.restore(ran);
      if (rollback || writes.length === 1) {
        for (const write of writes) write.reject(rollback?.error ?? error);
        return;
      }
      // The database and each executed operation's in-memory state have rolled
      // back. Preserve input order and settle each caller independently.
      for (const write of writes) await this.alone(write);
    }
  }

  private async alone(write: Write): Promise<void> {
    let ran = false;
    try {
      await this.transaction(async (tx) => {
        ran = true;
        await write.operation(tx);
      });
      write.resolve();
    } catch (error) {
      const rollback = ran ? this.restore([write]) : undefined;
      write.reject(rollback?.error ?? error);
    }
  }

  /** Restore in reverse order because two queued operations can share state. */
  private restore(writes: Write[]): { error: unknown } | undefined {
    let failure: { error: unknown } | undefined;
    for (let index = writes.length - 1; index >= 0; index--) {
      try {
        writes[index]?.rollback();
      } catch (error) {
        // Settle every caller even if a cleanup fails; retrying with uncertain
        // state would be unsafe, but later independent writes can still run.
        failure ??= { error };
      }
    }
    return failure;
  }
}
