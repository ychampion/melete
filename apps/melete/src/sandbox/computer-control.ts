/**
 * Who is driving each sandbox computer: the agent, or a person who took it
 * over. Keyed by the sandbox itself rather than the session, because a
 * workspace resumed by the next attempt is the same computer. Every change
 * moves the epoch on, so an action planned under the old one can be told
 * apart.
 *
 * The service keeps this in Postgres (`sandbox_control`), so every instance
 * on the database reads the same holder, and a computer a person took over
 * stays theirs across a restart or a change of which instance sweeps. A
 * change is made only from the epoch it was read at: of two instances taking
 * the same computer over at once, one wins and the other is told the epoch
 * moved. Handing the computer to another attempt moves the epoch too, so a
 * takeover read before that hand-over loses rather than parking the wrong job.
 */
import type { SandboxControl } from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';

export type ComputerControlState = { control: SandboxControl; epoch: number };

/** How long a person keeps a computer with no live view of it open. */
export const UNWATCHED_HOLD_MS = 30 * 60_000;

export interface ComputerControls {
  state(sandbox: string): Promise<ComputerControlState>;
  /**
   * Control passes to `to`, and the epoch moves on even when it was already
   * there. With `from`, only if the epoch is still that one; null if it moved.
   */
  change(
    sandbox: string,
    to: SandboxControl,
    options?: { from?: number; principalId?: string },
  ): Promise<ComputerControlState | null>;
  /** The holder's live view is open now. */
  seen(sandbox: string): Promise<void>;
  /** Hands back every computer whose holder has had no live view open for `afterMs`. */
  handBackUnwatched(afterMs?: number): Promise<string[]>;
  /** Told of each change made through this object, in this process. */
  onChange(listener: (sandbox: string) => void): () => void;
}

const AGENT: ComputerControlState = { control: 'agent', epoch: 0 };

/**
 * A condition on `sandbox_session` rows: the computer is not held by a
 * person. Used in the statement that settles, suspends or expires a session,
 * so the check and the act are one.
 */
export function notHeldByPerson(sql: Sql | TransactionSql) {
  return sql`not exists (select 1 from sandbox_control c
    where c.provider_sandbox_id = sandbox_session.provider_sandbox_id and c.control = 'human')`;
}

/**
 * Inside the transaction that hands a computer to another attempt: moves the
 * epoch on and keeps the row locked until that transaction ends, so a
 * takeover waits for it and then finds the epoch it read gone. Returns the
 * epoch it moved to, or null when a person holds the computer; nothing
 * changes then.
 */
export async function claimForAttempt(tx: TransactionSql, sandbox: string): Promise<number | null> {
  await tx`insert into sandbox_control (provider_sandbox_id, control, epoch)
    values (${sandbox}, 'agent', 0) on conflict (provider_sandbox_id) do nothing`;
  const [moved] = await tx`update sandbox_control set epoch = epoch + 1, changed_at = now()
    where provider_sandbox_id = ${sandbox} and control = 'agent'
    returning epoch`;
  // The epoch the attempt was handed the computer at (always 1 or more), or null.
  return moved ? Number(moved.epoch) : null;
}

export class PostgresComputerControls implements ComputerControls {
  private readonly listeners = new Set<(sandbox: string) => void>();

  constructor(private readonly sql: Sql) {}

  async state(sandbox: string): Promise<ComputerControlState> {
    const [row] = await this.sql<ComputerControlState[]>`select control, epoch
      from sandbox_control where provider_sandbox_id = ${sandbox}`;
    return row ? { control: row.control, epoch: row.epoch } : AGENT;
  }

  async change(
    sandbox: string,
    to: SandboxControl,
    options: { from?: number; principalId?: string } = {},
  ): Promise<ComputerControlState | null> {
    const principal = to === 'human' ? (options.principalId ?? null) : null;
    const { from } = options;
    // Every computer has a row at its first change, at epoch 0; the change is
    // then one update, compared against the epoch read.
    await this.sql`insert into sandbox_control (provider_sandbox_id, control, epoch)
      values (${sandbox}, 'agent', 0) on conflict (provider_sandbox_id) do nothing`;
    const [row] = await this.sql<ComputerControlState[]>`
      update sandbox_control set control = ${to}, epoch = epoch + 1,
        principal_id = ${principal}, changed_at = now(),
        seen_at = ${to === 'human' ? this.sql`now()` : this.sql`null`}
      where provider_sandbox_id = ${sandbox}
        ${from === undefined ? this.sql`` : this.sql`and epoch = ${from}`}
      returning control, epoch`;
    if (!row) return null;
    for (const listener of this.listeners) listener(sandbox);
    return { control: row.control, epoch: row.epoch };
  }

  async seen(sandbox: string): Promise<void> {
    await this.sql`update sandbox_control set seen_at = now()
      where provider_sandbox_id = ${sandbox} and control = 'human'`;
  }

  async handBackUnwatched(afterMs = UNWATCHED_HOLD_MS): Promise<string[]> {
    const rows = await this.sql`update sandbox_control
      set control = 'agent', epoch = epoch + 1, principal_id = null, changed_at = now(),
        seen_at = null
      where control = 'human'
        and coalesce(seen_at, changed_at) < now() - make_interval(secs => ${afterMs / 1000})
      returning provider_sandbox_id`;
    const sandboxes = rows.map((row) => String(row.provider_sandbox_id));
    for (const sandbox of sandboxes) for (const listener of this.listeners) listener(sandbox);
    return sandboxes;
  }

  onChange(listener: (sandbox: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** One process's controls, for code exercised without a database. */
export class MemoryComputerControls implements ComputerControls {
  private readonly held = new Map<string, ComputerControlState>();
  private readonly listeners = new Set<(sandbox: string) => void>();

  async state(sandbox: string): Promise<ComputerControlState> {
    return this.held.get(sandbox) ?? AGENT;
  }

  async change(
    sandbox: string,
    to: SandboxControl,
    options: { from?: number } = {},
  ): Promise<ComputerControlState | null> {
    const current = this.held.get(sandbox) ?? AGENT;
    if (options.from !== undefined && options.from !== current.epoch) return null;
    const next = { control: to, epoch: current.epoch + 1 };
    this.held.set(sandbox, next);
    for (const listener of this.listeners) listener(sandbox);
    return next;
  }

  async seen(): Promise<void> {}

  async handBackUnwatched(): Promise<string[]> {
    return [];
  }

  onChange(listener: (sandbox: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
