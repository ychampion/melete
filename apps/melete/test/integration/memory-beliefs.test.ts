/**
 * "What I believe about you", end to end against Postgres: a correction is the
 * person's own word and keeps the old value in history; undoing a day puts
 * every belief back exactly and can itself be undone; the weekly digest names
 * the week's changes; an action records what it rested on when it is proposed;
 * beliefs survive export and import, and a change of model.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Belief, claimHandleOf } from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { ExperienceMemory } from '../../src/experience/memory.ts';
import { actionBecause } from '../../src/memory/basis.ts';
import { beliefHistory, blockBelief, listBeliefs, listBlocks } from '../../src/memory/beliefs.ts';
import { type MemoryScope, provisionMemorySpace } from '../../src/memory/db.ts';
import { latestDigest, writeDueDigest } from '../../src/memory/digest.ts';
import { ingest } from '../../src/memory/evidence.ts';
import type { ExtractionGateway } from '../../src/memory/extract.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import {
  beliefMarkdown,
  exportBeliefFile,
  importBeliefFile,
  parseBeliefMarkdown,
} from '../../src/memory/portable.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import {
  applyRewind,
  memoryTimeline,
  previewRewind,
  resolveTarget,
  undoRewind,
} from '../../src/memory/rewind.ts';
import { runExtractionWork } from '../../src/memory/service.ts';
import { addDays, localDay, zonedInstant } from '../../src/memory/zoned.ts';
import { seedJob } from '../helpers/broker.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-beliefs-'));
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = db ? describe : describe.skip;

async function journalFor(name: string) {
  const journal = new FileRestrictionJournal(join(root, `${name}-${crypto.randomUUID()}.jsonl`));
  await journal.initializeNew();
  return journal;
}
const experienceScope = (scope: MemoryScope): MemoryScope => ({
  ...scope,
  publisher: 'experience',
});
/** What a person sees of their beliefs, without the fields that move on every write. */
const seen = (beliefs: Belief[]) =>
  beliefs
    .map((belief) => ({
      id: belief.id,
      label: belief.label,
      value: belief.value,
      category: belief.category,
      trust: belief.trust,
      corrected: belief.corrected,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
async function setRecordedAt(db: TestDatabase, claimId: string, at: Date) {
  await db.sql`update memory_revisions set recorded_at = ${at.toISOString()}
    where claim_id = ${claimId} and revision = (select head_revision from memory_claims where id = ${claimId})`;
}
async function keyed(db: TestDatabase, scope: MemoryScope, key: string) {
  const [row] =
    await db.sql`select id from memory_claims where space_id = ${scope.spaceId} and key = ${key}`;
  return String(row?.id);
}
const pref = (db: TestDatabase, scope: MemoryScope, key: string, value: string, eventAt: string) =>
  record(db, scope, { identity: `${key}:${value}`, text: `I like ${value}.`, eventAt }, [
    { key, content: value, quote: value, kind: 'preference' },
  ]);

withDb('beliefs a person can see and correct', () => {
  test('a correction is the person’s own word, supersedes the belief and keeps its history', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await pref(db, scope, 'pref.coffee.order', 'flat white', '2026-09-01T09:00:00Z');
    const memory = new ExperienceMemory(db.sql);
    const [before] = await listBeliefs(db.sql, scope, 'UTC');
    expect(before).toMatchObject({
      label: 'Coffee: order',
      value: 'flat white',
      category: 'preferences',
      trust: 'yours',
      corrected: false,
      earlier: 0,
    });
    expect(before?.source.text).toBe('an assistant you connected saved this, Sep 1');

    await memory.edit(scope.spaceId, scope.ownerId, String(before?.id), {
      value: 'oat flat white',
      version: before?.version,
    });
    const [after] = await listBeliefs(db.sql, scope, 'UTC');
    expect(after).toMatchObject({
      id: before?.id,
      value: 'oat flat white',
      trust: 'yours',
      corrected: true,
      earlier: 1,
    });
    expect(after?.source.kind).toBe('correction');
    expect(after?.source.text).toStartWith('you corrected this, ');
    const [revision] = await db.sql`select r.protected, r.origin_trust from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision where c.id = ${String(before?.id)}`;
    expect(revision).toMatchObject({ protected: true, origin_trust: 'owner' });
    const history = await beliefHistory(db.sql, scope, String(before?.id), 'UTC');
    expect(history.versions.map((version) => [version.value, version.current])).toEqual([
      ['oat flat white', true],
      ['flat white', false],
    ]);
    // An edit made against the old version is refused, not applied on top.
    const stale = await memory
      .edit(scope.spaceId, scope.ownerId, String(before?.id), {
        value: 'espresso',
        version: before?.version,
      })
      .then(
        () => 'applied',
        (error: unknown) => (error as { code?: string }).code ?? 'refused',
      );
    expect(stale).toBe('item_changed');
  });

  test('forget and don’t learn again: the subject is refused when proposed again', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await pref(db, scope, 'pref.music.genre', 'jazz', '2026-09-02T09:00:00Z');
    const id = await keyed(db, scope, 'pref.music.genre');
    await blockBelief(db.sql, experienceScope(scope), id, await journalFor('block'));
    expect(await listBeliefs(db.sql, scope, 'UTC')).toEqual([]);
    expect((await listBlocks(db.sql, scope)).blocks.map((block) => block.label)).toEqual([
      'Music: genre',
    ]);
    const again = await pref(db, scope, 'pref.music.genre', 'blues', '2026-09-03T09:00:00Z');
    expect(again.claim_ids).toEqual([]);
    expect(await listBeliefs(db.sql, scope, 'UTC')).toEqual([]);
    const [rejection] =
      await db.sql`select reason from memory_rejections where space_id = ${scope.spaceId}`;
    expect(rejection?.reason).toBe('blocked_by_person');
  });
});

withDb('rewinding a day', () => {
  test('undoing a day is exact, and undoing the undo puts everything back', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const zone = 'America/New_York';
    await db.sql`insert into experience_profile (space_id, time_zone) values (${scope.spaceId}, ${zone})`;
    const now = new Date();
    const dayOne = localDay(new Date(now.getTime() - 3 * 86_400_000), zone);
    const dayTwo = addDays(dayOne, 1);
    const on = (day: string, time: string) => zonedInstant(day, time, zone);

    // Day one: two preferences learned.
    await pref(db, scope, 'pref.coffee.order', 'flat white', on(dayOne, '09:00').toISOString());
    const coffee = await keyed(db, scope, 'pref.coffee.order');
    await setRecordedAt(db, coffee, on(dayOne, '09:05'));
    await pref(db, scope, 'pref.gym.days', 'tuesdays', on(dayOne, '18:00').toISOString());
    await setRecordedAt(db, await keyed(db, scope, 'pref.gym.days'), on(dayOne, '18:05'));
    const endOfDayOne = seen(await listBeliefs(db.sql, scope, zone));

    // Day two: one corrected, one new.
    const memory = new ExperienceMemory(db.sql);
    const coffeeBelief = (await listBeliefs(db.sql, scope, zone)).find((b) => b.id === coffee);
    await memory.edit(scope.spaceId, scope.ownerId, coffee, {
      value: 'oat flat white',
      version: coffeeBelief?.version,
    });
    await setRecordedAt(db, coffee, on(dayTwo, '10:00'));
    await pref(db, scope, 'pref.meetings.time', 'afternoons', on(dayTwo, '11:00').toISOString());
    const meetings = await keyed(db, scope, 'pref.meetings.time');
    await setRecordedAt(db, meetings, on(dayTwo, '11:05'));
    const endOfDayTwo = seen(await listBeliefs(db.sql, scope, zone));
    expect(endOfDayTwo).toHaveLength(3);

    const timeline = await memoryTimeline(db.sql, scope, zone, 30, now);
    const byDay = new Map(timeline.days.map((day) => [day.day, day]));
    expect(
      byDay
        .get(dayTwo)
        ?.changes.map((c) => [c.label, c.change])
        .sort(),
    ).toEqual([
      ['Coffee: order', 'corrected'],
      ['Meetings: time', 'learned'],
    ]);
    expect(byDay.get(dayOne)?.changes.map((c) => c.change)).toEqual(['learned', 'learned']);

    const window = await resolveTarget(db.sql, scope, { day: dayTwo }, zone);
    const preview = await previewRewind(db.sql, scope, window);
    expect(preview.steps.map((step) => [step.label, step.from, step.to]).sort()).toEqual([
      ['Coffee: order', 'oat flat white', 'flat white'],
      ['Meetings: time', 'afternoons', null],
    ]);
    const rewind = await applyRewind(db.sql, scope, window, { day: dayTwo });
    expect(rewind.steps).toHaveLength(2);
    // Exactly the state at the end of day one: value, trust and source class.
    expect(seen(await listBeliefs(db.sql, scope, zone))).toEqual(endOfDayOne);
    // A belief set aside is not recalled.
    const [aside] = await db.sql`select r.status from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision where c.id = ${meetings}`;
    expect(aside?.status).toBe('retracted');
    // Nothing was erased: the corrected value is still in the history.
    const history = await beliefHistory(db.sql, scope, coffee, zone);
    expect(history.versions.map((v) => v.value)).toContain('oat flat white');

    const undone = await undoRewind(db.sql, scope, rewind.id);
    expect(undone.undone_at).not.toBeNull();
    expect(seen(await listBeliefs(db.sql, scope, zone))).toEqual(endOfDayTwo);
    // Undoing twice changes nothing more.
    await undoRewind(db.sql, scope, rewind.id);
    expect(seen(await listBeliefs(db.sql, scope, zone))).toEqual(endOfDayTwo);
    // The rewind's own revisions are not "learned": day two still reads as before.
    const later = await memoryTimeline(db.sql, scope, zone, 30, new Date());
    expect(
      later.days
        .find((day) => day.day === dayTwo)
        ?.changes.map((c) => c.change)
        .sort(),
    ).toEqual(['corrected', 'learned']);
  });

  test('a belief set aside by a rewind is learned again when it is said again', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const yesterday = localDay(new Date(Date.now() - 86_400_000), 'UTC');
    await pref(db, scope, 'pref.tea.kind', 'green tea', `${yesterday}T09:00:00Z`);
    const tea = await keyed(db, scope, 'pref.tea.kind');
    await setRecordedAt(db, tea, new Date(`${yesterday}T09:01:00Z`));
    const window = await resolveTarget(db.sql, scope, { day: yesterday }, 'UTC');
    await applyRewind(db.sql, scope, window, { day: yesterday });
    expect(await listBeliefs(db.sql, scope, 'UTC')).toEqual([]);
    await pref(db, scope, 'pref.tea.kind', 'black tea', new Date().toISOString());
    expect((await listBeliefs(db.sql, scope, 'UTC')).map((b) => [b.id, b.value])).toEqual([
      [tea, 'black tea'],
    ]);
  });
});

