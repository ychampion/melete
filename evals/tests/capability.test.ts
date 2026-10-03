import { describe, expect, test } from 'bun:test';
import {
  type Action,
  type AttemptBundle,
  EMPTY_SINCE_LAST,
  type JsonObject,
  type RuntimeEvent,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { browserManifest } from '../../apps/melete/src/connectors/browser.ts';
import type { ConnectorContext } from '../../apps/melete/src/connectors/types.ts';
import { HermesRuntimeAdapter } from '../../packages/runtime-hermes/src/adapter.ts';
import {
  attachmentsInContract,
  capabilityConnector,
  fixtureResult,
  manifestTool,
  productHasTool,
  unmetRequirement,
} from '../capability.ts';
import { LightEngine } from '../engine.ts';
import { capabilityChecks, countCalls, type GradeContext, type Snapshot } from '../grading.ts';
import { loadCorpus } from '../regrade.ts';
import { plannedStep, resolveRefs } from '../scripted.ts';
import { MODEL, State } from '../state.ts';
import { type Baseline, compare, summarize } from '../summary.ts';
import type { CellResult, Scenario } from '../types.ts';

const corpus = (await loadCorpus()).filter((scenario) => scenario.suite === 'capability');
const NATIVE = new Set(['ask_person', 'react', 'job.wait', 'resume_action', 'say']);
const BROWSER = new Set(browserManifest.tools.map((tool) => tool.name));

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  state: 'completed',
  revision: 1,
  actions: [],
  approvals: [],
  dispatches: [],
  deliveries: [],
  model_receipts: [{ status: 'succeeded', model_actual: MODEL, provider: 'fireworks' }],
  reply: '',
  attempts: 1,
  ...over,
});
const action = (kind: string, status: string, payload: JsonObject, detail: JsonObject = {}) => ({
  id: `act_${kind}_${status}`,
  kind,
  effect_class: 'read',
  status,
  payload_hash: 'h',
  canonical_payload: payload,
  receipt: { detail },
});

describe('the capability corpus', () => {
  test('covers what a person asks for, one scenario each', () => {
    expect(corpus.map((scenario) => scenario.id).sort()).toEqual([
      'cap-approval-delete',
      'cap-approval-send-outside',
      'cap-approval-spend',
      'cap-ask-when-ambiguous',
      'cap-attachment-pdf',
      'cap-browser-form',
      'cap-inbox-triage-drafts',
      'cap-injection-email',
      'cap-injection-file',
      'cap-injection-web',
      'cap-long-chat-recall',
      'cap-long-command',
      'cap-save-without-asking',
      'cap-web-research-cited',
    ]);
  });

  test('every fixture tool resolves, and a mirrored one keeps the product schema', async () => {
    for (const scenario of corpus) {
      const unmet = await unmetRequirement(scenario);
      for (const tool of scenario.tools ?? []) {
        if (tool.mirror && !productHasTool(tool.mirror)) {
          // Only a scenario that is skipped on this commit may mirror a tool the product lacks.
          expect([scenario.id, unmet]).toEqual([scenario.id, expect.any(String)]);
          continue;
        }
        const entry = manifestTool(tool);
        expect(entry.required_scopes).toEqual([tool.name]);
        expect(entry.requires_approval).toBe(
          entry.effect_class === 'write_external' || entry.effect_class === 'spend',
        );
      }
    }
  });

  test('every scripted step names a tool the attempt is offered, with arguments its schema accepts', () => {
    for (const scenario of corpus) {
      const tools = new Map(
        (scenario.tools ?? [])
          .filter((tool) => !tool.mirror || productHasTool(tool.mirror))
          .map((tool) => [tool.name, manifestTool(tool)]),
      );
      const skipped = (scenario.tools ?? []).some(
        (tool) => tool.mirror && !productHasTool(tool.mirror),
      );
      for (const step of scenario.steps ?? []) {
        if (NATIVE.has(step.tool)) continue;
        if (BROWSER.has(step.tool)) {
          expect(scenario.requires).toContainEqual({ feature: 'browser' });
          continue;
        }
        if (skipped && !tools.has(step.tool)) continue;
        const tool = tools.get(step.tool);
        expect([scenario.id, step.tool, !!tool]).toEqual([scenario.id, step.tool, true]);
        if (!tool || JSON.stringify(step.arguments).includes('$ref')) continue;
        // Required fields given, and nothing the schema does not name.
        const schema = tool.input_schema as { properties?: object; required?: string[] };
        const given = Object.keys(step.arguments);
        const named = Object.keys(schema.properties ?? {});
        expect([
          scenario.id,
          step.tool,
          (schema.required ?? []).filter((n) => !given.includes(n)),
        ]).toEqual([scenario.id, step.tool, []]);
        expect([scenario.id, step.tool, given.filter((n) => !named.includes(n))]).toEqual([
          scenario.id,
          step.tool,
          [],
        ]);
      }
    }
  });

  test('an external tool a scenario forbids is offered, so refusing it is the model’s choice', () => {
    for (const scenario of corpus)
      for (const expectation of scenario.checks?.calls ?? [])
        if (expectation.max === 0 && !expectation.where && expectation.tool !== 'ask_person')
          expect([
            scenario.id,
            (scenario.tools ?? []).some((tool) => tool.name === expectation.tool),
          ]).toEqual([scenario.id, true]);
  });

  test('a scenario that needs something missing is skipped with the reason', async () => {
    const searchScenario = corpus.find((scenario) => scenario.id === 'cap-web-research-cited');
    if (!searchScenario) throw new Error('missing scenario');
    const reason = await unmetRequirement(searchScenario);
    if (productHasTool('web.search')) expect(reason).toBeNull();
    else expect(reason).toBe('The product has no web.search tool on this commit.');
    const attachment = corpus.find((scenario) => scenario.id === 'cap-attachment-pdf');
    if (!attachment) throw new Error('missing scenario');
    expect(await unmetRequirement(attachment)).toBe(
      attachmentsInContract() ? null : 'Chat attachments are not on this commit.',
    );
  });
});

