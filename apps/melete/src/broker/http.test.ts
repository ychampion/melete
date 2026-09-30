import { expect, spyOn, test } from 'bun:test';
import type { CapabilityClaims, ToolSpec } from '@melete/contracts';
import { signCapability, verifyCapability } from './capability.ts';
import { BrokerFault } from './errors.ts';
import { type BrokerOperations, createBrokerApp } from './http.ts';

const key = 'attempt-key-for-tests-only-000000000000';
const approvalKey = 'approval-key-for-tests-only-0000000000';
const suffix = '01J8ZP3QWABCDEFGHJKMNPQRST';
const claims: CapabilityClaims = {
  job_id: `job_${suffix}`,
  attempt_id: `att_${suffix}`,
  space_id: `sp_${suffix}`,
  epoch: 2,
  revision: 0,
  scopes: ['files.read'],
  budget: { max_actions: 5, max_output_tokens: 100, max_usd_est: 0 },
  exp: 4_000_000_000,
};
const tools: ToolSpec[] = ['files.read', 'files.list'].map((name) => ({
  name,
  description: name,
  input_schema: {},
  effect_class: 'read',
  connection_id: `conn_${suffix}`,
}));
const resumed: { attempt: string; id: string }[] = [];
const broker: BrokerOperations = {
  async authorize(c) {
    if (c.epoch !== 2) throw new BrokerFault('stale_epoch');
  },
  async catalog(c) {
    return c.scopes.includes('files.read') ? [...tools] : [];
  },
  async propose(c) {
    if (!c.scopes.includes('files.write')) throw new BrokerFault('scope_denied');
    throw new BrokerFault('unknown_tool');
  },
  async get() {
    throw new BrokerFault('action_not_found');
  },
  async resume(c, id) {
    resumed.push({ attempt: c.attempt_id, id });
    throw new BrokerFault('revision_mismatch');
  },
  async react(_c, request) {
    return { message_id: request.message_id ?? '1', emoji: request.emoji };
  },
  async decide() {
    return { decision: 'approved' };
  },
};
const app = createBrokerApp({ broker, capabilityKey: key, approvalKey });
const auth = (c = claims) => ({ authorization: `Bearer ${signCapability(c, key)}` });

test('HS256 rejects expired, tampered and unsigned capabilities', () => {
  expect(verifyCapability(signCapability(claims, key), key)).toEqual(claims);
  expect(() => verifyCapability(signCapability({ ...claims, exp: 1 }, key), key)).toThrow();
  const valid = signCapability(claims, key);
  expect(() => verifyCapability(`${valid.slice(0, -8)}AAAAAAAA`, key)).toThrow();
  expect(() => verifyCapability('eyJhbGciOiJub25lIn0.e30.', key)).toThrow();
});
test('stale epoch rejected at HTTP boundary', async () => {
  const response = await app.request('/tools', { headers: auth({ ...claims, epoch: 1 }) });
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('stale_epoch');
});
test('missing scope rejected on proposal', async () => {
  const response = await app.request('/actions', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ kind: 'files.write', connection_id: `conn_${suffix}`, payload: {} }),
  });
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('scope_denied');
});
test('catalog order stable and out-of-scope catalog empty', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await app.request('/tools', { headers: auth() });
    expect(
      ((await response.json()) as { tools: ToolSpec[] }).tools.map((t: ToolSpec) => t.name),
    ).toEqual(['files.list', 'files.read']);
  }
  const response = await app.request('/tools', { headers: auth({ ...claims, scopes: [] }) });
  expect(((await response.json()) as { tools: ToolSpec[] }).tools).toEqual([]);
});
test('attempt credential cannot approve itself; API credential can decide', async () => {
  const body = JSON.stringify({ payload_hash: 'a'.repeat(64) });
  expect(
    (await app.request(`/actions/act_${suffix}/approve`, { method: 'POST', headers: auth(), body }))
      .status,
  ).toBe(401);
  expect(
    (
      await app.request(`/actions/act_${suffix}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${approvalKey}` },
        body,
      })
    ).status,
  ).toBe(200);
});
test('an attempt resumes by id alone, and neither the approval credential nor a stale attempt can', async () => {
  const path = `/actions/act_${suffix}/resume`;
  const response = await app.request(path, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ payload: { body: 'retyped' } }),
  });
  // The refusal is the broker's own; the body a caller sent is never read.
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'revision_mismatch',
  );
  expect(resumed).toEqual([{ attempt: claims.attempt_id, id: `act_${suffix}` }]);
  expect(
    (
      await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${approvalKey}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await app.request(path, { method: 'POST', headers: auth({ ...claims, epoch: 1 }) })).status,
  ).toBe(403);
  expect((await app.request(path, { method: 'GET', headers: auth() })).status).toBe(404);
  expect(resumed).toHaveLength(1);
});
test('unlisted paths and methods rejected including HEAD', async () => {
  for (const [path, method] of [
    ['/health', 'GET'],
    ['/tools', 'HEAD'],
    ['/tools', 'POST'],
    ['/actions/x/dispatch', 'POST'],
  ]) {
    expect((await app.request(path as string, { method, headers: auth() })).status).toBe(404);
  }
});

test('an unexpected failure is logged with its cause, and the caller still learns nothing more', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlc2lnbmF0dXJl';
  const failing = createBrokerApp({
    broker: {
      ...broker,
      discovery: {
        async find() {
          throw new TypeError(
            `Cannot read properties of undefined (reading 'agent_id') for someone@example.com with Bearer ${token}`,
          );
        },
      } as unknown as NonNullable<BrokerOperations['discovery']>,
    },
    capabilityKey: key,
    approvalKey,
  });
  const written: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  let response: Response;
  try {
    response = await failing.request('/tools/search', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ query: 'current time' }),
    });
  } finally {
    spy.mockRestore();
  }
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: { code: 'internal_error', message: 'Broker request failed' },
  });
  const line = written.join('');
  expect(line).toContain('broker POST /tools/search failed: TypeError');
  expect(line).toContain("reading 'agent_id'");
  // Where it was thrown, so the cause can be found from the log alone.
  expect(line).toContain('http.test.ts');
  // Never the credential, never an address, never the request body.
  expect(line).not.toContain(token);
  expect(line).not.toContain('someone@example.com');
  expect(line).not.toContain('current time');
});