withDb('the weekly digest', () => {
  test('it lists the week’s new and changed beliefs, once, on Sunday morning local time', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const zone = 'Asia/Kolkata';
    await db.sql`insert into experience_profile (space_id, time_zone, day_start, day_end)
      values (${scope.spaceId}, ${zone}, '08:00', '22:00')`;
    // Sunday 27 September 2026, 08:00 in Kolkata, covers the week from Sunday the 20th.
    const sunday = '2026-09-27';
    await pref(db, scope, 'pref.coffee.order', 'flat white', '2026-09-10T09:00:00Z');
    const coffee = await keyed(db, scope, 'pref.coffee.order');
    await setRecordedAt(db, coffee, new Date('2026-09-10T09:00:00Z'));
    const memory = new ExperienceMemory(db.sql);
    const [coffeeBelief] = await listBeliefs(db.sql, scope, zone);
    await memory.edit(scope.spaceId, scope.ownerId, coffee, {
      value: 'oat flat white',
      version: coffeeBelief?.version,
    });
    await setRecordedAt(db, coffee, new Date('2026-09-24T06:00:00Z'));
    await pref(db, scope, 'pref.gym.days', 'tuesdays', '2026-09-22T09:00:00Z');
    await setRecordedAt(
      db,
      await keyed(db, scope, 'pref.gym.days'),
      new Date('2026-09-22T09:00:00Z'),
    );
    // Learned before the week began: not in it.
    await pref(db, scope, 'pref.tea.kind', 'green tea', '2026-09-19T09:00:00Z');
    await setRecordedAt(
      db,
      await keyed(db, scope, 'pref.tea.kind'),
      new Date('2026-09-19T09:00:00Z'),
    );
    // Learned after the digest's cut-off: next week's.
    await pref(db, scope, 'pref.walks.time', 'evenings', '2026-09-27T03:00:00Z');
    await setRecordedAt(
      db,
      await keyed(db, scope, 'pref.walks.time'),
      new Date('2026-09-27T03:00:00Z'),
    );

    // Saturday evening (last week's is six days old) and Sunday 07:30 local: none due.
    expect(await writeDueDigest(db.sql, scope, new Date('2026-09-26T14:00:00Z'))).toBeNull();
    expect(await writeDueDigest(db.sql, scope, zonedInstant(sunday, '07:30', zone))).toBeNull();
    // Sunday 08:30 local: due, for this week.
    const at = zonedInstant(sunday, '08:30', zone);
    const digest = await writeDueDigest(db.sql, scope, at);
    expect(digest?.week_of).toBe(sunday);
    expect(digest?.window_start).toBe(zonedInstant('2026-09-20', '08:00', zone).toISOString());
    expect(
      digest?.items.map((item) => [item.label, item.change, item.value, item.previous]),
    ).toEqual([
      ['Coffee: order', 'corrected', 'oat flat white', 'flat white'],
      ['Gym: days', 'learned', 'tuesdays', null],
    ]);
    expect(digest?.items.every((item) => item.current && item.version)).toBe(true);
    // Written once.
    expect(await writeDueDigest(db.sql, scope, new Date(at.getTime() + 3_600_000))).toBeNull();
    // Correcting a belief after the digest withdraws its inline actions.
    const [gym] = (await listBeliefs(db.sql, scope, zone)).filter((b) => b.label === 'Gym: days');
    await memory.edit(scope.spaceId, scope.ownerId, String(gym?.id), {
      value: 'tuesdays and fridays',
      version: gym?.version,
    });
    const latest = await latestDigest(db.sql, scope, at);
    expect(latest.digest?.items.find((item) => item.label === 'Gym: days')).toMatchObject({
      current: false,
      version: null,
    });
    expect(latest.next_at).toBe(zonedInstant('2026-10-04', '08:00', zone).toISOString());
  });
});

