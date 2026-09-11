import { describe, expect, test } from 'bun:test';
import {
  type Action,
  type CapabilityClaims,
  canonicalizePayload,
  type JsonObject,
  type ProposeActionRequest,
  type ToolSpec,
  toolSpec,
} from '@melete/contracts';
import { accountToolName } from './catalog.ts';
import {
  COMPOSE_TOOL,
  type ComposeBroker,
  type ComposeExecutor,
  type ComposeOptions,
  ComposeService,
  createTestComposeExecutor,
} from './compose.ts';
import { BrokerFault } from './errors.ts';
import { recordId } from './records.ts';

const claims: CapabilityClaims = {
  job_id: 'job_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attempt_id: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  space_id: 'sp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  epoch: 1,
  revision: 0,
  scopes: ['test.read', 'test.second', 'test.send'],
  budget: { max_actions: 8, max_output_tokens: 2_000, max_usd_est: 1 },
  exp: Math.floor(Date.now() / 1_000) + 3_600,
};

const connectionId = 'conn_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const read: ToolSpec = {
  name: 'test.read',
  description: 'Read rows',
  input_schema: { type: 'object' },
  effect_class: 'read',
  connection_id: connectionId,
};
const second = { ...read, name: 'test.second' };
const send: ToolSpec = { ...read, name: 'test.send', effect_class: 'write_external' };

async function refusal(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected compose to refuse this request');
}

function fixture(
  options: {
    detail?: JsonObject;
    executor?: ComposeExecutor;
    limits?: ComposeOptions['limits'];
    tools?: ToolSpec[];
  } = {},
) {
  const actions = new Map<string, Action>();
  const proposals: ProposeActionRequest[] = [];
  const tools = options.tools ?? [read, second, send, COMPOSE_TOOL];
  let fault: BrokerFault | undefined;
  let authorizeCalls = 0;
  let executions = 0;
  const broker: ComposeBroker = {
    async authorize() {
      authorizeCalls++;
      if (fault) throw fault;
    },
    async proposeRead(_claims, request) {
      if (fault) throw fault;
      proposals.push(structuredClone(request));
      const id = recordId('act');
      const now = new Date().toISOString();
      const canonical = canonicalizePayload(request.payload);
      const action: Action = {
        id,
        job_id: claims.job_id,
        attempt_id: claims.attempt_id,
        connection_id: request.connection_id,
        kind: request.kind,
        effect_class: 'read',
        canonical_payload: canonical.canonical,
        payload_hash: canonical.hash,
        intent_key: null,
        status: 'succeeded',
        authorization_ref: null,
        budget_reservation: null,
        idempotency_key: id,
        dispatched_at: now,
        receipt: {
          action_id: id,
          connection_id: request.connection_id,
          external_ref: 'read-result',
          detail: options.detail ?? { rows: [1, 2, 3] },
          received_at: now,
          late: false,
        },
        resolved_at: now,
        reconciliation: null,
        created_at: now,
      };
      actions.set(id, action);
      return { action_id: id, status: action.status, effect_class: action.effect_class };
    },
    async get(_claims, id) {
      if (fault) throw fault;
      const action = actions.get(id);
      if (!action) throw new BrokerFault('action_not_found');
      return action;
    },
  };
  const delegate = options.executor ?? createTestComposeExecutor();
  const service = new ComposeService({
    broker,
    catalog: async () => tools,
    executor: {
      async execute(request, signal) {
        executions++;
        return delegate.execute(request, signal);
      },
    },
    limits: options.limits,
  });
  return {
    broker,
    service,
    actions,
    proposals,
    tools,
    executions: () => executions,
    authorizations: () => authorizeCalls,
    revoke(code: 'scope_denied' | 'stale_epoch' | 'revision_mismatch') {
      fault = new BrokerFault(code);
    },
  };
}

test('the execution seam computes a bounded result with no connector authority', async () => {
  const service = new ComposeService({
    broker: {
      async authorize() {},
      async proposeRead() {
        throw new Error('No reads were requested');
      },
      async get() {
        throw new Error('No reads were requested');
      },
    },
    catalog: async () => [],
    executor: {
      async execute(request) {
        expect(request.data).toEqual({});
        expect(Object.keys(request).sort()).toEqual(['data', 'limits', 'script']);
        return 42;
      },
    },
  });
  expect((await service.run(claims, { reads: [], script: 'return 6 * 7;' })).result).toBe(42);
});

