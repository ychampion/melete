/**
 * Pushes from changes of state: a conversation that stopped on the person, and
 * one that answered while they were away. Read from the jobs and turns, paced
 * by the same policy as every other push, deduplicated against the decision
 * cards, throttled per conversation and kind, and silent while a client of the
 * person has focus.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, like } from 'drizzle-orm';
import {
  agent,
  clientFocus,
  experienceTurn,
  job,
  principal,
  pushIntent,
  pushSetting,
  pushSubscription,
  question,
  space,
} from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { answerPreview, PushService } from '../../src/push/service.ts';
import { generateVapidKeys } from '../../src/push/webpush.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
}, 60_000);

const MINUTE = 60_000;

(fixture ? describe : describe.skip)('pushes from changes of state', () => {
  if (!fixture) return;
  const db = fixture.db;
  let push: PushService;

  beforeAll(async () => {
    push = new PushService(db, {
      keys: await generateVapidKeys(),
      subject: 'mailto:owner@example.com',
      extraOrigins: [],
    });
  });

  /** A person with one subscribed device, subscribed an hour ago. */
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
    await db.insert(pushSubscription).values({
      id: newId('psub'),
      principalId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${principalId}`,
      p256dh: 'x',
      auth: 'y',
      createdAt: new Date(Date.now() - 60 * MINUTE),
    });
    return { principalId, spaceId, agentId, since: new Date(Date.now() - 60 * MINUTE) };
  };
  type Person = Awaited<ReturnType<typeof person>>;

  /** A conversation whose current turn ended `status`, with the job in `state`. */
  const conversation = async (
    who: Person,
    shape: {
      state: string;
      status: string;
      wait?: Record<string, unknown>;
      answer?: string;
      finishedAt?: Date;
      kind?: string;
    },
  ) => {
    const jobId = newId('job');
    const turnId = newId('turn');
    await db.insert(job).values({
      id: jobId,
      spaceId: who.spaceId,
      principalId: who.principalId,
      title: 'Book the dentist',
      objective: 'Book the dentist',
      kind: shape.kind ?? 'chat',
      agentId: who.agentId,
      state: shape.state,
      wait: shape.wait ?? { kind: 'none' },
      currentTurnId: turnId,
    });
    await db.insert(experienceTurn).values({
      id: turnId,
      jobId,
      agentId: who.agentId,
      submissionId: `sub:${turnId}`,
      text: 'Book me a dentist for next week.',
      answer: shape.answer ?? '',
      status: shape.status,
      finishedAt: shape.finishedAt ?? new Date(),
    });
    return { jobId, turnId };
  };

  const intents = (who: Person) =>
    db
      .select()
      .from(pushIntent)
      .where(
        and(eq(pushIntent.principalId, who.principalId), like(pushIntent.dedupKey, 'status:%')),
      );

  test('a conversation that stopped on the person is pushed with its reason', async () => {
    const who = await person();
    const { jobId } = await conversation(who, {
      state: 'waiting_for_input',
      status: 'needs_you',
      wait: { kind: 'user_input', question: 'The site wants a code sent to your phone.' },
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    const [only, ...rest] = await intents(who);
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({
      kind: 'needs_you',
      title: 'Book the dentist',
      body: 'The site wants a code sent to your phone.',
      because: 'Because it can’t go on without you.',
      url: `/#/chat/${jobId}`,
      urgency: 'soon',
      droppedAt: null,
    });
    // The same stop, read again, is the same intent.
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(1);
  });

  test('a stop the decision cards already tell of is not pushed twice', async () => {
    const who = await person();
    const { jobId } = await conversation(who, {
      state: 'waiting_for_input',
      status: 'needs_you',
      wait: { kind: 'user_input', question: 'Which day suits you?' },
    });
    await db.insert(question).values({
      id: newId('qst'),
      jobId,
      text: 'Which day suits you?',
      because: ['Your answer decides the next step.'],
      ifIgnored: 'It waits for your answer.',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(0);
    await push.collectDecisions(who.principalId, who.since);
    const decisions = await db
      .select()
      .from(pushIntent)
      .where(eq(pushIntent.principalId, who.principalId));
    expect(decisions.map((row) => row.kind)).toEqual(['decision']);
  });

  test('a reminder resting on its timer, and a finished turn waiting for more, are not stops', async () => {
    const who = await person();
    await conversation(who, {
      state: 'waiting_for_event_or_time',
      status: 'needs_you',
      wait: { kind: 'timer', wake_at: new Date(Date.now() + 5 * MINUTE).toISOString() },
    });
    await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      wait: { kind: 'user_input', question: 'What would you like to do next?' },
      answer: '',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(0);
  });

  test('an answer that came while the person was away is pushed with a preview', async () => {
    const who = await person();
    const { jobId, turnId } = await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      wait: { kind: 'user_input', question: 'What would you like to do next?' },
      answer: '**Booked.** Dr. Rao, [Tuesday at 9](https://example.com/booking).',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    const [only] = await intents(who);
    expect(only).toMatchObject({
      kind: 'done',
      body: 'Booked. Dr. Rao, Tuesday at 9.',
      because: 'Because it finished while you were away.',
      url: `/#/chat/${jobId}`,
      dedupKey: `status:done:${jobId}:${turnId}`,
      droppedAt: null,
    });
  });

  test('an answer that came while a client had focus is not pushed, and one waiting is dropped once seen', async () => {
    const who = await person();
    await push.focus(who.principalId);
    await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      answer: 'Done while you watched.',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(0);

    // Away: the focus is old, so the next answer is told.
    await db
      .update(clientFocus)
      .set({ focusedAt: new Date(Date.now() - 30 * MINUTE) })
      .where(eq(clientFocus.principalId, who.principalId));
    await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      answer: 'Done while you were out.',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    const [waiting] = await intents(who);
    expect(waiting?.droppedAt).toBeNull();
    // They come back before it goes out: nothing left to tell.
    await push.focus(who.principalId);
    await push.collectStatus(who.principalId, who.since, new Date());
    const [seen] = await intents(who);
    expect(seen?.droppedAt).not.toBeNull();
  });

  test('one push per conversation and kind inside the throttle window', async () => {
    const who = await person();
    const first = await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      answer: 'First answer.',
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    // A second answer in the same conversation, a minute later.
    const second = newId('turn');
    await db.insert(experienceTurn).values({
      id: second,
      jobId: first.jobId,
      agentId: who.agentId,
      submissionId: `sub:${second}`,
      text: 'And the hygienist?',
      answer: 'Second answer.',
      status: 'done',
      finishedAt: new Date(),
    });
    // Another conversation is not held back by the first.
    await conversation(who, { state: 'waiting_for_input', status: 'done', answer: 'Elsewhere.' });
    await push.collectStatus(who.principalId, who.since, new Date());
    const rows = await intents(who);
    const byKey = new Map(rows.map((row) => [row.dedupKey, row]));
    expect(rows).toHaveLength(3);
    expect(byKey.get(`status:done:${first.jobId}:${first.turnId}`)?.droppedAt).toBeNull();
    expect(byKey.get(`status:done:${first.jobId}:${second}`)?.droppedAt).not.toBeNull();
    expect(rows.filter((row) => row.droppedAt === null)).toHaveLength(2);
  });

  test('a stop whose job moved on is dropped before it goes out', async () => {
    const who = await person();
    const { jobId } = await conversation(who, {
      state: 'waiting_for_input',
      status: 'needs_you',
      wait: { kind: 'user_input', question: 'Sign in to the clinic site.' },
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    await db.update(job).set({ state: 'running', stateVersion: 1 }).where(eq(job.id, jobId));
    await push.collectStatus(who.principalId, who.since, new Date());
    const [moved] = await intents(who);
    expect(moved?.droppedAt).not.toBeNull();
  });

  test('the person’s switches are respected', async () => {
    const who = await person();
    await db
      .insert(pushSetting)
      .values({ principalId: who.principalId, decisions: false, settled: false });
    await conversation(who, {
      state: 'waiting_for_input',
      status: 'needs_you',
      wait: { kind: 'user_input', question: 'Approve the card on the page.' },
    });
    await conversation(who, { state: 'waiting_for_input', status: 'done', answer: 'Done.' });
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(0);
  });

  test('news from before the first device, or older than the lookback, is not pushed', async () => {
    const who = await person();
    await conversation(who, {
      state: 'waiting_for_input',
      status: 'done',
      answer: 'Old news.',
      finishedAt: new Date(Date.now() - 2 * 60 * MINUTE),
    });
    await push.collectStatus(who.principalId, who.since, new Date());
    expect(await intents(who)).toHaveLength(0);
  });

  test('a pass clears pushes that went out, were dropped or never went, once old', async () => {
    const who = await person();
    const { jobId } = await conversation(who, { state: 'running', status: 'running' });
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 86_400_000);
    const recent = new Date(now.getTime() - 2 * 86_400_000);
    const openQuestion = newId('qst');
    await db.insert(question).values({
      id: openQuestion,
      jobId,
      text: 'Which day suits you?',
      because: ['Your answer decides the next step.'],
      ifIgnored: 'It waits for your answer.',
    });
    const intent = (
      key: string,
      at: Date,
      shape: { sent?: boolean; dropped?: boolean; kind?: string },
    ) =>
      db.insert(pushIntent).values({
        id: newId('pint'),
        principalId: who.principalId,
        kind: shape.kind ?? 'done',
        title: 'Book the dentist',
        body: 'Done.',
        because: 'Because it finished while you were away.',
        url: `/#/chat/${jobId}`,
        dedupKey: key,
        createdAt: at,
        ...(shape.sent ? { sentAt: at, batchId: newId('pbat') } : {}),
        ...(shape.dropped ? { droppedAt: at } : {}),
      });
    const tag = who.principalId;
    await intent(`sweep:${tag}:sent-old`, old, { sent: true });
    await intent(`sweep:${tag}:dropped-old`, old, { dropped: true });
    await intent(`sweep:${tag}:waiting-old`, old, {});
    await intent(`sweep:${tag}:sent-recent`, recent, { sent: true });
    // Still open: its row is what keeps it from being told again.
    await intent(`decision:question:${openQuestion}`, old, { sent: true, kind: 'decision' });

    await new PushService(db, { keys: null, subject: null, extraOrigins: [] }).runOnce(now);

    const left = await db
      .select({ key: pushIntent.dedupKey })
      .from(pushIntent)
      .where(eq(pushIntent.principalId, who.principalId));
    expect(left.map((row) => row.key).sort()).toEqual(
      [`decision:question:${openQuestion}`, `sweep:${tag}:sent-recent`].sort(),
    );
  });

  test('a preview is plain words, clipped for a lock screen', () => {
    expect(answerPreview('# Plan\n\n- **one**\n- `two`\n```\ncode\n```')).toBe('Plan - one - two');
    expect(answerPreview('x'.repeat(500))).toHaveLength(200);
  });
});