withDb('why an action was taken', () => {
  test('the beliefs recalled for the turn are recorded when the action is proposed', async () => {
    if (!db) return;
    const seed = await seedJob(db.sql);
    const spaceId = seed.claims.space_id;
    const [owner] = await db.sql`select id from owner limit 1`;
    const ownerId = owner
      ? String(owner.id)
      : String(
          (
            await db.sql`insert into owner (id, email) values ('own_basis', 'basis@example.test') returning id`
          )[0]?.id,
        );
    await provisionMemorySpace(db.sql, ownerId, spaceId);
    await db.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
    const scope: MemoryScope = {
      ownerId,
      spaceId,
      publisher: 'authenticated-owner',
      audience: 'private',
      role: 'owner',
    };
    await pref(db, scope, 'pref.dinner.time', 'seven', '2026-09-20T09:00:00Z');
    const dinner = await keyed(db, scope, 'pref.dinner.time');
    // Memory handed the attempt this belief.
    await db.sql`insert into memory_contexts (id, space_id, job_id, attempt_id, job_revision, policy_generation,
        data_revision, access_generation, audience, purpose, items, recipe, token_budget, recall_status)
      values ('ctx_basis', ${spaceId}, ${seed.claims.job_id}, ${seed.claims.attempt_id}, 0, 1, 1, 1,
        '["private"]'::jsonb, 'chat',
        ${JSON.stringify([{ claim_id: dinner, revision: 1, handle: claimHandleOf(dinner, 1), key: 'pref.dinner.time', origin_trust: 'owner', sources: [] }])}::text::jsonb,
        'simple-lexical-v1', '{}'::jsonb, 'complete')`;
    const connector = {
      manifest: {
        name: 'test',
        provider: 'test',
        version: '0.1.0',
        description: 'fixture',
        credentials: [],
        health: true,
        tools: [
          {
            name: 'test.send',
            description: 'send',
            input_schema: { type: 'object' },
            effect_class: 'write_external',
            required_scopes: ['test.send'],
            requires_approval: true,
            verify: false,
          },
        ],
      },
      async execute() {
        throw new Error('not dispatched in this test');
      },
      async verify() {
        return { decision: 'unsupported', reason: 'fixture' };
      },
      async health() {
        return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
      },
    } as unknown as Connector;
    const broker = new BrokerService({
      sql: db.sql,
      connectors: { get: (id: string) => (id === seed.connectionId ? connector : undefined) },
    });
    const proposal = await broker.propose(seed.claims, {
      kind: 'test.send',
      connection_id: seed.connectionId,
      payload: { to: 'maya@example.com', body: 'Dinner at seven?' },
    });
    expect(proposal.status).toBe('needs_approval');
    const [basis] =
      await db.sql`select * from memory_action_basis where action_id = ${proposal.action_id}`;
    expect(basis?.attempt_id).toBe(seed.claims.attempt_id);
    const recalled = await actionBecause(db.sql, spaceId, proposal.action_id);
    expect(recalled).toEqual([
      { kind: 'belief', id: dinner, label: 'Dinner: time: seven', basis: 'recalled' },
    ]);
    // When the runtime declares what the action used, that is what is named.
    await pref(db, scope, 'pref.wine.kind', 'red', '2026-09-20T10:00:00Z');
    const wine = await keyed(db, scope, 'pref.wine.kind');
    await recordOutput(db.sql, scope, {
      job_id: seed.claims.job_id,
      attempt_id: seed.claims.attempt_id,
      kind: 'action',
      output_id: proposal.action_id,
      output_version: '1',
      uses: [claimHandleOf(wine, 1)],
    });
    expect(await actionBecause(db.sql, spaceId, proposal.action_id)).toEqual([
      { kind: 'belief', id: wine, label: 'Wine: kind: red', basis: 'declared' },
    ]);
  });
});

