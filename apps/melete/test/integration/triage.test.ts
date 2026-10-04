/**
 * Sorting what came in, end to end on Postgres through the real model gateway
 * on its fake transport: a seeded inbox and calendar of thirty-three changes,
 * three of which need the person.
 *
 * - the three are listed first, and sorting takes no action of any kind;
 * - sorting again, or reading the same things again, makes no model call;
 * - a private space's mail never reaches a cloud model;
 * - at a background spending limit nothing is sent and nothing fails;
 * - every call is a background call on the `t1` step, charged to the person.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fakeProvider } from '../../src/gateway/index.ts';
import { PriceTable } from '../../src/gateway/prices.ts';
import { NO_LIMIT, SpendingGuard, type SpendingLimits } from '../../src/gateway/spending.ts';
import type { GatewayProtocol } from '../../src/gateway/types.ts';
import { newId } from '../../src/ids.ts';
import { PostgresPrivacyStore, PrivacyRouter } from '../../src/privacy/index.ts';
import { updateSettings } from '../../src/privacy/routes.ts';
import { openTriageGateway, type TriageClassifier } from '../../src/triage/classifier.ts';
import { type NoticedSituation, TriageService } from '../../src/triage/service.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';
import { triageInbox } from './triage-fixtures.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
afterAll(async () => {
  await handle?.close();
}, 15_000);

const prices = new PriceTable({ 'fake/*': { input: 0.3, output: 1.2 } });
function limits(background: Partial<NonNullable<SpendingLimits['background']>> = {}) {
  return {
    installation: { day: NO_LIMIT, month: NO_LIMIT },
    person: { day: NO_LIMIT, month: NO_LIMIT },
    background: { day: NO_LIMIT, month: NO_LIMIT, ...background },
    noticePercent: 80,
  } satisfies SpendingLimits;
}

let fixtures: ReturnType<typeof triageInbox> | null = null;
const inbox = () => {
  if (!handle) throw new Error('no database');
  fixtures ??= triageInbox(handle.sql);
  return fixtures;
};

let personId = '';
let spaceId = '';
let connectionId = '';
let privateSpaceId = '';
let privateConnectionId = '';

/** Every request body the cloud model was sent, and every one the local model was. */
const toCloud: string[] = [];
const toLocal: string[] = [];

/**
 * The scripted model: it labels what it is shown by the words in it, as a
 * small model would, and says "urgent" about anything that claims to be.
 */
function scriptedAnswer(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  const input = JSON.parse(messages.at(-1)?.content ?? '{}') as {
    items: { id: string; kind: string; subject?: string; title?: string; changed?: string[] }[];
  };
  return JSON.stringify({
    items: input.items.map((item) => {
      const words = `${item.subject ?? ''} ${item.title ?? ''}`;
      const needs =
        /\b(sign|confirm|can you)\b/i.test(words) ||
        (item.kind === 'calendar.event.changed' && (item.changed ?? []).includes('start'));
      return {
        id: item.id,
        verdict: needs ? 'needs_you' : item.kind.startsWith('calendar') ? 'fyi' : 'ignore',
        urgency: /urgent|friday/i.test(words) ? 'urgent' : 'normal',
        sentence: needs ? `You need to deal with: ${words.trim()}` : 'Nothing to do.',
        reason: needs ? 'Someone is waiting on you.' : 'No action needed.',
      };
    }),
  });
}

