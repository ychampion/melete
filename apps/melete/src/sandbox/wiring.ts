/**
 * What the service does about sandboxes besides running commands in them.
 *
 * Three things, all of them the service's own business rather than a job's: at
 * boot and every hour after it asks each provider what it still holds and
 * brings that into agreement with the session table; on a timer it sweeps leases that ran out,
 * suspends workspaces whose attempt stopped renewing them and forgets
 * workspaces nobody resumed; and when an attempt ends it suspends that
 * attempt's workspace, or closes its sandbox when there is nothing to keep.
 *
 * A provider belongs to the connection that holds its key, so everything here
 * is resolved by connection: two spaces may use the same provider with
 * different accounts, and one account's reconciliation must never judge the
 * other's sandboxes.
 */
import type { Sql } from 'postgres';
import { reconcileSandboxes } from './reconcile.ts';
import type { SandboxSessions } from './sessions.ts';
import type { SandboxProvider } from './types.ts';

/** The providers this installation currently has, by the connection that holds the key. */
export type SandboxProviders = () => ReadonlyMap<
  string,
  { adapter: string; provider: SandboxProvider }
>;

export type SandboxWiringOptions = {
  sql: Sql;
  sessions: SandboxSessions;
  providers: SandboxProviders;
  /** The `melete.project` label: which sandboxes this installation owns. */
  project: string;
  /** How often the sweep runs. */
  sweepMs: number;
  /**
   * How often reconciliation runs again after boot, so an orphan left while
   * the service ran is found without waiting for a restart. An hour unless set.
   */
  reconcileMs?: number;
  log?: (line: string) => void;
};

export type ReconciledAdapter = {
  connectionId: string;
  adapter: string;
  destroyed: string[];
  lost: string[];
};

export type SandboxWiring = {
  reconcile(signal: AbortSignal): Promise<ReconciledAdapter[]>;
  sweep(signal: AbortSignal): Promise<string[]>;
  /** Called when an attempt finishes. Never blocks the outcome that called it. */
  afterAttempt(attemptId: string): void;
  /** Ends the attempt's session: suspended if it is a workspace, closed if not. */
  settleAttempt(attemptId: string, signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): void;
};

