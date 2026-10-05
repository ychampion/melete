/**
 * Sorting with a real model, on request: the seeded inbox and calendar of
 * thirty-three changes, sorted by the default model at Fireworks through the
 * real gateway. Run with MELETE_LIVE_TRIAGE=1 and FIREWORKS_API_KEY set:
 *
 *   MELETE_LIVE_TRIAGE=1 bun test apps/melete/test/integration/triage-live.test.ts
 *
 * It checks what the scripted run checks, against the real thing: the three
 * that need the person are listed first, no action is taken, sorting again
 * makes no call, a private space's mail never leaves for the cloud, and the
 * whole run costs less than thirty cents at the default model's prices.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { providersFromEnv } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard } from '../../src/gateway/spending.ts';
import { newId } from '../../src/ids.ts';
import { PostgresPrivacyStore, PrivacyRouter } from '../../src/privacy/index.ts';
import { updateSettings } from '../../src/privacy/routes.ts';
import { openTriageGateway } from '../../src/triage/classifier.ts';
import { TriageService } from '../../src/triage/service.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';
import { NEEDS_YOU, triageInbox } from './triage-fixtures.ts';

const live = process.env.MELETE_LIVE_TRIAGE === '1' && Boolean(process.env.FIREWORKS_API_KEY);
const handle = live ? await testDatabase() : null;
const withLive = handle ? describe : describe.skip;
afterAll(async () => {
  await handle?.close();
}, 15_000);

const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';

withLive('sorting with a real model', () => {
  test('the three come first, for under thirty cents, and nothing private leaves', async () => {
    if (!handle) return;
    const sql = handle.sql;
    await resetTestRows(sql);
    await sql`delete from model_usage`;
    await sql`delete from event where job_id is null`;
    const personId = newId('own');
    await sql`insert into owner (id, email) values (${personId}, ${`${personId}@example.test`})`;
    await sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
    const spaceId = newId('sp');
    const privateSpaceId = newId('sp');
    for (const id of [spaceId, privateSpaceId])
      await sql`insert into space (id, name, git_path, owner_principal_id)
        values (${id}, 'Personal', ${`/spaces/${id}`}, ${personId})`;
    const connectionId = newId('conn');
    const privateConnectionId = newId('conn');
    await sql`insert into connection (id, space_id, provider, label)
      values (${connectionId}, ${spaceId}, 'imap', 'Mail'),
        (${privateConnectionId}, ${privateSpaceId}, 'imap', 'Health mail')`;

    const router = new PrivacyRouter({
      store: new PostgresPrivacyStore(sql, () => 'a'.repeat(64)),
    });
    await updateSettings(router, privateSpaceId, { private_space: true });
    const guard = new SpendingGuard(
      sql,
      {
        installation: { day: NO_LIMIT, month: NO_LIMIT },
        person: { day: NO_LIMIT, month: NO_LIMIT },
        background: { day: NO_LIMIT, month: NO_LIMIT },
        noticePercent: 80,
      },
      new PriceTable({
        'fireworks/*deepseek-v4p1-flash*': { input: 0.3, output: 1.2, cached_input: 0.006 },
      }),
    );
    /** Every request body that left for the provider. */
    const sent: string[] = [];
    const labeller = await openTriageGateway({
      source: {
        current: async () => ({ provider: 'fireworks', model: MODEL }),
        providers: async (configured) => configured,
      },
      providers: providersFromEnv(process.env),
      privacy: router,
      spending: guard,
      fetch: async (request: Request) => {
        sent.push(await request.clone().text());
        return fetch(request);
      },
    });
    try {
      const inbox = triageInbox(sql);
      await inbox.seedInbox(connectionId);
      await inbox.deliverMail(privateConnectionId, {
        from: 'Dr. Patel <office@clinic.example>',
        subject: 'Can you confirm your follow-up appointment?',
      });
      const service = new TriageService({ sql, classifier: labeller, spending: guard });
      const first = await service.run();
      console.log('first run', first);
      expect(first.collected).toBe(34);

      const list = await service.needsYou(personId);
      console.log(
        'needs you',
        list.items.map((item) => `${item.urgency} | ${item.sentence} | ${item.because.label}`),
      );
      expect(
        list.items
          .slice(0, 3)
          .map((item) => item.because.subject)
          .sort(),
      ).toEqual([...NEEDS_YOU].sort());
      const [actions] = await sql`select (select count(*)::int from action) as actions,
        (select count(*)::int from approval) as approvals, (select count(*)::int from job) as jobs`;
      expect(actions).toEqual({ actions: 0, approvals: 0, jobs: 0 });

      // Again, and the same things read again: no new call.
      const calls = sent.length;
      expect((await service.run()).calls).toBe(0);
      await sql`delete from triage_item where space_id = ${spaceId}`;
      const reread = await service.run();
      expect(reread.calls).toBe(0);
      expect(sent.length).toBe(calls);

      expect(sent.join('\n')).not.toContain('Patel');
      expect(sent.join('\n')).not.toContain('follow-up');

      const [spent] =
        await sql`select count(*)::int as calls, coalesce(sum(cost_usd), 0)::float8 as usd,
          bool_and(purpose = 'triage' and class = 'background' and tier = 't1') as tagged
        from model_usage`;
      console.log('spent', spent);
      expect(spent?.tagged).toBe(true);
      expect(Number(spent?.usd)).toBeLessThan(0.3);
    } finally {
      await labeller.close();
    }
  }, 180_000);
});