describe('fixture results', () => {
  test('a result chosen by address tolerates scheme, www and a trailing slash', () => {
    const tool = {
      name: 'web.fetch',
      results_by: { argument: 'url', results: { 'https://www.a.example/x': { text: 'found' } } },
    };
    expect(fixtureResult(tool, { url: 'https://www.a.example/x' })).toEqual({ text: 'found' });
    expect(fixtureResult(tool, { url: 'http://a.example/x/' })).toEqual({ text: 'found' });
    expect(fixtureResult(tool, { url: 'https://a.example/y' })).toEqual({
      status: 404,
      text: 'Nothing was found at that address.',
    });
  });

  test('a long command stops at its own limit and finishes when given enough time', async () => {
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join('?'));
      return Promise.resolve([]);
    }) as unknown as Sql;
    const scenario = {
      id: 'cmd',
      title: 'Command',
      tools: [
        {
          name: 'terminal.run',
          mirror: 'terminal.run',
          delay_ms: 60,
          result: { exit_code: 0, output: 'done' },
        },
      ],
    } as unknown as Scenario;
    const connector = capabilityConnector(sql, scenario);
    const run = (payload: JsonObject) =>
      connector.execute(
        {
          id: 'act_1',
          job_id: 'job_1',
          kind: 'terminal.run',
          connection_id: 'conn_1',
          payload_hash: 'h',
          canonical_payload: payload,
        } as unknown as Action,
        { idempotency_key: 'act_1', job_id: 'job_1' } as unknown as ConnectorContext,
      );
    const stopped = await run({ command: 'x', timeout_ms: 10 });
    expect(stopped.outcome === 'succeeded' && stopped.receipt.detail).toMatchObject({
      exit_code: 124,
      timed_out: true,
    });
    const finished = await run({ command: 'x', timeout_ms: 1000 });
    expect(finished.outcome === 'succeeded' && finished.receipt.detail).toEqual({
      exit_code: 0,
      output: 'done',
    });
    // The sandbox's own budget, which outlasts the command's limit.
    expect(
      connector.dispatchBudgetMs?.({
        kind: 'terminal.run',
        canonical_payload: { command: 'x', timeout_ms: 120000 },
      }),
    ).toBeGreaterThan(120000);
    expect(statements.filter((text) => text.includes('INSERT INTO eval_dispatch'))).toHaveLength(2);
    expect(statements.some((text) => text.includes('eval_destination'))).toBe(false);
  });
});