withDb('automatic memory with a real model’s answer', () => {
  test('a reply with no op, a fence, a reasoning block and a short offset is kept', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const text = 'Email and admin is what eats my week right now.';
    await ingest(db.sql, scope, {
      stream: 'chat',
      source_identity: 'realistic',
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: new Date().toISOString(),
      text,
    });
    const [work] =
      await db.sql`select w.id from memory_work w join memory_sources s on s.id = w.source_id
      where s.space_id = ${scope.spaceId} and s.source_identity = 'realistic'`;
    // The shape a reasoning model answered with: no "op", a fenced body after
    // its reasoning, a date for a timestamp and an end offset one short.
    const gateway: ExtractionGateway = {
      async chat({ messages }) {
        const input = JSON.parse(messages[1]?.content ?? '{}') as {
          evidence: { source: { source_id: string } };
        };
        return `<think>The person names a time sink.</think>
\`\`\`json
${JSON.stringify({
  proposals: [
    {
      kind: 'user_statement',
      domain_key: 'work.time_sink',
      content: 'Email and admin take up most of the week',
      factual_status: 'attributed',
      valid_from: new Date().toISOString().slice(0, 10),
      sources: [
        {
          source_id: input.evidence.source.source_id,
          source_version: '1',
          start: 0,
          end: text.length - 1,
          quote: text,
        },
      ],
    },
  ],
})}
\`\`\``;
      },
    };
    const errors: string[] = [];
    await runExtractionWork(
      {
        sql: db.sql,
        boss: db.boss,
        journal: await journalFor('realistic'),
        gateway,
        onError: (code) => errors.push(code),
      },
      String(work?.id),
    );
    expect(errors).toEqual([]);
    const [kept] = await listBeliefs(db.sql, scope, 'UTC');
    expect(kept).toMatchObject({
      label: 'Work time sink',
      value: 'Email and admin take up most of the week',
      category: 'work',
    });
    const [done] = await db.sql`select status, error_code from memory_work where id = ${work?.id}`;
    expect(done).toMatchObject({ status: 'done', error_code: null });
  });

  test('an answer with nothing readable is tried once more, then set aside with its reason', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await ingest(db.sql, scope, {
      stream: 'chat',
      source_identity: 'unreadable',
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: new Date().toISOString(),
      text: 'I moved to Porto last month.',
    });
    const [work] =
      await db.sql`select w.id from memory_work w join memory_sources s on s.id = w.source_id
      where s.space_id = ${scope.spaceId} and s.source_identity = 'unreadable'`;
    const gateway: ExtractionGateway = { chat: async () => 'I could not find anything.' };
    const errors: string[] = [];
    const options = {
      sql: db.sql,
      boss: db.boss,
      journal: await journalFor('unreadable'),
      gateway,
      onError: (code: string) => errors.push(code),
    };
    await runExtractionWork(options, String(work?.id));
    await runExtractionWork(options, String(work?.id));
    expect(errors).toEqual(['extraction_unreadable', 'extraction_unreadable']);
    const [row] =
      await db.sql`select status, error_code, calls from memory_work where id = ${work?.id}`;
    expect(row).toMatchObject({
      status: 'rejected',
      error_code: 'extraction_unreadable',
      calls: 2,
    });
  });
});

