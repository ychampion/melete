/**
 * A reminder that comes due is noticeable wherever the person is: its chat is
 * unread, and Home's "Needs you" lists it, until they open that chat. An
 * ordinary answer, a reminder still being written, and a chat the person has
 * written in since are not unread.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { conversationList, conversationResponse, needsYouList } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { agent, experienceTurn, job, owner, principal, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { cameDueUnseen, unseenReminders } from '../../src/experience/unread.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { openWakeTurn } from '../../src/jobs/wake-turn.ts';
import type { NoticedSituation } from '../../src/triage/service.ts';
import { TriageService } from '../../src/triage/service.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
}, 60_000);

(fixture ? describe : describe.skip)('a reminder that came due waits for the person', () => {
  if (!fixture) return;
  const { db, sql } = fixture;
  const experience = new ExperienceService(db);

  const person = async () => {
    const principalId = newId('own');
    const spaceId = newId('sp');
    const agentId = newId('agent');
    await db.insert(principal).values({ id: principalId, email: `${principalId}@example.com` });
    await db.insert(space).values({
      id: spaceId,
      name: 'personal',
      kind: 'personal',
      ownerPrincipalId: principalId,
      gitPath: `/data/spaces/${spaceId}`,
    });
    await db.insert(agent).values({
      id: agentId,
      spaceId,
      name: 'Melete',
      role: 'assistant',
      colour: 'blue',
      surface: 'paper',
      eyeColour: 'dark',
      tone: 'plain',
      standingInstruction: '',
      isDefault: true,
    });
    return { principalId, spaceId, agentId };
  };
  type Person = Awaited<ReturnType<typeof person>>;

  /** A chat resting on a reminder the person asked for. */
  const chat = async (who: Person, title = 'Call Sam back') => {
    const jobId = newId('job');
    await db.insert(job).values({
      id: jobId,
      spaceId: who.spaceId,
      principalId: who.principalId,
      title,
      objective: `Remind me to ${title.toLowerCase()}.`,
      kind: 'chat',
      agentId: who.agentId,
      state: 'waiting_for_input',
      wait: { kind: 'none' },
    });
    return jobId;
  };

  const row = async (jobId: string) => {
    const [found] = await db.select().from(job).where(eq(job.id, jobId));
    if (!found) throw new Error('job missing');
    return found;
  };

  /** The timer fires and opens its own turn, as the runner does; `answer` finishes it. */
  const fire = async (jobId: string, key: string, answer?: string) => {
    const woke = await db.transaction(async (tx) => openWakeTurn(tx, await row(jobId), key));
    const turnId = woke.currentTurnId;
    if (!turnId) throw new Error('no wake turn');
    await db
      .update(experienceTurn)
      .set(
        answer === undefined
          ? { status: 'streaming' }
          : { answer, status: 'done', finishedAt: new Date() },
      )
      .where(eq(experienceTurn.id, turnId));
    return turnId;
  };

  const finish = (turnId: string, answer: string) =>
    db
      .update(experienceTurn)
      .set({ answer, status: 'done', finishedAt: new Date() })
      .where(eq(experienceTurn.id, turnId));

  const view = async (jobId: string) => experience.view(await row(jobId));
  const needsYou = (who: Person) =>
    new TriageService({
      sql,
      classifier: null,
      reminders: (principalId) => unseenReminders(sql, principalId),
    }).needsYou(who.principalId);

  test('the chat is unread and Home lists it until the person opens the chat', async () => {
    const who = await person();
    const jobId = await chat(who);
    const turnId = await fire(jobId, 'timer:1', 'Time to call Sam back.');

    expect((await view(jobId)).unread).toBe(true);
    const listed = (await needsYou(who)).items;
    expect(listed).toEqual([
      expect.objectContaining({
        id: turnId,
        source: 'reminder',
        sentence: 'Time to call Sam back.',
        conversation_id: jobId,
        seen: false,
        because: expect.objectContaining({ kind: 'reminder', subject: 'Call Sam back' }),
      }),
    ]);

    // Opening the chat is seeing it.
    const seen = await experience.seen(who.spaceId, jobId);
    expect(seen.conversation.unread).toBeUndefined();
    expect((await view(jobId)).unread).toBeUndefined();
    expect((await needsYou(who)).items).toEqual([]);
  });

  test('an ordinary answer is not unread', async () => {
    const who = await person();
    const jobId = await chat(who, 'Packing list');
    const turnId = newId('turn');
    await db.insert(experienceTurn).values({
      id: turnId,
      jobId,
      agentId: who.agentId,
      submissionId: `sub:${jobId}`,
      text: 'Make me a packing list.',
      answer: 'Here is your packing list.',
      status: 'done',
      finishedAt: new Date(),
    });
    await db.update(job).set({ currentTurnId: turnId }).where(eq(job.id, jobId));
    expect((await view(jobId)).unread).toBeUndefined();
    expect((await needsYou(who)).items).toEqual([]);
  });

  test('a reminder still being written is not unread, and opening the chat then does not hide it', async () => {
    const who = await person();
    const jobId = await chat(who);
    const turnId = await fire(jobId, 'timer:2');
    expect((await view(jobId)).unread).toBeUndefined();
    // The person looks while it is still being written...
    await experience.seen(who.spaceId, jobId);
    // ...and it finishes after: what they did not see yet is still unread.
    await finish(turnId, 'Time to call Sam back.');
    expect((await view(jobId)).unread).toBe(true);
    expect((await needsYou(who)).items.map((item) => item.id)).toEqual([turnId]);
  });

  test('a second reminder in a chat already seen is unread again', async () => {
    const who = await person();
    const jobId = await chat(who, 'Medication');
    await fire(jobId, 'timer:1', 'Take the first pill.');
    await experience.seen(who.spaceId, jobId);
    const second = await fire(jobId, 'timer:2', 'Take the second pill.');
    expect((await view(jobId)).unread).toBe(true);
    expect((await needsYou(who)).items).toEqual([
      expect.objectContaining({ id: second, sentence: 'Take the second pill.' }),
    ]);
  });

  test('a message the person sends in the chat ends it, as being there sees it', async () => {
    const who = await person();
    const jobId = await chat(who);
    await fire(jobId, 'timer:1', 'Time to call Sam back.');
    const reply = newId('turn');
    await db.insert(experienceTurn).values({
      id: reply,
      jobId,
      agentId: who.agentId,
      submissionId: `sub:${reply}`,
      text: 'Done, thanks.',
    });
    await db.update(job).set({ currentTurnId: reply }).where(eq(job.id, jobId));
    expect((await view(jobId)).unread).toBeUndefined();
    expect((await needsYou(who)).items).toEqual([]);
  });

  test('another person never sees it, and a chat of another person cannot be marked seen', async () => {
    const who = await person();
    const other = await person();
    const jobId = await chat(who);
    await fire(jobId, 'timer:1', 'Time to call Sam back.');
    expect((await needsYou(other)).items).toEqual([]);
    await expect(experience.seen(other.spaceId, jobId)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await view(jobId)).unread).toBe(true);
  });

  test('a reminder that came due ranks after urgent items and before the rest', async () => {
    const who = await person();
    const jobId = await chat(who);
    const turnId = await fire(jobId, 'timer:1', 'Time to call Sam back.');
    const noticed = (id: string, urgency: 'urgent' | 'soon'): NoticedSituation =>
      ({
        id,
        kind: 'meeting.changed',
        state: 'open',
        title: `Noticed ${urgency}`,
        reason: 'A meeting moved.',
        because: [],
        subject_key: `subject:${id}`,
        deadline_at: null,
        urgency,
        person_set: urgency === 'urgent',
        acked_at: null,
        created_at: new Date().toISOString(),
      }) as unknown as NoticedSituation;
    const service = new TriageService({
      sql,
      classifier: null,
      reminders: (principalId) => unseenReminders(sql, principalId),
      situations: async () => [noticed('sit_soon', 'soon'), noticed('sit_urgent', 'urgent')],
    });
    const order = (await service.needsYou(who.principalId)).items.map((item) => item.id);
    expect(order).toEqual(['sit_urgent', turnId, 'sit_soon']);
  });

  test('the rule in hand and the rule in SQL agree on every turn shape', async () => {
    const who = await person();
    const shapes: Array<{ submission: string; status: string; answer: string; seen: boolean }> = [];
    for (const submission of ['wake:x:timer:1', 'sub:x'])
      for (const status of ['done', 'streaming', 'failed', 'needs_you'])
        for (const answer of ['Time to go.', '   '])
          for (const seen of [false, true]) shapes.push({ submission, status, answer, seen });
    for (const shape of shapes) {
      const jobId = await chat(who, `Shape ${shapes.indexOf(shape)}`);
      const turnId = newId('turn');
      await db.insert(experienceTurn).values({
        id: turnId,
        jobId,
        agentId: who.agentId,
        submissionId: shape.submission.replace('x', jobId),
        text: '',
        answer: shape.answer,
        status: shape.status,
        finishedAt: new Date(),
        seenAt: shape.seen ? new Date() : null,
      });
      await db.update(job).set({ currentTurnId: turnId }).where(eq(job.id, jobId));
    }
    const listed = new Set((await needsYou(who)).items.map((item) => item.conversation_id));
    const rows = await db.select().from(job).where(eq(job.principalId, who.principalId));
    let unread = 0;
    for (const found of rows) {
      const [turn] = await db
        .select()
        .from(experienceTurn)
        .where(eq(experienceTurn.id, found.currentTurnId ?? ''));
      const inHand = cameDueUnseen(found, turn);
      expect({ id: found.title, listed: listed.has(found.id) }).toEqual({
        id: found.title,
        listed: inHand,
      });
      expect((await experience.view(found)).unread === true).toBe(inHand);
      if (inHand) unread += 1;
    }
    // Only a finished wake with words, not seen yet.
    expect(unread).toBe(1);
  });

  test('over HTTP: the chat list, Home and opening the chat agree', async () => {
    const app = createApp({
      db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql,
      checkDatabase: async () => 'ok',
    });
    const ownerId = newId('own');
    const spaceId = newId('sp');
    const agentId = newId('agent');
    const token = randomBytes(32).toString('base64url');
    await db.insert(owner).values({ id: ownerId, email: `${ownerId}@example.test` });
    await sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
    await db.insert(space).values({
      id: spaceId,
      name: 'Personal',
      kind: 'personal',
      ownerPrincipalId: ownerId,
      gitPath: `/spaces/${spaceId}`,
    });
    await db.insert(agent).values({
      id: agentId,
      spaceId,
      name: 'Melete',
      role: 'assistant',
      colour: 'blue',
      surface: 'paper',
      eyeColour: 'dark',
      tone: 'plain',
      standingInstruction: '',
      isDefault: true,
    });
    await db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId,
      spaceId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const request = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Cookie: `melete_session=${token}` } });
    const jobId = await chat({ principalId: ownerId, spaceId, agentId });
    const turnId = await fire(jobId, 'timer:1', 'Time to call Sam back.');

    const listed = conversationList.parse(await (await request('/conversations')).json());
    expect(listed.conversations.find((c) => c.id === jobId)?.unread).toBe(true);
    const home = needsYouList.parse(await (await request('/needs-you')).json());
    expect(home.items.map((item) => [item.source, item.id, item.conversation_id])).toEqual([
      ['reminder', turnId, jobId],
    ]);

    const opened = await request(`/conversations/${jobId}/seen`, { method: 'POST' });
    expect(opened.status).toBe(200);
    expect(conversationResponse.parse(await opened.json()).conversation.unread).toBeUndefined();
    const after = conversationList.parse(await (await request('/conversations')).json());
    expect(after.conversations.find((c) => c.id === jobId)?.unread).toBeUndefined();
    expect(needsYouList.parse(await (await request('/needs-you')).json()).items).toEqual([]);
    // Someone else's chat is not found, so not marked.
    expect((await request(`/conversations/${newId('job')}/seen`, { method: 'POST' })).status).toBe(
      404,
    );
  });
});
