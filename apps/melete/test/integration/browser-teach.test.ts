/**
 * Teaching by showing, through the service: starting it needs the same permission as a takeover
 * and parks the work the same way; the handback that ends it gives the steps to the conversation
 * as one record marked shown by the person, which the next attempt reads; discarding gives
 * nothing; and nothing else from the takeover reaches the job's events. Real Postgres; the worker
 * is the real session controller over a stand-in Chromium, so control epochs are the worker's own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { projectComputer } from '../../src/experience/computer.ts';
import { collectHistory } from '../../src/jobs/bundle.ts';
import type { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import { BrowserSessionService, SHOWN_NOTE } from '../../src/workers/browser/routes.ts';
import { BrowserFault, BrowserSessions } from '../../src/workers/browser/sessions.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const suite = database ? describe : describe.skip;
const OWNER = 'own_teaching';

suite('showing the agent how in the browser', () => {
  const { sql } = database ?? ({} as NonNullable<typeof database>);
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await database?.close();
  });

  async function setup() {
    const [owner] = await sql`select id from owner limit 1`;
    if (!owner) {
      await sql`insert into owner (id, email) values (${OWNER}, 'teach@example.test')`;
      await sql`insert into principal (id, email) values (${OWNER}, 'teach@example.test')`;
    }
    const { claims } = await seedJob(sql, { provider: 'web' });
    const root = await mkdtemp(join(tmpdir(), 'melete-teach-service-'));
    roots.push(root);
    const page = { setDefaultTimeout() {}, url: () => 'about:blank' };
    const worker = new BrowserSessions({
      spaceId: claims.space_id,
      spaceRoot: root,
      launch: async () =>
        ({
          pages: () => [page],
          newPage: async () => page,
          close: async () => {},
          browser: () => null,
          cookies: async () => [],
        }) as unknown as BrowserContext,
    });
    const leased = await worker.lease(claims.job_id, {
      public_compartment: false,
      allowed_domains: [],
    });
    const calls: string[] = [];
    const client = {
      takeover: async (id: string, options?: { teach?: boolean }) => {
        calls.push(`takeover${options?.teach ? ':teach' : ''}`);
        return worker.takeover(id, options);
      },
      handback: async (id: string, options?: { discard?: boolean }) => {
        calls.push(`handback${options?.discard ? ':discard' : ''}`);
        return worker.handback(id, options);
      },
    } as unknown as BrowserWorkerClient;
    const service = new BrowserSessionService(sql, { get: async () => client });
    await service.record(leased, claims);
    const events = async () =>
      (await sql`select seq, type, payload, created_at as "createdAt", attempt_id as "attemptId"
        from event where job_id = ${claims.job_id} order by seq`) as unknown as Array<{
        seq: number;
        type: string;
        payload: Record<string, unknown>;
        createdAt: Date;
        attemptId: string | null;
      }>;
    const computer = async () => {
      const bindings = await sql`select b.id, b.control, b.updated_at,
          b.control = 'human' and exists (select 1 from event e where e.job_id = b.job_id
            and e.type = 'notice' and e.payload->>'kind' = 'browser_teaching'
            and e.payload->>'session_id' = b.id
            and (e.payload->>'control_epoch')::bigint = b.control_epoch) as teaching
        from browser_session_binding b where b.job_id = ${claims.job_id}`;
      return projectComputer({
        rows: [],
        bindings: bindings as never,
        available: { browser: true, terminal: false },
      }).browser;
    };
    return { claims, worker, service, sessionId: leased.id, calls, events, computer };
  }

  test('teaching cannot start without take-over permission, and starts as a takeover', async () => {
    const s = await setup();
    const refused = await s.service
      .control(s.sessionId, 'takeover', 'prin_stranger', { teach: true })
      .then(
        () => 'taken',
        (error: unknown) => (error instanceof BrowserFault ? error.reason : String(error)),
      );
    expect(refused).toBe('session_not_found');
    expect(s.calls).toEqual([]);
    expect(s.worker.session?.control).toBe('automation');

    const before = s.worker.session?.control_epoch ?? -1;
    const taken = await s.service.control(s.sessionId, 'takeover', OWNER, { teach: true });
    expect(taken).toMatchObject({
      control: 'human',
      control_epoch: before + 1,
      teaching: true,
    });
    // The work is parked exactly as a takeover parks it.
    const [job] = await sql`select state, wait from job where id = ${s.claims.job_id}`;
    expect(job?.state).toBe('waiting_for_input');
    expect(String(job?.wait?.question)).toStartWith('Browser control:');
    expect((await s.computer())?.teaching).toBe(true);
    // Automation holding the old epoch is refused while the person teaches.
    expect(() => s.worker.checkInput(s.sessionId, before)).toThrow('stale_control_epoch');
    await s.service.control(s.sessionId, 'handback', OWNER, { discard: true });
    expect((await s.computer())?.teaching).toBeUndefined();
  });

  test('the handback delivers the steps to the turn, marked as shown by the person, and nothing else', async () => {
    const s = await setup();
    const taken = await s.service.control(s.sessionId, 'takeover', OWNER, { teach: true });
    const log = s.worker.teaching(s.sessionId, taken.control_epoch);
    log?.opened('https://bank.example/statements?session=abc123def456', 'Statements');
    log?.clicked(
      { role: 'button', name: 'Download PDF', tag: 'button', attributes: {} },
      'Statements',
    );
    log?.filled({ role: 'searchbox', name: 'Search', tag: 'input', attributes: {} });
    const seenBefore = (await s.events()).length;

    const back = await s.service.control(s.sessionId, 'handback', OWNER);
    expect(back).toMatchObject({ control: 'automation', shown_steps: 3 });
    const written = (await s.events()).slice(seenBefore);
    const shown = written.filter(
      (row) =>
        row.type === 'notice' &&
        row.payload.kind === 'trigger_event' &&
        (row.payload.event as { kind?: string }).kind === 'shown_by_person',
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.payload.event).toMatchObject({
      kind: 'shown_by_person',
      session_id: s.sessionId,
      truncated: false,
      note: SHOWN_NOTE,
      steps: [
        { kind: 'open', url: 'https://bank.example/statements', title: 'Statements' },
        { kind: 'click', role: 'button', name: 'Download PDF', title: 'Statements' },
        { kind: 'fill', label: 'Search', value: '{search}' },
      ],
    });
    // The next attempt reads it as something that happened.
    const all = await s.events();
    const history = collectHistory(all, [], seenBefore ? (all[seenBefore - 1]?.seq ?? 0) : 0);
    expect(history.inputs.trigger_events).toEqual([shown[0]?.payload.event as never]);
    // Nothing read during the takeover is anywhere else in the job's record.
    const record = JSON.stringify(await s.events());
    expect(record).not.toContain('abc123def456');
    // A second handback has nothing more to give.
    const again = await s.service.control(s.sessionId, 'handback', OWNER);
    expect(again.shown_steps).toBe(0);
    expect((await s.events()).filter((row) => row.payload.kind === 'trigger_event')).toHaveLength(
      1,
    );
  });

  test('discarding hands back and leaves no record; a plain takeover records nothing', async () => {
    const s = await setup();
    const taken = await s.service.control(s.sessionId, 'takeover', OWNER, { teach: true });
    s.worker
      .teaching(s.sessionId, taken.control_epoch)
      ?.clicked({ role: 'button', name: 'Pay now', tag: 'button', attributes: {} }, 'Pay');
    const discarded = await s.service.control(s.sessionId, 'handback', OWNER, { discard: true });
    expect(discarded.control).toBe('automation');
    expect(discarded.shown_steps).toBeUndefined();
    expect(s.calls).toEqual(['takeover:teach', 'handback:discard']);

    const plain = await s.service.control(s.sessionId, 'takeover', OWNER);
    expect(plain.teaching).toBeUndefined();
    expect(s.worker.teaching(s.sessionId, plain.control_epoch)).toBeUndefined();
    expect((await s.computer())?.teaching).toBeUndefined();
    await s.service.control(s.sessionId, 'handback', OWNER);
    const record = await s.events();
    expect(record.filter((row) => row.payload.kind === 'trigger_event')).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('Pay now');
  });

  test('a worker that hands back more than a step log holds is not believed', async () => {
    const s = await setup();
    const lying = {
      takeover: (id: string) => s.worker.takeover(id, { teach: true }),
      handback: async (id: string) => ({
        ...(await s.worker.handback(id)),
        shown: { steps: [{ kind: 'page_text', text: 'everything on the page' }], truncated: false },
      }),
    } as unknown as BrowserWorkerClient;
    const service = new BrowserSessionService(sql, { get: async () => lying });
    await service.control(s.sessionId, 'takeover', OWNER, { teach: true });
    const back = await service.control(s.sessionId, 'handback', OWNER);
    expect(back.shown_steps).toBe(0);
    expect(JSON.stringify(await s.events())).not.toContain('everything on the page');
  });
});