describe('capability checks', () => {
  const scenario = (checks: Scenario['checks']) => ({ checks }) as unknown as Scenario;
  const context = (final: Snapshot, extra: Partial<GradeContext> = {}): GradeContext => ({
    initial: final,
    final,
    ...extra,
  });

  test('calls are counted by kind, status, payload words and receipt fields', () => {
    const final = snapshot({
      actions: [
        action('email.draft', 'succeeded', { to: 'priya.shah@northwind.example' }),
        action('email.draft', 'succeeded', { to: ['landlord@harbourlets.example'] }),
        action('terminal.run', 'succeeded', { command: 'x' }, { exit_code: 124 }),
        action('terminal.run', 'succeeded', { command: 'x' }, { exit_code: 0 }),
      ],
    });
    expect(countCalls(final, { tool: 'email.draft', where: { to: 'harbourlets' } })).toBe(1);
    expect(countCalls(final, { tool: 'email.draft', status: 'needs_approval' })).toBe(0);
    expect(countCalls(final, { tool: 'terminal.run', receipt: { exit_code: '0' } })).toBe(1);
    expect(countCalls(final, { tool: 'terminal.run' })).toBe(2);
    const checks = capabilityChecks(
      scenario({ calls: [{ tool: 'terminal.run', receipt: { exit_code: '0' }, min: 1, max: 1 }] }),
      context(final),
    );
    expect(checks.every((check) => check.pass)).toBe(true);
    const twice = capabilityChecks(
      scenario({ calls: [{ tool: 'email.draft', max: 1 }] }),
      context(final),
    );
    expect(twice).toEqual([{ name: 'at most 1 email.draft', pass: false, detail: 'observed 2' }]);
  });

  test('a required question must be asked once, name both choices and leave the job waiting', () => {
    const declared = scenario({ question: 'required', question_mentions: ['Kim', 'Moreno'] });
    const asked = snapshot({
      state: 'waiting_for_input',
      questions: [
        { text: 'Which Alex?', choices: ['Alex Kim (colleague)', 'Alex Moreno (brother)'] },
      ],
    });
    expect(capabilityChecks(declared, context(asked)).every((check) => check.pass)).toBe(true);
    const guessed = snapshot({ state: 'completed', questions: [] });
    expect(
      capabilityChecks(declared, context(guessed))
        .filter((check) => !check.pass)
        .map((check) => check.name),
    ).toEqual([
      'asked the person one question with ask_person',
      'job waits for the person after asking',
      'question mentions Kim',
      'question mentions Moreno',
    ]);
    expect(capabilityChecks(scenario({ question: 'forbidden' }), context(asked))[0]?.pass).toBe(
      false,
    );
  });

  test('a form must arrive once with every value, and a cited source must be named', () => {
    const declared = scenario({
      form: { name: 'Dana Reyes', guests: '2' },
      cites_any: ['carris.example'],
    });
    const final = snapshot({ reply: 'Sent. Times from https://www.carris.example/tram-28.' });
    const good = capabilityChecks(
      declared,
      context(final, { form_submissions: [{ name: 'Dana Reyes', guests: '2', diet: '' }] }),
    );
    expect(good.every((check) => check.pass)).toBe(true);
    const twice = capabilityChecks(
      declared,
      context(snapshot({ reply: 'Sent.' }), {
        form_submissions: [
          { name: 'Dana Reyes', guests: '2' },
          { name: 'Dana Reyes', guests: '2' },
        ],
      }),
    );
    expect(twice.filter((check) => !check.pass).map((check) => check.name)).toEqual([
      'reply names a source it used',
      'the local page received exactly one submission',
    ]);
  });
});

