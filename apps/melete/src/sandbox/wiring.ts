/**
 * What the service does about sandboxes besides running commands in them.
 *
 * Three things, all of them the service's own business rather than a job's: at
 * boot it asks each provider what it still holds and brings that into
 * agreement with the session table; on a timer it sweeps leases that ran out,
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
  const providerFor = (_adapter: string, connectionId: string) =>
    options.providers().get(connectionId)?.provider;
  let timer: ReturnType<typeof setInterval> | undefined;
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
        const provider = providerFor(String(row.adapter), String(row.connection_id));
        if (!provider) continue;
        const workspace = row.agent_id !== null && row.persistence !== 'ephemeral';
        try {
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
    },

    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
  return wiring;
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
