/**
 * A detail is kept with the someone it is about. In a room, one member's
 * detail is never merged with, attached to or changed into another's, however
 * alike their words. Two people who share a first name stay two when the
 * person says how each is related to them. "The owner of my flat" is not the
 * person, and a block saved under an older subject keeps holding.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { getHead } from '../../src/memory/claims.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest, persistEvidence } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { claimWork } from '../../src/memory/work.ts';
import { createScope, createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;
type Batch = NonNullable<Awaited<ReturnType<typeof claimWork>>>;

withDb('a detail is kept with the someone it is about', () => {
  // Only run with a database (see withDb).
  const store = db as NonNullable<typeof db>;
  let sequence = 0;
  const at = (minutes: number) => new Date(Date.UTC(2026, 7, 10, 9, minutes)).toISOString();
  /** One message from the person in their own memory, read the way the extraction worker reads it. */
  const said = async (scope: MemoryScope, text: string) => {
    sequence++;
    await ingest(store.sql, scope, {
      stream: 'chat',
      source_identity: `said-${sequence}`,
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: at(sequence),
      text,
    });
    const batch = await claimWork(store.sql, scope);
    if (!batch) throw new Error(`no work for ${text}`);
    return batch;
  };
  /** A room: memory every member's words are kept in. */
  const room = async (): Promise<MemoryScope> => ({
    ...(await createScope(store)),
    audience: 'space',
    publisher: 'room',
  });
  /** One message a member said in a room. */
  const memberSaid = async (scope: MemoryScope, member: string, text: string) => {
    sequence++;
    await store.sql.begin((tx) =>
      persistEvidence(tx, scope, {
        stream: 'room',
        source_identity: `room_message:${sequence}`,
        source_version: '1',
        source_type: 'message',
        author: 'member',
        author_principal_id: member,
        event_at: at(sequence),
        text,
      }),
    );
    const batch = await claimWork(store.sql, scope);
    if (!batch) throw new Error(`no work for ${text}`);
    return batch;
  };
  const span = (batch: Batch, quote: string) => {
    const start = batch.work.segment_start + batch.text.indexOf(quote);
    if (start < batch.work.segment_start) throw new Error(`"${quote}" is not in the message`);
    return {
      source_id: batch.source.source_id,
      source_version: batch.source.source_version,
      start,
      end: start + quote.length,
      quote,
    };
  };
  const add = (
    batch: Batch,
    domain_key: string,
    quote: string,
    content = quote,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      op: 'add',
      expected_revision: null,
      domain_key,
      content,
      kind: 'user_statement',
      factual_status: 'attributed',
      valid_from: batch.source.event_at,
      valid_until: null,
      sources: [span(batch, quote)],
      ...extra,
    }) as ExtractionProposal;
  const supersede = (batch: Batch, held: string, quote: string, content: string) => {
    const claim = batch.claims.find((item) => item.domain_key === held);
    if (!claim) throw new Error(`${held} was not shown`);
    return {
      ...add(batch, held, quote, content),
      op: 'supersede',
      claim_id: claim.id,
      expected_revision: claim.head_revision,
    } as ExtractionProposal;
  };
  /** Each detail held now: its subject, its words, whose words it rests on, and its revision. */
  const heldNow = async (scope: MemoryScope) => {
    const rows = await store.sql`select c.domain_key, c.head_revision, b.content,
        coalesce((select string_agg(distinct coalesce(s.author_principal_id, 'owner'), ',')
          from memory_references ref join memory_sources s on s.id = ref.source_id
          where ref.claim_id = c.id and ref.revision = c.head_revision), '') as said_by,
        (select count(distinct ref.source_id)::int from memory_references ref
          where ref.claim_id = c.id and ref.revision = c.head_revision) as messages
      from memory_claims c join memory_revision_content b
        on b.claim_id = c.id and b.revision = c.head_revision
      where c.space_id = ${scope.spaceId} and not c.hidden order by c.domain_key`;
    return rows.map((row) => [
      String(row.domain_key).replace(/member_[0-9a-f]{12}/, 'member'),
      row.content,
      row.said_by,
      row.messages,
      row.head_revision,
    ]);
  };

  test("in a room, two members' identical details stay two, on every path a detail is matched by", async () => {
    const scope = await room();
    const alice = 'prn_alice';
    const bob = 'prn_bob';
    const carol = 'prn_carol';
    const first = await memberSaid(
      scope,
      alice,
      "I'm allergic to peanuts. I live in Pune. I'm vegetarian.",
    );
    await commitExtraction(store.sql, scope, first, {
      proposals: [
        add(first, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
        add(first, 'home.city', 'I live in Pune', 'Lives in Pune'),
        // As an older extraction filed the person's own detail.
        add(first, 'person.user.diet', "I'm vegetarian", 'Vegetarian'),
      ],
    });
    // Bob is shown none of Alice's details, so none can be taken for his.
    const bobs = await memberSaid(scope, bob, "I'm allergic to peanuts. I'm vegan.");
    expect(bobs.claims.map((claim) => claim.domain_key)).toEqual([]);
    // The same subject.
    expect(
      await commitExtraction(store.sql, scope, bobs, {
        proposals: [
          add(bobs, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
          // Filed under the person, where Alice's diet is held under an older subject.
          add(bobs, 'self.diet', "I'm vegan", 'Vegan'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    // The same words under another subject, unseen by extraction.
    const again = await memberSaid(scope, bob, 'Peanuts: allergic to peanuts, still.');
    expect(
      await commitExtraction(
        store.sql,
        scope,
        { ...again, claims: [] },
        { proposals: [add(again, 'food.allergy', 'allergic to peanuts', 'Allergic to peanuts')] },
      ),
    ).toMatchObject({ status: 'committed' });
    // The same detail in other words, merged with what extraction was shown.
    const carols = await memberSaid(scope, carol, 'Peanut allergy here, a severe one.');
    const proposals = await proposeExtraction(store.sql, scope, carols, {
      chat: async () =>
        JSON.stringify({
          proposals: [
            {
              op: 'add',
              claim_id: null,
              expected_revision: null,
              domain_key: 'food.peanut_allergy',
              content: 'Allergic to peanuts',
              kind: 'user_statement',
              factual_status: 'attributed',
              valid_from: carols.source.event_at,
              valid_until: null,
              lasting: true,
              about: 'the_person',
              sources: [{ quote: 'Peanut allergy here' }],
            },
          ],
        }),
    });
    expect(await commitExtraction(store.sql, scope, carols, { proposals })).toMatchObject({
      status: 'committed',
    });
    // Alice's own detail said again still lands on hers.
    const hers = await memberSaid(scope, alice, 'Still allergic to peanuts.');
    await commitExtraction(store.sql, scope, hers, {
      proposals: [add(hers, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts')],
    });
    expect(await heldNow(scope)).toEqual([
      ['food.peanut_allergy', 'Allergic to peanuts', carol, 1, 1],
      ['health.allergy', 'Allergic to peanuts', alice, 2, 1],
      ['health.allergy.member', 'Allergic to peanuts', bob, 2, 1],
      ['home.city', 'Lives in Pune', alice, 1, 1],
      ['person.user.diet', 'Vegetarian', alice, 1, 1],
      ['self.diet', 'Vegan', bob, 1, 1],
    ]);

    // A change Bob proposes to Alice's city, as a reviewed change saved
    // before this, is refused, and her city stays as she said it.
    const moved = await memberSaid(scope, bob, 'I moved to Delhi.');
    expect(moved.claims.map((claim) => claim.domain_key)).not.toContain('home.city');
    const [city] = await store.sql`select id from memory_claims
      where space_id = ${scope.spaceId} and domain_key = 'home.city'`;
    const cityHead = await store.sql.begin((tx) => getHead(tx, scope, String(city?.id)));
    if (!cityHead) throw new Error('No city held');
    const shown = { ...moved, claims: [...moved.claims, cityHead] };
    expect(
      await commitExtraction(store.sql, scope, shown, {
        proposals: [supersede(shown, 'home.city', 'moved to Delhi', 'Lives in Delhi')],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'target_mismatch' });
    expect((await heldNow(scope)).find(([subject]) => subject === 'home.city')).toEqual([
      'home.city',
      'Lives in Pune',
      alice,
      1,
      1,
    ]);

    // A registry key one member holds is not weighed against another's.
    const seats = await memberSaid(scope, alice, 'I would like an aisle seat.');
    await commitExtraction(store.sql, scope, seats, {
      proposals: [
        add(seats, 'pref.travel.seat', 'aisle seat', 'aisle seat', {
          key: 'pref.travel.seat',
          kind: 'preference',
        }),
      ],
    });
    const window = await memberSaid(scope, bob, 'I would rather have a window seat.');
    expect(
      await commitExtraction(store.sql, scope, window, {
        proposals: [
          add(window, 'pref.travel.seat', 'window seat', 'window seat', {
            key: 'pref.travel.seat',
            kind: 'preference',
          }),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    const seatsNow = (await heldNow(scope)).filter(([subject]) =>
      String(subject).startsWith('pref.'),
    );
    expect(seatsNow).toEqual([
      ['pref.travel.seat', 'aisle seat', alice, 1, 1],
      ['pref.travel.seat.member', 'window seat', bob, 1, 1],
    ]);
    // Said twice in one message, a member's detail is kept once.
    const dave = 'prn_dave';
    const twice = await memberSaid(scope, dave, 'Allergic to peanuts. Yes, allergic to peanuts!');
    expect(
      await commitExtraction(store.sql, scope, twice, {
        proposals: [
          add(twice, 'health.allergy', 'Allergic to peanuts'),
          add(twice, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    // Once Alice's is forgotten, Bob saying his again still lands on his.
    await store.sql`update memory_claims set hidden = true
      where space_id = ${scope.spaceId} and domain_key = 'health.allergy'`;
    const later = await memberSaid(scope, bob, 'I have a peanut allergy, as ever.');
    await commitExtraction(store.sql, scope, later, {
      proposals: [add(later, 'health.allergy', 'I have a peanut allergy', 'Has a peanut allergy')],
    });
    const allergies = (await heldNow(scope))
      .filter(([subject]) => String(subject).startsWith('health.'))
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(allergies).toEqual([
      ['health.allergy.member', 'Allergic to peanuts', dave, 1, 1],
      ['health.allergy.member', 'Has a peanut allergy', bob, 1, 2],
    ]);
    // No detail in the room rests on two members' words.
    expect((await heldNow(scope)).filter(([, , by]) => String(by).includes(','))).toEqual([]);
  });

  test('a person of the same name the person relates differently is someone else, either way round', async () => {
    const scope = await createScope(store);
    const friend = await said(scope, 'my friend sam lives in Lisbon. he is vegetarian.');
    await commitExtraction(store.sql, scope, friend, {
      proposals: [
        add(
          friend,
          'person.sam.city',
          'my friend sam lives in Lisbon',
          'Friend Sam lives in Lisbon',
        ),
        add(friend, 'person.sam.diet', 'he is vegetarian', 'Friend Sam is vegetarian'),
      ],
    });
    // As both real models answered: one change to Friend Sam's city, one add on his diet.
    const brother = await said(scope, 'My brother Sam lives in Lisbon too, but he eats meat.');
    expect(
      await commitExtraction(store.sql, scope, brother, {
        proposals: [
          supersede(
            brother,
            'person.sam.city',
            'My brother Sam lives in Lisbon',
            'Brother Sam lives in Lisbon',
          ),
          add(brother, 'person.sam.diet', 'he eats meat', 'Brother Sam eats meat'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    expect(await heldNow(scope)).toEqual([
      ['person.brother.sam.city', 'Brother Sam lives in Lisbon', 'owner', 1, 1],
      ['person.brother.sam.diet', 'Brother Sam eats meat', 'owner', 1, 1],
      ['person.sam.city', 'Friend Sam lives in Lisbon', 'owner', 1, 1],
      ['person.sam.diet', 'Friend Sam is vegetarian', 'owner', 1, 1],
    ]);
    // Brother Sam's change, proposed on the subject Friend Sam holds, reaches his.
    const madrid = await said(scope, 'My brother Sam has moved to Madrid.');
    await commitExtraction(store.sql, scope, madrid, {
      proposals: [
        add(
          madrid,
          'person.sam.city',
          'My brother Sam has moved to Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    // The same person mentioned twice is still one: a change to Friend Sam is his.
    const porto = await said(scope, 'My friend Sam moved to Porto.');
    await commitExtraction(store.sql, scope, porto, {
      proposals: [
        supersede(
          porto,
          'person.sam.city',
          'My friend Sam moved to Porto',
          'Friend Sam lives in Porto',
        ),
      ],
    });
    const plain = await said(scope, 'Sam stopped being vegetarian.');
    await commitExtraction(store.sql, scope, plain, {
      proposals: [
        supersede(
          plain,
          'person.sam.diet',
          'Sam stopped being vegetarian',
          'Sam no longer vegetarian',
        ),
      ],
    });
    expect(await heldNow(scope)).toEqual([
      ['person.brother.sam.city', 'Brother Sam lives in Madrid', 'owner', 1, 2],
      ['person.brother.sam.diet', 'Brother Sam eats meat', 'owner', 1, 1],
      ['person.sam.city', 'Friend Sam lives in Porto', 'owner', 1, 2],
      ['person.sam.diet', 'Sam no longer vegetarian', 'owner', 1, 2],
    ]);

    // The other way round: the brother first, then a friend of the same name.
    const other = await createScope(store);
    const first = await said(other, 'My brother Sam lives in Lisbon.');
    await commitExtraction(store.sql, other, first, {
      proposals: [
        add(
          first,
          'person.sam.city',
          'My brother Sam lives in Lisbon',
          'Brother Sam lives in Lisbon',
        ),
      ],
    });
    const second = await said(other, 'My friend Sam lives in Lisbon as well.');
    await commitExtraction(store.sql, other, second, {
      proposals: [
        supersede(
          second,
          'person.sam.city',
          'My friend Sam lives in Lisbon',
          'Friend Sam lives in Lisbon',
        ),
      ],
    });
    // A friend who is also a colleague is one person.
    const third = await said(other, 'Sam, my colleague, lives in Lisbon. Sam is also my friend.');
    await commitExtraction(store.sql, other, third, {
      proposals: [
        add(
          third,
          'person.friend.sam.city',
          'Sam, my colleague, lives in Lisbon',
          'Sam, my colleague, lives in Lisbon',
        ),
      ],
    });
    expect(await heldNow(other)).toEqual([
      ['person.friend.sam.city', 'Sam, my colleague, lives in Lisbon', 'owner', 1, 2],
      ['person.sam.city', 'Brother Sam lives in Lisbon', 'owner', 1, 1],
    ]);
  });

  test('the owner of something is not the person; details saved under owner still are', async () => {
    const scope = await createScope(store);
    const before = await said(
      scope,
      'The owner of my flat lives in Porto. Can be home Thursday afternoon if that works.',
    );
    await commitExtraction(store.sql, scope, before, {
      proposals: [
        add(before, 'person.owner.city', 'The owner of my flat lives in Porto'),
        add(before, 'contact.owner.availability', 'Can be home Thursday afternoon if that works'),
      ],
    });
    const mine = await said(
      scope,
      'I live in Porto too. Can be home Thursday afternoon if that works.',
    );
    await commitExtraction(
      store.sql,
      scope,
      { ...mine, claims: [] },
      {
        proposals: [
          add(mine, 'self.city', 'I live in Porto', 'Lives in Porto'),
          add(mine, 'self.availability', 'Can be home Thursday afternoon if that works'),
        ],
      },
    );
    // The person's own city as a change to the subject the flat's owner is held under.
    const moved = await said(scope, 'I moved to Lisbon.');
    await commitExtraction(store.sql, scope, moved, {
      proposals: [add(moved, 'person.owner.city', 'I moved to Lisbon', 'Lives in Lisbon')],
    });
    expect(await heldNow(scope)).toEqual([
      ['contact.owner.availability', 'Can be home Thursday afternoon if that works', 'owner', 2, 1],
      ['person.owner.city', 'The owner of my flat lives in Porto', 'owner', 1, 1],
      ['self.city', 'Lives in Lisbon', 'owner', 1, 2],
    ]);
  });

  test('a block saved under an older subject with words the new one leaves out still holds', async () => {
    const scope = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_flights_seat', ${scope.spaceId}, 'person.preference.flights.aisle_seat', null, 'Aisle seat'),
      ('mb_health_peanut', ${scope.spaceId}, 'person.health.allergy.peanuts', null, 'Peanut allergy'),
      ('mb_diet_shellfish', ${scope.spaceId}, 'person.diet.allergy.shellfish', null, 'Shellfish'),
      ('mb_peanuts', ${scope.spaceId}, 'person.allergy.peanuts', null, 'Allergy peanuts')`;
    const batch = await said(
      scope,
      'Always book aisle seats for me. I am allergic to peanuts. I love peanut butter cookies, and I prefer window seats on trains. I am allergic to sesame.',
    );
    const result = await commitExtraction(store.sql, scope, batch, {
      proposals: [
        add(batch, 'travel.seat', 'Always book aisle seats for me', 'Always book aisle seats', {
          kind: 'preference',
        }),
        add(batch, 'food.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
        add(batch, 'food.likes', 'I love peanut butter cookies', 'Loves peanut butter cookies'),
        add(
          batch,
          'travel.train_seat',
          'prefer window seats on trains',
          'Prefers window seats on trains',
        ),
        add(batch, 'food.diet.allergy', 'allergic to sesame', 'Allergic to sesame'),
      ],
    });
    expect(result.status).toBe('committed');
    expect((await heldNow(scope)).map(([subject]) => subject)).toEqual([
      'food.diet.allergy',
      'food.likes',
      'travel.train_seat',
    ]);
    const refused =
      await store.sql`select reason from memory_rejections where work_id = ${batch.work.id}`;
    expect(refused.map((row) => row.reason)).toEqual(['blocked_by_person', 'blocked_by_person']);
  });
});
