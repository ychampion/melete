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
 * moved.
 */
import type { SandboxControl } from '@melete/contracts';
import type { Sql } from 'postgres';

export type ComputerControlState = { control: SandboxControl; epoch: number };

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
  /** Told of each change made through this object, in this process. */
  onChange(listener: (sandbox: string) => void): () => void;
}

const AGENT: ComputerControlState = { control: 'agent', epoch: 0 };

/**
 * A condition on `sandbox_session` rows: the computer is not held by a
 * person. For queries that settle or expire sessions.
 */
export function notHeldByPerson(sql: Sql) {
  return sql`not exists (select 1 from sandbox_control c
    where c.provider_sandbox_id = sandbox_session.provider_sandbox_id and c.control = 'human')`;
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
    const [row] =
      from === undefined
        ? await this.sql<ComputerControlState[]>`
            insert into sandbox_control (provider_sandbox_id, control, epoch, principal_id)
            values (${sandbox}, ${to}, 1, ${principal})
            on conflict (provider_sandbox_id) do update
              set control = excluded.control, epoch = sandbox_control.epoch + 1,
                principal_id = excluded.principal_id, changed_at = now()
            returning control, epoch`
        : from === 0
          ? // Epoch 0 is a computer with no row: only the first insert wins.
            await this.sql<ComputerControlState[]>`
              insert into sandbox_control (provider_sandbox_id, control, epoch, principal_id)
              values (${sandbox}, ${to}, 1, ${principal})
              on conflict (provider_sandbox_id) do nothing
              returning control, epoch`
          : await this.sql<ComputerControlState[]>`
              update sandbox_control set control = ${to}, epoch = epoch + 1,
                principal_id = ${principal}, changed_at = now()
              where provider_sandbox_id = ${sandbox} and epoch = ${from}
              returning control, epoch`;
    if (!row) return null;
    for (const listener of this.listeners) listener(sandbox);
    return { control: row.control, epoch: row.epoch };
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

  onChange(listener: (sandbox: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
