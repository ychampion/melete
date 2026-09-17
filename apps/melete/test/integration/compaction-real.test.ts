import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeEvent } from '@melete/contracts';
import { asc, eq } from 'drizzle-orm';
import {
  API_KEY,
  hermesHome,
  startRuntime,
  waitForApi,
} from '../../../../packages/runtime-hermes/scripts/e2e.ts';
import { HermesRuntimeAdapter } from '../../../../packages/runtime-hermes/src/adapter.ts';
import { signCapability } from '../../src/broker/capability.ts';
import { createInternalServer } from '../../src/broker/internal-server.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { event } from '../../src/db/schema.ts';
import {
  COMPACTION_FIXTURES,
  createCompactionScript,
  SCRIPTED_SUMMARY,
} from '../../src/gateway/compaction.ts';
import { fakeProvider } from '../../src/gateway/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

/**
 * Opt in after preparing the pinned Python environment; ordinary suites need no
 * Hermes install.
 *
 * Marked failing, not skipped: the behaviour is the one the engine is meant to
 * have, and it is red for a reason that is named and owned elsewhere. The
 * capability header is written only under the gateway provider entry, while the
 * engine builds the compaction summary call through a separate auxiliary client
 * that carries `model.extra_headers` and not the provider's. The summary
 * request therefore reaches the gateway with no capability and is refused
 * `401 capability_required` before it is ever authenticated, so the compaction
 * aborts before it commits, nothing is observed, and the next main request is
 * still the whole history and is refused `413 input_context_exceeded`. Writing
 * the header into `model.extra_headers` clears both; when it does, this stops
 * being a failing test and the `.failing` marker comes off.
 */
const realTest = process.env.MELETE_HERMES_E2E === '1' ? test.failing : test.skip;

/** Roughly 30 KB per read, so four reads pass any small compaction threshold. */
const FIXTURE_BYTES = 30_000;

