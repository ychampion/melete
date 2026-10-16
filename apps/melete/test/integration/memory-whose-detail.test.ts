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

    // A change Bob proposes to Alice's city, as a change saved
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

  test("in a room, a member's brother is kept where another member's brother of that name is held", async () => {
    const scope = await room();
    const alice = 'prn_alice';
    const bob = 'prn_bob';
    const friend = await memberSaid(scope, bob, 'My friend Sam lives in Lisbon.');
    await commitExtraction(store.sql, scope, friend, {
      proposals: [
        add(
          friend,
          'person.sam.city',
          'My friend Sam lives in Lisbon',
          'Friend Sam lives in Lisbon',
        ),
      ],
    });
    const hers = await memberSaid(scope, alice, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, scope, hers, {
      proposals: [
        add(
          hers,
          'person.brother.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    // As a change to the friend he holds, and as a new detail on that subject.
    const changed = await memberSaid(scope, bob, 'My brother Sam lives in Porto.');
    expect(
      await commitExtraction(store.sql, scope, changed, {
        proposals: [
          supersede(
            changed,
            'person.sam.city',
            'My brother Sam lives in Porto',
            'Brother Sam lives in Porto',
          ),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    const added = await memberSaid(scope, bob, 'My brother Sam is vegetarian.');
    await commitExtraction(store.sql, scope, added, {
      proposals: [
        add(added, 'person.sam.diet', 'My brother Sam is vegetarian', 'Brother Sam is vegetarian'),
      ],
    });
    const later = await memberSaid(scope, bob, 'My brother Sam moved to Braga.');
    await commitExtraction(store.sql, scope, later, {
      proposals: [
        add(
          later,
          'person.sam.city',
          'My brother Sam moved to Braga',
          'Brother Sam lives in Braga',
        ),
      ],
    });
    expect(await heldNow(scope)).toEqual([
      ['person.brother.sam.city', 'Brother Sam lives in Madrid', alice, 1, 1],
      ['person.brother.sam.city.member', 'Brother Sam lives in Braga', bob, 1, 2],
      ['person.sam.city', 'Friend Sam lives in Lisbon', bob, 1, 1],
      ['person.sam.diet', 'Brother Sam is vegetarian', bob, 1, 1],
    ]);
  });

  test("in a room, a member's change that leaves out which member it is lands on their own detail", async () => {
    const scope = await room();
    const alice = 'prn_alice';
    const bob = 'prn_bob';
    const hers = await memberSaid(scope, alice, 'I live in Lisbon.');
    await commitExtraction(store.sql, scope, hers, {
      proposals: [add(hers, 'home.city', 'I live in Lisbon', 'Lives in Lisbon')],
    });
    const his = await memberSaid(scope, bob, 'I live in Porto.');
    await commitExtraction(store.sql, scope, his, {
      proposals: [add(his, 'home.city', 'I live in Porto', 'Lives in Porto')],
    });
    /** A change to the detail held under `subject`, proposed under `proposed`. */
    const change = (
      batch: Batch,
      subject: RegExp,
      proposed: string,
      quote: string,
      content: string,
    ) => {
      const claim = batch.claims.find((item) => subject.test(item.domain_key));
      if (!claim) throw new Error(`${subject} was not shown`);
      return {
        ...add(batch, proposed, quote, content),
        op: 'supersede',
        claim_id: claim.id,
        expected_revision: claim.head_revision,
      } as ExtractionProposal;
    };
    // Bob's move, proposed under the subject without his part, beside a new detail.
    const moved = await memberSaid(scope, bob, 'I moved to Braga. I am vegan.');
    expect(
      await commitExtraction(store.sql, scope, moved, {
        proposals: [
          change(moved, /^home\.city\.member_/, 'home.city', 'I moved to Braga', 'Lives in Braga'),
          add(moved, 'food.diet', 'I am vegan', 'Vegan'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    // Alice's change, proposed with a member's part her detail is not held under.
    const back = await memberSaid(scope, alice, 'I moved to Faro.');
    expect(
      await commitExtraction(store.sql, scope, back, {
        proposals: [
          change(
            back,
            /^home\.city$/,
            'home.city.member_0123456789ab',
            'I moved to Faro',
            'Lives in Faro',
          ),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    expect(await heldNow(scope)).toEqual([
      ['food.diet', 'Vegan', bob, 1, 1],
      ['home.city', 'Lives in Faro', alice, 1, 2],
      ['home.city.member', 'Lives in Braga', bob, 1, 2],
    ]);
  });

  test("one change memory cannot make is refused alone; the message's other details are kept", async () => {
    const scope = await createScope(store);
    const first = await said(
      scope,
      'I live in Porto. The owner of my flat lives in Porto too. My sister Maya lives in Lisbon.',
    );
    await commitExtraction(store.sql, scope, first, {
      proposals: [
        add(first, 'home.city', 'I live in Porto', 'Lives in Porto'),
        add(
          first,
          'person.owner.city',
          'The owner of my flat lives in Porto',
          'The owner of my flat lives in Porto',
        ),
        add(
          first,
          'person.maya.city',
          'My sister Maya lives in Lisbon',
          'Sister Maya lives in Lisbon',
        ),
      ],
    });
    /** A change to the claim held as `held`, proposed under `proposed`. */
    const change = (batch: Batch, held: string, proposed: string, quote: string, content: string) =>
      ({
        ...supersede(batch, held, quote, content),
        domain_key: proposed,
      }) as ExtractionProposal;
    // The person's own move, proposed as a change to the flat owner's city.
    const moved = await said(scope, 'I moved to Braga. I am vegetarian.');
    expect(
      await commitExtraction(store.sql, scope, moved, {
        proposals: [
          change(moved, 'person.owner.city', 'home.city', 'I moved to Braga', 'Lives in Braga'),
          add(moved, 'food.diet', 'I am vegetarian', 'Vegetarian'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    // The person's own detail proposed as a change to Maya's city: that change
    // is refused, with its reason, and the rest of the message is kept.
    const berlin = await said(scope, 'It is Berlin for work now. I am allergic to peanuts.');
    expect(
      await commitExtraction(store.sql, scope, berlin, {
        proposals: [
          change(
            berlin,
            'person.maya.city',
            'work.city',
            'It is Berlin for work now',
            'Works in Berlin',
          ),
          add(berlin, 'health.allergy', 'I am allergic to peanuts', 'Allergic to peanuts'),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    const refused = await store.sql`select proposal_index, reason, detail from memory_rejections
      where space_id = ${scope.spaceId} and work_id = ${berlin.work.id}`;
    expect(refused.map((row) => [row.proposal_index, row.reason, row.detail])).toEqual([
      [0, 'change_set_refused', 'The proposed change could not be kept (target_mismatch).'],
    ]);
    expect(await heldNow(scope)).toEqual([
      ['food.diet', 'Vegetarian', 'owner', 1, 1],
      ['health.allergy', 'Allergic to peanuts', 'owner', 1, 1],
      ['home.city', 'Lives in Braga', 'owner', 1, 2],
      ['person.maya.city', 'Sister Maya lives in Lisbon', 'owner', 1, 1],
      ['person.owner.city', 'The owner of my flat lives in Porto', 'owner', 1, 1],
    ]);
    // A message whose only change is refused is still refused, as before.
    const alone = await said(scope, 'It is Berlin now.');
    expect(
      await commitExtraction(store.sql, scope, alone, {
        proposals: [
          change(alone, 'person.maya.city', 'home.city', 'It is Berlin now', 'Lives in Berlin'),
        ],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'target_mismatch' });
  });

  test('a relation said once is kept when a later change leaves it out of the words', async () => {
    const scope = await createScope(store);
    const madrid = await said(scope, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, scope, madrid, {
      proposals: [
        add(
          madrid,
          'person.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    const porto = await said(scope, 'Sam lives in Porto now.');
    await commitExtraction(store.sql, scope, porto, {
      proposals: [supersede(porto, 'person.sam.city', 'Sam lives in Porto', 'Sam lives in Porto')],
    });
    // A friend of the same name, as a change to that claim and as a new detail on its subject.
    const faro = await said(scope, 'My friend Sam lives in Faro.');
    expect(
      await commitExtraction(store.sql, scope, faro, {
        proposals: [
          supersede(
            faro,
            'person.sam.city',
            'My friend Sam lives in Faro',
            'Friend Sam lives in Faro',
          ),
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    const other = await createScope(store);
    const first = await said(other, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, other, first, {
      proposals: [
        add(
          first,
          'person.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    const second = await said(other, 'Sam lives in Porto now.');
    await commitExtraction(store.sql, other, second, {
      proposals: [supersede(second, 'person.sam.city', 'Sam lives in Porto', 'Sam lives in Porto')],
    });
    const third = await said(other, 'My friend Sam lives in Faro.');
    await commitExtraction(store.sql, other, third, {
      proposals: [
        add(third, 'person.sam.city', 'My friend Sam lives in Faro', 'Friend Sam lives in Faro'),
      ],
    });
    for (const space of [scope, other])
      expect(await heldNow(space)).toEqual([
        ['person.friend.sam.city', 'Friend Sam lives in Faro', 'owner', 1, 1],
        ['person.sam.city', 'Sam lives in Porto', 'owner', 1, 2],
      ]);
    // As a real model wrote it: the change's words leave the friend out, the person's do not.
    const quoted = await createScope(store);
    const brother = await said(quoted, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, quoted, brother, {
      proposals: [
        add(
          brother,
          'person.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    const moved = await said(quoted, 'Sam lives in Porto now.');
    await commitExtraction(store.sql, quoted, moved, {
      proposals: [supersede(moved, 'person.sam.city', 'Sam lives in Porto', 'Sam lives in Porto')],
    });
    const friend = await said(quoted, 'My friend Sam just moved to Faro.');
    await commitExtraction(store.sql, quoted, friend, {
      proposals: [
        supersede(
          friend,
          'person.sam.city',
          'My friend Sam just moved to Faro',
          'Sam lives in Faro',
        ),
      ],
    });
    // Words that do not say how the person knows him still change the one held.
    const plain = await said(quoted, 'Sam moved to Braga.');
    await commitExtraction(store.sql, quoted, plain, {
      proposals: [supersede(plain, 'person.sam.city', 'Sam moved to Braga', 'Sam lives in Braga')],
    });
    expect(await heldNow(quoted)).toEqual([
      ['person.friend.sam.city', 'Sam lives in Faro', 'owner', 1, 1],
      ['person.sam.city', 'Sam lives in Braga', 'owner', 1, 3],
    ]);
  });

  test("the person's words relate someone only by the word beside their name", async () => {
    const scope = await createScope(store);
    const madrid = await said(scope, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, scope, madrid, {
      proposals: [
        add(
          madrid,
          'person.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    // Someone else in the sentence says how the person heard it, not who Sam is.
    for (const [message, city] of [
      ['My friend told me Sam moved to Faro.', 'Faro'],
      ['My sister says Sam lives in Braga now.', 'Braga'],
      ['Mom called: Sam has moved to Lagos.', 'Lagos'],
    ] as const) {
      const batch = await said(scope, message);
      await commitExtraction(store.sql, scope, batch, {
        proposals: [
          supersede(batch, 'person.sam.city', message.slice(0, -1), `Sam lives in ${city}`),
        ],
      });
    }
    // A describing word between them still relates him.
    const friend = await said(scope, 'My good friend Sam just moved to Faro.');
    await commitExtraction(store.sql, scope, friend, {
      proposals: [
        supersede(
          friend,
          'person.sam.city',
          'My good friend Sam just moved to Faro',
          'Sam lives in Faro',
        ),
      ],
    });
    expect(await heldNow(scope)).toEqual([
      ['person.friend.sam.city', 'Sam lives in Faro', 'owner', 1, 1],
      ['person.sam.city', 'Sam lives in Lagos', 'owner', 1, 4],
    ]);
  });

  test("in a room, a member's change left without their part is kept apart from another of that name", async () => {
    const scope = await room();
    const alice = 'prn_alice';
    const bob = 'prn_bob';
    const hers = await memberSaid(scope, alice, 'My friend Sam lives in Lisbon.');
    await commitExtraction(store.sql, scope, hers, {
      proposals: [
        add(hers, 'person.sam.city', 'My friend Sam lives in Lisbon', 'Friend Sam lives in Lisbon'),
      ],
    });
    const his = await memberSaid(scope, bob, 'My brother Sam lives in Madrid.');
    await commitExtraction(store.sql, scope, his, {
      proposals: [
        add(
          his,
          'person.sam.city',
          'My brother Sam lives in Madrid',
          'Brother Sam lives in Madrid',
        ),
      ],
    });
    // Bob's friend, proposed as a change to his brother's city without his part.
    const friend = await memberSaid(scope, bob, 'My friend Sam just moved to Faro.');
    const brother = friend.claims.find((claim) =>
      /^person\.sam\.city\.member_/.test(claim.domain_key),
    );
    if (!brother) throw new Error("Bob's brother was not shown");
    expect(
      await commitExtraction(store.sql, scope, friend, {
        proposals: [
          {
            ...add(
              friend,
              'person.sam.city',
              'My friend Sam just moved to Faro',
              'Friend Sam lives in Faro',
            ),
            op: 'supersede',
            claim_id: brother.id,
            expected_revision: brother.head_revision,
          } as ExtractionProposal,
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    expect(await heldNow(scope)).toEqual([
      ['person.friend.sam.city', 'Friend Sam lives in Faro', bob, 1, 1],
      ['person.sam.city', 'Friend Sam lives in Lisbon', alice, 1, 1],
      ['person.sam.city.member', 'Brother Sam lives in Madrid', bob, 1, 1],
    ]);
  });

  test('a change refused alone is not put to the person for review', async () => {
    const scope = await createScope(store);
    await store.sql`update memory_spaces set require_review = true where space_id = ${scope.spaceId}`;
    const first = await said(scope, 'My sister Maya lives in Lisbon.');
    await commitExtraction(
      store.sql,
      scope,
      first,
      {
        proposals: [
          add(
            first,
            'person.maya.city',
            'My sister Maya lives in Lisbon',
            'Sister Maya lives in Lisbon',
          ),
        ],
      },
      true,
    );
    const berlin = await said(scope, 'It is Berlin for work now. I am allergic to peanuts.');
    expect(
      await commitExtraction(store.sql, scope, berlin, {
        proposals: [
          {
            ...supersede(
              berlin,
              'person.maya.city',
              'It is Berlin for work now',
              'Works in Berlin',
            ),
            domain_key: 'work.city',
          } as ExtractionProposal,
          add(berlin, 'health.allergy', 'I am allergic to peanuts', 'Allergic to peanuts'),
        ],
      }),
    ).toMatchObject({ status: 'review' });
    const [pending] =
      await store.sql`select payload from memory_proposals where work_id = ${berlin.work.id}`;
    if (!pending) throw new Error('nothing was put to the person');
    const proposed = (pending.payload as { proposals: ExtractionProposal[] }).proposals;
    expect(
      proposed.map((proposal) => [proposal.op, 'domain_key' in proposal && proposal.domain_key]),
    ).toEqual([['add', 'health.allergy']]);
    const refused = await store.sql`select proposal_index, reason from memory_rejections
      where space_id = ${scope.spaceId} and work_id = ${berlin.work.id}`;
    expect(refused.map((row) => [row.proposal_index, row.reason])).toEqual([
      [0, 'change_set_refused'],
    ]);
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
    // The person's own move proposed as a change to the flat owner's city never
    // lands on it: it is kept as the person's own, under the subject proposed.
    const faro = await said(scope, 'I moved to Faro.');
    await commitExtraction(store.sql, scope, faro, {
      proposals: [supersede(faro, 'person.owner.city', 'I moved to Faro', 'Lives in Faro')].map(
        (change) => ({ ...change, domain_key: 'home.city' }),
      ) as ExtractionProposal[],
    });
    expect(await heldNow(scope)).toEqual([
      ['contact.owner.availability', 'Can be home Thursday afternoon if that works', 'owner', 2, 1],
      ['home.city', 'Lives in Faro', 'owner', 1, 1],
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

  test('a block saved under one run of words, "person.peanut_allergy", still holds', async () => {
    const scope = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_peanut_run', ${scope.spaceId}, 'person.peanut_allergy', null, 'Peanut allergy'),
      ('mb_aisle_run', ${scope.spaceId}, 'person.aisle_seat', null, 'Aisle seat'),
      ('mb_sam_run', ${scope.spaceId}, 'person.sam_city', null, 'Sam city'),
      ('mb_shellfish_run', ${scope.spaceId}, 'person.shellfish_allergy', null, 'Shellfish allergy')`;
    const batch = await said(
      scope,
      'I am allergic to peanuts. Aisle seats only on flights. I love peanut butter cookies. I live in the same city as Sam. I am allergic to sesame.',
    );
    const result = await commitExtraction(store.sql, scope, batch, {
      proposals: [
        add(batch, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
        add(batch, 'travel.seat', 'Aisle seats only on flights', 'Aisle seats only on flights', {
          kind: 'preference',
        }),
        add(batch, 'food.likes', 'I love peanut butter cookies', 'Loves peanut butter cookies'),
        // Sam's city was blocked, not the person's: Sam is named here.
        add(batch, 'home.city', 'live in the same city as Sam', 'Lives in the same city as Sam'),
        add(batch, 'health.allergy.sesame', 'allergic to sesame', 'Allergic to sesame'),
      ],
    });
    expect(result.status).toBe('committed');
    expect((await heldNow(scope)).map(([subject]) => subject)).toEqual([
      'food.likes',
      'health.allergy.sesame',
      'home.city',
    ]);
    const refused =
      await store.sql`select reason from memory_rejections where work_id = ${batch.work.id}`;
    expect(refused.map((row) => row.reason)).toEqual(['blocked_by_person', 'blocked_by_person']);
  });
});
