/**
 * The brokered `terminal.run` connector, against the in-memory fake provider
 * and a real session table. Nothing here reaches a provider.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SandboxConnectionConfig } from '@melete/contracts';
import { type Action, canonicalizePayload, connectorManifest } from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import { SANDBOX_SYNC_ALLOWANCE_MS } from '../env.ts';
import { FakeSandboxEngine, FakeSandboxProvider } from '../sandbox/fake.ts';
import { seedSessionScope } from '../sandbox/session-fixtures.ts';
import { SandboxSessions } from '../sandbox/sessions.ts';
import { ConnectorRegistry } from './registry.ts';
import {
  createSandboxExecConnector,
  outputText,
  sandboxDispatchBudgetMs,
  sandboxExecManifest,
} from './sandbox-exec.ts';
import type { ConnectorContext } from './types.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const PROJECT = 'sandbox-exec-test';

let workRoot = '';
beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  workRoot = await mkdtemp(path.join(tmpdir(), 'melete-sandbox-exec-'));
});
afterAll(async () => {
  await handle?.close();
}, 30_000);

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'ephemeral',
  lifetime_seconds: 600,
};

test('the terminal manifest parses, is brokered, and registers', () => {
  connectorManifest.parse(sandboxExecManifest);
  const [tool] = sandboxExecManifest.tools;
  // Brokered: the service runs the command, so there is no record to validate.
  expect(tool?.execution).toBeUndefined();
  expect(tool?.record_schema).toBeNull();
  expect(tool).toMatchObject({
    name: 'terminal.run',
    effect_class: 'write_reversible',
    requires_approval: false,
    verify: true,
    required_scopes: ['terminal.run'],
  });
  const registry = new ConnectorRegistry();
  const provider = new FakeSandboxProvider();
  expect(() =>
    registry.register(
      'conn_01J0SANDBOXEXEC0000000000',
      createSandboxExecConnector({
        sessions: new SandboxSessions({} as never, {
          leaseSeconds: 300,
          workspaceRetentionSeconds: 3_600,
        }),
        provider,
        config,
        connectionId: 'conn_01J0SANDBOXEXEC0000000000',
        spaceId: 'sp_01',
        project: PROJECT,
        workRoot: 'unused',
        sql: {} as never,
      }),
    ),
  ).not.toThrow();
});

test('a dispatch may take the command timeout and the session margin, never less', () => {
  expect(
    sandboxDispatchBudgetMs({ canonical_payload: { command: 'true', timeout_ms: 90_000 } }),
  ).toBe(90_000 + SANDBOX_SYNC_ALLOWANCE_MS);
  expect(sandboxDispatchBudgetMs({ canonical_payload: { command: 'true' } })).toBe(
    120_000 + SANDBOX_SYNC_ALLOWANCE_MS,
  );
  // A payload the connector refuses still gets a bounded budget.
  expect(sandboxDispatchBudgetMs({ canonical_payload: { command: 'true', timeout_ms: -1 } })).toBe(
    120_000 + SANDBOX_SYNC_ALLOWANCE_MS,
  );
});

test('a run name is a short token', () => {
  const schema = sandboxExecManifest.tools[0]?.input_schema as {
    properties: { run: { pattern: string } };
  };
  const pattern = new RegExp(schema.properties.run.pattern);
  expect(pattern.test('0123456789abcdef')).toBe(true);
  expect(pattern.test('short')).toBe(false);
  expect(pattern.test('has a space in it')).toBe(false);
});

test('output text keeps a character the cap cut, and marks what is not text', () => {
  const bytes = new TextEncoder().encode('ok é');
  expect(outputText(bytes, false)).toEqual({ text: 'ok é', binary: false });
  // The cap fell inside the last character: not binary.
  expect(outputText(bytes.slice(0, -1), true)).toEqual({ text: 'ok ', binary: false });
  // The command itself ended inside one: that is not text.
  expect(outputText(bytes.slice(0, -1), false).binary).toBe(true);
  expect(outputText(new Uint8Array([0x61, 0x00]), false)).toEqual({
    text: 'a�',
    binary: true,
  });
});

withDb('a command in a remote sandbox', () => {
  const setup = async (
    over: {
      persistence?: SandboxConnectionConfig['persistence'];
      maxConcurrent?: number;
      maxPerConnection?: number;
      /** Shared where two connections run side by side, so their sandbox ids differ. */
      engine?: FakeSandboxEngine;
    } = {},
  ) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const scope = await seedSessionScope(handle.sql);
    const provider = new FakeSandboxProvider(over.engine ? { engine: over.engine } : {});
    const sessions = new SandboxSessions(handle.sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const connector = createSandboxExecConnector({
      sessions,
      provider,
      config: { ...config, ...(over.persistence ? { persistence: over.persistence } : {}) },
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: PROJECT,
      workRoot,
      sql: handle.sql,
      ...(over.maxConcurrent === undefined ? {} : { maxConcurrent: over.maxConcurrent }),
      ...(over.maxPerConnection === undefined ? {} : { maxPerConnection: over.maxPerConnection }),
    });
    const attemptId = await scope.attempt();
    await mkdir(path.join(workRoot, scope.jobId), { recursive: true });
    const action = async (
      payload: Record<string, unknown>,
      attempt = attemptId,
    ): Promise<Action> => {
      const id = await scope.action(attempt);
      const canonical = canonicalizePayload(payload);
      return {
        id,
        job_id: scope.jobId,
        attempt_id: attempt,
        connection_id: scope.connectionId,
        kind: 'terminal.run',
        effect_class: 'write_reversible',
        canonical_payload: canonical.canonical,
        payload_hash: canonical.hash,
        intent_key: null,
        status: 'dispatched',
        authorization_ref: null,
        budget_reservation: null,
        idempotency_key: id,
        dispatched_at: new Date().toISOString(),
        receipt: null,
        resolved_at: null,
        reconciliation: null,
        repair_trace: [],
        repair_counters: {},
        repair_disposition: null,
        retry_after_at: null,
        created_at: new Date().toISOString(),
      };
    };
    const context = (action: Action): ConnectorContext => ({
      job_id: action.job_id,
      space_id: scope.spaceId,
      idempotency_key: action.id,
      constraints: {
        deliverable: { kind: 'none' },
        allowed_domains: [],
        public_compartment: false,
      },
    });
    const run = async (payload: Record<string, unknown>, attempt = attemptId) => {
      const target = await action(payload, attempt);
      return { action: target, result: await connector.execute(target, context(target)) };
    };
    return { scope, provider, sessions, connector, attemptId, action, context, run };
  };

  test('an ordinary command is recorded with what ran, where, and in which sandbox', async () => {
    const { provider, run, sessions } = await setup();
    const { result } = await run({ command: "printf 'from the sandbox'" });
    if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
    expect(result.receipt.detail).toMatchObject({
      language: 'shell',
      command: "printf 'from the sandbox'",
      cwd: '.',
      exit_code: 0,
      timed_out: false,
      truncated: false,
      output_digest: digest('from the sandbox'),
      output_bytes: 16,
      digest_verified: true,
      adapter: 'fake',
      image_ref: 'base',
      egress: 'deny_all',
      persistence: 'ephemeral',
    });
    expect(result.receipt.external_ref).toBe(digest('from the sandbox'));
    expect(String(result.receipt.detail.sandbox_id)).toStartWith('fake-sbx-');
    expect(provider.calls.create).toBe(1);
    // The session is recorded, leased and still running.
    const session = await sessions.get(String(result.receipt.detail.session_id));
    expect(session).toMatchObject({ status: 'ready', adapter: 'fake' });
  }, 60_000);

  test("a remote command's digest is verified because the service wrote the file", async () => {
    const { scope, run } = await setup();
    const slow = await run({ command: 'printf started; sleep 5; printf never', timeout_ms: 1_000 });
    if (slow.result.outcome !== 'succeeded') throw new Error(JSON.stringify(slow.result));
    expect(slow.result.receipt.detail).toMatchObject({ timed_out: true, output: 'started' });
    const size = 70_000;
    const { action, result } = await run({ command: `head -c ${size} /dev/zero` });
    if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
    const detail = result.receipt.detail as Record<string, unknown>;
    // The service read the output out of the sandbox, wrote it here and hashed
    // these bytes, so it says so rather than repeating a claim.
    expect(detail.digest_verified).toBe(true);
    expect(detail.truncated).toBe(true);
    expect(detail.output_path).toBe(`.melete/exec/${action.id}.out`);
    const stored = await readFile(path.join(workRoot, scope.jobId, String(detail.output_path)));
    expect(stored.byteLength).toBe(size);
    expect(digest(stored)).toBe(String(detail.output_digest));
    expect(detail.artifact).toMatchObject({
      area: 'work',
      path: detail.output_path,
      kind: 'text',
      size,
      content_hash: digest(stored),
    });
    const validations = detail.validations as { name: string; status: string }[];
    expect(validations.map((entry) => entry.name)).toEqual(['text.parses']);
    // A small output is hashed by the service too, so it is verified as well.
    const small = await run({ command: 'printf small' });
    if (small.result.outcome !== 'succeeded') throw new Error('expected a receipt');
    expect(small.result.receipt.detail).toMatchObject({
      digest_verified: true,
      output_path: null,
    });
  }, 60_000);

  test('the output travels back on the receipt, as text or marked binary', async () => {
    const { scope, run } = await setup();
    const text = await run({ command: "printf 'line one\\nline two'" });
    if (text.result.outcome !== 'succeeded') throw new Error(JSON.stringify(text.result));
    expect(text.result.receipt.detail).toMatchObject({
      output: 'line one\nline two',
      output_binary: false,
    });

    // Bytes that are not UTF-8 are marked, and a NUL never reaches the receipt,
    // since Postgres cannot store one inside a JSON string.
    const work = path.join(workRoot, scope.jobId);
    await Bun.write(path.join(work, 'blob.bin'), new Uint8Array([0x41, 0x00, 0xff, 0xfe, 0x42]));
    const binary = await run({ command: 'cat /work/blob.bin' });
    if (binary.result.outcome !== 'succeeded') throw new Error(JSON.stringify(binary.result));
    const detail = binary.result.receipt.detail as Record<string, unknown>;
    expect(detail.output_binary).toBe(true);
    expect(String(detail.output)).not.toContain('\0');
    expect(String(detail.output)).toStartWith('A');
    // The digest names the real bytes, not the text shown.
    expect(detail.output_digest).toBe(digest(new Uint8Array([0x41, 0x00, 0xff, 0xfe, 0x42])));

    // A preview cut at the cap inside a character is still text.
    await Bun.write(path.join(work, 'accents.txt'), `a${'é'.repeat(9_000)}`);
    const accents = await run({ command: 'cat /work/accents.txt' });
    if (accents.result.outcome !== 'succeeded') throw new Error(JSON.stringify(accents.result));
    const cut = accents.result.receipt.detail as Record<string, unknown>;
    expect(cut.truncated).toBe(true);
    expect(cut.output_binary).toBe(false);
    expect(String(cut.output)).toBe(`a${'é'.repeat(8_191)}`);
  }, 60_000);

  test('a malformed run name is refused before a sandbox opens', async () => {
    const { provider, run } = await setup();
    const { result } = await run({ command: 'true', run: 'not a run name' });
    expect(result).toMatchObject({ outcome: 'failed', retryable: true });
    expect(provider.calls.create).toBe(0);
    expect(provider.calls.exec).toBe(0);
  }, 60_000);

  test('a second command in one attempt reuses the session', async () => {
    const { provider, run } = await setup();
    const first = await run({ command: 'printf once > /work/first.txt; printf done' });
    const second = await run({ command: 'cat /work/first.txt' });
    if (first.result.outcome !== 'succeeded' || second.result.outcome !== 'succeeded')
      throw new Error('expected two receipts');
    // One sandbox, one session, and the second command sees the first's files.
    expect(provider.calls.create).toBe(1);
    expect(second.result.receipt.detail.session_id).toBe(first.result.receipt.detail.session_id);
    expect(second.result.receipt.detail.sandbox_id).toBe(first.result.receipt.detail.sandbox_id);
    expect(second.result.receipt.detail.output_digest).toBe(digest('once'));
  }, 60_000);

  test('a reused session is renewed before its command is sent', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const { sql } = handle;
    const { provider, run, sessions } = await setup();
    const first = await run({ command: 'printf first' });
    if (first.result.outcome !== 'succeeded') throw new Error(JSON.stringify(first.result));
    const [session] = await sql`select id from sandbox_session where status = 'ready'`;
    // A second of lease left: the sweep would take it while the command ran.
    await sql`update sandbox_session set lease_expires_at = now() + interval '1 second'
      where id = ${session?.id}`;
    // The lease as the provider is sent the command.
    let leaseAtExec = 0;
    const exec = provider.exec.bind(provider);
    provider.exec = async (sandbox, spec, signal) => {
      const row = await sessions.get(String(session?.id));
      leaseAtExec = row?.leaseExpiresAt.getTime() ?? 0;
      return exec(sandbox, spec, signal);
    };
    const second = await run({ command: 'printf second' });
    expect(second.result.outcome).toBe('succeeded');
    expect(leaseAtExec - Date.now()).toBeGreaterThan(60_000);
  }, 60_000);

  test('an unknown outcome is never re-dispatched', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const { provider, run, sessions, connector, context } = await setup();
    provider.loseNextAcknowledgement('after_start');
    const lost = await run({ command: 'printf once >> /work/counter; sleep 1; printf done' });
    expect(lost.result.outcome).toBe('unknown');
    const [settled] = await handle.sql`select outcome, session_id from sandbox_command
      where action_id = ${lost.action.id}`;
    // Recorded as unknown, so the broker cannot send it as a first run again.
    expect(settled?.outcome).toBe('unknown');
    expect(
      await sessions.beginCommand(String(settled?.session_id), lost.action.id, lost.action.id),
    ).toBe('again');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // Asked again, the same action reattaches to the marker instead of running.
    const again = await connector.execute(lost.action, context(lost.action));
    if (again.outcome !== 'succeeded') throw new Error(JSON.stringify(again));
    expect(again.receipt.late).toBe(true);
    expect(again.receipt.detail.output_digest).toBe(digest('done'));
    const counter = await provider.getFile(
      { providerSandboxId: 'fake-sbx-0001', imageDigest: null, region: null },
      '/work/counter',
      64,
      AbortSignal.timeout(5_000),
    );
    expect(new TextDecoder().decode(counter)).toBe('once');
    expect(provider.calls.exec).toBeLessThan(6);
  }, 60_000);

  test('a verify after an unknown dispatch reads the marker, never the command again', async () => {
    const { provider, run, connector, context } = await setup();
    provider.loseNextAcknowledgement('after_start');
    const lost = await run({ command: 'printf once >> /work/counter; sleep 1; printf done' });
    expect(lost.result.outcome).toBe('unknown');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const decision = await connector.verify(lost.action, context(lost.action));
    if (decision.decision !== 'succeeded') throw new Error(JSON.stringify(decision));
    expect(decision.evidence).toMatchObject({ output_digest: digest('done') });
    expect(decision.receipt?.detail.digest_verified).toBe(true);
    const counter = await provider.getFile(
      { providerSandboxId: 'fake-sbx-0001', imageDigest: null, region: null },
      '/work/counter',
      64,
      AbortSignal.timeout(5_000),
    );
    expect(new TextDecoder().decode(counter)).toBe('once');
  }, 60_000);

  test('a job that has used its sandbox time is refused, and nothing is dispatched', async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const { scope, provider, run } = await setup();
    await handle.sql`update job set budget = jsonb_set(budget, '{max_sandbox_seconds}', '0'::jsonb)
      where id = ${scope.jobId}`;
    const refused = await run({ command: 'printf nothing' });
    if (refused.result.outcome !== 'failed') throw new Error(JSON.stringify(refused.result));
    expect(refused.result.reason).toContain('sandbox_time_exhausted');
    // Nothing ran, so the same action may be sent again once the budget allows.
    expect(refused.result.retryable).toBe(true);
    expect(provider.calls.create).toBe(0);
  }, 60_000);

  test('a command for another job or another connection is refused before anything opens', async () => {
    const { provider, action, context, connector } = await setup();
    const foreign = await action({ command: 'printf nothing' });
    await expect(
      connector.execute({ ...foreign, job_id: 'job_OTHER' }, context(foreign)),
    ).rejects.toThrow('identity mismatch');
    await expect(
      connector.execute(
        { ...foreign, connection_id: 'conn_01J0OTHER00000000000000000' },
        context(foreign),
      ),
    ).rejects.toThrow('identity mismatch');
    expect(provider.calls.create).toBe(0);
  }, 60_000);

  test("a workspace command opens the agent's workspace and resumes it next time", async () => {
    if (!handle) throw new Error('Postgres is unavailable');
    const { scope, provider, sessions, run, connector, context, action } = await setup({
      persistence: 'pause',
    });
    await handle.sql`update job set agent_id = ${scope.agentId} where id = ${scope.jobId}`;
    const first = await run({ command: 'printf remembered > /work/notes.txt; printf ok' });
    if (first.result.outcome !== 'succeeded') throw new Error('expected a receipt');
    const sessionId = String(first.result.receipt.detail.session_id);
    const session = await sessions.get(sessionId);
    expect(session).toMatchObject({ persistence: 'pause', agentId: scope.agentId });
    await sessions.suspendWorkspace(sessionId, provider, AbortSignal.timeout(10_000));

    // A later attempt for the same agent comes back to the same files.
    const next = await scope.attempt();
    const resumed = await action({ command: 'cat /work/notes.txt' }, next);
    const outcome = await connector.execute(resumed, context(resumed));
    if (outcome.outcome !== 'succeeded') throw new Error(JSON.stringify(outcome));
    expect(outcome.receipt.detail.output_digest).toBe(digest('remembered'));
    expect(outcome.receipt.detail.session_id).not.toBe(sessionId);
    expect(provider.calls.create).toBe(1);
    expect(provider.calls.resume).toBe(1);
  }, 60_000);

  test('a sandbox beyond the concurrency limit is refused, and nothing is dispatched', async () => {
    const { provider, run, scope, action, context, connector } = await setup({ maxConcurrent: 1 });
    const first = await run({ command: 'printf first' });
    expect(first.result.outcome).toBe('succeeded');
    // The limit counts what this installation has running, whatever job it serves.
    const second = await action({ command: 'printf second' }, await scope.attempt());
    const refused = await connector.execute(second, context(second));
    if (refused.outcome !== 'failed') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toContain('which is its limit');
    expect(refused.retryable).toBe(true);
    expect(provider.calls.create).toBe(1);
  }, 60_000);

  test('concurrent attempts cannot race past the limit', async () => {
    const { scope, provider, action, context, connector } = await setup({ maxConcurrent: 2 });
    // Five attempts open at once. Counting before the row is written would let
    // all five read the same total and pass; counting under the lock that
    // writes it cannot.
    const actions = await Promise.all(
      [0, 1, 2, 3, 4].map(async () => action({ command: 'printf racing' }, await scope.attempt())),
    );
    const outcomes = await Promise.all(actions.map((one) => connector.execute(one, context(one))));
    expect(outcomes.filter((one) => one.outcome === 'succeeded')).toHaveLength(2);
    const refused = outcomes.filter((one) => one.outcome === 'failed');
    expect(refused).toHaveLength(3);
    for (const one of refused)
      expect(one.outcome === 'failed' && one.reason).toContain('which is its limit');
    // Exactly two sandboxes were ever created, not five.
    expect(provider.calls.create).toBe(2);
  }, 60_000);

  test('two connections each have their own allowance', async () => {
    // Room in the service for three, and one apiece: a provider quota belongs
    // to an account, and an account is a connection here.
    const engine = new FakeSandboxEngine();
    const first = await setup({ maxConcurrent: 3, maxPerConnection: 1, engine });
    const second = await setup({ maxConcurrent: 3, maxPerConnection: 1, engine });
    expect((await first.run({ command: 'printf one' })).result.outcome).toBe('succeeded');

    // The first connection has spent what is its own.
    const again = await first.action({ command: 'printf two' }, await first.scope.attempt());
    const refused = await first.connector.execute(again, first.context(again));
    if (refused.outcome !== 'failed') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toContain('this connection already has');
    expect(refused.retryable).toBe(true);

    // The second's allowance is untouched by the first being full.
    expect((await second.run({ command: 'printf three' })).result.outcome).toBe('succeeded');
    expect(first.provider.calls.create).toBe(1);
    expect(second.provider.calls.create).toBe(1);
  }, 60_000);

  test("a command never runs in another connection's session, even in the same attempt", async () => {
    const engine = new FakeSandboxEngine();
    const first = await setup({ engine });
    const second = await setup({ engine });
    expect((await first.run({ command: 'printf first' })).result.outcome).toBe('succeeded');
    const sandboxes = engine.sandboxes.size;
    // The second connection's command, in the attempt the first one's session serves.
    const stray = await second.action({ command: 'printf second' }, first.attemptId);
    const outcome = await second.connector.execute(stray, second.context(stray));
    if (outcome.outcome !== 'failed') throw new Error(JSON.stringify(outcome));
    expect(outcome.reason).toContain('session_exists');
    expect(second.provider.calls.exec).toBe(0);
    // Nothing ran through the second connection, and nothing new was created.
    expect(engine.sandboxes.size).toBe(sandboxes);
  }, 60_000);

  test('the installation ceiling refuses a sandbox a connection still had room for', async () => {
    // Two apiece, but only two in the whole service.
    const engine = new FakeSandboxEngine();
    const first = await setup({ maxConcurrent: 2, maxPerConnection: 2, engine });
    const second = await setup({ maxConcurrent: 2, maxPerConnection: 2, engine });
    expect((await first.run({ command: 'printf one' })).result.outcome).toBe('succeeded');
    expect((await second.run({ command: 'printf two' })).result.outcome).toBe('succeeded');

    // The first connection has one of its two, so only the ceiling can refuse it.
    const again = await first.action({ command: 'printf three' }, await first.scope.attempt());
    const refused = await first.connector.execute(again, first.context(again));
    if (refused.outcome !== 'failed') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toContain('this installation already has');
    expect(refused.retryable).toBe(true);
    expect(first.provider.calls.create).toBe(1);
  }, 60_000);
});