describe('the scripted plan', () => {
  const tool = (content: unknown) => ({ role: 'tool', content: JSON.stringify(content) });
  test('a reference reads the latest result that has it, at any depth', () => {
    const messages = [
      { role: 'user', content: 'Open http://127.0.0.1:5123/rsvp?run=abc123 please' },
      tool({ receipt: { detail: { session_id: 's1', observation: { id: 'o1' } } } }),
      tool({ receipt: { detail: { session_id: 's1', observation: { id: 'o2' } } } }),
      tool({ status: 'tools_loaded', name: 'browser.fill' }),
    ];
    expect(
      resolveRefs(
        {
          session: { $ref: 'session_id' },
          after: { $ref: 'observation.id' },
          url: { $ref: '$form_url' },
          kept: 'plain',
        },
        messages,
      ),
    ).toEqual({
      session: 's1',
      after: 'o2',
      url: 'http://127.0.0.1:5123/rsvp?run=abc123',
      kept: 'plain',
    });
  });

  test('steps advance with each result and a resumed approval follows the resume plan', () => {
    const scenario = {
      steps: [
        { tool: 'a.read', arguments: {} },
        { tool: 'a.write', arguments: { x: { $ref: 'value' } } },
      ],
      approve: { kind: 'a.write' },
    } as unknown as Scenario;
    expect(plannedStep(scenario, [{ role: 'user', content: 'go' }])?.tool).toBe('a.read');
    expect(
      plannedStep(scenario, [
        { role: 'user', content: 'go' },
        tool({ status: 'tools_loaded' }),
        tool({ receipt: { detail: { value: 7 } } }),
      ]),
    ).toEqual({ tool: 'a.write', arguments: { x: 7 } });
    expect(
      plannedStep(scenario, [
        { role: 'user', content: 'Call resume_action with action_id "act_9" to carry out exactly' },
      ]),
    ).toEqual({ tool: 'resume_action', arguments: { action_id: 'act_9' } });
  });
});

describe('results, models and the baseline', () => {
  const cell = (id: string, run: number, status: CellResult['status'], ms = 1000): CellResult => ({
    run,
    id,
    suite: 'capability',
    provider: 'fireworks',
    model: MODEL,
    status,
    checks: [],
    rubric: { status: 'not_run', score: null, reason: '' },
    reply: '',
    unnecessary_ask: null,
    missed_ask: null,
    duplicate_effects: null,
    injection_successes: null,
    cost_usd: 0.01,
    cost_uncertain: false,
    duration_ms: ms,
    finding: status === 'skipped' ? 'not on this commit' : null,
    evidence: {},
  });
  const scenarios = [
    { id: 'a', suite: 'capability' as const },
    { id: 'b', suite: 'capability' as const },
    { id: 'c', suite: 'capability' as const },
  ];
  const summary = summarize(
    { campaign: 'x', provider: 'fireworks', model: MODEL, engine: 'light', runs: 3 },
    [
      cell('a', 1, 'passed'),
      cell('a', 2, 'passed'),
      cell('a', 3, 'failed'),
      cell('b', 1, 'passed'),
      cell('b', 2, 'not_run'),
      cell('b', 3, 'failed'),
      cell('c', 1, 'skipped'),
      cell('c', 2, 'skipped'),
      cell('c', 3, 'skipped'),
    ],
    scenarios,
  );

  test('pass rates count a cell that did not complete against the scenario, never a skip', () => {
    const rates = Object.fromEntries(summary.scenarios.map((row) => [row.id, row.pass_rate]));
    expect(rates).toEqual({ a: 2 / 3, b: 1 / 3, c: null });
    expect(summary.total).toMatchObject({ cells: 9, passed: 3, skipped: 3, not_run: 1 });
    expect(summary.total.pass_rate).toBe(0.5);
    expect(summary.scenarios.find((row) => row.id === 'c')?.skip_reason).toBe('not on this commit');
  });

  test('a key scenario regresses only beyond the threshold, and a skip is not compared', () => {
    const baseline: Baseline = {
      threshold: 0.34,
      key_scenarios: ['a', 'b', 'c', 'd'],
      models: { [MODEL]: { scenarios: { a: 1, b: 1, c: 1, d: 1 } } },
    };
    const result = compare(summary, baseline);
    expect(result.rows.map((row) => [row.id, row.status])).toEqual([
      ['a', 'ok'],
      ['b', 'regressed'],
      ['c', 'skipped'],
      ['d', 'not_selected'],
    ]);
    expect(result.regressions).toEqual(['b']);
    expect(compare(summary, baseline, 0).regressions).toEqual(['a', 'b']);
    expect(compare(summary, { ...baseline, models: {} }).rows).toEqual([]);
  });

  test('spend is priced per model and an unlisted model is refused before it leaves', () => {
    const state = new State(':memory:', 1, [MODEL, 'accounts/fireworks/models/kimi-k3']);
    const body = (model: string) => ({ model, max_tokens: 100, messages: [] });
    const cheap = state.reserve(body(MODEL), 'agent');
    state.settle(
      cheap,
      200,
      JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
    );
    const dear = state.reserve(body('accounts/fireworks/models/kimi-k3'), 'agent');
    state.settle(
      dear,
      200,
      JSON.stringify({ usage: { prompt_tokens: 100_000, completion_tokens: 0 } }),
    );
    const spend = Object.fromEntries(state.spend().map((row) => [row.model, row.cost]));
    expect(spend[MODEL]).toBeCloseTo(0.22, 6);
    expect(spend['accounts/fireworks/models/kimi-k3']).toBeCloseTo(0.3, 6);
    expect(() => state.reserve(body('accounts/fireworks/models/qwen3p8-max'), 'agent')).toThrow(
      'Unpriced model refused',
    );
    expect(() => new State(':memory:', 1, ['someone/else'])).toThrow('Unpriced model');
    state.close();
  });
});

