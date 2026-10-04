/**
 * The agent's own terminal beside a paired computer. The engine is built from
 * the attempt bundle's tools (`attemptEngineFeatures`), and the plugin from the
 * broker's catalog. When the two disagree about `terminal.run`, the plugin
 * hands the terminal to an engine that never built one, and the model is left
 * with no terminal at all. A paired computer brings a dozen `device.*` tools
 * that sort ahead of it, so this is checked with one online. This is the
 * container deployment's path: the bundle the runner claims reaches the
 * engine launcher unchanged.
 *
 * The engine is also built only with what the agent answering may use: an
 * agent without the computer gets no terminal, and a narrowed agent only its
 * own connections' tools, as the broker's catalog serves them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { DEVICE_TOOLS } from '@melete/contracts';
import { attemptEngineFeatures, renderEngineConfig } from '@melete/runtime-hermes';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { sandboxExecManifest } from '../../src/connectors/sandbox-exec.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { deviceManifest, deviceToolName } from '../../src/devices/connector.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';
import { createScope } from './postgres.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 30_000);

/** Only the catalog is read here; nothing is dispatched. */
const listed = (manifest: Connector['manifest']): Connector => ({
  manifest,
  execute: () => Promise.reject(new Error('not dispatched in this test')),
  verify: () => Promise.reject(new Error('not dispatched in this test')),
  health: () => Promise.reject(new Error('not checked in this test')),
});

const COMPUTER = /^(?:browser|computer|terminal|exec|device)\./;

type AgentSettings = { usesComputer?: boolean; narrowedToDevice?: boolean };

/** A space with the agent's sandbox, optionally a paired computer, and one claimed attempt. */
async function attempt(paired: boolean, agent?: AgentSettings) {
  if (!handle || !queue) throw new Error('Postgres unavailable');
  const scope = await createScope({ ...handle, boss: queue.boss });
  const sandboxId = newId('conn');
  const sandboxScopes = sandboxExecManifest.tools.map((tool) => tool.name);
  await handle.sql`insert into connection (id, space_id, provider, label, scopes, status)
    values (${sandboxId}, ${scope.spaceId}, 'sandbox', 'Sandbox',
      ${JSON.stringify(sandboxScopes)}::jsonb, 'active')`;
  const registry = new ConnectorRegistry().register(sandboxId, listed(sandboxExecManifest));
  // A companion that allows files and pages but no commands: everything but device.run.
  const deviceScopes = DEVICE_TOOLS.filter((tool) => tool !== 'run').map(deviceToolName);
  const deviceId = newId('conn');
  if (paired) {
    await handle.sql`insert into connection (id, space_id, provider, label, scopes, status)
      values (${deviceId}, ${scope.spaceId}, 'device', 'fake laptop',
        ${JSON.stringify(deviceScopes)}::jsonb, 'active')`;
    registry.register(deviceId, listed(deviceManifest('fake laptop')));
  }
  const jobs = new JobService(handle.db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'paired-device-terminal-key-32-chars-long',
    scopes: [...sandboxScopes, ...deviceScopes],
    loadCatalog: new RuntimeCatalog(handle.db, registry).forAttempt,
  });
  const job = await jobs.create({
    space_id: scope.spaceId,
    title: 'Terminal',
    objective: 'run in your terminal: sleep 50 && echo done-long',
  });
  if (agent) {
    const agentId = newId('agent');
    const allowed = agent.narrowedToDevice ? JSON.stringify([deviceId]) : null;
    await handle.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour,
        tone, standing_instruction, uses_computer, allowed_connection_ids)
      values (${agentId}, ${scope.spaceId}, 'Atlas', 'Travel', '#336699', 'rounded', '#111111', 'warm',
        '', ${agent.usesComputer !== false}, ${allowed}::jsonb)`;
    await handle.sql`update job set agent_id = ${agentId} where id = ${job.id}`;
  }
  const claim = await runner.claim({
    job_id: job.id,
    expected_epoch: job.leaseEpoch,
    expected_version: job.stateVersion,
    reason: 'created',
  });
  if (!claim) throw new Error('No claimed attempt');
  const broker = new BrokerService({ sql: handle.sql, connectors: registry });
  const served = (await broker.catalog(claim.claims)).map((tool) => tool.name);
  return { claim, served, deviceId };
}

const withDb = handle && queue ? describe : describe.skip;

withDb("the agent's own terminal", () => {
  for (const paired of [true, false]) {
    test(`the engine keeps its terminal ${paired ? 'with' : 'without'} a paired computer online`, async () => {
      const { claim, served } = await attempt(paired);
      // What the engine is built with: its own terminal, pinned to the sandbox.
      const features = attemptEngineFeatures(claim.bundle.tools);
      expect(features).toEqual({
        toolsets: ['melete', 'todo', 'terminal_tools'],
        terminalBackend: 'melete_sandbox',
      });
      const config = renderEngineConfig({
        provider: 'fake',
        model: 'scripted',
        brokerUrl: 'http://broker.invalid',
        features,
      }) as { platform_toolsets: { api_server: string[] }; terminal?: { backend: string } };
      expect(config.platform_toolsets.api_server).toContain('terminal_tools');
      expect(config.terminal?.backend).toBe('melete_sandbox');
      // What the plugin is served: the same terminal, which it hands to the engine.
      expect(served).toContain('terminal.run');
      if (paired) expect(served).toContain('device.status');
    }, 20_000);
  }
});

withDb('the engine is built for the agent answering', () => {
  test('an agent that does not use the computer gets no terminal and no computer tools', async () => {
    const { claim, served } = await attempt(true, { usesComputer: false });
    expect(attemptEngineFeatures(claim.bundle.tools)).toEqual({});
    expect(claim.bundle.tools.filter((tool) => COMPUTER.test(tool.name))).toEqual([]);
    // The broker serves the same: nothing it would then refuse.
    expect(served.filter((name) => COMPUTER.test(name))).toEqual([]);
  }, 20_000);

  test("an agent narrowed to some connections gets only those connections' tools", async () => {
    const { claim, served, deviceId } = await attempt(true, { narrowedToDevice: true });
    const connected = claim.bundle.tools.filter((tool) => tool.connection_id !== null);
    expect(connected.length).toBeGreaterThan(0);
    expect(connected.every((tool) => tool.connection_id === deviceId)).toBe(true);
    // The sandbox is not this agent's, so neither is its terminal.
    expect(attemptEngineFeatures(claim.bundle.tools)).toEqual({});
    expect(served).not.toContain('terminal.run');
  }, 20_000);

  test('an agent that may use everything keeps the terminal beside a paired computer', async () => {
    const { claim } = await attempt(true, {});
    expect(attemptEngineFeatures(claim.bundle.tools)).toEqual({
      toolsets: ['melete', 'todo', 'terminal_tools'],
      terminalBackend: 'melete_sandbox',
    });
  }, 20_000);
});
