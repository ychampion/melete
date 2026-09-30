/**
 * Who is driving each sandbox computer: the agent, or a person who took it
 * over. Held in memory for as long as the process runs, keyed by the sandbox
 * itself rather than the session, because a workspace resumed by the next
 * attempt is the same computer. Every change moves the epoch on, so an action
 * planned under the old one can be told apart. A restart gives every computer
 * back to the agent, and a job a person parked stays parked until they answer.
 */
import type { SandboxControl } from '@melete/contracts';

export type ComputerControlState = { control: SandboxControl; epoch: number };

export class ComputerControls {
  private readonly held = new Map<string, ComputerControlState>();
  private readonly listeners = new Set<(sandbox: string) => void>();

  state(sandbox: string): ComputerControlState {
    return this.held.get(sandbox) ?? { control: 'agent', epoch: 0 };
  }

  /** Control passes to `to`; the epoch moves on even when it was already there. */
  change(sandbox: string, to: SandboxControl): ComputerControlState {
    const next = { control: to, epoch: this.state(sandbox).epoch + 1 };
    this.held.set(sandbox, next);
    for (const listener of this.listeners) listener(sandbox);
    return next;
  }

  onChange(listener: (sandbox: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forget(sandbox: string): void {
    this.held.delete(sandbox);
  }
}

/** The one table this process keeps. */
export const computerControls = new ComputerControls();
