import { afterAll, expect, test } from 'bun:test';
import type { Skill } from '@melete/contracts';
import { signCapability } from '../../src/broker/capability.ts';
import { accountToolName, META_TOOLS, toolTokens } from '../../src/broker/catalog.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const db = await testDatabase();
const dbTest = db ? test : test.skip;
afterAll(async () => {
  await db?.close();
});

dbTest(
  'Postgres lexical ranking uses names, descriptions and examples in deterministic order',
  async () => {
    const s = await setup();
    const read = s.connector.manifest.tools.find((tool) => tool.name === 'test.read');
    if (!read) throw new Error('fixture tool absent');
    read.description = 'Read an invoice';
    const byName = await s.broker.discovery.search(s.claims, 'INVOICE');
    expect(byName.map((entry) => entry.name)).toEqual(['test.invoice', 'test.read']);
    expect(
      (await s.broker.discovery.search(s.claims, 'receipt')).map((entry) => entry.name),
    ).toEqual(['test.invoice']);
    expect(await s.broker.discovery.search(s.claims, '"; DROP TABLE action; --')).toEqual([]);
    expect(await s.broker.discovery.search(s.claims, 'INVOICE')).toEqual(byName);
  },
);

async function setup(options: { skills?: Skill[] } = {}) {
  if (!db) throw new Error('Postgres unavailable');
  const seed = await seedJob(db.sql, { scopes: ['test.read', 'test.invoice', 'test.send'] });
  let calls = 0;
  const connector: Connector = {
    manifest: {
      name: 'test',
      provider: 'test',
      version: '1',
      description: 'Scripted catalog',
      credentials: [],
      health: true,
      tools: ['read', 'invoice', 'send'].map((verb) => ({
        name: `test.${verb}`,
        description: verb === 'invoice' ? 'Find archived invoices by vendor' : `Perform ${verb}`,
        input_schema: {
          type: 'object',
          properties: { vendor: { type: 'string' } },
          additionalProperties: false,
        },
        effect_class: verb === 'send' ? 'write_external' : 'read',
        required_scopes: [`test.${verb}`],
        requires_approval: false,
        verify: false,
      })),
    },
    catalog: {
      source: 'capability',
      examples: { 'test.invoice': ['Look up a past receipt', 'Find archived invoices', 'omitted'] },
    },
    async execute(action) {
      calls++;
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: 'invoice-17',
          received_at: new Date().toISOString(),
          late: false,
          detail: { rows: [{ vendor: 'Paper', amount: 17 }] },
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  const registry = new ConnectorRegistry().register(seed.connectionId, connector);
  const broker = new BrokerService({
    sql: db.sql,
    connectors: registry,
    catalog: { skills: async () => options.skills ?? [] },
  });
  return { ...seed, broker, registry, connector, calls: () => calls, sql: db.sql };
}

dbTest('a large valid scope manifest remains discoverable and callable', async () => {
  const s = await setup();
  const tool = s.connector.manifest.tools.find((item) => item.name === 'test.invoice');
  if (!tool) throw new Error('fixture tool absent');
  const extraScopes = Array.from({ length: 32 }, (_, index) => `scope_${index}_${'a'.repeat(125)}`);
  tool.required_scopes.push(...extraScopes);
  s.claims.scopes.push(...extraScopes);
  await s.sql`update connection set scopes = ${JSON.stringify(s.claims.scopes)}::jsonb where id = ${s.connectionId}`;
  const matches = await s.broker.discovery.search(s.claims, 'invoice');
  expect(matches.map((entry) => entry.name)).toEqual(['test.invoice']);
  expect(matches[0]?.required_scopes).toHaveLength(33);
  const loaded = await s.broker.discovery.load(s.claims, 'test.invoice');
  expect(
    (
      await s.broker.propose(s.claims, {
        kind: loaded.tool.name,
        connection_id: s.connectionId,
        payload: {},
      })
    ).status,
  ).toBe('succeeded');
  expect(s.calls()).toBe(1);
});

dbTest(
  'scripted job discovers, loads and calls a tool absent from initial context through the broker',
  async () => {
    const s = await setup();
    const initial = await s.broker.catalog(s.claims);
    expect(initial).toEqual(META_TOOLS);
    const found = await s.broker.discovery.search(s.claims, 'archived invoices');
    expect(found.map((tool) => tool.name)).toEqual(['test.invoice']);
    expect(found[0]).toMatchObject({
      source: 'capability',
      effect_class: 'read',
      examples: ['Look up a past receipt', 'Find archived invoices'],
    });
    expect(found[0]).not.toHaveProperty('input_schema');
    const loaded = await s.broker.discovery.load(s.claims, found[0]?.name ?? '');
    expect(loaded.tool.input_schema).toHaveProperty('properties.vendor');
    expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).toContain('test.invoice');
    const response = await s.broker.propose(s.claims, {
      kind: loaded.tool.name,
      connection_id: loaded.tool.connection_id ?? '',
      payload: { vendor: 'Paper' },
    });
    expect(response.status).toBe('succeeded');
    const action = await s.broker.get(s.claims, response.action_id);
    expect(action.receipt).toMatchObject({ detail: { rows: [{ vendor: 'Paper', amount: 17 }] } });
    expect(s.calls()).toBe(1);
    expect(await s.broker.discovery.search(s.claims, 'invoices')).toEqual([]);
    const [context] =
      await s.sql`select * from attempt_tool_context where attempt_id = ${s.claims.attempt_id}`;
    expect(context?.loaded).toHaveLength(1);
    expect(context?.loaded[0]).toEqual(loaded.tool);
    expect(
      await s.sql`select * from budget_ledger where action_id = ${response.action_id}`,
    ).toHaveLength(1);
    expect(
      await s.sql`select * from event where attempt_id = ${s.claims.attempt_id} and payload->>'phase' = 'load_tool'`,
    ).toHaveLength(1);
    expect(toolTokens(initial)).toBeLessThan(1_400);
  },
);

dbTest(
  'loaded schema persists across service restart without leaking to another attempt',
  async () => {
    const s = await setup();
    await Promise.all([
      s.broker.discovery.load(s.claims, 'test.invoice'),
      s.broker.discovery.load(s.claims, 'test.invoice'),
    ]);
    const restarted = new BrokerService({ sql: s.sql, connectors: s.registry });
    expect(
      (await restarted.catalog(s.claims)).filter((tool) => tool.name === 'test.invoice'),
    ).toHaveLength(1);
    const newId = recordId('att');
    await s.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model) values (${newId}, ${s.claims.job_id}, 2, 'fake', 'fake', 'scripted')`;
    await s.sql`update job set lease_epoch = 2 where id = ${s.claims.job_id}`;
    expect(await restarted.catalog({ ...s.claims, attempt_id: newId, epoch: 2 })).toEqual(
      META_TOOLS,
    );
    expect(await rejectionOf(restarted.discovery.load(s.claims, 'test.read'))).toMatchObject({
      code: 'stale_epoch',
    });
  },
);

dbTest(
  'discovery and invocation recheck persisted scopes, space, revision and expiry',
  async () => {
    const s = await setup();
    await s.broker.discovery.load(s.claims, 'test.invoice');
    await s.sql`update connection set scopes = '["test.read"]'::jsonb where id = ${s.connectionId}`;
    expect(await s.broker.discovery.search(s.claims, 'invoices')).toEqual([]);
    expect(await rejectionOf(s.broker.discovery.load(s.claims, 'test.invoice'))).toMatchObject({
      code: 'unknown_tool',
    });
    expect(
      await rejectionOf(
        s.broker.propose(s.claims, {
          kind: 'test.invoice',
          connection_id: s.connectionId,
          payload: {},
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).not.toContain(
      'test.invoice',
    );
    for (const [claims, code] of [
      [{ ...s.claims, space_id: recordId('sp') }, 'scope_denied'],
      [{ ...s.claims, revision: 9 }, 'revision_mismatch'],
      [{ ...s.claims, exp: 1 }, 'stale_epoch'],
    ] as const)
      expect(await rejectionOf(s.broker.discovery.search(claims, 'read'))).toMatchObject({ code });
    expect(s.calls()).toBe(0);
  },
);

dbTest('loading an external write never changes its approval requirement', async () => {
  const s = await setup();
  const { tool } = await s.broker.discovery.load(s.claims, 'test.send');
  const response = await s.broker.propose(s.claims, {
    kind: tool.name,
    connection_id: s.connectionId,
    payload: {},
  });
  expect(response).toMatchObject({ status: 'needs_approval', effect_class: 'write_external' });
  expect(s.calls()).toBe(0);
});

dbTest('a tool reclassified after admission cannot dispatch through a loaded schema', async () => {
  for (const change of ['effect', 'approval'] as const) {
    const s = await setup();
    await s.broker.discovery.load(s.claims, 'test.read');
    const broker = new BrokerService({
      sql: s.sql,
      connectors: s.registry,
      resolveAuthority: async (_tx, input) => {
        if (input.phase === 'execution') {
          const tool = s.connector.manifest.tools.find((item) => item.name === 'test.read');
          if (tool) {
            if (change === 'effect') tool.effect_class = 'write_reversible';
            else tool.requires_approval = true;
          }
        }
        return {};
      },
    });
    const response = await broker.proposeRead(s.claims, {
      kind: 'test.read',
      connection_id: s.connectionId,
      payload: {},
    });
    expect(response.status).toBe('failed');
    expect(s.calls()).toBe(0);
    expect((await broker.get(s.claims, response.action_id)).dispatched_at).toBeNull();
  }
});

dbTest('schema change or failed health cannot silently replace a loaded tool', async () => {
  const s = await setup();
  await s.broker.discovery.load(s.claims, 'test.invoice');
  const declared = s.connector.manifest.tools.find((tool) => tool.name === 'test.invoice');
  if (!declared) throw new Error('fixture tool absent');
  declared.input_schema = { type: 'object', properties: { new_argument: { type: 'number' } } };
  expect(await rejectionOf(s.broker.discovery.load(s.claims, 'test.invoice'))).toMatchObject({
    code: 'unknown_tool',
  });
  expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).not.toContain('test.invoice');
  await s.sql`update connection set health = 'failing' where id = ${s.connectionId}`;
  expect(await rejectionOf(s.broker.discovery.load(s.claims, 'test.read'))).toMatchObject({
    code: 'connector_unavailable',
  });
});

dbTest(
  'same-named tools on two accounts receive stable aliases bound to their connection',
  async () => {
    const s = await setup();
    const second = recordId('conn');
    await s.sql`insert into connection (id, space_id, provider, label, scopes) values (${second}, ${s.claims.space_id}, 'test', 'Second', '["test.invoice"]'::jsonb)`;
    s.registry.register(second, s.connector);
    const names = (await s.broker.discovery.search(s.claims, 'invoice')).map((tool) => tool.name);
    expect(names).toHaveLength(2);
    const name = accountToolName('test.invoice', second);
    const { tool } = await s.broker.discovery.load(s.claims, name);
    expect(tool.connection_id).toBe(second);
    const response = await s.broker.propose(s.claims, {
      kind: name,
      connection_id: second,
      payload: {},
    });
    expect(await s.broker.get(s.claims, response.action_id)).toMatchObject({
      kind: 'test.invoice',
      connection_id: second,
    });
    expect(
      await rejectionOf(
        s.broker.propose(s.claims, { kind: name, connection_id: s.connectionId, payload: {} }),
      ),
    ).toMatchObject({ code: 'unknown_tool' });
  },
);

dbTest('granting a second account preserves the loaded first account name', async () => {
  const s = await setup();
  await s.broker.discovery.load(s.claims, 'test.invoice');
  const second = recordId('conn');
  await s.sql`insert into connection (id, space_id, provider, label, scopes) values (${second}, ${s.claims.space_id}, 'test', 'Second', '["test.invoice"]'::jsonb)`;
  s.registry.register(second, s.connector);
  expect(await s.broker.discovery.load(s.claims, 'test.invoice')).toMatchObject({
    tool: { name: 'test.invoice', connection_id: s.connectionId },
  });
  expect((await s.broker.catalog(s.claims)).map((tool) => tool.name)).toContain('test.invoice');
  const secondName = accountToolName('test.invoice', second);
  expect((await s.broker.discovery.search(s.claims, 'invoice')).map((tool) => tool.name)).toEqual([
    secondName,
  ]);
  await s.broker.discovery.load(s.claims, secondName);
  await s.sql`update connection set status = 'revoked' where id = ${s.connectionId}`;
  expect(await s.broker.discovery.load(s.claims, secondName)).toMatchObject({
    tool: { name: secondName, connection_id: second },
  });
  expect(await rejectionOf(s.broker.discovery.load(s.claims, 'test.invoice'))).toMatchObject({
    code: 'unknown_tool',
  });
});

dbTest('a new account cannot reuse a revoked account name during the same attempt', async () => {
  const s = await setup();
  await s.broker.discovery.load(s.claims, 'test.invoice');
  await s.sql`update connection set status = 'revoked' where id = ${s.connectionId}`;
  const second = recordId('conn');
  await s.sql`insert into connection (id, space_id, provider, label, scopes) values (${second}, ${s.claims.space_id}, 'test', 'Replacement', '["test.invoice"]'::jsonb)`;
  s.registry.register(second, s.connector);
  expect(await rejectionOf(s.broker.discovery.load(s.claims, 'test.invoice'))).toMatchObject({
    code: 'unknown_tool',
  });
  const secondName = accountToolName('test.invoice', second);
  expect(await s.broker.discovery.load(s.claims, secondName)).toMatchObject({
    tool: { connection_id: second },
  });
  const [context] =
    await s.sql`select loaded from attempt_tool_context where attempt_id = ${s.claims.attempt_id}`;
  expect(context?.loaded.map((tool: { connection_id: string }) => tool.connection_id)).toEqual([
    s.connectionId,
    second,
  ]);
});

dbTest('asynchronous or unresolved connector schemas cannot authorize an action', async () => {
  for (const schema of [
    { $async: true, type: 'object', required: ['vendor'] },
    { $ref: 'https://unregistered.invalid/schema' },
  ]) {
    const s = await setup();
    const tool = s.connector.manifest.tools.find((tool) => tool.name === 'test.invoice');
    if (!tool) throw new Error('fixture tool absent');
    tool.input_schema = schema;
    expect(
      await rejectionOf(
        s.broker.propose(s.claims, {
          kind: tool.name,
          connection_id: s.connectionId,
          payload: {},
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    expect(await s.sql`select id from action where job_id = ${s.claims.job_id}`).toHaveLength(0);
    expect(s.calls()).toBe(0);
  }
});

dbTest(
  'independent tool schemas may use the same schema id without sharing validation',
  async () => {
    const s = await setup();
    for (const [name, property] of [
      ['test.read', 'first'],
      ['test.invoice', 'second'],
    ]) {
      const tool = s.connector.manifest.tools.find((tool) => tool.name === name);
      if (!tool || !property) throw new Error('fixture tool absent');
      tool.input_schema = {
        $id: 'https://example.test/schema',
        type: 'object',
        properties: { [property]: { type: 'string' } },
        required: [property],
        additionalProperties: false,
      };
      expect(
        (
          await s.broker.propose(s.claims, {
            kind: tool.name,
            connection_id: s.connectionId,
            payload: { [property]: 'valid' },
          })
        ).status,
      ).toBe('succeeded');
      expect(
        await rejectionOf(
          s.broker.propose(s.claims, {
            kind: tool.name,
            connection_id: s.connectionId,
            payload: { wrong: 'invalid' },
          }),
        ),
      ).toMatchObject({ code: 'payload_invalid' });
    }
    expect(s.calls()).toBe(2);
  },
);

dbTest('skills are scoped read content and cannot grant their named tool scopes', async () => {
  const skill = (name: string, tools: string[]): Skill => ({
    path: 'fixture/SKILL.md',
    body: 'Follow the procedure.',
    frontmatter: {
      name,
      tools,
      description: 'Find a receipt procedure',
      triggers: ['receipt'],
      max_tokens: 400,
    },
  });
  const s = await setup({
    skills: [skill('receipts', ['test.invoice']), skill('forbidden', ['vault.export'])],
  });
  expect((await s.broker.discovery.search(s.claims, 'procedure')).map((tool) => tool.name)).toEqual(
    ['skills.receipts'],
  );
  await s.broker.discovery.load(s.claims, 'skills.receipts');
  expect(await s.broker.discovery.callSkill(s.claims, 'skills.receipts', {})).toEqual({
    name: 'receipts',
    body: 'Follow the procedure.',
  });
  expect(await rejectionOf(s.broker.discovery.load(s.claims, 'skills.forbidden'))).toMatchObject({
    code: 'unknown_tool',
  });
  await s.sql`update job set constraints = '{"public_compartment":true}'::jsonb where id = ${s.claims.job_id}`;
  expect(
    await rejectionOf(s.broker.discovery.callSkill(s.claims, 'skills.receipts', {})),
  ).toMatchObject({ code: 'unknown_tool' });
});

dbTest(
  'HTTP discovery rejects unauthenticated, forged schemas and extra authority fields',
  async () => {
    const s = await setup();
    const key = 'catalog-capability-key-32-characters';
    const app = createBrokerApp({
      broker: s.broker,
      capabilityKey: key,
      approvalKey: 'catalog-approval-key-32-characters',
    });
    const request = (payload: unknown, token?: string) =>
      app.request('/tools/load', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    expect((await request({ name: 'test.read' })).status).toBe(401);
    const token = signCapability(s.claims, key);
    expect(
      (await request({ name: 'test.invoice', input_schema: {}, required_scopes: [] }, token))
        .status,
    ).toBe(400);
    expect((await request({ name: 'test.invoice' }, token)).status).toBe(200);
  },
);