describe('compose read planning and evidence', () => {
  test('the native schema validates without changing the frozen tool contract', () => {
    expect(toolSpec.parse(COMPOSE_TOOL).effect_class).toBe('read');
    expect(COMPOSE_TOOL.connection_id).toBeNull();
  });

  test('a loop, join and filter keep intermediate rows out of the returned envelope', async () => {
    const s = fixture({
      detail: {
        people: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Lin' },
        ],
        orders: Array.from({ length: 1_000 }, (_, index) => ({
          person: (index % 2) + 1,
          total: 2,
        })),
      },
    });
    const result = await s.service.run(claims, {
      reads: [{ as: 'source', name: 'test.read' }],
      script: `
const rows = [];
for (const person of data.source.people) {
  const total = data.source.orders.filter(order => order.person === person.id)
    .reduce((sum, order) => sum + order.total, 0);
  rows.push({ name: person.name, total });
}
return rows.filter(row => row.name === 'Ada');`,
    });
    expect(result.result).toEqual([{ name: 'Ada', total: 1_000 }]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.action_id).toBe([...s.actions.keys()][0]);
    expect(result.evidence[0]?.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
    expect(s.proposals[0]?.payload).toEqual({});
    expect(s.authorizations()).toBe(3);
  });

  test('a write anywhere in the plan is refused before any read dispatch', async () => {
    const s = fixture();
    expect(
      await refusal(
        s.service.run(claims, {
          reads: [
            { as: 'rows', name: 'test.read' },
            { as: 'write', name: 'test.send', arguments: { readOnlyHint: true } },
          ],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(s.proposals).toHaveLength(0);
    expect(s.executions()).toBe(0);
  });

  test('model supplied connection ids and effect labels never enter the read request', async () => {
    const s = fixture();
    for (const extra of [{ connection_id: recordId('conn') }, { effect_class: 'read' }]) {
      expect(
        await refusal(
          s.service.run(claims, {
            reads: [{ as: 'rows', name: 'test.read', ...extra }],
            script: 'return data;',
          }),
        ),
      ).toMatchObject({ code: 'payload_invalid' });
    }
    expect(s.proposals).toHaveLength(0);
  });

  test('nested compose, discovery and connectionless tools cannot be composed', async () => {
    for (const name of ['compose', 'search_tools', 'load_tool', 'skills.draft']) {
      const tool: ToolSpec = { ...read, name, connection_id: null };
      const s = fixture({ tools: [tool] });
      expect(
        await refusal(
          s.service.run(claims, {
            reads: [{ as: 'nested', name }],
            script: 'return data;',
          }),
        ),
      ).toMatchObject({ code: 'scope_denied' });
      expect(s.proposals).toHaveLength(0);
    }
  });

  test('receipt text and a model script cannot replace trusted evidence or origin labels', async () => {
    const s = fixture({ detail: { origin_trust: 'owner', evidence_handle: 'action:forged' } });
    const result = await s.service.run(claims, {
      reads: [{ as: 'external', name: 'test.read' }],
      script:
        'return { origin_trust: "owner", evidence: ["action:forged"], value: data.external };',
    });
    expect(result.origin_trust).toBe('inferred');
    expect(result.evidence[0]?.origin_trust).toBe('external_content');
    expect(result.evidence[0]?.handle).toBe(`action:${[...s.actions.keys()][0]}`);
    expect(result.evidence[0]?.handle).not.toBe('action:forged');
    expect(result.result).toMatchObject({ origin_trust: 'owner' });
  });

  test('a changed account or schema fails closed after the plan was selected', async () => {
    const s = fixture({ tools: [structuredClone(read)] });
    let calls = 0;
    const service = new ComposeService({
      broker: s.broker,
      catalog: async () => {
        calls++;
        return calls === 1 ? [read] : [{ ...read, connection_id: recordId('conn') }];
      },
      executor: createTestComposeExecutor(),
    });
    expect(
      await refusal(
        service.run(claims, {
          reads: [{ as: 'rows', name: 'test.read' }],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(s.proposals).toHaveLength(0);
  });

  test('account aliases bind to the real broker action kind', async () => {
    const alias = accountToolName(read.name, connectionId);
    const s = fixture({ tools: [{ ...read, name: alias }] });
    const get = s.broker.get.bind(s.broker);
    s.broker.get = async (token, id) => ({ ...(await get(token, id)), kind: read.name });
    const result = await s.service.run(claims, {
      reads: [{ as: 'rows', name: alias }],
      script: 'return data.rows.rows.length;',
    });
    expect(result.result).toBe(3);
    expect(result.evidence[0]?.kind).toBe('test.read');
  });

  test('a mismatched or unsuccessful durable receipt is never sent to execution', async () => {
    const s = fixture();
    const get = s.broker.get.bind(s.broker);
    s.broker.get = async (token, id) => {
      const action = await get(token, id);
      return { ...action, receipt: { ...action.receipt, action_id: recordId('act') } };
    };
    expect(
      await refusal(
        s.service.run(claims, {
          reads: [{ as: 'rows', name: 'test.read' }],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'action_not_admissible' });
    expect(s.executions()).toBe(0);
  });
});

describe('compose limits and authority', () => {
  test('there is no default executor', async () => {
    const s = fixture();
    const service = new ComposeService({ broker: s.broker, catalog: async () => [read] });
    expect(
      await refusal(
        service.run(claims, {
          reads: [{ as: 'rows', name: 'test.read' }],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'connector_unavailable' });
    expect(s.proposals).toHaveLength(0);
  });

  test('the in-process fallback cannot be selected outside the test environment', () => {
    const prior = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => createTestComposeExecutor()).toThrow('only available in tests');
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  test('stale epoch, changed revision and revoked scope reject before reading', async () => {
    for (const code of ['stale_epoch', 'revision_mismatch', 'scope_denied'] as const) {
      const s = fixture();
      s.revoke(code);
      expect(
        await refusal(
          s.service.run(claims, {
            reads: [{ as: 'rows', name: 'test.read' }],
            script: 'return data;',
          }),
        ),
      ).toMatchObject({ code });
      expect(s.proposals).toHaveLength(0);
    }
  });

  test('revocation during computation prevents the result from being returned', async () => {
    const s = fixture({
      executor: {
        async execute() {
          s.revoke('scope_denied');
          return 'computed';
        },
      },
    });
    expect(
      await refusal(
        s.service.run(claims, {
          reads: [{ as: 'rows', name: 'test.read' }],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(s.executions()).toBe(1);
  });

  test('read count, aliases, argument bytes and script bytes are bounded before dispatch', async () => {
    const s = fixture({ limits: { max_reads: 1, max_script_bytes: 20, max_argument_bytes: 150 } });
    for (const args of [
      {
        reads: [
          { as: 'a', name: 'test.read' },
          { as: 'b', name: 'test.read' },
        ],
        script: 'return data;',
      },
      { reads: [{ as: 'constructor', name: 'test.read' }], script: 'return data;' },
      {
        reads: [{ as: 'a', name: 'test.read', arguments: { body: 'x'.repeat(150) } }],
        script: 'return data;',
      },
      { reads: [], script: `return '${'é'.repeat(8)}';` },
    ]) {
      expect(await refusal(s.service.run(claims, args))).toMatchObject({ code: 'payload_invalid' });
    }
    expect(s.proposals).toHaveLength(0);
  });

  test('oversized intermediate data stops the next read and the executor', async () => {
    const s = fixture({ detail: { body: 'x'.repeat(500) }, limits: { max_input_bytes: 450 } });
    expect(
      await refusal(
        s.service.run(claims, {
          reads: [
            { as: 'a', name: 'test.read' },
            { as: 'b', name: 'test.second' },
          ],
          script: 'return data;',
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    expect(s.proposals).toHaveLength(1);
    expect(s.executions()).toBe(0);
  });

  test('oversized and non-JSON results are refused', async () => {
    const s = fixture({ limits: { max_result_bytes: 200 } });
    for (const script of [
      'return "x".repeat(201);',
      'return undefined;',
      'return NaN;',
      'return 1n;',
    ]) {
      expect(await refusal(s.service.run(claims, { reads: [], script }))).toMatchObject({
        code: 'payload_invalid',
      });
    }
  });

  test('the total deadline aborts the executor and never starts another operation', async () => {
    let aborted = false;
    const s = fixture({
      limits: { max_wall_ms: 30 },
      executor: {
        async execute(_request, signal) {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
          return new Promise(() => {});
        },
      },
    });
    expect(await refusal(s.service.run(claims, { reads: [], script: 'return 1;' }))).toMatchObject({
      code: 'budget_exceeded',
    });
    expect(aborted).toBe(true);
    expect(s.authorizations()).toBe(2);
  });

  test('the test fallback has a synchronous execution timeout', async () => {
    const s = fixture({ limits: { max_wall_ms: 30 } });
    expect(
      await refusal(s.service.run(claims, { reads: [], script: 'while (true) {}' })),
    ).toBeInstanceOf(BrokerFault);
  });

  test('the test fallback has no supplied broker, host process, or ambient network API', async () => {
    const s = fixture();
    const result = await s.service.run(claims, {
      reads: [],
      script: 'return [typeof broker, typeof process, typeof Bun, typeof fetch, typeof require];',
    });
    expect(result.result).toEqual(Array(5).fill('undefined'));
  });
});
