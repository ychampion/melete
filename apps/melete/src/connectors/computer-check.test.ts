/**
 * A check that a person is there on the computer's screen, through the
 * sandbox connection, against a real job table: the agent is told to stop and
 * not to try another way past it, and the work is handed to the person with
 * a card for the computer, as the browser's hand-off does.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Action, canonicalizePayload, type SandboxConnectionConfig } from '@melete/contracts';
import { testDatabase } from '../../test/helpers/database.ts';
import type { DesktopCommand } from '../sandbox/adapters/docker.ts';
import { FakeSandboxProvider } from '../sandbox/fake.ts';
import { MAX_CHECK_HAND_OFFS } from '../sandbox/hand-off.ts';
import { seedSessionScope } from '../sandbox/session-fixtures.ts';
import { SandboxSessions } from '../sandbox/sessions.ts';
import {
  CHECK_HANDED_OVER,
  CHECK_STILL_THERE,
  createSandboxExecConnector,
} from './sandbox-exec.ts';
import type { ConnectorContext } from './types.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'pause',
  lifetime_seconds: 600,
};

let workRoot = '';
beforeEach(async () => {
  if (handle) await handle.sql`truncate space cascade`;
  workRoot = await mkdtemp(path.join(tmpdir(), 'melete-computer-check-'));
});
afterAll(async () => {
  await handle?.close();
}, 30_000);

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Cloudflare's check page as the desktop helper reads it. */
const CHECK_PAGE = encode({
  source: 'accessibility',
  url: 'https://demo.shop.example/checkout',
  title: 'Just a moment...',
  elements: [
    { ref: 'n2', role: 'heading', name: 'demo.shop.example', box: [40, 100, 400, 40] },
    {
      ref: 'n3',
      role: 'Iframe',
      name: 'Widget containing a Cloudflare security challenge',
      box: [40, 200, 300, 65],
    },
  ],
});
const PLAIN_PAGE = encode({
  source: 'accessibility',
  url: 'https://demo.shop.example/',
  title: 'Shop',
  elements: [{ ref: 'n2', role: 'heading', name: 'Welcome', box: [40, 100, 400, 40] }],
});

withDb('a check that a person is there, on the computer', () => {
  const scene = async (screen: Uint8Array) => {
    if (!handle) throw new Error('Postgres is unavailable');
    const sql = handle.sql;
    const scope = await seedSessionScope(sql);
    await sql`update connection set provider = 'sandbox',
        scopes = '["terminal.run","computer.open"]'::jsonb
      where id = ${scope.connectionId}`;
    await sql`update job set agent_id = ${scope.agentId}, state = 'running', lease_epoch = 1
      where id = ${scope.jobId}`;
    // A desktop that shows the given page after any step.
    const provider = Object.assign(new FakeSandboxProvider(), {
      desktop: true,
      async computer(_handle: unknown, command: DesktopCommand) {
        if (command.kind === 'screenshot') return png(1024, 768);
        if (command.kind === 'text') return screen;
        return encode({ navigated: true, window: 'Shop - Chromium' });
      },
    });
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const connector = createSandboxExecConnector({
      sessions,
      provider,
      config,
      connectionId: scope.connectionId,
      spaceId: scope.spaceId,
      project: 'computer-check-test',
      workRoot,
      sql,
      workspaceWaitMs: 0,
      challengeWaitMs: 1,
    });
    await mkdir(path.join(workRoot, scope.jobId), { recursive: true });
    /** One step on the computer, by a new attempt of the work, as the job runs again. */
    const step = async () => {
      const attemptId = await scope.attempt();
      await sql`update job set state = 'running' where id = ${scope.jobId}`;
      const id = `act_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      const canonical = canonicalizePayload({ step: 1, url: 'https://demo.shop.example/checkout' });
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, idempotency_key)
      values (${id}, ${scope.jobId}, ${attemptId}, ${scope.connectionId}, 'computer.open',
        'write_reversible', ${canonical.json}::jsonb, ${canonical.hash}, ${id})`;
      const action = {
        id,
        job_id: scope.jobId,
        attempt_id: attemptId,
        connection_id: scope.connectionId,
        kind: 'computer.open',
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
      const ctx: ConnectorContext = {
        job_id: scope.jobId,
        space_id: scope.spaceId,
        idempotency_key: id,
        constraints: {
          deliverable: { kind: 'none' },
          allowed_domains: [],
          public_compartment: false,
        },
      };
      const result = await connector.execute(action, ctx);
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      const detail = result.receipt.detail as Record<string, unknown>;
      const [job] = await sql`select state, wait from job where id = ${scope.jobId}`;
      const [attempt] = await sql`select outcome from attempt where id = ${attemptId}`;
      return { detail, job, attempt };
    };
    return { step };
  };
  const setup = async (screen: Uint8Array) => (await scene(screen)).step();

  test('the step stops at the check, tells the agent not to get past it, and hands the computer over', async () => {
    const { detail, job, attempt } = await setup(CHECK_PAGE);
    expect(detail).toMatchObject({
      challenge: 'cloudflare',
      handed_to: 'person',
      next_step: CHECK_HANDED_OVER,
    });
    expect(String(detail.next_step)).toContain('Do not click the check');
    expect(job?.state).toBe('waiting_for_input');
    expect(job?.wait.handoff).toMatchObject({
      reason: 'captcha',
      service: 'shop.example',
      done: ['Opened demo.shop.example'],
      take_over: { surface: 'computer', session_id: detail.session_id },
    });
    expect(attempt?.outcome).toBe('fenced');
  }, 60_000);

  test('a check still there after the person handed it back twice is not handed over again', async () => {
    const { step } = await scene(CHECK_PAGE);
    for (let time = 0; time < MAX_CHECK_HAND_OFFS; time += 1)
      expect((await step()).detail.handed_to).toBe('person');
    // The third look at the same check: the agent is told, and the work is not held there.
    const { detail, job, attempt } = await step();
    expect(detail).toMatchObject({ challenge: 'cloudflare', next_step: CHECK_STILL_THERE });
    expect(detail.handed_to).toBeUndefined();
    expect(job?.state).toBe('running');
    expect(attempt?.outcome).toBeNull();
  }, 60_000);

  test('a page with no check goes on as before', async () => {
    const { detail, job, attempt } = await setup(PLAIN_PAGE);
    expect(detail.challenge).toBeUndefined();
    expect(detail.handed_to).toBeUndefined();
    expect(detail.next_step).toBeUndefined();
    expect(job?.state).toBe('running');
    expect(attempt?.outcome).toBeNull();
  }, 60_000);
});
