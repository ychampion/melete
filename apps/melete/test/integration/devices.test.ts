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
import {
  type CapabilityClaims,
  DEVICE_LIMITS,
  type DeviceView,
  type RuntimeAdapter,
} from '@melete/contracts';
import { attemptEngineFeatures } from '@melete/runtime-hermes';
import { BrowserBridge } from '../../../../packages/device/src/browser.ts';
import {
  type AgentOptions,
  ApiError,
  type Capabilities,
  DeviceAgent,
  pair,
} from '../../../../packages/device/src/index.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorFactory, useConnectorFactory } from '../../src/connectors/configured.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { sandboxExecManifest } from '../../src/connectors/sandbox-exec.ts';
import { sharedDeviceHub } from '../../src/devices/hub.ts';
import { PUBLIC_ONLY_NOTE, routedDescription, SIGNED_IN_NOTE } from '../../src/devices/routing.ts';
import { loadEnv } from '../../src/env.ts';
import { projectPermission } from '../../src/experience/projectors.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { RuntimeCatalog } from '../../src/knowledge/catalog.ts';
import { PostgresPrivacyStore } from '../../src/privacy/store.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
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

const ALL: Capabilities = {
  commands: true,
  files: true,
  open_url: true,
  screenshot: true,
  browser: true,
};

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
  const jobs = new JobService(fixture.db, queue.boss);
  const app = createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_MASTER_KEY: MASTER_KEY,
      MELETE_PUBLIC_URL: 'http://localhost:3000',
    }),
    db: fixture.db,
    sql: fixture.sql,
    registry,
    jobs,
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
    options: {
      grant?: Partial<Capabilities>;
      local?: Capabilities;
      tools?: AgentOptions['tools'];
    } = {},
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
    const agent = new DeviceAgent(config, {
      configDir,
      print: (line) => log.push(line),
      ...(options.tools ? { tools: options.tools } : {}),
    });
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
  return {
    app,
    as,
    cookie,
    address,
    code,
    computer,
    job,
    broker,
    jobs,
    sql: fixture.sql,
    workRoot,
    db: fixture.db,
  };
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

  test('a command too long to show whole is refused before anyone is asked', async () => {
    const s = need();
    const { config } = await s.computer({ grant: { commands: true } });
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(tools);
    // What the person would see, then what would run after it, out of sight.
    const shown = 'echo tidy up #';
    const hidden = '; echo not shown';
    const command = `${shown}${' '.repeat(DEVICE_LIMITS.max_command_chars - shown.length)}${hidden}`;
    expect(
      await rejectionOf(
        s.broker.propose(claims, {
          kind: 'device.run',
          connection_id: connectionId,
          payload: { command, cwd: 'Shared' },
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    expect(
      await s.sql`select a.id from approval a join action x on x.id = a.action_id
        where x.job_id = ${claims.job_id}`,
    ).toHaveLength(0);
    // At the limit, it is asked for, and the card carries every character.
    const longest = `echo ${'x'.repeat(DEVICE_LIMITS.max_command_chars - 5)}`;
    const proposal = await s.broker.propose(claims, {
      kind: 'device.run',
      connection_id: connectionId,
      payload: { command: longest, cwd: 'Shared' },
    });
    expect(proposal.status).toBe('needs_approval');
    const card = projectPermission({
      id: 'apr_long',
      version: 'v1',
      action: {
        id: proposal.action_id,
        jobId: claims.job_id,
        attemptId: claims.attempt_id,
        kind: 'device.run',
        effectClass: 'write_external',
        connectionId,
        canonicalPayload: { command: longest, cwd: 'Shared' },
        receipt: null,
        status: 'needs_approval',
        createdAt: new Date(),
        resolvedAt: null,
      },
      connection: { id: connectionId, label: 'Test laptop', provider: 'device' },
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date(),
    });
    expect(card.preview?.facts.find((fact) => fact.label === 'Command')?.value).toBe(longest);
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
    expect(((await changed.json()) as { device: DeviceView }).device.cloud_screenshots).toBeNull();

    // Whose screen a screenshot shows is read from the job's own succeeded
    // screenshot action and the computer behind its connection, never from
    // the picture; letting cloud models see it is that computer's own answer.
    const store = new PostgresPrivacyStore(s.sql);
    const deviceId = localOff.config.device_id;
    const screenshot = async (job: typeof claims, kind: string, status: string) => {
      const id = recordId('act');
      await s.sql`insert into action (id, job_id, attempt_id, connection_id, kind,
        effect_class, canonical_payload, payload_hash, idempotency_key, status)
        values (${id}, ${job.job_id}, ${job.attempt_id}, ${connectionId}, ${kind}, 'read',
          '{}'::jsonb, ${'d'.repeat(64)}, ${id}, ${status})`;
      return id;
    };
    const shot = await screenshot(claims, 'device.screenshot', 'succeeded');
    expect(await store.screenshotSource(claims.job_id, shot)).toEqual({
      kind: 'device',
      deviceId,
      cloudScreenshots: null,
    });
    const shown = await s.app.request(
      `/devices/${deviceId}`,
      s.as(s.cookie, 'PATCH', { cloud_screenshots: true }),
    );
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { device: DeviceView }).device.cloud_screenshots).toBe(true);
    expect(await store.screenshotSource(claims.job_id, shot)).toEqual({
      kind: 'device',
      deviceId,
      cloudScreenshots: true,
    });
    // Its grants are untouched by it.
    const [kept] = await s.sql`select scopes from connection where id = ${connectionId}`;
    expect(kept?.scopes).toContain('device.screenshot');
    // Another job's screenshot, an action that is not a screenshot, or one that
    // did not succeed names nothing.
    const otherJob = await s.job(tools);
    expect(await store.screenshotSource(otherJob.job_id, shot)).toBeNull();
    const listing = await screenshot(claims, 'device.list_files', 'succeeded');
    expect(await store.screenshotSource(claims.job_id, listing)).toBeNull();
    const failed = await screenshot(claims, 'device.browser_screenshot', 'failed');
    expect(await store.screenshotSource(claims.job_id, failed)).toBeNull();
    expect(await store.screenshotSource(claims.job_id, recordId('act'))).toBeNull();
  }, 60_000);

  test("a screenshot's picture is handed to its own job's runtime by the broker, from the service's copy", async () => {
    const s = need();
    const { config } = await s.computer({ grant: { screenshot: true } });
    const connectionId = await connectionOf(config.device_id);
    const shots = [...tools, 'device.screenshot'];
    const claims = await s.job(shots);
    const broker = new BrokerService({ sql: s.sql, connectors: registry, workRoot: s.workRoot });
    // Saved the way the device connector saves it: readable by the service's
    // own user only, which the runtime (another user) cannot open itself.
    const picture = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('a picture'),
    ]);
    const saved = async (
      job: typeof claims,
      kind: string,
      status: string,
      path: string,
      bytes: Buffer = picture,
    ): Promise<string> => {
      const id = recordId('act');
      await mkdir(join(s.workRoot, job.job_id, 'device'), { recursive: true });
      await writeFile(join(s.workRoot, job.job_id, 'device', `screenshot-${id}.png`), bytes, {
        mode: 0o600,
      });
      const receipt = {
        action_id: id,
        connection_id: connectionId,
        external_ref: null,
        detail: { path: path.replace('{id}', id) },
        received_at: new Date().toISOString(),
        late: false,
      };
      await s.sql`insert into action (id, job_id, attempt_id, connection_id, kind,
        effect_class, canonical_payload, payload_hash, idempotency_key, status, receipt)
        values (${id}, ${job.job_id}, ${job.attempt_id}, ${connectionId}, ${kind}, 'read',
          '{}'::jsonb, ${'d'.repeat(64)}, ${id}, ${status}, ${JSON.stringify(receipt)}::jsonb)`;
      return id;
    };
    const shot = await saved(
      claims,
      'device.screenshot',
      'succeeded',
      'device/screenshot-{id}.png',
    );
    expect(await broker.screenshot(claims, shot)).toEqual({
      media_type: 'image/png',
      data: picture.toString('base64'),
    });
    // Another job, a tool that is not a screenshot, one that did not succeed,
    // or a receipt naming a path outside the job's workspace gets nothing.
    const otherJob = await s.job(shots);
    for (const [job, id] of [
      [otherJob, shot],
      [claims, await saved(claims, 'device.read_file', 'succeeded', 'device/screenshot-{id}.png')],
      [claims, await saved(claims, 'device.screenshot', 'failed', 'device/screenshot-{id}.png')],
      [claims, await saved(claims, 'device.screenshot', 'succeeded', '../escape.png')],
      // A file at the receipt's path that is not a PNG is not served as one.
      [
        claims,
        await saved(
          claims,
          'device.screenshot',
          'succeeded',
          'device/screenshot-{id}.png',
          Buffer.from('<html>not a picture</html>'),
        ),
      ],
    ] as const)
      expect(await rejectionOf(broker.screenshot(job, id))).toMatchObject({
        code: 'action_not_found',
      });
  }, 60_000);

  test('work for an offline computer waits, and goes when it connects again', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    sharedDeviceHub.disconnect(config.device_id, false);
    const claims = await s.job(tools);
    const proposal = await s.broker.propose(claims, {
      kind: 'device.list_files',
      connection_id: await connectionOf(config.device_id),
      payload: { path: 'Shared/notes' },
    });
    // Nothing was sent; the action waits for the computer and the job waits with it.
    expect(proposal.status).toBe('admitted');
    const [parked] = await s.sql`select status, retry_after_at, repair_trace from action
      where id = ${proposal.action_id}`;
    expect(parked?.retry_after_at).not.toBeNull();
    expect(parked?.repair_trace.at(-1)?.decision).toBe('park_until_reconnect');
    const [waiting] = await s.sql`select state from job where id = ${claims.job_id}`;
    expect(waiting?.state).toBe('waiting_for_event_or_time');
    expect(log.some((line) => line.includes('→ list_files'))).toBe(false);

    await connected(agent, async () => {
      // Connecting made the action due now and woke the job.
      const [due] = await s.sql`select retry_after_at <= now() as due from action
        where id = ${proposal.action_id}`;
      expect(due?.due).toBe(true);
      const [woken] = await s.sql`select next_wake_at <= now() as due from job
        where id = ${claims.job_id}`;
      expect(woken?.due).toBe(true);
      // The broker's sweep carries it out.
      expect(await s.broker.resumeParked()).toBe(1);
      const [done] =
        await s.sql`select status, receipt from action where id = ${proposal.action_id}`;
      expect(done?.status).toBe('succeeded');
      expect(done?.receipt.detail.entries).toEqual([{ name: 'todo.md', kind: 'file', size: 9 }]);
    });
  }, 60_000);

  test('stopping the conversation cancels what waited for the computer', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    sharedDeviceHub.disconnect(config.device_id, false);
    const claims = await s.job(tools);
    const proposal = await s.broker.propose(claims, {
      kind: 'device.list_files',
      connection_id: await connectionOf(config.device_id),
      payload: { path: 'Shared' },
    });
    expect(proposal.status).toBe('admitted');
    await s.jobs.cancel(claims.job_id, 'stopped by the person');
    await connected(agent, async () => {
      await s.broker.resumeParked();
      await Bun.sleep(300);
    });
    expect(log.some((line) => line.includes('→ list_files'))).toBe(false);
    const [row] = await s.sql`select status from action where id = ${proposal.action_id}`;
    expect(row?.status).not.toBe('succeeded');
  }, 60_000);
});