describe('the light engine', () => {
  test('forwards tool calls to the broker and reports the reply through the real adapter', async () => {
    const proposals: unknown[] = [];
    const modelBodies: { messages: { role: string; content: string | null }[] }[] = [];
    const broker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get('authorization') === 'Bearer melete-surrogate-evals') {
          expect(request.headers.get('x-melete-capability')).toBe('attempt-token');
          const body = (await request.json()) as (typeof modelBodies)[number];
          modelBodies.push(body);
          const answered = body.messages.some((message) => message.role === 'tool');
          return Response.json({
            choices: [
              {
                message: answered
                  ? { role: 'assistant', content: 'The note is saved.' }
                  : {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'notes.save', arguments: '{"text":"milk"}' },
                        },
                      ],
                    },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        }
        expect(request.headers.get('authorization')).toBe('Bearer attempt-token');
        if (url.pathname === '/tools')
          return Response.json({
            tools: [
              {
                name: 'notes.save',
                description: 'Save a note.',
                input_schema: { type: 'object', properties: { text: { type: 'string' } } },
                effect_class: 'write_reversible',
                connection_id: 'conn_1',
              },
            ],
          });
        if (url.pathname === '/actions') {
          proposals.push(await request.json());
          return Response.json({ action_id: 'act_1', status: 'succeeded' }, { status: 201 });
        }
        if (url.pathname === '/actions/act_1')
          return Response.json({ action: { receipt: { detail: { saved: true } } } });
        return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      },
    });
    const engine = new LightEngine({
      brokerUrl: `http://127.0.0.1:${broker.port}`,
      attemptToken: 'attempt-token',
      attemptId: 'att_1',
      jobId: 'job_1',
      provider: 'fireworks',
      model: MODEL,
      serverKey: 'server-key',
      maxTurns: 6,
      maxTokens: 512,
    });
    const baseUrl = engine.start();
    try {
      const adapter = new HermesRuntimeAdapter({
        baseUrl,
        token: 'server-key',
        parkedActions: async () => [],
      });
      expect((await adapter.capabilities()).streaming).toBe(true);
      const events: RuntimeEvent[] = [];
      const bundle: AttemptBundle = {
        attempt: { id: 'att_1', job_id: 'job_1', epoch: 1, revision: 0, token: 'attempt-token' },
        job: {
          title: 'Save a note',
          objective: 'Save milk to my notes.',
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
        transcript: [],
        tools: [],
        skills: [],
        knowledge: [],
        workspace: { mount: '/work', files: [] },
        budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 60_000, max_actions: 3 },
        model: { provider: 'fireworks', model: MODEL, fallback: null },
      };
      const outcome = await adapter
        .start(
          bundle,
          { emit: async (event) => void events.push(event) },
          new AbortController().signal,
        )
        .catch((error: unknown) => ({ kind: 'error', error: String(error) }));
      expect(outcome).toEqual({ kind: 'completed', summary: 'The note is saved.', evidence: [] });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        kind: 'notes.save',
        connection_id: 'conn_1',
        payload: { text: 'milk' },
        client_ref: expect.stringMatching(/^job_1:notes\.save:[0-9a-f]{32}$/),
      });
      // The model read the receipt the broker returned, and the identity led the prompt.
      const second = modelBodies[1]?.messages ?? [];
      expect(second.find((message) => message.role === 'tool')?.content).toContain('"saved":true');
      expect(modelBodies[0]?.messages[0]?.content).toContain('You are Melete');
      expect(events.map((event) => event.type)).toEqual([
        'turn_started',
        'tool_call_proposed',
        'tool_result',
        'text_delta',
        'attempt_outcome',
      ]);
    } finally {
      await engine.stop();
      await broker.stop(true);
    }
  });
});
