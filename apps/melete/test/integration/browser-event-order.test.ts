/**
 * A browser takeover and handback write job events, and event order must be commit order or an
 * event stream reader can step past a slow commit. Each write therefore waits for the event
 * order lock, as every other event writer does. Real Postgres; the worker is a stand-in.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { recordId } from '../../src/broker/records.ts';
import { EVENT_ORDER_LOCK } from '../../src/db/transaction.ts';
import type { BrowserWorkerClient } from '../../src/workers/browser/client.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const suite = database ? describe : describe.skip;

suite('browser control events wait for the event order lock', () => {
  const { sql } = database ?? ({} as NonNullable<typeof database>);
  afterAll(async () => {
    await database?.close();
  });

  const sessions = new BrowserSessionService(sql, {
    get: async (spaceId) => {
      const change =
        (control: BrowserSession['control']) =>
        async (id: string): Promise<BrowserSession> => {
          const [binding] = await sql`select * from browser_session_binding where id = ${id}`;
          return {
            id,
            space_id: spaceId,
            profile_dir: '',
            job_id: String(binding?.job_id),
            control_epoch: Number(binding?.control_epoch ?? 0) + 1,
            control,
            warm_until: Date.now() + 60_000,
          };
        };
      return {
        takeover: change('human'),
        handback: change('automation'),
      } as unknown as BrowserWorkerClient;
    },
  });

  /** Runs `operation` while another transaction holds the lock, and reports what committed. */
  async function whileLocked(jobId: string, operation: () => Promise<unknown>) {
    const events = async () =>
      (await sql`select type, payload->>'kind' as kind from event where job_id = ${jobId}
        order by seq`) as unknown as Array<{ type: string; kind: string | null }>;
    const before = (await events()).length;
    let pending: Promise<unknown> | undefined;
    let during: Array<{ type: string; kind: string | null }> = [];
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`;
      pending = operation();
      await Bun.sleep(400);
      during = (await events()).slice(before);
    });
    await pending;
    return { during, after: (await events()).slice(before) };
  }

  test('a takeover parks its job and a handback records its notice only in event order', async () => {
    const { claims } = await seedJob(sql, { provider: 'web' });
    const sessionId = `bs_${recordId('x')}`;
    await sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
      values (${sessionId}, ${claims.space_id}, ${claims.job_id}, 0, 'automation')`;

    const takeover = await whileLocked(claims.job_id, () =>
      sessions.control(sessionId, 'takeover'),
    );
    expect(takeover.during).toEqual([]);
    expect(takeover.after.map((event) => event.type)).toContain('job_state_changed');

    const handback = await whileLocked(claims.job_id, () =>
      sessions.control(sessionId, 'handback'),
    );
    expect(handback.during).toEqual([]);
    expect(handback.after).toContainEqual({ type: 'notice', kind: 'browser_handback' });
  }, 30_000);
});