withDb("the person's own browser", () => {
  test('sign-in work goes to their browser, waits for it, and a click names what it clicks', async () => {
    const s = need();
    const { config } = await s.computer({ grant: { browser: true } });
    const [row] =
      await s.sql`select connection_id from paired_device where id = ${config.device_id}`;
    const connectionId = String(row?.connection_id);
    const claims = await s.job([
      'device.browser_open',
      'device.browser_read',
      'device.browser_click',
    ]);

    // The routing rule is in the tools the agent is offered.
    const offered = await s.broker.discovery.available(claims);
    const open = offered.find((tool) => tool.name === 'device.browser_open');
    expect(open?.description).toContain(SIGNED_IN_NOTE.trim());

    // The browser is not connected yet: the step waits for it.
    const proposal = await s.broker.propose(claims, {
      kind: 'device.browser_open',
      connection_id: connectionId,
      payload: { url: 'https://example.com/account' },
    });
    expect(proposal.status).toBe('admitted');

    const opened: unknown[] = [];
    const sentToBrowser: { tool: string; arguments: Record<string, unknown> }[] = [];
    // What the page shows now; the stand-in extension checks it as the real one does.
    let buttonNow = 'Delete account';
    const tab = { tab_id: 41, url: 'https://example.com/account', title: 'Your account' };
    const answerFor = (tool: string, args: Record<string, unknown>) => {
      if (tool === 'browser_open') return { ok: true, result: tab };
      if (tool === 'browser_read')
        return {
          ok: true,
          result: {
            ...tab,
            url: 'https://example.com/account?session=secret-token',
            text: 'Your account',
            truncated: false,
            elements: [
              { ref: 'e1', role: 'link', name: 'Home', tag: 'a', target: 'https://example.com/' },
              { ref: 'e3', role: 'button', name: buttonNow, tag: 'button' },
            ],
          },
        };
      const expected = args.expect as { url: string; element: { name: string } } | undefined;
      if (expected?.url !== 'https://example.com/account' || expected.element.name !== buttonNow)
        return {
          ok: false,
          error: {
            code: 'page_changed',
            message: `That element is now button "${buttonNow}", not button "${expected?.element.name}" as approved. Nothing was done; read the page again.`,
          },
        };
      return { ok: true, result: tab };
    };
    const bridge: BrowserBridge = new BrowserBridge({
      config: { ...config, capabilities: { ...config.capabilities, browser: true } },
      resolve: async () => ['93.184.215.14'],
      send: (message) => {
        const value = message as {
          type: string;
          id?: string;
          tool?: string;
          arguments?: Record<string, unknown>;
        };
        if (value.type !== 'request') return;
        if (value.tool === 'browser_open') opened.push(value.arguments);
        sentToBrowser.push({ tool: String(value.tool), arguments: value.arguments ?? {} });
        queueMicrotask(() =>
          bridge.receive({
            type: 'answer',
            id: value.id,
            answer: answerFor(String(value.tool), value.arguments ?? {}),
          }),
        );
      },
    });
    const running = bridge.run();
    try {
      for (let tries = 0; tries < 50; tries++) {
        const [due] = await s.sql`select retry_after_at <= now() as due from action
          where id = ${proposal.action_id}`;
        if (due?.due) break;
        await Bun.sleep(100);
      }
      expect(await s.broker.resumeParked()).toBe(1);
      const [done] =
        await s.sql`select status, receipt from action where id = ${proposal.action_id}`;
      expect(done?.status).toBe('succeeded');
      expect(done?.receipt.detail).toMatchObject({ tab_id: 41, title: 'Your account' });
      expect(opened).toEqual([{ url: 'https://example.com/account' }]);

      // Parking released that attempt; the next step comes from a later one.
      const later = await s.job(['device.browser_read', 'device.browser_click']);
      const click = (ref: string, extra: Record<string, unknown> = {}) =>
        s.broker.propose(later, {
          kind: 'device.browser_click',
          connection_id: connectionId,
          payload: { tab_id: 41, ref, ...extra },
        });
      // Nothing is clicked on a ref the person could not be shown.
      expect(await rejectionOf(click('e3'))).toMatchObject({ code: 'payload_invalid' });

      const read = await s.broker.propose(later, {
        kind: 'device.browser_read',
        connection_id: connectionId,
        payload: { tab_id: 41 },
      });
      expect(read.status).toBe('succeeded');
      expect(await rejectionOf(click('e9'))).toMatchObject({ code: 'payload_invalid' });

      // Whatever the model claims the element is, the card shows what the read saw.
      const asked = await click('e3', {
        expect: { url: 'https://example.com/account', element: { role: 'button', name: 'Save' } },
      });
      expect(asked.status).toBe('needs_approval');
      const [stored] = await s.sql`select * from action where id = ${asked.action_id}`;
      const card = projectPermission({
        id: 'apr_click',
        version: 'v1',
        action: {
          id: asked.action_id,
          jobId: later.job_id,
          attemptId: later.attempt_id,
          kind: 'device.browser_click',
          effectClass: 'write_external',
          connectionId,
          canonicalPayload: stored?.canonical_payload,
          receipt: null,
          status: 'needs_approval',
          createdAt: new Date(),
          resolvedAt: null,
        },
        connection: { id: connectionId, label: 'Test laptop', provider: 'device' },
        reasons: ['This change needs your permission before it happens.'],
        canAlways: false,
        requestedAt: new Date(),
      });
      // The address leaves out the query, which held a session token.
      expect(card.preview?.facts).toEqual([
        { label: 'Page', value: 'https://example.com/account' },
        { label: 'Title', value: 'Your account' },
        { label: 'Element', value: 'button "Delete account"' },
      ]);

      // Approved; then the page changes before the click goes.
      await s.broker.decide(asked.action_id, {
        decision: 'approved',
        payload_hash: asked.payload_hash,
      });
      await s.broker.admit(later, asked.action_id, asked.payload_hash);
      buttonNow = 'Save';
      const refused = await s.broker.dispatch(asked.action_id);
      expect(refused.status).toBe('failed');
      expect(JSON.stringify(refused.reconciliation)).toContain('Nothing was done');
      const sentClick = sentToBrowser.find((entry) => entry.tool === 'browser_click');
      expect(sentClick?.arguments.expect).toEqual({
        url: 'https://example.com/account',
        title: 'Your account',
        element: { role: 'button', name: 'Delete account', tag: 'button' },
      });
    } finally {
      bridge.stop();
      await running;
    }
  }, 60_000);

  test('a page on their network opens in their browser only once approved', async () => {
    const s = need();
    const { config } = await s.computer({ grant: { browser: true } });
    const [row] =
      await s.sql`select connection_id from paired_device where id = ${config.device_id}`;
    const claims = await s.job(['device.browser_open']);
    const proposal = await s.broker.propose(claims, {
      kind: 'device.browser_open',
      connection_id: String(row?.connection_id),
      payload: { url: 'http://192.168.1.1/admin' },
    });
    expect(proposal.status).toBe('needs_approval');
  }, 30_000);

  test("the cloud browser is kept for public pages once the person's browser is there", () => {
    expect(routedDescription('browser.open', 'Open a page.', true)).toBe(
      `Open a page.${PUBLIC_ONLY_NOTE}`,
    );
    expect(routedDescription('browser.open', 'Open a page.', false)).toBe('Open a page.');
    expect(routedDescription('device.browser_open', 'Open.', true)).toBe(`Open.${SIGNED_IN_NOTE}`);
    expect(routedDescription('email.send', 'Send.', true)).toBe('Send.');
  });
});