export function startSandboxes(options: SandboxWiringOptions): SandboxWiring {
  const { sql, sessions } = options;
  const say = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // A row names the adapter that created its sandbox. A connection that now
  // holds another adapter cannot reach that sandbox, and handing the other
  // adapter its id would ask the wrong provider to destroy it.
  const providerFor = (adapter: string, connectionId: string) => {
    const held = options.providers().get(connectionId);
    if (held && held.adapter !== adapter)
      throw new Error(
        `connection ${connectionId} now holds the ${held.adapter} adapter, and this session's sandbox was created by ${adapter}`,
      );
    return held?.provider;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  const pending = new Set<Promise<void>>();

  const wiring: SandboxWiring = {
    async reconcile(signal) {
      const reports: ReconciledAdapter[] = [];
      for (const [connectionId, { adapter, provider }] of options.providers()) {
        try {
          const report = await reconcileSandboxes({
            sql,
            provider,
            project: options.project,
            connectionId,
            signal,
          });
          reports.push({ connectionId, adapter, ...report });
        } catch (error) {
          // A provider that does not answer proves nothing; the next boot asks again.
          say(`sandbox reconciliation with ${adapter} did not finish: ${String(error)}`);
        }
      }
      return reports;
    },

    sweep(signal) {
      return sessions.sweep(providerFor, signal);
    },

    async settleAttempt(attemptId, signal) {
      const rows = await sql`select id, agent_id, persistence, connection_id, adapter
        from sandbox_session
        where attempt_id = ${attemptId} and status in ('opening', 'ready')`;
      for (const row of rows) {
        const id = String(row.id);
        const workspace = row.agent_id !== null && row.persistence !== 'ephemeral';
        try {
          const provider = providerFor(String(row.adapter), String(row.connection_id));
          if (!provider) continue;
          if (workspace) await sessions.suspendWorkspace(id, provider, signal);
          else await sessions.close(id, provider, signal);
        } catch (error) {
          // Recorded on the row; the lease sweep finishes what this could not.
          say(`sandbox session ${id} was not settled when its attempt ended: ${String(error)}`);
        }
      }
    },

    afterAttempt(attemptId) {
      const work = wiring
        .settleAttempt(attemptId, AbortSignal.timeout(120_000))
        .catch(() => {})
        .finally(() => pending.delete(work));
      pending.add(work);
    },

    start() {
      timer ??= setInterval(() => {
        void wiring.sweep(AbortSignal.timeout(options.sweepMs)).catch(() => {
          say('sandbox sweep failed');
        });
      }, options.sweepMs);
      timer.unref?.();
      reconcileTimer ??= setInterval(() => {
        void wiring.reconcile(AbortSignal.timeout(120_000)).catch(() => {
          say('sandbox reconciliation failed');
        });
      }, options.reconcileMs ?? 3_600_000);
      reconcileTimer.unref?.();
    },

    stop() {
      clearInterval(timer);
      clearInterval(reconcileTimer);
      timer = undefined;
      reconcileTimer = undefined;
    },
  };
  return wiring;
}

/**
 * What revoking a sandbox connection, or switching it to another key, does
 * first, while the key it had is still held: destroy every sandbox and
 * snapshot the connection's sessions recorded. That key is the only way into
 * the account they live in, and after the change nothing here holds it. A
 * teardown that does not finish does not stop the change; what is left is
 * recorded lost on its rows with the reason, where the sweep and a space
 * removal report it.
 */
export function sandboxKeyChange(options: {
  sessions: SandboxSessions;
  providerFor: (adapter: string, connectionId: string) => SandboxProvider | undefined;
  /** A provider lent a given key, to ask whether a new key reaches the same account. */
  withKey?: (
    adapter: string,
    secretRef: string,
    spaceId: string,
  ) => { provider: SandboxProvider; close(): Promise<void> };
  log?: (line: string) => void;
}) {
  const say = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  return async (
    connection: { id: string; provider: string },
    change: 'revoke' | 'switch' = 'revoke',
    next?: { secretRef: string; spaceId: string },
    signal: AbortSignal = AbortSignal.timeout(120_000),
  ): Promise<void> => {
    if (connection.provider !== 'sandbox') return;
    // A new key that sees what the old one made is the same account's key,
    // rotated: the sandboxes and workspaces carry on under it, since the
    // connection lends whatever key it holds on each call. Only a key that
    // cannot see them, another account's, means they must end now.
    const withKey = options.withKey;
    if (
      change === 'switch' &&
      next &&
      withKey &&
      (await options.sessions.visibleWith(
        connection.id,
        (adapter) => withKey(adapter, next.secretRef, next.spaceId),
        signal,
      ))
    )
      return;
    try {
      await options.sessions.destroyWorkspacesForConnection(
        connection.id,
        options.providerFor,
        signal,
      );
    } catch (error) {
      const happened = change === 'revoke' ? 'was revoked' : 'had its key replaced';
      const left = await options.sessions.recordLeftBehind(
        connection.id,
        `the connection ${happened} before this sandbox could be destroyed, and nothing can reach it without the key it had: ${String(error)}`,
      );
      say(
        `sandbox connection ${connection.id} ${happened} with ${left.length} session(s) not destroyed: ${String(error)}`,
      );
    }
  };
}

/**
 * What a space removal's sandboxes phase is given: providers built from the
 * connection rows, since a space under removal serves no connectors, the
 * teardown, and the question the removal finishes on, asked of the providers
 * rather than of these rows.
 */
export function sandboxRemovalTeardown(
  sessions: SandboxSessions,
  providerFor: (adapter: string, connectionId: string) => SandboxProvider,
) {
  return {
    providerFor,
    destroyWorkspacesForSpace: (
      spaceId: string,
      provider: typeof providerFor,
      signal: AbortSignal,
    ) => sessions.destroyWorkspacesForSpace(spaceId, provider, signal),
    listWorkspacesForSpace: (spaceId: string, provider: typeof providerFor) =>
      sessions.listWorkspacesForSpace(spaceId, provider),
  };
}

/**
 * What the wiring needs of the connector factory, without depending on it: the
 * sandbox settings it was built with and the providers it has opened.
 */
export type SandboxFactory = {
  options: {
    sandbox?: { sessions: SandboxSessions; project: string; maxConcurrent: number };
  };
  sandboxProviders: ReadonlyMap<string, { adapter: string; provider: SandboxProvider }>;
};

/**
 * The wiring a validated environment implies, or nothing when this
 * installation has no sandbox project and therefore owns no sandboxes.
 */
export function startSandboxesFromEnv(
  sql: Sql,
  env: { MELETE_SANDBOX_LEASE_SECONDS: number },
  factory: SandboxFactory,
): SandboxWiring | undefined {
  const sandbox = factory.options.sandbox;
  if (!sandbox) return undefined;
  return startSandboxes({
    sql,
    sessions: sandbox.sessions,
    providers: () => factory.sandboxProviders,
    project: sandbox.project,
    // Often enough that a lease that ran out is noticed well before a session
    // could be mistaken for live, and seldom enough to be cheap.
    sweepMs: Math.max(30_000, Math.floor((env.MELETE_SANDBOX_LEASE_SECONDS * 1000) / 3)),
  });
}
