/**
 * One computer, a display per chat: two chats of one agent, or a chat and a
 * run, work on the same computer at once, each on its own screen with its own
 * browser. Against a desktop that keeps a page per display, and a real
 * session table. Nothing here reaches a provider.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Action, SandboxConnectionConfig } from '@melete/contracts';
import { canonicalizePayload } from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import { recordId } from '../broker/records.ts';
import type {
  DesktopCommand,
  DesktopDisplay,
  DockerSandboxProvider,
} from '../sandbox/adapters/docker.ts';
import { SandboxComputerService } from '../sandbox/computer.ts';
import { computerFull } from '../sandbox/displays.ts';
import { FakeSandboxProvider } from '../sandbox/fake.ts';
import { seedSessionScope } from '../sandbox/session-fixtures.ts';
import { SandboxSessions } from '../sandbox/sessions.ts';
import type { SandboxHandle } from '../sandbox/types.ts';
import { startSandboxes } from '../sandbox/wiring.ts';
import { createSandboxExecConnector } from './sandbox-exec.ts';
import type { ConnectorContext } from './types.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const PROJECT = 'sandbox-displays-test';

let workRoot = '';
beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  // Who holds a computer is kept by its id, which the fake reuses from one test to the next.
  if (handle) await handle.sql`truncate sandbox_control`;
  workRoot = await mkdtemp(path.join(tmpdir(), 'melete-sandbox-displays-'));
});
afterAll(async () => {
  await handle?.close();
}, 30_000);

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'pause',
  lifetime_seconds: 600,
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * The in-memory sandbox, with a desktop that keeps one page per display, as
 * the computer's own browsers do: what one display opens, only that display shows.
 */
function desktopProvider() {
  const inner = new FakeSandboxProvider();
  const pages = new Map<string, string>();
  const ended: Array<{ sandbox: string; number: number; id: string }> = [];
  const seen: Array<{ command: DesktopCommand['kind']; display: number | null }> = [];
  const keyOf = (target: SandboxHandle, display?: DesktopDisplay) =>
    `${target.providerSandboxId}:${display?.number ?? 0}`;
  const desktop = {
    desktop: true as const,
    async computer(
      target: SandboxHandle,
      command: DesktopCommand,
      _signal: AbortSignal,
      display?: DesktopDisplay,
    ) {
      seen.push({ command: command.kind, display: display?.number ?? null });
      const key = keyOf(target, display);
      switch (command.kind) {
        case 'screenshot':
          return png(1024, 768);
        case 'open':
          pages.set(key, command.url);
          return encode({ window: `${command.url} - Chromium`, browser: true, navigated: true });
        case 'info':
          return encode({ window: `${pages.get(key) ?? 'New Tab'} - Chromium`, browser: true });
        case 'text':
          return encode({ source: 'none', reason: 'nothing to read here' });
        default:
          return encode({ accepted: 1 });
      }
    },
    async *frames() {},
    async endDisplay(target: SandboxHandle, display: DesktopDisplay) {
      ended.push({ sandbox: target.providerSandboxId, number: display.number, id: display.id });
      pages.delete(keyOf(target, display));
    },
    async running() {
      return true;
    },
    touch() {},
  };
  // The sandbox calls go to the fake itself, so its own bookkeeping holds.
  const provider = new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(desktop, property)) return desktop[property as keyof typeof desktop];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DockerSandboxProvider & { calls: FakeSandboxProvider['calls'] };
  return { provider, pages, ended, seen };
}