const completion = (content: string, model: string) =>
  Response.json({
    id: `cmpl_${randomUUID()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
  });

/** How the fake provider answers: as the scripted model, or failing as an outage or nonsense. */
let provider: 'answer' | 'down' | 'nonsense' = 'answer';

async function classifier(spending?: SpendingGuard): Promise<{
  classifier: TriageClassifier;
  router: PrivacyRouter;
}> {
  if (!handle) throw new Error('no database');
  const router = new PrivacyRouter({
    store: new PostgresPrivacyStore(handle.sql, () => 'a'.repeat(64)),
    resolve: async () => [{ address: '93.184.216.34' }],
  });
  const opened = await openTriageGateway({
    source: {
      current: async () => ({ provider: 'fake', model: 'fake-scripted-v1' }),
      providers: async (configured) => configured,
    },
    providers: [fakeProvider],
    privacy: router,
    ...(spending ? { spending } : {}),
    fake: async (body: Record<string, unknown>, _attempt: string, _protocol: GatewayProtocol) => {
      toCloud.push(JSON.stringify(body));
      if (provider === 'down')
        return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
      if (provider === 'nonsense') return completion('Sure! Here you go.', 'fake-scripted-v1');
      return completion(scriptedAnswer(body), 'fake-scripted-v1');
    },
    fetch: async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      toLocal.push(JSON.stringify(body));
      return completion(scriptedAnswer(body), 'llama3.3');
    },
  });
  return { classifier: opened, router };
}

withDb('sorting what came in', () => {
  beforeEach(async () => {
    if (!handle) return;
    await resetTestRows(handle.sql);
    await handle.sql`delete from model_usage`;
    await handle.sql`delete from event where job_id is null`;
    toCloud.length = 0;
    toLocal.length = 0;
    provider = 'answer';
    personId = newId('own');
    await handle.sql`insert into owner (id, email) values (${personId}, ${`${personId}@example.test`})`;
    await handle.sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
    spaceId = newId('sp');
    privateSpaceId = newId('sp');
    for (const id of [spaceId, privateSpaceId])
      await handle.sql`insert into space (id, name, git_path, owner_principal_id)
        values (${id}, 'Personal', ${`/spaces/${id}`}, ${personId})`;
    connectionId = newId('conn');
    privateConnectionId = newId('conn');
    await handle.sql`insert into connection (id, space_id, provider, label)
      values (${connectionId}, ${spaceId}, 'imap', 'Mail'),
        (${privateConnectionId}, ${privateSpaceId}, 'imap', 'Health mail')`;
  }, 20_000);

  test('the three that need the person come first, with no action taken', async () => {
    if (!handle) return;
    const guard = new SpendingGuard(handle.sql, limits(), prices);
    const { classifier: labeller } = await classifier(guard);
    const counts = async () =>
      (
        await handle.sql`select
          (select count(*)::int from action) as actions,
          (select count(*)::int from approval) as approvals,
          (select count(*)::int from job) as jobs,
          (select count(*)::int from attempt) as attempts,
          (select count(*)::int from push_intent) as pushes,
          (select count(*)::int from event where job_id is not null) as job_events`
      )[0];
    try {
      await inbox().seedInbox(connectionId);
      const before = await counts();
      const service = new TriageService({ sql: handle.sql, classifier: labeller, spending: guard });
      const result = await service.run();
      expect(result.collected).toBe(33);
      // Machine-sent mail is settled by the rules: no model sees it.
      expect(result.byRules).toBe(17);
      expect(result.byModel).toBe(16);
      // Sixteen maybes are one call.
      expect(result.calls).toBe(1);
      expect(toCloud).toHaveLength(1);

      const list = await service.needsYou(personId);
      expect(list.items).toHaveLength(3);
      expect(list.items.map((item) => item.because.subject)).toEqual(
        expect.arrayContaining([
          'Can you sign the renewal by Friday?',
          'Lunch tomorrow - please confirm the time',
          'Board review',
        ]),
      );
      // A model saying "urgent" is read as soon at most, and soon comes first.
      expect(list.items[0]?.because.subject).toBe('Can you sign the renewal by Friday?');
      expect(list.items[0]?.urgency).toBe('soon');
      expect(list.items.every((item) => item.urgency !== 'urgent')).toBe(true);
      for (const item of list.items) {
        expect(item.because.handle).toMatch(/^event:\d+$/);
        expect(item.chat_prompt).toBe(
          `Help me with this item from my Home list (source ${item.because.handle}).`,
        );
      }
      // Sorting took no action of any kind.
      expect(await counts()).toEqual(before);
      expect(before).toMatchObject({ actions: 0, approvals: 0, jobs: 0, pushes: 0 });

      // Charged to the person, as background work on the t1 step.
      const usage = await handle.sql`select principal_id, purpose, class, tier from model_usage`;
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        principal_id: personId,
        purpose: 'triage',
        class: 'background',
        tier: 't1',
      });

      // Seen, then dismissed: it leaves the list.
      const [first] = list.items;
      if (!first) throw new Error('empty list');
      expect((await service.ack(personId, first.id)).seen).toBe(true);
      await service.dismiss(personId, first.id);
      expect((await service.needsYou(personId)).items.map((item) => item.id)).not.toContain(
        first.id,
      );
      // Someone else's item is not theirs to touch.
      const refused = await service.dismiss(newId('own'), first.id).then(
        () => null,
        (error: Error) => error.message,
      );
      expect(refused).toBe('No such item.');
    } finally {
      await labeller.close();
    }
  });

  test('unchanged items are never sorted twice', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    try {
      await inbox().seedInbox(connectionId);
      const service = new TriageService({ sql: handle.sql, classifier: labeller });
      await service.run();
      expect(toCloud).toHaveLength(1);
      // Nothing new: nothing is asked.
      const again = await service.run();
      expect(again).toMatchObject({ collected: 0, calls: 0, byModel: 0 });
      // The same things read again (their items forgotten, the observations
      // still there) are labelled from the cache, with no call.
      await handle.sql`delete from triage_item`;
      const reread = await service.run();
      expect(reread).toMatchObject({ collected: 33, calls: 0, byModel: 0, fromCache: 16 });
      expect(toCloud).toHaveLength(1);
      expect((await service.needsYou(personId)).items).toHaveLength(3);
      // A meeting in a state never labelled before is asked about.
      await inbox().deliverCalendar(connectionId, 'calendar.event.changed', {
        title: 'Board review',
        changed: ['location'],
      });
      expect(await service.run()).toMatchObject({ collected: 1, calls: 1, byModel: 1 });
    } finally {
      await labeller.close();
    }
  });

  test('a private space never reaches a cloud model', async () => {
    if (!handle) return;
    const { classifier: labeller, router } = await classifier();
    try {
      await updateSettings(router, privateSpaceId, { private_space: true });
      await inbox().deliverMail(privateConnectionId, {
        from: 'Dr. Patel <office@clinic.example>',
        subject: 'Can you confirm your follow-up appointment?',
      });
      await inbox().deliverMail(connectionId, {
        from: 'Dana Kim <dana@client.example>',
        subject: 'Can you sign the renewal?',
      });
      const service = new TriageService({ sql: handle.sql, classifier: labeller });
      const first = await service.run();
      expect(first.byModel).toBe(1);
      expect(toCloud.join('\n')).not.toContain('Patel');
      expect(toCloud.join('\n')).not.toContain('follow-up');
      expect(toLocal).toHaveLength(0);
      const [kept] = await handle.sql`select verdict, unsorted from triage_item
        where space_id = ${privateSpaceId}`;
      expect(kept).toMatchObject({ verdict: null, unsorted: 'kept_private' });
      expect((await service.needsYou(personId)).unsorted).toBe(1);

      // With a local model, the private item is sorted there, and only there.
      await updateSettings(router, privateSpaceId, {
        local_model: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.3' },
      });
      router.invalidate(privateSpaceId);
      await handle.sql`update triage_item set triaged_at = now() - interval '2 hours'
        where space_id = ${privateSpaceId}`;
      const second = await service.run();
      expect(second.byModel).toBe(1);
      expect(toLocal.join('\n')).toContain('follow-up');
      expect(toCloud.join('\n')).not.toContain('Patel');
      const subjects = (await service.needsYou(personId)).items.map((i) => i.because.subject);
      expect(subjects).toContain('Can you confirm your follow-up appointment?');
    } finally {
      await labeller.close();
    }
  });

  test('at the background limit nothing is sent, nothing fails, and items wait', async () => {
    if (!handle) return;
    const guard = new SpendingGuard(
      handle.sql,
      limits({ day: { usd: 0.001, tokens: null } }),
      prices,
    );
    const { classifier: labeller } = await classifier(guard);
    try {
      // Background work already spent today's limit.
      await handle.sql`insert into model_usage (id, created_at, space_id, principal_id, purpose,
          provider, model, status, input_tokens, output_tokens, cost_usd, class, tier)
        values (${randomUUID()}, now(), ${spaceId}, ${personId}, 'memory', 'fake',
          'fake-scripted-v1', 'ok', 1000, 1000, 0.01, 'background', 'service')`;
      await inbox().seedInbox(connectionId);
      const service = new TriageService({ sql: handle.sql, classifier: labeller, spending: guard });
      const result = await service.run();
      expect(result).toMatchObject({ collected: 33, byRules: 17, calls: 0, byModel: 0 });
      expect(result.unsorted).toBe(16);
      expect(toCloud).toHaveLength(0);
      const list = await service.needsYou(personId);
      expect(list.items).toHaveLength(0);
      expect(list.unsorted).toBe(16);
    } finally {
      await labeller.close();
    }
  });

  test('sorting off: items are kept, unsorted, and the list stays calm', async () => {
    if (!handle) return;
    await inbox().seedInbox(connectionId);
    const service = new TriageService({ sql: handle.sql, classifier: null });
    const result = await service.run();
    expect(result).toMatchObject({ collected: 33, byRules: 17, calls: 0, unsorted: 16 });
    expect((await service.needsYou(personId)).items).toEqual([]);
  });

  test('something Melete noticed is listed once, by urgency', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    try {
      await inbox().deliverCalendar(connectionId, 'calendar.event.changed', {
        title: 'Board review',
        changed: ['start'],
        key: 'calendar:shared-key',
      });
      await inbox().deliverMail(connectionId, {
        from: 'Dana Kim <dana@client.example>',
        subject: 'Can you sign the renewal?',
      });
      const noticed: NoticedSituation = {
        id: 'sit_01HZZZZZZZZZZZZZZZZZZZZZZZ',
        kind: 'deadline.at_risk',
        subject_key: 'calendar:shared-key',
        urgency: 'urgent',
        person_set: true,
        title: 'The board deck is due in an hour.',
        reason: 'You set this deadline.',
        because: ['clock:clk_1'],
        state: 'open',
        deadline_at: new Date(Date.now() + 3600_000).toISOString(),
        created_at: new Date(Date.now() - 3600_000).toISOString(),
        acked_at: null,
      };
      const service = new TriageService({
        sql: handle.sql,
        classifier: labeller,
        situations: async () => [noticed],
      });
      await service.run();
      const list = await service.needsYou(personId);
      expect(list.items.map((item) => item.source)).toEqual(['situation', 'triage']);
      expect(list.items[0]?.urgency).toBe('urgent');
      expect(list.items[1]?.because.kind).toBe('mail');
    } finally {
      await labeller.close();
    }
  });

  test('a one-time code never reaches the cloud model', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    try {
      await inbox().deliverMail(connectionId, {
        from: 'Startup <team@startup.example>',
        subject: 'Your login code: 482913',
      });
      await inbox().deliverMail(connectionId, {
        from: 'Bank <security@bank.example>',
        subject: '771234 is your verification code',
      });
      const service = new TriageService({ sql: handle.sql, classifier: labeller });
      // Settled by the rules: no call at all.
      expect(await service.run()).toMatchObject({ collected: 2, byRules: 2, calls: 0 });
      // And whatever reaches the gateway has its codes swapped out first.
      const answer = await labeller.label(
        { principalId: personId, spaceId, batchId: 'b1' },
        JSON.stringify({
          items: [
            { id: 'i1', kind: 'mail.received', subject: 'Re: lunch, and my login code: 482913' },
            { id: 'i2', kind: 'mail.received', subject: 'use 902114 to sign in, see you' },
          ],
        }),
      );
      expect(answer.ok).toBe(true);
      expect(toCloud.join('\n')).not.toContain('482913');
      expect(toCloud.join('\n')).not.toContain('902114');
      expect(toCloud.join('\n')).toContain('lunch');
    } finally {
      await labeller.close();
    }
  });

  test('one sensitive item stays private and the rest of its group is still sorted', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    try {
      await inbox().deliverMail(connectionId, {
        from: 'Dana Kim <dana@client.example>',
        subject: 'Can you sign the renewal?',
      });
      await inbox().deliverMail(connectionId, {
        from: 'Town News <editor@townnews.example>',
        subject: 'Inside the rehab centre that changed a town',
      });
      await inbox().deliverMail(connectionId, {
        from: 'Sam Ortiz <sam@friends.example>',
        subject: 'Lunch tomorrow - please confirm the time',
      });
      const service = new TriageService({ sql: handle.sql, classifier: labeller });
      const result = await service.run();
      expect(result.byModel).toBe(2);
      expect(result.unsorted).toBe(1);
      expect(toCloud.join('\n')).not.toContain('rehab');
      const rows = await handle.sql`select fields->>'subject' as subject, verdict, unsorted
        from triage_item order by event_seq`;
      expect(rows.map((row) => [row.subject, row.verdict, row.unsorted])).toEqual([
        ['Can you sign the renewal?', 'needs_you', null],
        ['Inside the rehab centre that changed a town', null, 'kept_private'],
        ['Lunch tomorrow - please confirm the time', 'needs_you', null],
      ]);
      const list = await service.needsYou(personId);
      expect(list.items).toHaveLength(2);
      expect([list.unsorted, list.unsorted_reason]).toEqual([1, 'kept_private']);
    } finally {
      await labeller.close();
    }
  });

  test('an outage or a nonsense answer leaves items unsorted, counted and retried, never filed away', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    let clock = Date.now();
    try {
      await inbox().deliverMail(connectionId, {
        from: 'Dana Kim <dana@client.example>',
        subject: 'Can you sign the renewal?',
      });
      const service = new TriageService({
        sql: handle.sql,
        classifier: labeller,
        now: () => new Date(clock),
      });
      provider = 'down';
      for (let attempt = 0; attempt < 4; attempt++) {
        await service.run();
        clock += 25 * 3600_000;
      }
      provider = 'nonsense';
      await service.run();
      const [row] = await handle.sql`select verdict, unsorted, tries from triage_item`;
      expect(row).toMatchObject({ verdict: null, unsorted: 'failed', tries: 5 });
      expect((await service.needsYou(personId)).unsorted_reason).toBe('failed');
      // Not tried again before its wait is over.
      const calls = toCloud.length;
      expect((await service.run()).calls).toBe(0);
      expect(toCloud.length).toBe(calls);
      // Back up: it is sorted, and needs the person.
      provider = 'answer';
      clock += 25 * 3600_000;
      expect((await service.run()).byModel).toBe(1);
      expect((await service.needsYou(personId)).items).toHaveLength(1);
    } finally {
      await labeller.close();
    }
  });

  test('another person sees none of it, and a week on it is swept', async () => {
    if (!handle) return;
    const { classifier: labeller } = await classifier();
    let clock = Date.now();
    try {
      await inbox().seedInbox(connectionId);
      const service = new TriageService({
        sql: handle.sql,
        classifier: labeller,
        now: () => new Date(clock),
      });
      await service.run();
      const member = newId('own');
      await handle.sql`insert into principal (id, email) values (${member}, ${`${member}@example.test`})`;
      expect(await service.needsYou(member)).toEqual({
        items: [],
        unsorted: 0,
        unsorted_reason: null,
      });
      clock += 8 * 24 * 3600_000;
      await service.sweep();
      const [left] = await handle.sql`select (select count(*)::int from triage_item) as items,
        (select count(*)::int from triage_verdict) as labels`;
      expect(left).toEqual({ items: 0, labels: 0 });
    } finally {
      await labeller.close();
    }
  });
});