withDb('what waited for the computer, when the person stops or time runs out', () => {
  const connectionOf = async (deviceId: string) =>
    String(
      (await need().sql`select connection_id from paired_device where id = ${deviceId}`)[0]
        ?.connection_id,
    );

  /** A conversation with an agent and a turn under way, as the chat makes one. */
  const conversation = async (scopes: string[]) => {
    const s = need();
    const claims = await s.job(scopes);
    const agentId = recordId('agt');
    await s.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
        standing_instruction, asks_before_acting)
      values (${agentId}, ${claims.space_id}, 'Helper', 'helper', 'blue', 'plain', 'dark', 'plain',
        '', false)`;
    const turnId = recordId('turn');
    await s.sql`update job set kind = 'chat', agent_id = ${agentId} where id = ${claims.job_id}`;
    await s.sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
      values (${turnId}, ${claims.job_id}, ${agentId}, ${recordId('sub')}, 'tidy my notes', 'running')`;
    await s.sql`update job set current_turn_id = ${turnId} where id = ${claims.job_id}`;
    return claims;
  };

  test('Stop in the conversation cancels what waited for the computer', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    sharedDeviceHub.disconnect(config.device_id, false);
    const claims = await conversation(['device.list_files']);
    const proposal = await s.broker.propose(claims, {
      kind: 'device.list_files',
      connection_id: await connectionOf(config.device_id),
      payload: { path: 'Shared' },
    });
    expect(proposal.status).toBe('admitted');
    // What the Stop button does: the conversation waits for the person again.
    const runner = new AttemptRunner(s.jobs, {} as RuntimeAdapter, { key: 'k'.repeat(40) });
    await runner.stopConversation(claims.job_id);
    await connected(agent, async () => {
      await s.broker.resumeParked();
      await Bun.sleep(300);
    });
    expect(log.some((line) => line.includes('→ list_files'))).toBe(false);
    const [row] =
      await s.sql`select status, reconciliation from action where id = ${proposal.action_id}`;
    expect(row?.status).toBe('failed');
    expect(row?.reconciliation).toMatchObject({ reason: 'the conversation was stopped' });
  }, 60_000);

  test('an approval that runs out while the computer is off is not used', async () => {
    const s = need();
    const broker = new BrokerService({ sql: s.sql, connectors: registry, approvalTtlMs: 3_000 });
    const { config, agent, log } = await s.computer({ grant: { commands: true } });
    sharedDeviceHub.disconnect(config.device_id, false);
    const claims = await s.job(['device.run']);
    const proposal = await broker.propose(claims, {
      kind: 'device.run',
      connection_id: await connectionOf(config.device_id),
      payload: { command: 'echo late', cwd: 'Shared' },
    });
    expect(proposal.status).toBe('needs_approval');
    await broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await broker.admit(claims, proposal.action_id, proposal.payload_hash);
    expect((await broker.dispatch(proposal.action_id)).status).toBe('admitted');
    await Bun.sleep(3_500);
    await connected(agent, async () => {
      await broker.resumeParked();
      await Bun.sleep(300);
    });
    expect(log.some((line) => line.includes('→ run echo late'))).toBe(false);
    const [row] =
      await s.sql`select status, reconciliation from action where id = ${proposal.action_id}`;
    expect(row?.status).toBe('failed');
    expect(row?.reconciliation).toMatchObject({ reason: 'its approval expired while it waited' });
  }, 60_000);

  test('typed text too long to show whole is refused, and a submit is shown', async () => {
    const s = need();
    const { config } = await s.computer({ grant: { browser: true } });
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(['device.browser_type']);
    expect(
      await rejectionOf(
        s.broker.propose(claims, {
          kind: 'device.browser_type',
          connection_id: connectionId,
          payload: { tab_id: 4, ref: 'e2', text: 'x'.repeat(DEVICE_LIMITS.max_typed_chars + 1) },
        }),
      ),
    ).toMatchObject({ code: 'payload_invalid' });
    const card = projectPermission({
      id: 'apr_type',
      version: 'v1',
      action: {
        id: 'act_type',
        jobId: claims.job_id,
        attemptId: claims.attempt_id,
        kind: 'device.browser_type',
        effectClass: 'write_external',
        connectionId,
        canonicalPayload: { tab_id: 4, ref: 'e2', text: 'hello', submit: true },
        receipt: null,
        status: 'needs_approval',
        createdAt: new Date(),
        resolvedAt: null,
      },
      connection: { id: connectionId, label: 'Test laptop', provider: 'device' },
      reasons: ['This change needs your permission before it happens.'],
      canAlways: false,
      requestedAt: new Date(),
    });
    expect(card.preview?.facts).toContainEqual({ label: 'Then', value: 'Press Enter to submit' });
  }, 60_000);

  test('a page on the computer or its network waits for approval; a public one does not', async () => {
    const s = need();
    const opened: string[] = [];
    const { config, agent, log } = await s.computer({
      tools: {
        launch: async (_command, args) => {
          opened.push(String(args.at(-1)));
        },
        resolve: async (host) =>
          host === 'rebind.example'
            ? ['192.168.1.1']
            : host === 'example.com'
              ? ['93.184.215.14']
              : [],
      },
    });
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(['device.status', 'device.open_url']);
    await connected(agent, async () => {
      const local = await s.broker.propose(claims, {
        kind: 'device.open_url',
        connection_id: connectionId,
        payload: { url: 'http://127.0.0.1:8080/admin' },
      });
      expect(local.status).toBe('needs_approval');
      const open = await s.broker.propose(claims, {
        kind: 'device.open_url',
        connection_id: connectionId,
        payload: { url: 'https://example.com/' },
      });
      expect(open.status).toBe('succeeded');
      expect(opened).toEqual(['https://example.com/']);

      // A public-looking name that resolves to the local network on the computer.
      const rebound = await s.broker.propose(claims, {
        kind: 'device.open_url',
        connection_id: connectionId,
        payload: { url: 'https://rebind.example/' },
      });
      expect(rebound.status).toBe('failed');
      expect(opened).toEqual(['https://example.com/']);

      await s.broker.decide(local.action_id, {
        decision: 'approved',
        payload_hash: local.payload_hash,
      });
      await s.broker.admit(claims, local.action_id, local.payload_hash);
      expect((await s.broker.dispatch(local.action_id)).status).toBe('succeeded');
      expect(opened).toEqual(['https://example.com/', 'http://127.0.0.1:8080/admin']);
    });
    expect(log.some((line) => line.includes('local network'))).toBe(true);
  }, 60_000);

  test('turning a capability off withdraws what waits to be collected', async () => {
    const s = need();
    const { config, agent, log } = await s.computer();
    const connectionId = await connectionOf(config.device_id);
    const claims = await s.job(['device.status', 'device.list_files']);
    // Online, but between polls: the request waits in the queue.
    sharedDeviceHub.touch(config.device_id);
    const waiting = s.broker.propose(claims, {
      kind: 'device.list_files',
      connection_id: connectionId,
      payload: { path: 'Shared' },
    });
    // Handed to the hub: the action is on its way to the computer.
    for (let tries = 0; tries < 100; tries++) {
      const [row] = await s.sql`select status from action where job_id = ${claims.job_id}`;
      if (row?.status === 'dispatched') break;
      await Bun.sleep(50);
    }
    const changed = await s.app.request(
      `/devices/${config.device_id}`,
      s.as(s.cookie, 'PATCH', { capabilities: { files: false } }),
    );
    expect(changed.status).toBe(200);
    const proposal = await waiting;
    expect(proposal.status).toBe('failed');
    // Read as stored: the attempt may no longer look at a tool that was turned off.
    const [action] =
      await s.sql`select reconciliation from action where id = ${proposal.action_id}`;
    expect(JSON.stringify(action?.reconciliation)).toContain('turned off');
    // The computer connects afterwards and is handed nothing.
    await connected(agent, async () => {
      await Bun.sleep(300);
    });
    expect(log.some((line) => line.includes('→ list_files'))).toBe(false);
  }, 60_000);
});

