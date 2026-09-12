import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import { createScriptedProvider, fakeProvider } from '../../src/gateway/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

/** Opt in after preparing the pinned Python environment; ordinary suites need no Hermes install. */
const realTest = process.env.MELETE_HERMES_E2E === '1' ? test : test.skip;

realTest(
  'real Hermes persists lifecycle hooks and a throwing observer without stopping the tool run',
  async () => {
    const handle = await testDatabase();
    if (!handle) throw new Error('Postgres unavailable');
    const queue = await startQueue(handle.url);
    const jobs = new JobService(handle.db, queue.boss);
    const key = 'real-hook-capability-key-at-least-32-bytes';
    const approvalKey = 'real-hook-approval-key-at-least-32-bytes';
    const { claims, connectionId } = await seedJob(handle.sql, {
      provider: 'files',
      scopes: ['files.read'],
      budget: { max_wall_ms: 180_000 },
    });
    await handle.sql`update attempt set lease_expires_at = now() + interval '5 minutes', connection_generations = ${JSON.stringify({ [connectionId]: 0 })}::jsonb where id = ${claims.attempt_id}`;
    const token = signCapability(claims, key);
    const workRoot = mkdtempSync(join(tmpdir(), 'melete-hook-work-'));
    mkdirSync(join(workRoot, claims.job_id));
    writeFileSync(join(workRoot, claims.job_id, 'fixture.txt'), 'private fixture value');
    const registry = await configuredConnectors({
      sql: handle.sql,
      workRoot,
      spacesRoot: mkdtempSync(join(tmpdir(), 'melete-hook-spaces-')),
      connections: [],
      enableTestConnector: true,
    });
    const internal = createInternalServer({
      sql: handle.sql,
      connectors: registry,
      capabilityKey: key,
      approvalKey,
      boss: queue.boss,
      providers: [fakeProvider],
      defaultProvider: 'fake',
      fake: createScriptedProvider([
        { tool: { name: 'files.read', arguments: { path: 'fixture.txt' } } },
        { text: 'Finished the scripted read.' },
      ]),
    });
    await new Promise<void>((resolve, reject) => {
      internal.server.once('error', reject);
      internal.server.listen(3162, '127.0.0.1', resolve);
    });
    const previousBroker = process.env.MELETE_BROKER_URL;
    const catalogResponse = await fetch('http://127.0.0.1:3162/tools', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as { tools: { name: string }[] };
    // Native discovery and reactions need no connection grant; the only granted
    // connector operation in this fixture must still be files.read.
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'files.read',
      'load_tool',
      'react',
      'search_tools',
    ]);
    process.env.MELETE_BROKER_URL = 'http://127.0.0.1:3162';
    const home = hermesHome(3162, 3160, token);
    // Fault injection lives only in this disposable plugin copy. It uses the same
    // observer wrapper, and the real Hermes loader dispatches it after registration.
    appendFileSync(
      join(home, 'plugins/melete/__init__.py'),
      `
_normal_register = register
def register(ctx):
    result = _normal_register(ctx)
    from melete_runtime_hooks import observe
    def broken(name, payload):
        raise ValueError("private observer exception")
    def throwing_observer(**payload):
        observe("pre_tool_call", payload, build=broken)
    ctx.register_hook("pre_tool_call", throwing_observer)
    return result
`,
    );
    const runtime = startRuntime(home, 3160, token, claims.attempt_id, claims.job_id);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    const adapter = new HermesRuntimeAdapter({
      baseUrl: 'http://127.0.0.1:3160',
      token: API_KEY,
      parkedActions: async () => [],
    });
    const bundle: AttemptBundle = {
      attempt: { id: claims.attempt_id, job_id: claims.job_id, epoch: 1, revision: 0, token },
      job: {
        title: 'Lifecycle proof',
        objective: 'Read once and finish.',
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
      budget: { max_turns: 5, max_output_tokens: 2000, max_wall_ms: 180_000, max_actions: 2 },
      model: { provider: 'fake', model: 'scripted', fallback: null },
    };
    try {
      await waitForApi(3160, 90_000);
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
        AbortSignal.timeout(60_000),
      );
      expect(outcome.kind).toBe('completed');
      for (const value of delivered) await runner.emit(claims, value);
      const saved = await handle.db
        .select()
        .from(event)
        .where(eq(event.attemptId, claims.attempt_id))
        .orderBy(asc(event.seq));
      const hooks = saved.filter((row) => row.type === 'hook_event' || row.type === 'hook_error');
      const names = hooks.map((row) => (row.payload as { name: string }).name);
      for (const name of [
        'on_session_start',
        'pre_llm_call',
        'pre_tool_call',
        'post_tool_call',
        'post_llm_call',
        'on_session_end',
      ])
        expect(names).toContain(name);
      expect(names.indexOf('pre_tool_call')).toBeLessThan(names.indexOf('post_tool_call'));
      expect(names.indexOf('post_tool_call')).toBeLessThan(names.indexOf('on_session_end'));
      expect(
        hooks.some(
          (row) =>
            row.type === 'hook_error' &&
            (row.payload as { error_code?: string }).error_code === 'observer_failed',
        ),
      ).toBe(true);
      expect(new Set(hooks.map((row) => row.dedupKey)).size).toBe(hooks.length);
      expect(JSON.stringify(hooks)).not.toContain('private fixture value');
      expect(JSON.stringify(hooks)).not.toContain('private observer exception');
      const actions = await handle.sql`select status from action where job_id = ${claims.job_id}`;
      expect(actions).toHaveLength(1);
      expect(actions[0]?.status).toBe('succeeded');
      process.stdout.write(
        `real Hermes hook proof: ${hooks.length} persisted observations, one successful tool call\n`,
      );
    } finally {
      await runtime.stop();
      writeFileSync(join(home, 'runtime.log'), runtime.log());
      process.stdout.write(`real Hermes hook log: ${join(home, 'runtime.log')}\n`);
      if (previousBroker === undefined) delete process.env.MELETE_BROKER_URL;
      else process.env.MELETE_BROKER_URL = previousBroker;
      await runner.stop();
      internal.server.closeAllConnections();
      await new Promise<void>((resolve) => internal.server.close(() => resolve()));
      await queue.stop();
      await handle.close();
    }
  },
  180_000,
);
