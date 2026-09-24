import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeActionResponse } from '@melete/contracts';
import { signCapability } from '../../src/broker/capability.ts';
import { createInternalServer } from '../../src/broker/internal-server.ts';
import { startEffectBoundary } from '../../src/broker/start.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { loadEnv } from '../../src/env.ts';
import { fakeProvider } from '../../src/gateway/fake.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { spaceIdFor } from '../../src/knowledge/spaces.ts';
import { seedJob } from '../helpers/broker.ts';
import { unusedTestPort } from '../helpers/database.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
if (fixture) await initializeTestLedger(fixture.sql);
afterAll(async () => {
  await fixture?.close();
});
const capabilityKey = 'gateway-integration-signing-key-0000000000';
const approvalKey = 'gateway-integration-approval-key-000000000';

async function setup(maxTurns = 10, maxOutputTokens?: number) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const seed = await seedJob(fixture.sql, {
    scopes: ['test.send'],
    budget: {
      max_turns: maxTurns,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    },
  });
  const connector = createTestConnector(fixture.sql);
  const internal = createInternalServer({
    sql: fixture.sql,
    connectors: { get: (id) => (id === seed.connectionId ? connector : undefined) },
    capabilityKey,
    approvalKey,
    providers: [fakeProvider],
    defaultProvider: 'fake',
  });
  await new Promise<void>((resolve, reject) => {
    internal.server.once('error', reject);
    internal.server.listen(0, '127.0.0.1', resolve);
  });
  const address = internal.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing gateway address');
  const base = `http://127.0.0.1:${address.port}`;
  const token = signCapability(seed.claims, capabilityKey);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const inference = (messages: unknown[], stream = true) =>
    post(
      '/providers/fake/v1/chat/completions',
      {
        model: 'scripted',
        max_tokens: 64,
        stream,
        messages,
      },
      { authorization: 'Bearer melete-surrogate-fixture', 'x-melete-capability': token },
    );
  return {
    ...seed,
    ...internal,
    sql: fixture.sql,
    token,
    base,
    post,
    inference,
    close: () => new Promise<void>((resolve) => internal.server.close(() => resolve())),
  };
}

databaseTest(
  'scripted fake streams through the gateway, broker approval, destination, and final response',
  async () => {
    const s = await setup();
    try {
      const first = await s.inference([{ role: 'user', content: 'Send the scripted message.' }]);
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('text/event-stream');
      const firstStream = await first.text();
      const chunks = firstStream
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      const call = chunks
        .flatMap((chunk) => chunk.choices ?? [])
        .flatMap((choice) => choice.delta?.tool_calls ?? [])[0];
      expect(call.function.name).toBe('test.send');
      expect(firstStream).toContain('data: [DONE]');
      const request = {
        kind: call.function.name,
        connection_id: s.connectionId,
        payload: JSON.parse(call.function.arguments),
        client_ref: call.id,
      };
      const proposed = await s.post('/actions', request, { authorization: `Bearer ${s.token}` });
      const proposal = proposeActionResponse.parse(await proposed.json());
      expect(proposed.status).toBe(201);
      expect(proposal.status).toBe('needs_approval');
      expect(
        await s.sql`select * from test_destination_ledger where action_id = ${proposal.action_id}`,
      ).toHaveLength(0);
      const selfApproval = await s.post(
        `/actions/${proposal.action_id}/approve`,
        { payload_hash: proposal.payload_hash },
        { authorization: `Bearer ${s.token}` },
      );
      expect(selfApproval.status).toBe(401);
      await selfApproval.arrayBuffer();
      const approval = await s.post(
        `/actions/${proposal.action_id}/approve`,
        { payload_hash: proposal.payload_hash },
        { authorization: `Bearer ${approvalKey}` },
      );
      expect(approval.status).toBe(200);
      await approval.arrayBuffer();
      const resumed = await s.post('/actions', request, { authorization: `Bearer ${s.token}` });
      const action = proposeActionResponse.parse(await resumed.json());
      expect(action.action_id).toBe(proposal.action_id);
      expect(action.status).toBe('succeeded');
      const second = await s.inference([
        { role: 'user', content: 'Send the scripted message.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: call.id, type: 'function', function: call.function }],
        },
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ action_id: action.action_id, status: action.status }),
        },
      ]);
      const finalStream = await second.text();
      expect(second.status).toBe(200);
      expect(finalStream).toContain('This is a walkthrough answer from the scripted model.');
      const [attempt] =
        await s.sql`select provider, model, model_actual, usage from attempt where id = ${s.claims.attempt_id}`;
      expect(attempt?.provider).toBe('fake');
      expect(attempt?.model).toBe('scripted');
      expect(attempt?.model_actual).toBe('fake-scripted-v1');
      expect(attempt?.usage).toMatchObject({ input_tokens: 29, output_tokens: 16, requests: 2 });
      expect(
        await s.sql`select action_id from test_destination_ledger where action_id = ${action.action_id}`,
      ).toHaveLength(1);
      const receipts =
        await s.sql`select payload from event where attempt_id = ${s.claims.attempt_id} and payload->>'phase' = 'model_receipt' order by seq`;
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts) {
        expect(receipt.payload.model_actual).toBe('fake-scripted-v1');
        expect(receipt.payload.latency_ms).toBeGreaterThanOrEqual(0);
        expect(receipt.payload.status).toBe('succeeded');
      }
    } finally {
      await s.close();
    }
  },
);