withDb("the agent's own terminal beside a paired computer", () => {
  test('a computer that answers, with commands off, leaves the engine its terminal', async () => {
    const s = need();
    // The agent's own sandbox, with its terminal and desktop.
    const [personal] = await s.sql`select id from space where kind = 'personal'`;
    const spaceId = String(personal?.id);
    const sandboxId = recordId('conn');
    const sandboxScopes = sandboxExecManifest.tools.map((tool) => tool.name);
    await s.sql`insert into connection (id, space_id, provider, label, scopes, status)
      values (${sandboxId}, ${spaceId}, 'sandbox', 'Sandbox', ${JSON.stringify(sandboxScopes)}::jsonb, 'active')`;
    registry.register(sandboxId, {
      manifest: sandboxExecManifest,
      execute: () => Promise.reject(new Error('not dispatched in this test')),
      verify: () => Promise.reject(new Error('not dispatched in this test')),
      health: () => Promise.reject(new Error('not checked in this test')),
    });
    const deviceScopes = [
      'device.status',
      'device.list_files',
      'device.read_file',
      'device.write_file',
      'device.open_url',
      'device.screenshot',
      'device.browser_open',
      'device.browser_read',
      'device.browser_click',
      'device.browser_type',
      'device.browser_screenshot',
      'device.run',
    ];
    const { config, agent } = await s.computer({
      grant: { commands: false, files: true, open_url: true, screenshot: true, browser: true },
      local: { ...ALL, commands: false },
    });
    const [paired] =
      await s.sql`select connection_id from paired_device where id = ${config.device_id}`;
    const connectionId = String(paired?.connection_id);
    const runner = new AttemptRunner(s.jobs, new StubRuntimeAdapter(), {
      key: 'paired-device-terminal-key-32-chars-long',
      scopes: [...sandboxScopes, ...deviceScopes],
      loadCatalog: new RuntimeCatalog(s.db, registry).forAttempt,
    });
    await connected(agent, async () => {
      // The computer is online and answers.
      const status = await s.broker.propose(await s.job(['device.status']), {
        kind: 'device.status',
        connection_id: connectionId,
        payload: {},
      });
      expect(status.status).toBe('succeeded');
      const job = await s.jobs.create({
        space_id: spaceId,
        title: 'Terminal',
        objective: 'run in your terminal: sleep 50 && echo done-long',
      });
      const claim = await runner.claim({
        job_id: job.id,
        expected_epoch: job.leaseEpoch,
        expected_version: job.stateVersion,
        reason: 'created',
      });
      if (!claim) throw new Error('No claimed attempt');
      // Commands off: the computer's own terminal is not offered.
      expect(claim.bundle.tools.map((tool) => tool.name)).not.toContain('device.run');
      // The container deployment builds the engine from this bundle.
      expect(attemptEngineFeatures(claim.bundle.tools)).toEqual({
        toolsets: ['melete', 'terminal_tools'],
        terminalBackend: 'melete_sandbox',
      });
      // The plugin is served the same terminal, which it hands to the engine.
      const served = (await s.broker.catalog(claim.claims)).map((tool) => tool.name);
      expect(served).toContain('terminal.run');
      // Other tests' computers share this space, so a name may carry its account.
      expect(served.some((name) => name.startsWith('device.status'))).toBe(true);
    });
  }, 60_000);
});
