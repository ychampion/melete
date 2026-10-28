/**
 * `conversations.search` and `conversations.read`, against Postgres: a new chat
 * that points back is answered from the earlier conversation itself.
 *
 * - A search finds an earlier chat's answer by a word in it, and never the
 *   conversation the turn is in.
 * - Only the person's own chats: never another person's, never a room's.
 * - A private conversation's words reach only a turn that is itself private.
 * - A read is a bounded excerpt, centred where it is asked to be.
 * - A recipient read from an earlier answer vouches for nothing at admission.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { collectOriginFields, resolveOriginWarnings } from '../../src/broker/trust.ts';
import { openDatabase } from '../../src/db/client.ts';
import {
  EARLIER_GUIDANCE,
  type EarlierOptions,
  READ_TOKENS,
  readConversation,
  searchConversations,
} from '../../src/experience/earlier.ts';
import { ExperienceHome } from '../../src/experience/home.ts';
import { newId } from '../../src/ids.ts';
import { createMemoryTrustResolver } from '../../src/memory/broker-trust.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { createScope, createTestDatabase, type TestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 1) : null;
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

async function setup(database: TestDatabase) {
  const scope = await createScope(database);
  const agent = newId('agent');
  await database.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
    values (${agent}, ${scope.spaceId}, 'Melete', 'assistant', 'blue', 'soft', 'dark', 'plain', '')`;
  return { space: scope.spaceId, owner: scope.ownerId, agent };
}

type Place = Awaited<ReturnType<typeof setup>>;
let clock = Date.UTC(2026, 9, 1);

/** A chat with its turns, each said and answered a minute after the last. */
async function chat(
  database: TestDatabase,
  place: Place,
  turns: [said: string, answer: string][],
  options: { principal?: string | null; audience?: 'principal' | 'room'; title?: string } = {},
) {
  const id = newId('job');
  await database.sql`insert into job (id, space_id, title, objective, principal_id, kind, audience, agent_id)
    values (${id}, ${place.space}, ${options.title ?? 'New chat'}, 'New chat',
      ${options.principal === undefined ? place.owner : options.principal}, 'chat',
      ${options.audience ?? 'principal'}, ${place.agent})`;
  for (const [said, answer] of turns) {
    clock += 60_000;
    await database.sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, answer, status, created_at)
      values (${`turn_${randomUUID()}`}, ${id}, ${place.agent}, ${randomUUID()}, ${said}, ${answer},
        'completed', ${new Date(clock).toISOString()})`;
  }
  return id;
}

async function principal(database: TestDatabase, kind: 'person' | 'room') {
  const id = `prn_${randomUUID()}`;
  await database.sql`insert into principal (id, email, kind) values (${id}, ${`${id}@example.test`}, ${kind})`;
  return id;
}

/** The attempt every search here is made from; which one matters only to `readsPrivate`. */
const ATTEMPT = 'att_01J8ZP3QWABCDEFGHJKMNPQRST';

/**
 * Conversations `kept` stay private. A turn in one of them may read the others
 * unless its requests go to a cloud model (`cloud`).
 */
const options = (
  database: TestDatabase,
  kept: string[] = [],
  cloud: string[] = [],
): EarlierOptions => ({
  sql: database.sql,
  keepsPrivate: async (jobId) => kept.includes(jobId),
  readsPrivate: async (jobId) => kept.includes(jobId) && !cloud.includes(jobId),
});

const PLUMBER: [string, string] = [
  'Can you find me someone to fix the leaking boiler?',
  "Mario's Heating can come on Thursday. His number is 555-0142 and his email is mario@heating.example.",
];

withDb('conversations.search and conversations.read', () => {
  test("finds an earlier chat's answer by a word in it, but not the chat the turn is in", async () => {
    if (!db) return;
    const place = await setup(db);
    const earlier = await chat(db, place, [PLUMBER], { title: 'Boiler repair' });
    const current = await chat(db, place, [["What was Mario's number?", '']]);

    const found = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'Mario' },
    );
    expect(found.status).toBe('found');
    expect(found.guidance).toBe(EARLIER_GUIDANCE.found);
    expect(found.hits.map((hit) => hit.conversation_id)).toEqual([earlier]);
    expect(found.hits[0]).toMatchObject({
      conversation_id: earlier,
      title: 'Boiler repair',
      kind: 'answer',
      position: 1,
    });
    expect(found.hits[0]?.snippet).toContain('555-0142');

    // The person's own words come back as theirs.
    const said = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'leaking boiler' },
    );
    expect(said.hits[0]).toMatchObject({ conversation_id: earlier, kind: 'message' });

    // Words found nowhere: an honest nothing, told not to deny it was said.
    const nothing = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'vacuum cleaner' },
    );
    expect(nothing).toEqual({ status: 'nothing', hits: [], guidance: EARLIER_GUIDANCE.nothing });
    expect(nothing.guidance).toContain('never say they never told you');
  });

  test("another person's chat and a room's chat are never returned or read", async () => {
    if (!db) return;
    const place = await setup(db);
    const mine = await chat(db, place, [PLUMBER]);
    const someone = await principal(db, 'person');
    const theirs = await chat(db, place, [PLUMBER], { principal: someone });
    const room = await principal(db, 'room');
    const roomChat = await chat(db, place, [PLUMBER], { principal: room, audience: 'room' });
    // A room's request with no principal of its own still belongs to the room.
    const unnamed = await chat(db, place, [PLUMBER], { principal: null, audience: 'room' });
    const current = await chat(db, place, [['Who fixes boilers?', '']]);

    const found = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'Mario', limit: 20 },
    );
    expect(found.hits.map((hit) => hit.conversation_id)).toEqual([mine]);
    for (const id of [theirs, roomChat, unnamed, current])
      expect(
        (
          await readConversation(
            options(db),
            { job_id: current, attempt_id: ATTEMPT },
            { conversation_id: id },
          )
        ).status,
      ).toBe('not_found');

    // The other person searching finds their own chat, not the owner's.
    const theirTurn = await chat(db, place, [['Who fixes boilers?', '']], { principal: someone });
    const fromThem = await searchConversations(
      options(db),
      { job_id: theirTurn, attempt_id: ATTEMPT },
      { query: 'Mario' },
    );
    expect(fromThem.hits.map((hit) => hit.conversation_id)).toEqual([theirs]);

    // A room's own work searches nothing at all.
    const roomTurn = await chat(db, place, [['Who fixes boilers?', '']], {
      principal: room,
      audience: 'room',
    });
    expect(
      (
        await searchConversations(
          options(db),
          { job_id: roomTurn, attempt_id: ATTEMPT },
          { query: 'Mario' },
        )
      ).status,
    ).toBe('not_available_here');
  });

  test("a private chat's words reach only a turn that is itself private", async () => {
    if (!db) return;
    const place = await setup(db);
    const kept = await chat(db, place, [
      ['My therapist is Dr Okafor, can you note her number?', 'Dr Okafor: 555-0199.'],
    ]);
    const open = await chat(db, place, [['What was the therapist number?', '']]);
    const quiet = await chat(db, place, [['What was the therapist number?', '']]);

    const outside = await searchConversations(
      options(db, [kept]),
      { job_id: open, attempt_id: ATTEMPT },
      { query: 'Okafor' },
    );
    expect(outside).toEqual({
      status: 'nothing',
      hits: [],
      withheld: 1,
      guidance: EARLIER_GUIDANCE.withheld,
    });
    expect(
      await readConversation(
        options(db, [kept]),
        { job_id: open, attempt_id: ATTEMPT },
        { conversation_id: kept },
      ),
    ).toEqual({ status: 'withheld', guidance: EARLIER_GUIDANCE.private });

    const inside = await searchConversations(
      options(db, [kept, quiet]),
      { job_id: quiet, attempt_id: ATTEMPT },
      { query: 'Okafor' },
    );
    expect(inside.status).toBe('found');
    expect(inside.hits.map((hit) => hit.conversation_id)).toEqual([kept]);
    const read = await readConversation(
      options(db, [kept, quiet]),
      { job_id: quiet, attempt_id: ATTEMPT },
      { conversation_id: kept },
    );
    expect(read.turns?.[0]?.answer).toBe('Dr Okafor: 555-0199.');
  });

  test("a private chat's words stay out of a private turn whose requests go to a cloud model", async () => {
    if (!db) return;
    const place = await setup(db);
    const kept = await chat(db, place, [
      ['My therapist is Dr Okafor, can you note her number?', 'Dr Okafor: 555-0199.'],
    ]);
    // Private too, but the person let it go to a cloud model redacted: what
    // another private conversation was about would leave with it.
    const redacted = await chat(db, place, [['What was the therapist number?', '']]);
    const rules = options(db, [kept, redacted], [redacted]);
    expect(
      await searchConversations(
        rules,
        { job_id: redacted, attempt_id: ATTEMPT },
        { query: 'Okafor' },
      ),
    ).toEqual({ status: 'nothing', hits: [], withheld: 1, guidance: EARLIER_GUIDANCE.withheld });
    expect(
      await readConversation(
        rules,
        { job_id: redacted, attempt_id: ATTEMPT },
        { conversation_id: kept },
      ),
    ).toEqual({ status: 'withheld', guidance: EARLIER_GUIDANCE.private });
  });

  test('a read is a bounded excerpt, centred on a position or a phrase', async () => {
    if (!db) return;
    const place = await setup(db);
    const long = await chat(
      db,
      place,
      Array.from({ length: 40 }, (_, i): [string, string] => [
        `Question ${i + 1}: ${'what about the next vacuum on the list? '.repeat(8)}`,
        `Answer ${i + 1}: ${i === 6 ? 'The Dyson V8 is the cheapest at $199. ' : ''}${'It has good suction and a long battery. '.repeat(10)}`,
      ]),
    );
    const current = await chat(db, place, [['Which vacuum was cheapest?', '']]);
    const tokens = (turns: unknown) => Math.ceil(JSON.stringify(turns).length / 4);

    const middle = await readConversation(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { conversation_id: long, around: 20 },
    );
    expect(middle.status).toBe('found');
    expect(middle.total_turns).toBe(40);
    const positions = middle.turns?.map((turn) => turn.position) ?? [];
    expect(positions).toContain(20);
    expect(positions.length).toBeGreaterThan(1);
    expect(positions.length).toBeLessThan(40);
    expect(tokens(middle.turns)).toBeLessThanOrEqual(READ_TOKENS + 50);
    expect([middle.more_before, middle.more_after]).toEqual([true, true]);

    const phrase = await readConversation(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { conversation_id: long, around: 'Dyson V8' },
    );
    expect(phrase.turns?.map((turn) => turn.position)).toContain(7);
    expect(phrase.turns?.find((turn) => turn.position === 7)?.answer).toContain('$199');

    // Nothing asked for: the latest part.
    const latest = await readConversation(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { conversation_id: long },
    );
    expect(latest.turns?.at(-1)?.position).toBe(40);
    expect(latest.more_after).toBe(false);

    // A search names the turn to read around.
    const hit = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'Dyson' },
    );
    expect(hit.hits[0]?.position).toBe(7);

    await expect(
      readConversation(
        options(db),
        { job_id: current, attempt_id: ATTEMPT },
        { conversation_id: long, around: 0 },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      searchConversations(
        options(db),
        { job_id: current, attempt_id: ATTEMPT },
        { query: 'x', limit: 21 },
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  test('what Melete sent in an earlier chat is found by its subject and reference', async () => {
    if (!db) return;
    const place = await setup(db);
    const earlier = await chat(db, place, [PLUMBER, ['Email him to confirm.', 'Sent.']]);
    const current = await chat(db, place, [['Did you confirm the boiler visit?', '']]);
    const [turn] = await db.sql`select id from experience_turn where job_id = ${earlier}
      order by created_at desc limit 1`;
    const connection = newId('conn');
    await db.sql`insert into connection (id, space_id, provider, label, scopes)
      values (${connection}, ${place.space}, 'imap', 'Mail', '["email.send"]'::jsonb)`;
    const attempt = newId('att');
    await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id)
      values (${attempt}, ${earlier}, 1, 'scripted-v1', 'fake', 'scripted-v1', ${turn?.id})`;
    const sent = async (status: string, subject: string) => {
      const id = newId('act');
      await db.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, receipt)
        values (${id}, ${earlier}, ${attempt}, ${connection}, 'email.send', 'write_external',
          ${JSON.stringify({ to: 'mario@heating.example', subject })}::jsonb, ${'a'.repeat(64)},
          ${id}, ${status}, ${JSON.stringify({ external_ref: `ref-${status}` })}::jsonb)`;
    };
    await sent('succeeded', 'Thursday boiler visit');
    // Only what went out: a refused send is not something Melete made.
    await sent('refused', 'Thursday boiler visit');

    const found = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'Thursday visit' },
    );
    const made = found.hits.filter((hit) => hit.kind === 'made');
    expect(made).toEqual([
      {
        conversation_id: earlier,
        title: 'New chat',
        when: expect.any(String),
        snippet: 'email.send: Thursday boiler visit (ref ref-succeeded)',
        kind: 'made',
        position: 2,
      },
    ]);
  });

  test('a recipient read from an earlier answer is not vouched for at admission', async () => {
    if (!db) return;
    const place = await setup(db);
    await chat(db, place, [PLUMBER]);
    const current = await chat(db, place, [['Email Mario that Thursday works', '']]);
    const read = await searchConversations(
      options(db),
      { job_id: current, attempt_id: ATTEMPT },
      { query: 'Mario' },
    );
    expect(read.hits[0]?.snippet).toContain('mario@heating.example');

    const payload = { to: 'mario@heating.example', subject: 'Thursday', body: 'Thursday works.' };
    const warnings = await resolveOriginWarnings(db.sql, createMemoryTrustResolver(), {
      space_id: place.space,
      job_id: current,
      connection_id: newId('conn'),
      kind: 'email.send',
      effect_class: 'write_external',
      canonical_payload: payload,
      fields: collectOriginFields(payload, 'email.send'),
    });
    expect(warnings.map((warning) => [warning.field, warning.origin_trust])).toEqual([
      ['to', 'unknown'],
    ]);
  });

  test('an agent set not to read memory, or public research, searches nothing', async () => {
    if (!db) return;
    const place = await setup(db);
    await chat(db, place, [PLUMBER]);
    const withheld = await chat(db, place, [['Who fixes boilers?', '']]);
    const quiet = newId('agent');
    await db.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction, reads_memory)
      values (${quiet}, ${place.space}, 'Scout', 'assistant', 'blue', 'soft', 'dark', 'plain', '', false)`;
    await db.sql`update job set agent_id = ${quiet} where id = ${withheld}`;
    expect(
      await searchConversations(
        options(db),
        { job_id: withheld, attempt_id: ATTEMPT },
        { query: 'Mario' },
      ),
    ).toEqual({
      status: 'not_available_here',
      hits: [],
      guidance: EARLIER_GUIDANCE.not_available_here,
    });
    const research = await chat(db, place, [['Who fixes boilers?', '']]);
    await db.sql`update job set constraints = '{"public_compartment": true}'::jsonb where id = ${research}`;
    expect(
      (
        await readConversation(
          options(db),
          { job_id: research, attempt_id: ATTEMPT },
          { conversation_id: research },
        )
      ).status,
    ).toBe('not_available_here');
  });

  test("Home finds a chat by a word in its answer, among the person's own chats only", async () => {
    if (!db || !handle) return;
    const place = await setup(db);
    const mine = await chat(db, place, [PLUMBER], { title: 'Boiler repair' });
    const someone = await principal(db, 'person');
    await chat(db, place, [PLUMBER], { principal: someone });
    const home = new ExperienceHome(handle.db);
    const found = await principalContext.run(place.owner, () => home.search(place.space, 'Mario'));
    expect(found.results.map((result) => result.id)).toEqual([mine]);
  });
});