withDb('memory belongs to the person, not the model', () => {
  test('export and import round trip, as JSON and as Markdown', async () => {
    if (!db) return;
    const source = await createScope(db);
    await pref(db, source, 'pref.coffee.order', 'flat white', '2026-09-01T09:00:00Z');
    await record(
      db,
      source,
      {
        identity: 'maya',
        text: 'Maya’s email is maya@example.com',
        eventAt: '2026-09-02T09:00:00Z',
        sourceType: 'observation',
        stream: 'contacts',
      },
      [
        {
          key: 'contact.maya.email',
          content: 'maya@example.com',
          quote: 'maya@example.com',
          kind: 'checked_fact',
        },
      ],
    );
    const exported = await exportBeliefFile(db.sql, source, 'UTC');
    expect(exported.beliefs).toHaveLength(2);
    const comparable = (file: typeof exported) =>
      file.beliefs
        .map(({ label, value, category, subject }) => ({ label, value, category, subject }))
        .sort((a, b) => a.subject.localeCompare(b.subject));

    const target = experienceScope(await createScope(db));
    const json = await importBeliefFile(db.sql, target, JSON.parse(JSON.stringify(exported)));
    expect(json).toEqual({ imported: 2, skipped: 0, notes: [] });
    expect(comparable(await exportBeliefFile(db.sql, target, 'UTC'))).toEqual(comparable(exported));
    const imported = await listBeliefs(db.sql, target, 'UTC');
    expect(imported.every((belief) => belief.source.kind === 'import')).toBe(true);
    // Importing the same file again adds nothing.
    expect(await importBeliefFile(db.sql, target, exported)).toMatchObject({
      imported: 0,
      skipped: 2,
    });

    const markdown = beliefMarkdown(exported);
    expect(markdown).toContain('## People');
    expect(markdown).toContain('- **Coffee: order**: flat white');
    const fromMarkdown = experienceScope(await createScope(db));
    expect(
      await importBeliefFile(db.sql, fromMarkdown, parseBeliefMarkdown(markdown)),
    ).toMatchObject({
      imported: 2,
    });
    expect(comparable(await exportBeliefFile(db.sql, fromMarkdown, 'UTC'))).toEqual(
      comparable(exported),
    );

    // A different current value is never overwritten.
    const changed = {
      ...exported,
      beliefs: exported.beliefs.map((b) => ({ ...b, value: `${b.value}!` })),
    };
    const kept = await importBeliefFile(db.sql, target, changed);
    expect(kept.imported).toBe(0);
    expect(kept.notes[0]).toContain('you already have a different value');
  });

  test('beliefs learned through one model are what the next model reads and corrects', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const spoken = async (identity: string, text: string) => {
      await ingest(db.sql, scope, {
        stream: 'chat',
        source_identity: identity,
        source_version: '1',
        source_type: 'message',
        author: 'owner',
        event_at: new Date().toISOString(),
        text,
      });
      const [work] =
        await db.sql`select w.id from memory_work w join memory_sources s on s.id = w.source_id
        where s.space_id = ${scope.spaceId} and s.source_identity = ${identity}`;
      return String(work?.id);
    };
    type Seen = {
      evidence: { source: { source_id: string }; text: string; start: number };
      claims: { id: string; head_revision: number; current: { content: string } }[];
    };
    const span = (input: Seen, quote: string) => {
      const at = input.evidence.text.indexOf(quote);
      return {
        source_id: input.evidence.source.source_id,
        source_version: '1',
        start: input.evidence.start + at,
        end: input.evidence.start + at + quote.length,
        quote,
      };
    };
    const shown: string[][] = [];
    // The first model answers in a code fence, as many do.
    const first: ExtractionGateway = {
      async chat({ messages }) {
        const input = JSON.parse(messages[1]?.content ?? '{}') as Seen;
        shown.push(input.claims.map((claim) => claim.current.content));
        return `\`\`\`json\n${JSON.stringify({
          proposals: [
            {
              op: 'add',
              expected_revision: null,
              domain_key: 'person.maya.city',
              content: 'Lisbon',
              kind: 'user_statement',
              factual_status: 'attributed',
              valid_from: new Date().toISOString(),
              valid_until: null,
              sources: [span(input, 'Lisbon')],
            },
          ],
        })}\n\`\`\``;
      },
    };
    // A different model, from a different provider, reads the same memory.
    const second: ExtractionGateway = {
      async chat({ messages }) {
        const input = JSON.parse(messages[1]?.content ?? '{}') as Seen;
        shown.push(input.claims.map((claim) => claim.current.content));
        const lisbon = input.claims.find((claim) => claim.current.content === 'Lisbon');
        return JSON.stringify({
          proposals: lisbon
            ? [
                {
                  op: 'supersede',
                  claim_id: lisbon.id,
                  expected_revision: lisbon.head_revision,
                  domain_key: 'person.maya.city',
                  content: 'Porto',
                  kind: 'user_statement',
                  factual_status: 'attributed',
                  valid_from: new Date().toISOString(),
                  valid_until: null,
                  sources: [span(input, 'Porto')],
                },
              ]
            : [],
        });
      },
    };
    const journal = await journalFor('models');
    const errors: string[] = [];
    const options = {
      sql: db.sql,
      boss: db.boss,
      journal,
      onError: (code: string) => errors.push(code),
    };
    await runExtractionWork(
      { ...options, gateway: first },
      await spoken('m1', 'My sister Maya lives in Lisbon.'),
    );
    expect(errors).toEqual([]);
    const [learned] = await listBeliefs(db.sql, scope, 'UTC');
    expect(learned).toMatchObject({ label: "Maya's city", value: 'Lisbon', category: 'people' });
    await runExtractionWork(
      { ...options, gateway: second },
      await spoken('m2', 'Actually Maya moved to Porto.'),
    );
    expect(errors).toEqual([]);
    expect(shown[1]).toContain('Lisbon');
    const [moved] = await listBeliefs(db.sql, scope, 'UTC');
    expect(moved).toMatchObject({ id: learned?.id, value: 'Porto', earlier: 1 });
    // Nothing about a belief names the model or provider that read it.
    const columns = await db.sql`select table_name, column_name from information_schema.columns
      where table_name in ('memory_claims','memory_revisions','memory_revision_content','memory_sources','memory_references')
        and (column_name like '%model%' or column_name like '%provider%')`;
    expect(columns.length).toBe(0);
  });
});
