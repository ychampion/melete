/** Pinned local Hermes, real broker/Postgres and a scripted inference provider. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeEvent } from '@melete/contracts';
import { signCapability } from '../../../apps/melete/src/broker/capability.ts';
import { toolTokens } from '../../../apps/melete/src/broker/catalog.ts';
import { createInternalServer } from '../../../apps/melete/src/broker/internal-server.ts';
import { recordId } from '../../../apps/melete/src/broker/records.ts';
import { emailManifest } from '../../../apps/melete/src/connectors/email.ts';
import { createFilesConnector, filesManifest } from '../../../apps/melete/src/connectors/files.ts';
import { ConnectorRegistry } from '../../../apps/melete/src/connectors/registry.ts';
import type { Connector } from '../../../apps/melete/src/connectors/types.ts';
import {
  createScriptedProvider,
  type FakeTurn,
  fakeProvider,
} from '../../../apps/melete/src/gateway/fake.ts';
import { startQueue } from '../../../apps/melete/src/jobs/queue.ts';
import { seedJob } from '../../../apps/melete/test/helpers/broker.ts';
import { createPostgresFixture } from '../../../apps/melete/test/helpers/postgres.ts';
import { brokerCatalogState, brokerParkedActions, HermesRuntimeAdapter } from '../src/adapter.ts';
import { API_KEY, hermesHome, ROOT, type Runtime, startRuntime, waitForApi } from './e2e.ts';

const BROKER_PORT = 3142;
const HERMES_PORT = 3140;
const CAPABILITY_KEY = 'discovery-capability-key-discovery-key';
const APPROVAL_KEY = 'discovery-approval-key-discovery-key';
const TARGET = 'test.inspect';
const VERDICT = 'discovered through the broker';
const PIN = '2237be355906fbe6065ce1815711eee52b2d646e';
const sourceHashes = {
  'agent/agent_init.py': 'c70a887f700a98276e76b60f987399af3fc3a994ef860c6788f14550fb2b9a52',
  'tools/registry.py': 'ca02644ea36dfa08ab7e12893d283a3b12549a5ffd33ea72c29c632a94e7b201',
  'gateway/platforms/api_server_runs.py':
    '270f7e221b5486a6ac499732d0f5471f3f48dc0c0a0633186bc762bcb1345a39',
};
type WireMessage = { role?: string; content?: unknown; [key: string]: unknown };
type WireTool = { function?: { name?: string } };
type Capture = { attemptId: string; body: Record<string, unknown> };
const messages = (body: Record<string, unknown>) => (body.messages ?? []) as WireMessage[];
const names = (body: Record<string, unknown>) =>
  ((body.tools ?? []) as WireTool[]).map((tool) => tool.function?.name);
const nonSystem = (body: Record<string, unknown>) =>
  messages(body).filter((message) => message.role !== 'system');

async function main() {
  assert(
    existsSync(join(ROOT, '.hermes-venv', 'Scripts', 'python.exe')),
    'Install the isolated Hermes venv first.',
  );
  for (const [file, expected] of Object.entries(sourceHashes)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(ROOT, '.hermes-src', file)))
        .digest('hex'),
      expected,
      `Pinned source differs: ${file}`,
    );
  }
  const db = await createPostgresFixture();
  assert(db, 'No disposable database could be started.');
  let runtime: Runtime | undefined;
  let home: string | undefined;
  let internal: ReturnType<typeof createInternalServer> | undefined;
  let boss: Awaited<ReturnType<typeof startQueue>> | undefined;
  const captures: Capture[] = [];
  const starts: { headers: Headers; body: Record<string, unknown> }[] = [];
  const stops: string[] = [];
  const events: RuntimeEvent[] = [];
  try {
    boss = await startQueue(db.url);
    const scopes = [...filesManifest.tools, ...emailManifest.tools].flatMap((tool) => [
      tool.name,
      ...tool.required_scopes,
    ]);
    scopes.push(TARGET, 'test.read');
    const budget = {
      max_output_tokens: 64_000,
      max_turns: 12,
      max_wall_ms: 120_000,
      max_actions: 10,
    };
    const { claims, connectionId } = await seedJob(db.sql, {
      scopes: [...new Set(scopes)],
      budget,
    });
    const token = signCapability(claims, CAPABILITY_KEY);
    let executions = 0;
    const target: Connector = {
      manifest: {
        name: 'test',
        version: '1.0.0',
        provider: 'test',
        description: 'Discovery fixture capability.',
        credentials: [],
        health: true,
        tools: [
          {
            name: TARGET,
            description: 'Read the fixture verdict for the discovery demonstration.',
            input_schema: { type: 'object', properties: {}, additionalProperties: false },
            effect_class: 'read',
            required_scopes: ['test.read'],
            requires_approval: false,
            verify: false,
          },
        ],
      },
      catalog: { source: 'capability', examples: { [TARGET]: ['fixture verdict'] } },
      async execute(action, context) {
        assert.equal(action.kind, TARGET);
        assert.equal(context.job_id, claims.job_id);
        assert.equal(action.attempt_id, claims.attempt_id);
        assert.deepEqual(action.canonical_payload, {});
        executions++;
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: 'fixture-read',
            detail: { verdict: VERDICT },
            received_at: new Date().toISOString(),
            late: false,
          },
        };
      },
      async verify() {
        return { decision: 'unsupported', reason: 'Read fixture.' };
      },
      async health() {
        return { status: 'ok', detail: 'Local fixture.', checked_at: new Date().toISOString() };
      },
    };
    const registry = new ConnectorRegistry().register(connectionId, target);
    // Existing schemas fill the core near its limit; only the target read executes.
    const fileId = recordId('conn');
    const emailId = recordId('conn');
    for (const [id, provider, manifest] of [
      [fileId, 'files', filesManifest],
      [emailId, 'imap', emailManifest],
    ] as const) {
      await db.sql`insert into connection (id, space_id, provider, label, scopes)
        values (${id}, ${claims.space_id}, ${provider}, 'Discovery core fixture',
          ${JSON.stringify(manifest.tools.flatMap((tool) => [tool.name, ...tool.required_scopes]))}::jsonb)`;
    }
    registry.register(
      fileId,
      createFilesConnector({
        workRoot: mkdtempSync(join(tmpdir(), 'melete-discovery-work-')),
        spacesRoot: mkdtempSync(join(tmpdir(), 'melete-discovery-spaces-')),
      }),
    );
    registry.register(emailId, {
      manifest: emailManifest,
      async execute() {
        throw new Error('The discovery fixture must not call mail.');
      },
      async verify() {
        return { decision: 'unsupported', reason: 'No mail transport.' };
      },
      async health() {
        return { status: 'ok', detail: 'Schema fixture.', checked_at: new Date().toISOString() };
      },
    });
    let searched = false;
    let loaded = false;
    let invoked = false;
    internal = createInternalServer({
      sql: db.sql,
      connectors: registry,
      boss: boss.boss,
      capabilityKey: CAPABILITY_KEY,
      approvalKey: APPROVAL_KEY,
      providers: [fakeProvider],
      defaultProvider: 'fake',
      catalog: { coreTokenBudget: 750 },
      fake: async (body, attemptId, protocol) => {
        assert.equal(protocol, 'chat/completions');
        captures.push({ attemptId, body: structuredClone(body) });
        let turn: FakeTurn;
        if (!searched) {
          searched = true;
          turn = {
            tool: {
              name: 'search_tools',
              arguments: { query: 'fixture verdict' },
              id: 'call_search',
            },
          };
        } else if (!loaded) {
          loaded = true;
          turn = { tool: { name: 'load_tool', arguments: { name: TARGET }, id: 'call_load' } };
        } else if (names(body).includes(TARGET) && !invoked) {
          invoked = true;
          turn = { tool: { name: TARGET, arguments: {}, id: 'call_inspect' } };
        } else {
          // A request can race the explicit stop; it cannot invoke an absent schema.
          turn = {
            text: invoked ? `The recorded receipt says: ${VERDICT}.` : 'Tool loading recorded.',
          };
        }
        return createScriptedProvider([turn])(body, attemptId, protocol);
      },
    });
    await new Promise<void>((resolve, reject) => {
      internal?.server.once('error', reject);
      internal?.server.listen(BROKER_PORT, '127.0.0.1', resolve);
    });
    process.env.MELETE_BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
    const core = await internal.broker.catalog(claims);
    const coreTokens = toolTokens(core);
    assert(coreTokens >= 650 && coreTokens <= 750, `Core not near-filled: ${coreTokens}`);
    assert(!core.some((tool) => tool.name === TARGET));
    const bundle: AttemptBundle = {
      attempt: {
        id: claims.attempt_id,
        job_id: claims.job_id,
        epoch: claims.epoch,
        revision: claims.revision,
        token,
      },
      job: {
        title: 'Discover the fixture verdict',
        objective:
          'Find the tool that reads the fixture verdict, load it, then read it and report its receipt.',
        constraints: {},
        progress_summary: '',
        unresolved_questions: [],
        deliverable: {},
      },
      inputs: {
        new_user_messages: [],
        approval_results: [],
        trigger_events: [],
        repair_briefs: [],
      },
      since_last: EMPTY_SINCE_LAST,
      transcript: [
        {
          role: 'user',
          content: 'Preserve this earlier fixture context.',
          at: new Date(0).toISOString(),
        },
      ],
      tools: core,
      skills: [],
      knowledge: [],
      workspace: { mount: '/work', files: [] },
      budget,
      model: { provider: 'fake', model: 'scripted', fallback: null },
    };
    home = hermesHome(BROKER_PORT, HERMES_PORT, token);
    runtime = startRuntime(home, HERMES_PORT, token, claims.attempt_id, claims.job_id);
    const coldStartMs = await waitForApi(HERMES_PORT);
    const adapter = new HermesRuntimeAdapter({
      baseUrl: `http://127.0.0.1:${HERMES_PORT}`,
      token: API_KEY,
      catalogState: brokerCatalogState({ brokerUrl: process.env.MELETE_BROKER_URL }),
      parkedActions: brokerParkedActions({
        brokerUrl: process.env.MELETE_BROKER_URL,
        serviceKey: APPROVAL_KEY,
        spaceId: claims.space_id,
      }),
      fetch: async (url, init) => {
        if (init?.method === 'POST' && new URL(url).pathname === '/v1/runs')
          starts.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        if (url.endsWith('/stop')) stops.push(url);
        return fetch(url, init);
      },
    });
    await adapter.capabilities();
    const outcome = await adapter.start(
      bundle,
      { emit: async (event) => void events.push(event) },
      new AbortController().signal,
    );
    process.stdout.write(
      `${JSON.stringify({ outcome, coreTokens, providerRequests: captures.length, runs: starts.length, stops: stops.length, executions, eventTypes: events.map((event) => event.type) })}\n`,
    );
    assert.equal(outcome.kind, 'completed');
    assert.equal(executions, 1);
    assert.equal(starts.length, 2);
    assert(stops.length >= 1);
    assert(captures.length >= 4);
    const first = captures[0]?.body;
    const beforeLoad = captures[1]?.body;
    const afterLoad = captures.find((capture) => names(capture.body).includes(TARGET))?.body;
    assert(first && beforeLoad && afterLoad);
    assert.deepEqual([...names(first)].sort(), core.map((tool) => tool.name).sort());
    assert(captures.every((capture) => capture.attemptId === claims.attempt_id));
    assert.deepEqual(
      starts.map((start) => start.headers.get('Idempotency-Key')),
      [claims.attempt_id, `${claims.attempt_id}:tools:1`],
    );
    for (const start of starts) {
      assert.equal(start.body.session_id, claims.job_id);
      assert.equal(start.body.conversation_history, undefined);
    }
    assert.deepEqual(
      nonSystem(afterLoad).slice(0, nonSystem(beforeLoad).length),
      nonSystem(beforeLoad),
      'Native history must remain an exact prefix across continuation.',
    );
    assert(JSON.stringify(nonSystem(afterLoad)).includes('Preserve this earlier fixture context.'));
    const results = captures.flatMap((capture) =>
      messages(capture.body).filter((message) => message.role === 'tool'),
    );
    assert(
      results.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('schema_fingerprint') &&
          message.content.includes(TARGET),
      ),
    );
    assert(
      results.some(
        (message) => typeof message.content === 'string' && message.content.includes(VERDICT),
      ),
    );
    const systemChars = messages(first)
      .filter((message) => message.role === 'system')
      .reduce(
        (sum, message) =>
          sum +
          (typeof message.content === 'string'
            ? message.content.length
            : JSON.stringify(message.content).length),
        0,
      );
    const toolSchemaChars = JSON.stringify(first.tools).length;
    const scaffoldingTokens = Math.ceil((systemChars + toolSchemaChars) / 4);
    assert(scaffoldingTokens < 4000, `Scaffolding is ${scaffoldingTokens} estimated tokens.`);
    const actions =
      await db.sql`select id, kind, status, effect_class, receipt from action where attempt_id = ${claims.attempt_id}`;
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.status, 'succeeded');
    assert.equal(actions[0]?.effect_class, 'read');
    assert.equal(actions[0]?.receipt.detail.verdict, VERDICT);
    const phases =
      await db.sql`select payload->>'phase' as phase from event where attempt_id = ${claims.attempt_id} and payload ? 'phase' order by seq`;
    assert(phases.some((event) => event.phase === 'search_tools'));
    assert(phases.some((event) => event.phase === 'load_tool'));
    const [context] =
      await db.sql`select loaded from attempt_tool_context where attempt_id = ${claims.attempt_id}`;
    assert(context?.loaded.some((tool: { name: string }) => tool.name === TARGET));
    assert(
      events.every(
        (event, index) => event.attempt_id === claims.attempt_id && event.local_seq === index,
      ),
    );
    assert.equal(events.filter((event) => event.type === 'attempt_outcome').length, 1);
    const summary = {
      pin: PIN,
      sourceHashes,
      coldStartMs,
      database: db.mode,
      brokerPort: BROKER_PORT,
      hermesPort: HERMES_PORT,
      coreNames: core.map((tool) => tool.name),
      coreTokens,
      systemChars,
      toolSchemaChars,
      scaffoldingTokens,
      estimator: 'ceil((system prompt characters + serialized tool schema characters) / 4)',
      requests: captures.length,
      runs: starts.length,
      stops: stops.length,
      attemptId: claims.attempt_id,
      actionId: actions[0]?.id,
      outcome,
      phases: phases.map((event) => event.phase),
      appendOnlyHistory: true,
      contiguousRuntimeEvents: events.length,
    };
    writeFileSync(join(home, 'discovery-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await runtime?.stop();
    if (home) {
      writeFileSync(join(home, 'runtime.log'), runtime?.log() ?? '');
      writeFileSync(join(home, 'provider-requests.json'), `${JSON.stringify(captures, null, 2)}\n`);
      writeFileSync(join(home, 'runtime-events.json'), `${JSON.stringify(events, null, 2)}\n`);
      process.stdout.write(`Discovery evidence: ${home}\n`);
    }
    if (internal?.server.listening)
      await new Promise<void>((resolve) => internal?.server.close(() => resolve()));
    await boss?.stop();
    await db.close();
  }
}

if (import.meta.main) await main();
