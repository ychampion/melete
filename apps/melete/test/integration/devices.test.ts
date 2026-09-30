/**
 * Connecting a person's own computer, end to end against a real database: the
 * Settings routes make a one-time code, the companion from packages/device
 * pairs with it over HTTP and holds its long poll, and the broker sends it
 * work through the device connector. The companion's tools run for real on a
 * temporary folder; nothing listens on the "computer".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityClaims } from '@melete/contracts';
import {
  ApiError,
  type Capabilities,
  DeviceAgent,
  pair,
} from '../../../../packages/device/src/index.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { sharedDeviceHub } from '../../src/devices/hub.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const MASTER_KEY = '71'.repeat(32);
const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const registry = new ConnectorRegistry();
const root = await mkdtemp(join(tmpdir(), 'melete-devices-'));
const closers: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await registry.close();
  await queue?.stop();
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);

const ALL: Capabilities = { commands: true, files: true, open_url: true, screenshot: true };

async function harness() {
  if (!fixture || !queue) throw new Error('Postgres unavailable');
  const workRoot = join(root, 'work');
  await mkdir(workRoot, { recursive: true });
  useConnectorFactory(
    registry,
    new ConnectorFactory({
      sql: fixture.sql,
      workRoot,
      spacesRoot: join(root, 'spaces'),
      masterKey: MASTER_KEY,
    }),
  );
  const app = createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_MASTER_KEY: MASTER_KEY,
      MELETE_PUBLIC_URL: 'http://localhost:3000',
    }),
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs: new JobService(fixture.db, queue.boss),
    checkDatabase: async () => 'ok',
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  closers.push(() => server.stop(true));
  const address = `http://127.0.0.1:${server.port}`;
  const as = (cookie: string, method = 'GET', body?: unknown): RequestInit => ({
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await app.request(
    '/setup',
    as('', 'POST', { email: 'devices-owner@example.test', password: 'devices-owner-password' }),
  );
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Setup failed: ${setup.status}`);
  const [space] = await fixture.sql`select id from space where kind = 'personal'`;
  if (!space) throw new Error('Missing personal space');

  /** A code from Settings, as the person would copy it. */
  const code = async (capabilities: Partial<Capabilities> = {}) => {
    const response = await app.request(
      '/devices/pairings',
      as(cookie, 'POST', {
        capabilities: {
          commands: false,
          files: true,
          open_url: true,
          screenshot: false,
          ...capabilities,
        },
      }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { code: string; expires_at: string };
  };

  /** A computer with one shared folder, paired through the companion's own code path. */
  const computer = async (
    options: { grant?: Partial<Capabilities>; local?: Capabilities } = {},
  ) => {
    const home = await mkdtemp(join(root, 'computer-'));
    const shared = join(home, 'Shared');
    await mkdir(join(shared, 'notes'), { recursive: true });
    await writeFile(join(shared, 'notes', 'todo.md'), 'buy milk\n');
    const configDir = join(home, 'config');
    const { code: pairing } = await code(options.grant);
    const config = await pair(
      {
        address,
        code: pairing,
        name: 'Test laptop',
        capabilities: options.local ?? ALL,
        folders: [{ name: 'Shared', path: shared }],
      },
      { configDir },
    );
    const log: string[] = [];
    const agent = new DeviceAgent(config, { configDir, print: (line) => log.push(line) });
    return { config, configDir, shared, agent, log };
  };

  /** A running job in the personal space whose attempt may use the given tools. */
  const job = async (scopes: string[]): Promise<CapabilityClaims> => {
    const jobId = recordId('job');
    const attemptId = recordId('att');
    await fixture.sql`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
      values (${jobId}, ${space.id}, 'Device work', 'Use the laptop', 'running', 1,
        ${JSON.stringify({ max_actions: 20, max_attempts: 3, max_output_tokens: 10_000, max_turns: 10, max_wall_ms: 60_000, max_usd_est: 2 })}::jsonb,
        ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb)`;
    // The attempt starts under the space's current policy, as a real one does.
    await fixture.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, policy_generation)
      select ${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted', policy_generation
      from space where id = ${space.id}`;
    return {
      job_id: jobId,
      attempt_id: attemptId,
      space_id: space.id as string,
      epoch: 1,
      revision: 0,
      scopes,
      budget: { max_actions: 20, max_output_tokens: 10_000, max_usd_est: 2 },
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  };

  const broker = new BrokerService({ sql: fixture.sql, connectors: registry });
  return { app, as, cookie, address, code, computer, job, broker, sql: fixture.sql };
}

const h = fixture ? await harness() : null;
const withDb = fixture ? describe : describe.skip;
const need = () => {
  if (!h) throw new Error('Postgres unavailable');
  return h;
};

const detailOf = (action: { receipt?: { detail?: unknown } | null }) =>
  (action.receipt?.detail ?? {}) as Record<string, unknown>;

/** Run the companion for the length of `work`. */
async function connected<T>(agent: DeviceAgent, work: () => Promise<T>): Promise<T> {
  const running = agent.run();
  await Bun.sleep(300);
  try {
    return await work();
  } finally {
    agent.stop();
    await running;
  }
}

withDb('pairing codes', () => {
  test('a code pairs one computer, once', async () => {
    const s = need();
    const { code } = await s.code();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const input = {
      address: s.address,
      // Typed loosely: any case, no dash.
      code: code.toLowerCase().replace('-', ''),
      name: 'First',
      capabilities: ALL,
      folders: [],
    };
    const first = await pair(input, { configDir: await mkdtemp(join(root, 'once-')) });
    expect(first.token).toMatch(/^mdt_/);
    expect(first.api).toBe(s.address);
    const again = await rejectionOf(
      pair({ ...input, name: 'Second' }, { configDir: await mkdtemp(join(root, 'twice-')) }),
    );
    expect(again).toBeInstanceOf(ApiError);
    expect((again as ApiError).status).toBe(400);
    const rows = await s.sql`select name from paired_device where name in ('First', 'Second')`;
    expect(rows.map((row) => row.name)).toEqual(['First']);
    // Only hashes are stored.
    const [kept] =
      await s.sql`select code_hash from device_pairing where device_id = ${first.device_id}`;
    expect(kept?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const [device] =
      await s.sql`select token_hash from paired_device where id = ${first.device_id}`;
    expect(device?.token_hash).not.toContain(first.token);
  });

  test('a code expires after ten minutes', async () => {
    const s = need();
    const { code, expires_at } = await s.code();
    const lifetime = Date.parse(expires_at) - Date.now();
    expect(lifetime).toBeGreaterThan(9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000);
    await s.sql`update device_pairing set expires_at = now() - interval '1 second'
      where used_at is null`;
    const refused = await s.app.request('/device/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        name: 'Late',
        platform: 'linux',
        companion_version: 'test',
        capabilities: ALL,
        folders: [],
      }),
    });
    expect(refused.status).toBe(400);
    expect(await s.sql`select id from paired_device where name = 'Late'`).toHaveLength(0);
  });

  test('only a signed-in owner makes codes', async () => {
    const s = need();
    const anonymous = await s.app.request('/devices/pairings', s.as('', 'POST', {}));
    expect(anonymous.status).toBe(401);
  });
});

withDb('the device token', () => {
  test('is required on every companion route, and revoking stops it at once', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    const hello = (token: string) =>
      s.app.request('/device/hello', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ companion_version: 'test', capabilities: ALL, folders: [] }),
      });
    expect((await hello(`mdt_${'A'.repeat(43)}`)).status).toBe(401);
    expect((await s.app.request('/device/requests')).status).toBe(401);
    expect((await hello(config.token)).status).toBe(200);

    const running = agent.run();
    await Bun.sleep(300);
    const listed = (await (await s.app.request('/devices', s.as(s.cookie))).json()) as {
      devices: { id: string; status: string }[];
    };
    expect(listed.devices.find((device) => device.id === config.device_id)?.status).toBe('online');

    const revoked = await s.app.request(
      `/devices/${config.device_id}/revoke`,
      s.as(s.cookie, 'POST'),
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { device: { status: string } }).device.status).toBe(
      'revoked',
    );
    // The companion's open poll ends; its next call is refused and it stops by itself.
    expect(await running).toBe('revoked');
    expect(log.some((line) => line.includes('no longer accepts'))).toBe(true);
    expect((await hello(config.token)).status).toBe(401);
    const [connection] = await s.sql`select c.status from connection c
      join paired_device d on d.connection_id = c.id where d.id = ${config.device_id}`;
    expect(connection?.status).toBe('revoked');
    expect(
      registry.get(
        String(
          (await s.sql`select connection_id from paired_device where id = ${config.device_id}`)[0]
            ?.connection_id,
        ),
      ),
    ).toBeUndefined();
  }, 30_000);
});

withDb('the agent uses the computer through the broker', () => {
  const tools = [
    'device.status',
    'device.list_files',
    'device.read_file',
    'device.write_file',
    'device.run',
  ];
  const connectionOf = async (deviceId: string) =>
    String(
      (await need().sql`select connection_id from paired_device where id = ${deviceId}`)[0]
        ?.connection_id,
    );

  test('a command waits for approval, then runs on the computer with a receipt', async () => {
    const s = need();
    const { config, agent, log } = await s.computer({ grant: { commands: true } });
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(tools);
    await connected(agent, async () => {
      const listing = await s.broker.propose(claims, {
        kind: 'device.list_files',
        connection_id: connectionId,
        payload: { path: 'Shared/notes' },
      });
      // Reading needs no approval.
      expect(listing.status).toBe('succeeded');
      const listed = await s.broker.get(claims, listing.action_id);
      expect(detailOf(listed).entries).toEqual([{ name: 'todo.md', kind: 'file', size: 9 }]);

      const proposal = await s.broker.propose(claims, {
        kind: 'device.run',
        connection_id: connectionId,
        payload: { command: 'echo hello', cwd: 'Shared' },
      });
      expect(proposal.status).toBe('needs_approval');
      // Nothing reached the computer before the person said yes.
      expect(log.some((line) => line.includes('→ run'))).toBe(false);
      await s.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      await s.broker.admit(claims, proposal.action_id, proposal.payload_hash);
      const done = await s.broker.dispatch(proposal.action_id);
      expect(done.status).toBe('succeeded');
      expect(String(detailOf(done).stdout).trim()).toBe('hello');
      expect(detailOf(done).exit_code).toBe(0);
      expect(detailOf(done).device).toBe('Test laptop');
      expect(log.some((line) => line.includes('→ run echo hello'))).toBe(true);

      const write = await s.broker.propose(claims, {
        kind: 'device.write_file',
        connection_id: connectionId,
        payload: { path: 'Shared/out/result.txt', content: 'written' },
      });
      expect(write.status).toBe('needs_approval');
    });
  }, 60_000);

  test('paths outside the shared folders are refused before anything is sent', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(tools);
    await connected(agent, async () => {
      for (const path of ['Shared/../..', '/etc/passwd', 'C:/Windows', 'Other/x', 'Shared\\..']) {
        const proposal = await s.broker.propose(claims, {
          kind: 'device.read_file',
          connection_id: connectionId,
          payload: { path },
        });
        expect([path, proposal.status]).toEqual([path, 'failed']);
      }
    });
    expect(log.some((line) => line.includes('→ read_file'))).toBe(false);
  }, 60_000);

  test('a capability turned off on either side is not offered and not run', async () => {
    const s = need();
    // Commands are off in Settings (the default).
    const settingsOff = await s.computer();
    const claims = await s.job(tools);
    expect(
      await rejectionOf(
        s.broker.propose(claims, {
          kind: 'device.run',
          connection_id: await connectionOf(settingsOff.config.device_id),
          payload: { command: 'echo no' },
        }),
      ),
    ).toMatchObject({ code: 'scope_denied' });

    // Commands are on in Settings but off on the computer itself.
    const localOff = await s.computer({
      grant: { commands: true },
      local: { ...ALL, commands: false },
    });
    const connectionId = await connectionOf(localOff.config.device_id);
    const [row] = await s.sql`select scopes from connection where id = ${connectionId}`;
    expect(row?.scopes).not.toContain('device.run');
    expect(row?.scopes).toContain('device.list_files');

    // Turning it on in Settings later changes the grant, never the computer's own choice.
    const changed = await s.app.request(
      `/devices/${localOff.config.device_id}`,
      s.as(s.cookie, 'PATCH', { capabilities: { screenshot: true } }),
    );
    expect(changed.status).toBe(200);
    const [after] = await s.sql`select scopes from connection where id = ${connectionId}`;
    expect(after?.scopes).toContain('device.screenshot');
    expect(after?.scopes).not.toContain('device.run');
  }, 60_000);

  test('an offline computer is told nothing, and the action says so', async () => {
    const s = need();
    const { config } = await s.computer();
    sharedDeviceHub.disconnect(config.device_id);
    const claims = await s.job(tools);
    const proposal = await s.broker.propose(claims, {
      kind: 'device.list_files',
      connection_id: await connectionOf(config.device_id),
      payload: { path: 'Shared' },
    });
    expect(proposal.status).toBe('failed');
  }, 30_000);
});