databaseTest('HTTP gateway request cap admits exactly one concurrent call', async () => {
  const s = await setup(1);
  try {
    const responses = await Promise.all([s.inference([], false), s.inference([], false)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    const requests =
      await s.sql`select seq from event where attempt_id = ${s.claims.attempt_id} and payload->>'phase' = 'model_request'`;
    expect(requests).toHaveLength(1);
    const [attempt] = await s.sql`select usage from attempt where id = ${s.claims.attempt_id}`;
    expect(attempt?.usage.requests).toBe(1);
  } finally {
    await s.close();
  }
});

databaseTest(
  'a request that names no output limit reserves only what the job has left',
  async () => {
    const s = await setup(10, 1000);
    try {
      const unlimited = () =>
        s.post(
          '/providers/fake/v1/chat/completions',
          { model: 'scripted', stream: false, messages: [] },
          { authorization: 'Bearer melete-surrogate-fixture', 'x-melete-capability': s.token },
        );
      const reserved = async () =>
        (
          await s.sql`select payload from event where attempt_id = ${s.claims.attempt_id}
            and payload->>'phase' = 'model_request' order by seq`
        ).map((row) => Number(row.payload.max_output_tokens));
      const first = await unlimited();
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      // The default of 4,096 is above this job's whole output budget.
      expect(await reserved()).toEqual([1000]);
      const [ledger] = await s.sql`select coalesce(sum(coalesce(settled, reserved)), 0)::int as used
        from budget_ledger where job_id = ${s.claims.job_id} and kind = 'tokens'`;
      const used = Number(ledger?.used);
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThan(1000);
      const second = await unlimited();
      expect(second.status).toBe(200);
      await second.arrayBuffer();
      expect(await reserved()).toEqual([1000, 1000 - used]);
    } finally {
      await s.close();
    }
  },
);

databaseTest(
  'an output budget above the window leaves each request its input room and still caps the job',
  async () => {
    // "scripted" falls back to the 128,000-token window; the job may spend
    // 250,000 output tokens across all of its requests.
    const s = await setup(10, 250_000);
    try {
      const request = (maxTokens: number, content: string) =>
        s.post(
          '/providers/fake/v1/chat/completions',
          {
            model: 'scripted',
            max_tokens: maxTokens,
            stream: false,
            messages: [{ role: 'user', content }],
          },
          { authorization: 'Bearer melete-surrogate-fixture', 'x-melete-capability': s.token },
        );
      // About 75,000 tokens of conversation, far more than 128,000 - 250,000.
      const conversation = 'conversation so far '.repeat(15_000);
      const first = await request(4096, conversation);
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      const [admitted] = await s.sql`select payload from event
        where attempt_id = ${s.claims.attempt_id} and payload->>'phase' = 'model_request'`;
      expect(admitted?.payload.max_input_tokens).toBe(128_000 - 4096);
      expect(admitted?.payload.max_output_tokens).toBe(4096);

      // Spend all but 3,000 of the job's output, then ask for more than that.
      const [ledger] = await s.sql`select coalesce(sum(coalesce(settled, reserved)), 0)::int as used
        from budget_ledger where job_id = ${s.claims.job_id} and kind = 'tokens'`;
      await s.sql`insert into budget_ledger (id, job_id, attempt_id, kind, reserved, settled)
        values (${`led_spent_${s.claims.attempt_id}`}, ${s.claims.job_id}, ${s.claims.attempt_id},
          'tokens', ${250_000 - 3000 - Number(ledger?.used)}, ${250_000 - 3000 - Number(ledger?.used)})`;
      const over = await request(4096, 'Continue.');
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      const within = await request(2000, 'Continue.');
      expect(within.status).toBe(200);
      await within.arrayBuffer();
    } finally {
      await s.close();
    }
  },
);

databaseTest(
  'cancellation fences both broker and provider HTTP routes without a request record',
  async () => {
    const s = await setup();
    try {
      await s.broker.cancel(s.claims.job_id);
      const catalog = await fetch(`${s.base}/tools`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(catalog.status).toBe(403);
      await catalog.arrayBuffer();
      const response = await s.inference([]);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'stale_epoch' } });
      expect(
        await s.sql`select id from budget_ledger where job_id = ${s.claims.job_id}`,
      ).toHaveLength(0);
    } finally {
      await s.close();
    }
  },
);

