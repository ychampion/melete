/**
 * Running one Composio tool for one connected account, counted first.
 *
 * Each connected account gets its own tool router session, opened on first
 * use and kept for the process; sessions cost nothing, and a tool run in one
 * is a plain tool call. Before a call is sent it is reserved against the
 * installation's limits (`ComposioMeter`), and refused there when a limit is
 * spent; a call Composio refused before running anything is given back, while
 * one whose fate is unknown stays counted.
 */
import type { ComposioMeter } from '../signals/managed-calls.ts';
import { type ComposioClient, ComposioFault, type ComposioToolResult } from './composio.ts';

export type ToolRun = {
  connectedAccountId: string;
  toolkit: string;
  tool: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

export class ComposioRunner {
  /** The session each connected account runs its tools in. */
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(
    readonly client: ComposioClient,
    readonly meter?: ComposioMeter,
  ) {}

  private session(accountId: string, toolkit: string, signal?: AbortSignal): Promise<string> {
    let open = this.sessions.get(accountId);
    if (!open) {
      open = (async () => {
        // The session's user is the account's own, read from Composio, never from a request.
        const account = await this.client.account(accountId, signal);
        if (account.toolkit !== toolkit) throw new ComposioFault('account_unavailable');
        return this.client.openSession({
          userId: account.userId,
          toolkit,
          connectedAccountId: accountId,
          ...(signal ? { signal } : {}),
        });
      })();
      open.catch(() => this.sessions.delete(accountId));
      this.sessions.set(accountId, open);
    }
    return open;
  }

  /** Forget an account's session, as when the account is removed. */
  forget(accountId: string): void {
    this.sessions.delete(accountId);
  }

  /**
   * Run one tool. Throws `ComposioCapReached` when a limit refuses it before
   * anything is sent, and `ComposioFault` when Composio could not run it.
   */
  async run(input: ToolRun): Promise<ComposioToolResult> {
    const reservation = this.meter ? await this.meter.reserve('tool_calls') : null;
    let mayHaveRun = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const session = await this.session(input.connectedAccountId, input.toolkit, input.signal);
        try {
          const result = await this.client.execute(session, input.tool, input.args, input.signal);
          mayHaveRun = true;
          return result;
        } catch (error) {
          // A session Composio no longer has: opened again once, the call not yet run.
          if (
            attempt === 0 &&
            error instanceof ComposioFault &&
            error.kind === 'account_unavailable' &&
            !error.mayHaveRun
          ) {
            this.sessions.delete(input.connectedAccountId);
            continue;
          }
          mayHaveRun = !(error instanceof ComposioFault) || error.mayHaveRun;
          throw error;
        }
      }
    } finally {
      if (reservation && !mayHaveRun)
        await this.meter?.release(reservation).catch(() => {
          process.stderr.write('composio: a call that was not sent could not be given back\n');
        });
    }
  }
}
