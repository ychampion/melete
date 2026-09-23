import {
  type AttemptBundle,
  type AttemptOutcome,
  type EventSink,
  inputTokenAllowance,
  type RuntimeAdapter,
} from '@melete/contracts';
import {
  type CatalogState,
  HermesRuntimeAdapter,
  RUNTIME_VERSION,
  renderInput,
  renderInstructions,
} from '@melete/runtime-hermes';
import { pendingRuntimeWait } from '../broker/runtime-wait.ts';
import type { MemorySql } from '../memory/db.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

export type AttemptTiming = { attemptId: string; coldStartMs: number; wallMs: number };

/** One engine per attempt; only the service can inspect the parked-action ledger. */
export class SupervisedHermesRuntime implements RuntimeAdapter {
  constructor(
    readonly supervisor: RuntimeSupervisor,
    readonly sql: MemorySql,
    readonly onTiming: (timing: AttemptTiming) => void = () => {},
    readonly catalogState?: CatalogState,
  ) {}
  async capabilities() {
    // No attempt identity exists at lease reservation time. Validate the live
    // server's capabilities again after launch, before sending it the bundle.
    return { streaming: true, tools: true, interrupt: true, version: RUNTIME_VERSION };
  }
  async start(
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    // Reserve conservative framing for the pinned engine preamble and plugin schemas.
    const promptBytes =
      Buffer.byteLength(
        JSON.stringify([renderInstructions(bundle), renderInput(bundle), bundle.tools]),
        'utf8',
      ) + 32768;
    if (promptBytes > inputTokenAllowance(bundle.model.model, bundle.budget))
      return {
        kind: 'budget_exhausted',
        summary: 'input_context_exceeded: assembled prompt exceeds the model input allowance',
      };
    const started = Date.now();
    const instance = await this.supervisor.launch(bundle, signal);
    try {
      const adapter = new HermesRuntimeAdapter({
        baseUrl: instance.baseUrl,
        token: instance.token,
        pendingWait: (current) => pendingRuntimeWait(this.sql, current),
        // Loading a tool updates broker state; the next Hermes run must hydrate
        // that state before the newly disclosed schema can reach the provider.
        catalogState: this.catalogState,
        parkedActions: async (current) => {
          const rows = await this
            .sql`select a.id from action a join approval p on p.action_id = a.id
              where a.job_id = ${current.attempt.job_id} and a.status = 'needs_approval'
              and p.job_revision = ${current.attempt.revision} and p.decision is null order by a.id`;
          return rows.map((row) => row.id as string);
        },
      });
      await adapter.capabilities();
      signal.throwIfAborted();
      return await adapter.start(bundle, sink, signal);
    } finally {
      // The outcome, or the engine's own failure, is what the attempt reports. An
      // engine that finished but would not stop is recorded, never turned into a
      // lost attempt that runs again.
      await instance.stop().catch((error: unknown) => {
        process.stderr.write(
          `runtime stop failed for ${bundle.attempt.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      this.onTiming({
        attemptId: bundle.attempt.id,
        coldStartMs: instance.coldStartMs,
        wallMs: Date.now() - started,
      });
    }
  }
}