databaseTest(
  'service startup binds the broker internal port and runs pg-boss against the fixture',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const spacesRoot = await mkdtemp(join(tmpdir(), 'melete-discovery-skills-'));
    await mkdir(join(spacesRoot, 'personal', '.git'), { recursive: true });
    await mkdir(join(spacesRoot, 'personal', 'skills'));
    await writeFile(
      join(spacesRoot, 'personal', 'skills', 'receipt.md'),
      `---
name: fixture-receipt
description: Read the fixtureonlyskill procedure
triggers: [fixtureonlyskill]
tools: [test.send]
max_tokens: 400
---
Use the scoped receipt procedure.
`,
    );
    const seed = await seedJob(fixture.sql, {
      scopes: ['test.send'],
      spaceId: spaceIdFor('personal'),
    });
    const env = loadEnv({
      DATABASE_URL: fixture.url,
      MELETE_CAPABILITY_KEY: capabilityKey,
      MELETE_APPROVAL_KEY: approvalKey,
      MELETE_BROKER_BIND: `127.0.0.1:${await unusedTestPort()}`,
      MELETE_ENABLE_TEST_CONNECTOR: 'true',
      MELETE_ENABLE_FAKE_PROVIDER: 'true',
      MELETE_DEFAULT_PROVIDER: 'fake',
      MELETE_DEFAULT_MAX_OUTPUT_TOKENS: '777',
      MELETE_SPACES_DIR: spacesRoot,
    });
    // A provider name the gateway does not have stops start-up before anything listens.
    await expect(
      startEffectBoundary(fixture, { ...env, MELETE_DEFAULT_PROVIDER: 'openai-compat' }),
    ).rejects.toThrow('"openai-compatible"');
    const internal = await startEffectBoundary(fixture, env);
    try {
      const token = signCapability(seed.claims, capabilityKey);
      const address = internal.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing broker address');
      const inference = await fetch(
        `http://127.0.0.1:${address.port}/providers/fake/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer melete-surrogate-fixture',
            'x-melete-capability': token,
          },
          body: JSON.stringify({ model: 'scripted', stream: false, messages: [] }),
        },
      );
      expect(inference.status).toBe(200);
      await inference.arrayBuffer();
      const [reserved] = await fixture.sql`select payload from event
        where attempt_id = ${seed.claims.attempt_id} and payload->>'phase' = 'model_request'`;
      // The configured output limit reaches the gateway this listener serves.
      expect(reserved?.payload.max_output_tokens).toBe(777);
      const response = await fetch(`http://127.0.0.1:${address.port}/tools`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tools: [
          { name: 'load_tool', connection_id: null },
          { name: 'react', connection_id: null },
          { name: 'search_tools', connection_id: null },
          // Pinned because the space has skills the attempt can read by name.
          { name: 'skills.read', connection_id: null },
          { name: 'test.send', connection_id: seed.connectionId },
        ],
      });
      const search = await fetch(`http://127.0.0.1:${address.port}/tools/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'fixtureonlyskill' }),
      });
      expect(await search.json()).toMatchObject({
        tools: [{ name: 'skills.fixture_receipt', source: 'skill' }],
      });
      const [queue] =
        await fixture.sql`select name from pgboss.queue where name = ${QUEUES.attempt}`;
      expect(queue?.name).toBe(QUEUES.attempt);
    } finally {
      await internal.close();
      await rm(spacesRoot, { recursive: true, force: true });
    }
  },
);