realTest(
  'real Hermes compacts inside an attempt through the gateway and records on_compaction',
  async () => {
    const handle = await testDatabase();
    if (!handle) throw new Error('Postgres unavailable');
    const queue = await startQueue(handle.url);
    const jobs = new JobService(handle.db, queue.boss);
    const key = 'real-compaction-capability-key-32-bytes';
    const approvalKey = 'real-compaction-approval-key-32-bytes';
    const { claims, connectionId } = await seedJob(handle.sql, {
      provider: 'files',
      scopes: ['files.read'],
      budget: { max_actions: 8, max_turns: 20, max_wall_ms: 240_000 },
    });
    await handle.sql`update attempt set lease_expires_at = now() + interval '10 minutes', connection_generations = ${JSON.stringify({ [connectionId]: 0 })}::jsonb where id = ${claims.attempt_id}`;
    const token = signCapability(claims, key);
    const workRoot = mkdtempSync(join(tmpdir(), 'melete-compaction-work-'));
    mkdirSync(join(workRoot, claims.job_id));
    for (const [index, name] of COMPACTION_FIXTURES.entries()) {
      writeFileSync(
        join(workRoot, claims.job_id, name),
        `fixture ${index} `.padEnd(FIXTURE_BYTES, `abcdefghij${index} `),
      );
    }
    const registry = await configuredConnectors({
      sql: handle.sql,
      workRoot,
      spacesRoot: mkdtempSync(join(tmpdir(), 'melete-compaction-spaces-')),
      connections: [],
      enableTestConnector: true,
    });
    const script = createCompactionScript();
    const internal = createInternalServer({
      sql: handle.sql,
      connectors: registry,
      capabilityKey: key,
      approvalKey,
      boss: queue.boss,
      providers: [fakeProvider],
      defaultProvider: 'fake',
      fake: script,
    });
    await new Promise<void>((resolve, reject) => {
      internal.server.once('error', reject);
      internal.server.listen(3172, '127.0.0.1', resolve);
    });
    const previousBroker = process.env.MELETE_BROKER_URL;
    process.env.MELETE_BROKER_URL = 'http://127.0.0.1:3172';
    // The absolute cap has to land between the third read and the fourth, not
    // below the first. The engine measures the whole message list, so one 30 KB
    // read already estimates about 10,000 tokens; a cap under that fires while
    // the transcript is three messages long, and the engine's head and tail
    // protections then leave nothing to summarize, which it records as a
    // no-progress compaction and backs off from for five minutes. Four reads
    // estimate about 32,500 tokens and three about 25,000, so the cap sits
    // between them. A legacy tail keeps the compaction to one summary call.
    const home = hermesHome(3172, 3170, token, {
      model: { context_length: 64_000 },
      compression: { threshold_tokens: 28_000, tail_mode: 'legacy', protect_last_n: 4 },
    });
    const runtime = startRuntime(home, 3170, token, claims.attempt_id, claims.job_id);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3170',
      token: API_KEY,
      parkedActions: async () => [],
    });
    const bundle: AttemptBundle = {
      attempt: { id: claims.attempt_id, job_id: claims.job_id, epoch: 1, revision: 0, token },
      job: {
        title: 'Compaction proof',
        objective: 'Read every fixture in turn and report when they are all read.',
        constraints: {},
        progress_summary: '',
        unresolved_questions: [],
        deliverable: {},
      },
      since_last: EMPTY_SINCE_LAST,
      inputs: {
        new_user_messages: [],
        approval_results: [],
        trigger_events: [],
        repair_briefs: [],
      },
      transcript: [],
      tools: [],
      skills: [],
      knowledge: [],
      workspace: { mount: '/work', files: [] },
      budget: {
        max_turns: 20,
        max_output_tokens: 10_000,
        max_wall_ms: 240_000,
        max_actions: 8,
      },
      model: { provider: 'fake', model: 'scripted', fallback: null },
    };
    try {
      await waitForApi(3170, 90_000);
      await adapter.capabilities();
      const delivered: RuntimeEvent[] = [];
      const outcome = await adapter.start(
        bundle,
        {
          emit: async (value) => {
            await runner.emit(claims, value);
            delivered.push(value);
          },
        },
        AbortSignal.timeout(180_000),
      );
      for (const value of delivered) await runner.emit(claims, value);
      const saved = await handle.db
        .select()
        .from(event)
        .where(eq(event.attemptId, claims.attempt_id))
        .orderBy(asc(event.seq));
      const hooks = saved.filter((row) => row.type === 'hook_event' || row.type === 'hook_error');
      const notices = saved.filter((row) => row.type === 'notice');
      const phase = (row: (typeof notices)[number], name: string) =>
        (row.payload as { phase?: string }).phase === name;
      const requests = notices.filter((row) => phase(row, 'model_request'));
      const receipts = notices.filter((row) => phase(row, 'model_receipt'));

      // 1. The compaction is a durable observation carrying its own count.
      const compactions = hooks.filter(
        (row) => (row.payload as { name: string }).name === 'on_compaction',
      );
      expect(compactions).not.toHaveLength(0);
      const first = compactions[0]?.payload as {
        outcome: string;
        detail?: { compression_count?: number };
      };
      expect(first.outcome).toBe('succeeded');
      expect(first.detail?.compression_count ?? 0).toBeGreaterThanOrEqual(1);

      // 2. The summary call reached the model and settled as a success. Every
      //    call that reaches the script reserved first, so the reservations and
      //    the script's record are the same sequence.
      const summaryIndex = script.calls.findIndex((call) => call.kind === 'summary');
      expect(summaryIndex).toBeGreaterThanOrEqual(0);
      const reservation = (
        requests[summaryIndex]?.payload as { reservation_id?: string } | undefined
      )?.reservation_id;
      expect(reservation).toBeDefined();
      const receipt = receipts.find(
        (row) => (row.payload as { reservation_id?: string }).reservation_id === reservation,
      );
      expect((receipt?.payload as { status?: string } | undefined)?.status).toBe('succeeded');
      // A granted output limit below the length the engine asked for would have
      // truncated the answer, and the engine reads a truncated summary as failed.
      expect(script.calls[summaryIndex]?.finish).toBe('stop');
      expect(script.calls[summaryIndex]?.answered).toContain(SCRIPTED_SUMMARY);

      // 3. The history after the compaction carries the summary and is smaller.
      const main = script.calls.filter((call) => call.kind === 'main');
      const resumed = main.findIndex((call) => call.carriesSummary);
      expect(resumed).toBeGreaterThan(0);
      expect(main[resumed]?.bytes).toBeLessThan(main[resumed - 1]?.bytes ?? 0);

      // 4. Nothing was refused for size: neither estimate nor body limit fired.
      expect(runtime.log()).not.toContain('input_context_exceeded');
      expect(runtime.log()).not.toContain('request_too_large');

      // 5. The attempt ran to the end with every observation delivered.
      expect(outcome.kind).toBe('completed');
      expect(
        hooks.filter(
          (row) => (row.payload as { error_code?: string }).error_code === 'capture_gap',
        ),
      ).toHaveLength(0);
      process.stdout.write(
        `real Hermes compaction proof: ${script.calls.length} model calls, ${compactions.length} compactions\n`,
      );
    } finally {
      await runtime.stop();
      writeFileSync(join(home, 'runtime.log'), runtime.log());
      process.stdout.write(`real Hermes compaction log: ${join(home, 'runtime.log')}\n`);
      if (previousBroker === undefined) delete process.env.MELETE_BROKER_URL;
      else process.env.MELETE_BROKER_URL = previousBroker;
      await runner.stop();
      internal.server.closeAllConnections();
      await new Promise<void>((resolve) => internal.server.close(() => resolve()));
      await queue.stop();
      await handle.close();
    }
  },
  240_000,
);