withDb('a display per chat on the agent computer', () => {
  const setup = async (over: { maxDisplays?: number } = {}) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    const ownerId = recordId('own');
    await sql`insert into owner (id, email) values (${ownerId}, ${`${ownerId}@example.test`}) on conflict do nothing`;
    await sql`insert into principal (id, email) values (${ownerId}, ${`${ownerId}@example.test`}) on conflict do nothing`;
    await sql`update space set owner_principal_id = ${ownerId} where id = ${scope.spaceId}`;
    const desktop = desktopProvider();
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
      ...(over.maxDisplays === undefined ? {} : { maxDisplays: over.maxDisplays }),
    });
    const connector = createSandboxExecConnector({
      sessions,
      provider: desktop.provider,
      config,
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: PROJECT,
      workRoot,
      sql,
      // Without displays, a second chat would be refused at once.
      workspaceWaitMs: 0,
      challengeWaitMs: 0,
    });
    const providers = () =>
      new Map([[scope.connectionId, { adapter: 'fake', provider: desktop.provider }]]);
    const wiring = startSandboxes({ sql, sessions, providers, project: PROJECT, sweepMs: 60_000 });

    /** A chat (or a run) of the agent, with a turn running now. */
    const chat = async (title: string) => {
      const jobId = recordId('job');
      await sql`insert into job (id, space_id, title, objective, agent_id, principal_id, state)
        values (${jobId}, ${scope.spaceId}, ${title}, 'Work', ${scope.agentId}, ${ownerId}, 'running')`;
      await mkdir(path.join(workRoot, jobId), { recursive: true });
      let epoch = 0;
      let attemptId = '';
      const turn = async () => {
        epoch += 1;
        attemptId = recordId('att');
        await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model,
            lease_expires_at)
          values (${attemptId}, ${jobId}, ${epoch}, 'fake', 'fake', 'scripted',
            now() + interval '10 minutes')`;
        return attemptId;
      };
      await turn();
      let step = 0;
      const run = async (kind: string, given: Record<string, unknown>) => {
        const id = recordId('act');
        // Each computer step is numbered, as the model numbers them.
        step += 1;
        const payload = kind.startsWith('computer.') ? { step, ...given } : given;
        const canonical = canonicalizePayload(payload);
        await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
            canonical_payload, payload_hash, idempotency_key)
          values (${id}, ${jobId}, ${attemptId}, ${scope.connectionId}, ${kind}, 'write_reversible',
            ${JSON.stringify(canonical.canonical)}::jsonb, ${canonical.hash}, ${id})`;
        const action = {
          id,
          job_id: jobId,
          attempt_id: attemptId,
          connection_id: scope.connectionId,
          kind,
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
        } as Action;
        const context: ConnectorContext = {
          job_id: jobId,
          space_id: scope.spaceId,
          idempotency_key: id,
          constraints: {
            deliverable: { kind: 'none' },
            allowed_domains: [],
            public_compartment: false,
          },
        };
        return connector.execute(action, context);
      };
      const detail = async (kind: string, payload: Record<string, unknown>) => {
        const result = await run(kind, payload);
        if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
        return result.receipt.detail as Record<string, unknown>;
      };
      return {
        jobId,
        attempt: () => attemptId,
        turn,
        run,
        detail,
        open: (url: string) => detail('computer.open', { url }),
        screenshot: () => detail('computer.screenshot', {}),
        /** The turn ends, the chat staying open. */
        endTurn: async () => {
          await sql`update attempt set ended_at = now(), lease_expires_at = null
            where id = ${attemptId}`;
        },
      };
    };
    return { sql, scope, ownerId, sessions, connector, wiring, providers, chat, ...desktop };
  };

  test('two chats on one computer each see only their own page', async () => {
    const s = await setup();
    const flights = await s.chat('Flights to Lisbon');
    const groceries = await s.chat('Weekly groceries');
    const a = await flights.open('https://flights.example/lisbon');
    const b = await groceries.open('https://shop.example/basket');
    // One computer, two screens.
    expect(b.sandbox_id).toBe(a.sandbox_id);
    expect(b.display).not.toBe(a.display);
    expect(b.computer_id).not.toBe(a.computer_id);
    expect(s.provider.calls.create).toBe(1);
    // Each chat's next look is at its own page, not the one opened last.
    expect((await flights.screenshot()).window).toBe('https://flights.example/lisbon - Chromium');
    expect((await groceries.screenshot()).window).toBe('https://shop.example/basket - Chromium');
    // A later turn of the same chat comes back to the same display.
    await flights.endTurn();
    await flights.turn();
    const again = await flights.screenshot();
    expect(again.computer_id).toBe(a.computer_id);
    expect(again.window).toBe('https://flights.example/lisbon - Chromium');
  }, 60_000);

  test('a background run on the computer does not keep a chat waiting', async () => {
    const s = await setup();
    const run = await s.chat('Nightly price check');
    const ran = await run.detail('terminal.run', { command: "printf 'checking prices'" });
    expect(ran.exit_code).toBe(0);
    await run.open('https://prices.example/');
    // The chat is not told to wait, and works at once on its own display.
    const chat = await s.chat('Plan the weekend');
    const opened = await chat.open('https://weather.example/');
    expect(opened.sandbox_id).toBe(ran.sandbox_id);
    const [busy] = await s.sql`select 1 from event
      where job_id = ${chat.jobId} and payload->>'kind' = 'computer_busy'`;
    expect(busy).toBeUndefined();
    // And the run carries on alongside it, on its own page.
    expect((await run.detail('terminal.run', { command: 'printf still' })).exit_code).toBe(0);
    expect((await run.screenshot()).window).toBe('https://prices.example/ - Chromium');
  }, 60_000);

  test("a person taking over one chat's display leaves the other chat's free", async () => {
    const s = await setup();
    const flights = await s.chat('Flights to Lisbon');
    const groceries = await s.chat('Weekly groceries');
    const a = await flights.open('https://flights.example/lisbon');
    await groceries.open('https://shop.example/basket');
    const service = new SandboxComputerService(s.sql, s.providers);
    const taken = await service.control(String(a.computer_id), 'takeover', s.ownerId);
    expect(taken).toMatchObject({ session_id: a.computer_id, control: 'human' });
    // The other chat goes on working on its display.
    expect((await groceries.screenshot()).window).toBe('https://shop.example/basket - Chromium');
    const listed = await service.list(groceries.jobId, s.ownerId);
    expect(listed.map((each) => each.control)).toEqual(['agent']);
    // Only the chat whose display was taken over is held.
    expect((await service.list(flights.jobId, s.ownerId)).map((each) => each.control)).toEqual([
      'human',
    ]);
    await flights.turn();
    const refused = await flights.run('computer.screenshot', {});
    if (refused.outcome !== 'failed') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toContain('a person has taken control');
  }, 60_000);

  test("a chat's display ends with the chat, and a stop ends only that chat's", async () => {
    const s = await setup();
    const flights = await s.chat('Flights to Lisbon');
    const groceries = await s.chat('Weekly groceries');
    const notes = await s.chat('Reading notes');
    const a = await flights.open('https://flights.example/lisbon');
    const b = await groceries.open('https://shop.example/basket');
    const c = await notes.open('https://notes.example/');
    // Stopping one chat ends its display and no other.
    expect(await s.wiring.endStoppedDisplays(flights.jobId, AbortSignal.timeout(10_000))).toEqual([
      String(a.computer_id),
    ]);
    expect(s.ended.map((each) => each.id)).toEqual([String(a.computer_id)]);
    expect((await groceries.screenshot()).window).toBe('https://shop.example/basket - Chromium');
    // A chat still open keeps its display between turns; one that ended loses it.
    await groceries.endTurn();
    await notes.endTurn();
    await s.sql`update job set state = 'completed' where id = ${groceries.jobId}`;
    expect(await s.wiring.reapDisplays(AbortSignal.timeout(10_000))).toEqual([
      String(b.computer_id),
    ]);
    expect(s.ended.map((each) => each.id)).toEqual([String(a.computer_id), String(b.computer_id)]);
    const [left] = await s.sql`select ended_at from sandbox_display
      where id = ${String(c.computer_id)}`;
    expect(left?.ended_at).toBeNull();
  }, 60_000);

  test('a computer with every display taken says so plainly, and runs nothing', async () => {
    const s = await setup({ maxDisplays: 1 });
    const flights = await s.chat('Flights to Lisbon');
    const groceries = await s.chat('Weekly groceries');
    await flights.open('https://flights.example/lisbon');
    const refused = await groceries.run('computer.open', { url: 'https://shop.example/basket' });
    if (refused.outcome !== 'failed') throw new Error(JSON.stringify(refused));
    expect(refused.reason).toBe(computerFull(1));
    expect(refused.retryable).toBe(false);
    expect(s.seen.filter((each) => each.command === 'open')).toHaveLength(1);
  }, 60_000);

  test('the computer is kept running while another chat is still on it', async () => {
    const s = await setup();
    const flights = await s.chat('Flights to Lisbon');
    const groceries = await s.chat('Weekly groceries');
    await flights.open('https://flights.example/lisbon');
    await groceries.open('https://shop.example/basket');
    // The chat that opened the computer finishes its turn first.
    await flights.endTurn();
    await s.wiring.settleAttempt(flights.attempt(), AbortSignal.timeout(10_000));
    expect(s.provider.calls.pause).toBe(0);
    const [row] = await s.sql`select status, attempt_id from sandbox_session
      where space_id = ${s.scope.spaceId}`;
    expect(row).toMatchObject({ status: 'ready', attempt_id: groceries.attempt() });
    expect((await groceries.screenshot()).window).toBe('https://shop.example/basket - Chromium');
  }, 60_000);
});
