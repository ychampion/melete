/**
 * "Forget and don't learn again" holds for anything about the forgotten
 * detail's subject by default. Asked for just that detail, it holds for the
 * detail wherever a later message files it, and not for a different detail
 * filed under the same subject. The block keeps no word of what was forgotten. The
 * proposals below are the subjects and sentences real models wrote for these
 * messages.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionProposal } from '@melete/contracts';
import { blockBelief, listBeliefs, listBlocks } from '../../src/memory/beliefs.ts';
import { type BlockScope, blockedSubject } from '../../src/memory/blocks.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import { type MemoryScope, stableId } from '../../src/memory/db.ts';
import { ingest, persistEvidence } from '../../src/memory/evidence.ts';
import { exportBeliefFile, importBeliefFile } from '../../src/memory/portable.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import { claimWork } from '../../src/memory/work.ts';
import { createScope, createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-blocks-'));
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
const withDb = db ? describe : describe.skip;
type Batch = NonNullable<Awaited<ReturnType<typeof claimWork>>>;

const KEY = 'test-master-key-0123456789abcdef0123456789abcdef';
let before: string | undefined;
beforeEach(() => {
  before = process.env.MELETE_MASTER_KEY;
  process.env.MELETE_MASTER_KEY = KEY;
});
afterEach(() => {
  if (before === undefined) delete process.env.MELETE_MASTER_KEY;
  else process.env.MELETE_MASTER_KEY = before;
});

withDb('a block holds for the detail that was forgotten', () => {
  const store = db as NonNullable<typeof db>;
  let sequence = 0;
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes)).toISOString();
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
  const add = (batch: Batch, domain_key: string, quote: string, content: string) => {
    const start = batch.work.segment_start + batch.text.indexOf(quote);
    if (start < batch.work.segment_start) throw new Error(`"${quote}" is not in the message`);
    return {
      op: 'add',
      expected_revision: null,
      domain_key,
      content,
      kind: 'user_statement',
      factual_status: 'attributed',
      valid_from: batch.source.event_at,
      valid_until: null,
      sources: [
        {
          source_id: batch.source.source_id,
          source_version: batch.source.source_version,
          start,
          end: start + quote.length,
          quote,
        },
      ],
    } as ExtractionProposal;
  };
  /**
   * One message, read as a model filed it: [subject, words quoted, sentence
   * saved], and the registry key it was given, if any.
   */
  const say = async (
    scope: MemoryScope,
    text: string,
    proposals: [string, string, string, string?][],
  ) => {
    const batch = await said(scope, text);
    const result = await commitExtraction(store.sql, scope, batch, {
      proposals: proposals.map(([subject, quote, content, key]) =>
        key ? { ...add(batch, subject, quote, content), key } : add(batch, subject, quote, content),
      ),
    });
    expect(result.status).toBe('committed');
    const refused = await store.sql`select reason from memory_rejections
      where work_id = ${batch.work.id} order by proposal_index`;
    return refused.map((row) => String(row.reason));
  };
  const held = async (scope: MemoryScope) => {
    const rows = await store.sql`select c.domain_key, b.content from memory_claims c
      join memory_revision_content b on b.claim_id = c.id and b.revision = c.head_revision
      where c.space_id = ${scope.spaceId} and not c.hidden order by c.domain_key, b.content`;
    return rows.map((row) => `${row.domain_key} :: ${row.content}`);
  };
  const journal = async () => {
    const file = new FileRestrictionJournal(join(root, `${crypto.randomUUID()}.jsonl`));
    await file.initializeNew();
    return file;
  };
  /**
   * Forget each held detail whose words match, and don't learn it again: as
   * far as `reach` asks, or as far as the default reaches when it is left out.
   */
  const blockAs = async (
    reach: BlockScope | undefined,
    scope: MemoryScope,
    ...patterns: RegExp[]
  ) => {
    const reached: string[] = [];
    for (const pattern of patterns) {
      const belief = (await listBeliefs(store.sql, scope, 'UTC')).find((item) =>
        pattern.test(item.value),
      );
      if (!belief) throw new Error(`nothing held matches ${pattern}`);
      const result = reach
        ? await blockBelief(store.sql, scope, belief.id, await journal(), reach)
        : await blockBelief(store.sql, scope, belief.id, await journal());
      reached.push(String((result as { scope?: unknown }).scope));
    }
    return reached;
  };
  /** Forget just the detail, as the tests of a detail's block below do. */
  const block = (scope: MemoryScope, ...patterns: RegExp[]) =>
    blockAs('detail', scope, ...patterns);
  /** Someone who said four things about themselves, then blocked all four. */
  /** Four details forgotten as far as `reach` asks; 'default' leaves it out. */
  const blockedFour = async (reach: BlockScope | 'default' = 'detail') => {
    const scope = await createScope(store);
    await say(
      scope,
      "When I fly I always book an aisle seat. Heads up, I'm allergic to peanuts. I'm vegetarian. I live in Lisbon.",
      [
        [
          'travel.seat',
          'When I fly I always book an aisle seat',
          'Always books an aisle seat when flying',
        ],
        ['health.allergy', "I'm allergic to peanuts", 'Allergic to peanuts'],
        ['food.diet', "I'm vegetarian", 'Vegetarian'],
        ['home.city', 'I live in Lisbon', 'Lives in Lisbon'],
      ],
    );
    await blockAs(
      reach === 'default' ? undefined : reach,
      scope,
      /aisle/,
      /peanut/,
      /vegetarian/i,
      /lisbon/i,
    );
    expect(await held(scope)).toEqual([]);
    return scope;
  };

  test('said again in new words, under another subject, it is not learned again', async () => {
    const scope = await blockedFour();
    expect(
      await say(scope, 'I have a peanut allergy, please tell restaurants when you book.', [
        [
          'dining.allergy_notice',
          'please tell restaurants when you book',
          'Tell restaurants about the peanut allergy when booking',
        ],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'Only vegetarian restaurants for me, please.', [
        ['food.restaurant', 'Only vegetarian restaurants for me', 'Only vegetarian restaurants'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'Book me on the Rome flight. Aisle seats only for me, always.', [
        ['travel.seat', 'Aisle seats only for me, always', 'Aisle seats only, always'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, "I can't stand window seats on planes, I always need the aisle.", [
        [
          'travel.seat',
          "I can't stand window seats on planes, I always need the aisle",
          "Can't stand window seats on planes; always needs the aisle",
        ],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, "I don't eat meat or fish.", [
        ['food.diet', "I don't eat meat or fish", "Doesn't eat meat or fish"],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'My flat is in Lisbon, near Alfama.', [
        ['home.city', 'My flat is in Lisbon, near Alfama', 'Flat is in Lisbon, near Alfama'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'Peanuts make me really ill, so no satay for me ever.', [
        ['health.allergy.peanuts', 'Peanuts make me really ill', 'Peanuts make me really ill'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(scope)).toEqual([]);
  });

  test('a different detail under the same subject, or someone else’s, is still learned', async () => {
    const nearby: [string, [string, string, string]][] = [
      [
        'On trains I like a window seat.',
        ['travel.seat', 'On trains I like a window seat', 'Prefers a window seat on trains'],
      ],
      [
        'On trains I like a window seat, honestly.',
        ['travel.seat.train', 'On trains I like a window seat', 'Prefers window seats on trains'],
      ],
      [
        'Also, an aisle seat on trains please.',
        ['travel.seat.train', 'an aisle seat on trains', 'Prefers an aisle seat on trains'],
      ],
      [
        'On long flights I like extra legroom.',
        [
          'travel.seat',
          'On long flights I like extra legroom',
          'Likes extra legroom on long flights',
        ],
      ],
      [
        "I'm also allergic to shellfish.",
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ],
      ["I don't drink alcohol.", ['food.diet', "I don't drink alcohol", "Doesn't drink alcohol"]],
      ['I moved to Porto last month.', ['home.city', 'I moved to Porto', 'Lives in Porto']],
      [
        'My office is in Lisbon.',
        ['work.office.city', 'My office is in Lisbon', 'Office is in Lisbon'],
      ],
      ['I grew up in Faro.', ['home.hometown', 'I grew up in Faro', 'Grew up in Faro']],
      ['I work in Lisbon.', ['work.city', 'I work in Lisbon', 'Works in Lisbon']],
      [
        'My sister Lena always wants an aisle seat when she flies.',
        [
          'person.lena.seat',
          'My sister Lena always wants an aisle seat when she flies',
          'Sister Lena always wants an aisle seat when she flies',
        ],
      ],
      [
        'My friend Sam is allergic to peanuts.',
        [
          'person.sam.allergy',
          'My friend Sam is allergic to peanuts',
          'Friend Sam is allergic to peanuts',
        ],
      ],
      [
        'My brother Tom is vegetarian.',
        ['person.tom.diet', 'My brother Tom is vegetarian', 'Brother Tom is vegetarian'],
      ],
    ];
    // Each said, one after another, by someone who blocked the four details
    // above. Blocks are checked on each detail as it is proposed, so one
    // learned earlier changes nothing for the next; a later detail under the
    // same subject may replace an earlier one.
    const scope = await blockedFour();
    for (const [text, [subject, quote, content]] of nearby) {
      expect(await say(scope, text, [[subject, quote, content]])).toEqual([]);
      expect(await held(scope)).toContain(`${subject} :: ${content}`);
    }
  });

  test('a block keeps no word of what was forgotten, and says it holds for that detail', async () => {
    const scope = await blockedFour();
    const rows = await store.sql`select domain_key, label from memory_blocks
      where space_id = ${scope.spaceId} order by label`;
    const stored = rows
      .map((row) => `${row.domain_key} ${row.label}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['aisle', 'peanut', 'vegetarian', 'lisbon', 'flying', 'allergic'])
      expect(stored).not.toContain(word);
    expect((await listBlocks(store.sql, scope)).blocks.map((row) => row.label).sort()).toEqual([
      'Food diet, the detail you forgot',
      'Health allergy, the detail you forgot',
      'Home city, the detail you forgot',
      'Travel seat, the detail you forgot',
    ]);
    // Two details blocked under one subject are two blocks.
    await say(scope, "I'm allergic to shellfish.", [
      ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
    ]);
    await block(scope, /shellfish/);
    expect((await listBlocks(store.sql, scope)).blocks).toHaveLength(5);
    expect(
      await say(scope, 'Shellfish is a no for me, I react badly.', [
        ['health.allergy', 'Shellfish is a no for me', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
  });

  test('blocks saved for a subject, before details were kept, hold under the subject models use today', async () => {
    const scope = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_flights_seat', ${scope.spaceId}, 'preference.flights.seat', null, 'Flights seat'),
      ('mb_location', ${scope.spaceId}, 'person.location.city', null, 'Location city'),
      ('mb_diet', ${scope.spaceId}, 'person.diet.vegetarian', null, 'Diet vegetarian')`;
    expect(
      await say(scope, 'For any flight you book me, pick an aisle seat.', [
        ['travel.seat', 'pick an aisle seat', 'Prefers aisle seats on flights'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, "I don't eat meat or fish.", [
        ['food.diet', "I don't eat meat or fish", "Doesn't eat meat or fish"],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, "I'm based in Lisbon these days.", [
        ['home.city', "I'm based in Lisbon these days", 'Based in Lisbon'],
      ]),
    ).toEqual(['blocked_by_person']);
    // Not the same subject, nor the same detail.
    expect(
      await say(scope, 'On trains I like a window seat.', [
        ['travel.seat.train', 'On trains I like a window seat', 'Prefers window seats on trains'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'My office is in Porto.', [
        ['work.office.city', 'My office is in Porto', 'Office is in Porto'],
      ]),
    ).toEqual([]);
    expect(await held(scope)).toEqual([
      'travel.seat.train :: Prefers window seats on trains',
      'work.office.city :: Office is in Porto',
    ]);
  });

  test('an older block that leaves out the kind of trip holds for the same seat, not a seat on trains', async () => {
    const scope = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_aisle', ${scope.spaceId}, 'person.preference.flights.aisle_seat', null, 'Aisle seat')`;
    expect(
      await say(scope, 'Always book aisle seats for me.', [
        ['travel.seat', 'Always book aisle seats for me', 'Always book aisle seats'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'An aisle seat on trains, please.', [
        ['travel.seat', 'An aisle seat on trains', 'Prefers an aisle seat on trains'],
      ]),
    ).toEqual([]);
  });

  test("a block on someone else's detail never holds for the person's own", async () => {
    const scope = await createScope(store);
    await say(scope, 'My friend Sam is allergic to peanuts.', [
      [
        'person.sam.allergy',
        'My friend Sam is allergic to peanuts',
        'Friend Sam is allergic to peanuts',
      ],
    ]);
    await block(scope, /Sam/);
    expect(
      await say(scope, "I'm allergic to peanuts.", [
        ['health.allergy', 'allergic to peanuts', 'Allergic to peanuts'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'Sam is allergic to cats too.', [
        ['person.sam.allergy', 'Sam is allergic to cats', 'Friend Sam is allergic to cats'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'Sam really reacts badly to peanuts.', [
        ['person.sam.allergy', 'Sam really reacts badly to peanuts', 'Sam reacts badly to peanuts'],
      ]),
    ).toEqual(['blocked_by_person']);
  });

  test('a block on a detail an older extraction saved as one run of words is the person’s own', async () => {
    const scope = await createScope(store);
    const kept = blockedSubject(
      scope.spaceId,
      'person.peanut_allergy',
      'Allergic to peanuts',
      'detail',
    );
    expect(kept.scope).toBe('detail');
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_run', ${scope.spaceId}, ${kept.subject}, null, 'Peanut allergy')`;
    expect(
      await say(scope, "I'm allergic to shellfish.", [
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'Please tell restaurants about my peanut allergy.', [
        [
          'booking.instruction.restaurants',
          'tell restaurants about my peanut allergy',
          'Tell restaurants about the peanut allergy',
        ],
      ]),
    ).toEqual(['blocked_by_person']);
  });

  test('a detail that says nothing of its own is blocked for its whole subject', async () => {
    const scope = await createScope(store);
    await say(scope, 'I have a few allergies.', [
      ['health.allergy', 'I have a few allergies', 'Has allergies'],
    ]);
    await block(scope, /allergies/);
    expect((await listBlocks(store.sql, scope)).blocks.map((row) => row.label)).toEqual([
      'Anything about Health allergy',
    ]);
    expect(
      await say(scope, "I'm allergic to shellfish.", [
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
  });

  test('without the install key, or after it changed, a block holds for its whole subject', async () => {
    delete process.env.MELETE_MASTER_KEY;
    const plain = await createScope(store);
    await say(plain, "I'm allergic to peanuts.", [
      ['health.allergy', 'allergic to peanuts', 'Allergic to peanuts'],
    ]);
    await block(plain, /peanut/);
    expect((await listBlocks(store.sql, plain)).blocks.map((row) => row.label)).toEqual([
      'Anything about Health allergy',
    ]);
    expect(
      await say(plain, "I'm allergic to shellfish.", [
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
    await say(plain, 'Call me Max.', [['general', 'Call me Max', 'Goes by Max']]);
    await block(plain, /Max/);
    expect(
      await say(plain, 'I go by Maxi now.', [['general', 'I go by Maxi', 'Goes by Maxi']]),
    ).toEqual(['blocked_by_person']);

    // Kept for its subject, it is a block on anything about it, the subjects it narrows to included.
    await say(plain, 'When I fly I always book an aisle seat.', [
      [
        'travel.seat',
        'When I fly I always book an aisle seat',
        'Always books an aisle seat when flying',
      ],
    ]);
    await block(plain, /aisle/);
    expect(
      await say(plain, 'On trains I like a window seat.', [
        ['travel.seat.train', 'On trains I like a window seat', 'Prefers window seats on trains'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(plain, 'On long flights I like extra legroom.', [
        ['travel.legroom', 'On long flights I like extra legroom', 'Likes extra legroom'],
      ]),
    ).toEqual([]);
    await say(plain, 'My friend Sam lives in Porto.', [
      ['person.sam.city', 'My friend Sam lives in Porto', 'Friend Sam lives in Porto'],
    ]);
    await block(plain, /Porto/);
    expect(
      await say(plain, 'Sam is in Porto, by the way.', [
        ['person.sam.city', 'Sam is in Porto', 'Sam lives in Porto'],
      ]),
    ).toEqual(['blocked_by_person']);

    process.env.MELETE_MASTER_KEY = KEY;
    const changed = await createScope(store);
    await say(changed, "I'm allergic to peanuts.", [
      ['health.allergy', 'allergic to peanuts', 'Allergic to peanuts'],
    ]);
    await block(changed, /peanut/);
    process.env.MELETE_MASTER_KEY = `${KEY}-rotated`;
    expect(
      await say(changed, "I'm allergic to shellfish.", [
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
  });

  test('a detail block made before the install key changed lists as holding for its whole subject, as it does', async () => {
    const scope = await createScope(store);
    await say(scope, "I'm allergic to peanuts.", [
      ['health.allergy', 'allergic to peanuts', 'Allergic to peanuts'],
    ]);
    await block(scope, /peanut/);
    const listed = async () =>
      (await listBlocks(store.sql, scope)).blocks.map((row) => [row.label, row.scope]);
    expect(await listed()).toEqual([['Health allergy, the detail you forgot', 'detail']]);
    process.env.MELETE_MASTER_KEY = `${KEY}-rotated`;
    expect(await listed()).toEqual([['Anything about Health allergy', 'topic']]);
    expect(
      await say(scope, "I'm allergic to shellfish.", [
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
    delete process.env.MELETE_MASTER_KEY;
    expect(await listed()).toEqual([['Anything about Health allergy', 'topic']]);
  });

  test('a block on a keyed detail holds for any value said under that key', async () => {
    const scope = await createScope(store);
    await say(scope, 'On flights I take an aisle seat.', [
      ['pref.travel.seat', 'aisle seat', 'aisle seat', 'pref.travel.seat'],
    ]);
    await block(scope, /aisle/);
    expect(
      await say(scope, 'Put me in a window seat on flights from now on.', [
        ['pref.travel.seat', 'window seat', 'window seat', 'pref.travel.seat'],
      ]),
    ).toEqual(['blocked_by_person']);
    // Another key is another detail.
    expect(
      await say(scope, 'On flights I take the vegetarian meal.', [
        ['pref.travel.meal', 'vegetarian meal', 'vegetarian meal', 'pref.travel.meal'],
      ]),
    ).toEqual([]);
    expect(await held(scope)).toEqual(['pref.travel.meal :: vegetarian meal']);
  });

  test('an older block on a two-word subject holds for that subject, not for a detail it only shares a word with', async () => {
    const scope = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_work_lisbon', ${scope.spaceId}, 'work.lisbon', null, 'Work lisbon')`;
    expect(
      await say(scope, 'I live in Lisbon.', [['general', 'I live in Lisbon', 'Lives in Lisbon']]),
    ).toEqual([]);
    expect(
      await say(scope, 'I work in Lisbon.', [
        ['work.lisbon', 'I work in Lisbon', 'Works in Lisbon'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(scope)).toEqual(['general :: Lives in Lisbon']);
  });

  test("in a room, a member's block holds for what that member says, not for another member", async () => {
    const scope: MemoryScope = {
      ...(await createScope(store)),
      audience: 'space',
      publisher: 'room',
    };
    const bob = 'prn_bob_blocks';
    const alice = 'prn_alice_blocks';
    const bobs = `travel.seat.member_${stableId('member', bob).slice(0, 12)}`;
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_room_seat', ${scope.spaceId}, ${bobs}, null, 'Travel seat')`;
    const fromBob = await memberSaid(scope, bob, 'Aisle seats for me, always.');
    await commitExtraction(store.sql, scope, fromBob, {
      proposals: [add(fromBob, 'travel.seat', 'Aisle seats for me, always', 'Aisle seats, always')],
    });
    const fromAlice = await memberSaid(scope, alice, 'I take the window seat.');
    await commitExtraction(store.sql, scope, fromAlice, {
      proposals: [add(fromAlice, 'travel.seat', 'I take the window seat', 'Takes the window seat')],
    });
    // Someone in a member's life, kept under that member's tag, too.
    const bobsSam = `person.sam.city.member_${stableId('member', bob).slice(0, 12)}`;
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_room_sam', ${scope.spaceId}, ${bobsSam}, null, 'Sam city')`;
    const samFromBob = await memberSaid(scope, bob, 'My friend Sam lives in Porto.');
    await commitExtraction(store.sql, scope, samFromBob, {
      proposals: [
        add(
          samFromBob,
          'person.sam.city',
          'My friend Sam lives in Porto',
          'Friend Sam lives in Porto',
        ),
      ],
    });
    const samFromAlice = await memberSaid(scope, alice, 'My friend Sam lives in Braga.');
    await commitExtraction(store.sql, scope, samFromAlice, {
      proposals: [
        add(
          samFromAlice,
          'person.sam.city',
          'My friend Sam lives in Braga',
          'Friend Sam lives in Braga',
        ),
      ],
    });
    expect(await held(scope)).toEqual([
      'person.sam.city :: Friend Sam lives in Braga',
      'travel.seat :: Takes the window seat',
    ]);
    const refused = await store.sql`select reason from memory_rejections
      where space_id = ${scope.spaceId}`;
    expect(refused.map((row) => row.reason)).toEqual(['blocked_by_person', 'blocked_by_person']);
  });

  test('a detail said in a script whose words are not compared stays blocked for its subject', async () => {
    // Saved in English, said again in Japanese under the blocked subject.
    const english = await createScope(store);
    await say(english, '私はベジタリアンです。私はリスボンに住んでいます。', [
      ['food.diet', '私はベジタリアンです', 'Is vegetarian'],
      ['home.city', '私はリスボンに住んでいます', 'Lives in Lisbon'],
    ]);
    await block(english, /vegetarian/i, /lisbon/i);
    expect(
      await say(english, '肉や魚は食べません。', [
        ['food.diet', '肉や魚は食べません', '肉や魚は食べません'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(english, 'リスボン在住です。', [
        ['home.city', 'リスボン在住です', 'リスボンに住んでいる'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(english)).toEqual([]);

    // Saved in Russian, said again in other words, or in English.
    const russian = await createScope(store);
    await say(russian, 'Я живу в Лиссабоне. У меня аллергия на арахис.', [
      ['home.city', 'Я живу в Лиссабоне', 'Живу в Лиссабоне'],
      ['health.allergy.peanuts', 'У меня аллергия на арахис', 'Аллергия на арахис'],
    ]);
    await block(russian, /Лиссабон/, /арахис/);
    expect((await listBlocks(store.sql, russian)).blocks.map((row) => row.label).sort()).toEqual([
      'Anything about Health allergy peanuts',
      'Anything about Home city',
    ]);
    expect(
      await say(russian, 'Мой дом — Лиссабон.', [
        ['home.city', 'Мой дом — Лиссабон', 'Lives in Lisbon'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(russian, 'Сейчас я обосновался в Лиссабоне.', [
        ['home.city', 'Сейчас я обосновался в Лиссабоне', 'Обосновался в Лиссабоне'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(russian, 'Арахис мне нельзя, аллергия.', [
        ['health.allergy', 'Арахис мне нельзя, аллергия', 'Allergic to peanuts'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(russian)).toEqual([]);
  });

  test('importing a file brings in a different detail under a blocked subject, not the blocked one', async () => {
    const target = await blockedFour();
    const shellfish = await createScope(store);
    await say(shellfish, "I'm allergic to shellfish.", [
      ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
    ]);
    const peanut = await createScope(store);
    await say(peanut, "I'm allergic to peanuts.", [
      ['health.allergy', 'allergic to peanuts', 'Allergic to peanuts'],
    ]);
    const from = async (scope: MemoryScope) =>
      JSON.parse(JSON.stringify(await exportBeliefFile(store.sql, scope, 'UTC')));
    expect(await importBeliefFile(store.sql, target, await from(peanut))).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect(await importBeliefFile(store.sql, target, await from(shellfish))).toMatchObject({
      imported: 1,
      skipped: 0,
    });
    expect(await held(target)).toEqual(['health.allergy :: Allergic to shellfish']);
  });

  test('by default a block holds for anything about the subject, the detail in new words included', async () => {
    const scope = await blockedFour('default');
    expect(
      (await listBlocks(store.sql, scope)).blocks.map((row) => [row.label, row.scope]).sort(),
    ).toEqual([
      ['Anything about Food diet', 'topic'],
      ['Anything about Health allergy', 'topic'],
      ['Anything about Home city', 'topic'],
      ['Anything about Travel seat', 'topic'],
    ]);
    // Said again in words the block's matcher was never shown, as real models
    // filed them, and a different detail under each subject.
    const again: [string, [string, string, string]][] = [
      [
        'Corridor seat for me on every flight.',
        [
          'travel.seat',
          'Corridor seat for me on every flight',
          'Prefers a corridor seat on every flight',
        ],
      ],
      ["I don't eat animals.", ['food.diet', "I don't eat animals", "Doesn't eat animals"]],
      [
        'I stick to plant-based food.',
        ['food.diet', 'I stick to plant-based food', 'Sticks to plant-based food'],
      ],
      [
        "Groundnuts are a no-go for me, I'm allergic.",
        ['health.allergy', "Groundnuts are a no-go for me, I'm allergic", 'Allergic to groundnuts'],
      ],
      [
        "I'm living in the Portuguese capital.",
        ['home.city', "I'm living in the Portuguese capital", 'Lives in the Portuguese capital'],
      ],
      ['I moved to Porto last month.', ['home.city', 'I moved to Porto', 'Lives in Porto']],
      [
        "I'm also allergic to shellfish.",
        ['health.allergy', 'allergic to shellfish', 'Allergic to shellfish'],
      ],
      [
        'On long flights I like extra legroom.',
        [
          'travel.seat',
          'On long flights I like extra legroom',
          'Likes extra legroom on long flights',
        ],
      ],
    ];
    for (const [text, [subject, quote, content]] of again)
      expect(await say(scope, text, [[subject, quote, content]])).toEqual(['blocked_by_person']);
    // Filed under another subject of the person's own, it is still the detail.
    expect(
      await say(scope, 'I have a peanut allergy, please tell restaurants when you book.', [
        [
          'dining.allergy_notice',
          'please tell restaurants when you book',
          'Tell restaurants about the peanut allergy when booking',
        ],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(scope)).toEqual([]);
    // Someone else's detail under a subject like it is theirs, not blocked.
    expect(
      await say(scope, 'My friend Sam is allergic to peanuts.', [
        [
          'person.sam.allergy',
          'My friend Sam is allergic to peanuts',
          'Friend Sam is allergic to peanuts',
        ],
      ]),
    ).toEqual([]);
    // A subject that names no topic of its own still holds for anything under it.
    await say(scope, 'Call me Max.', [['general', 'Call me Max', 'Goes by Max']]);
    expect(await blockAs(undefined, scope, /Max/)).toEqual(['topic']);
    expect(
      await say(scope, 'I go by Maxi now.', [['general', 'I go by Maxi', 'Goes by Maxi']]),
    ).toEqual(['blocked_by_person']);
  });

  test('asked for just this detail, a block lets a different detail under its subject be learned', async () => {
    const scope = await createScope(store);
    await say(scope, 'I live in Lisbon.', [['home.city', 'I live in Lisbon', 'Lives in Lisbon']]);
    expect(await blockAs('detail', scope, /Lisbon/)).toEqual(['detail']);
    expect(
      (await listBlocks(store.sql, scope)).blocks.map((row) => [row.label, row.scope]),
    ).toEqual([['Home city, the detail you forgot', 'detail']]);
    expect(
      await say(scope, 'My flat is in Lisbon, near Alfama.', [
        ['home.city', 'My flat is in Lisbon, near Alfama', 'Flat is in Lisbon, near Alfama'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'I moved to Porto last month.', [
        ['home.city', 'I moved to Porto', 'Lives in Porto'],
      ]),
    ).toEqual([]);
    expect(await held(scope)).toEqual(['home.city :: Lives in Porto']);
  });

  test('a block on anything about a subject holds for it under the names models use today', async () => {
    const scope = await createScope(store);
    await say(scope, 'On flights I always pick the aisle.', [
      [
        'preference.flights.seat',
        'On flights I always pick the aisle',
        'Prefers aisle seats on flights',
      ],
    ]);
    await say(scope, "I don't eat meat.", [
      ['person.diet.vegetarian', "I don't eat meat", 'Vegetarian, no meat'],
    ]);
    expect(await blockAs(undefined, scope, /aisle/, /meat/)).toEqual(['topic', 'topic']);
    // Another seat on flights, and another diet detail, under today's subjects.
    expect(
      await say(scope, 'Window seats on flights from now on.', [
        ['travel.seat', 'Window seats on flights from now on', 'Prefers window seats on flights'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(scope, 'I am a vegetarian who also skips eggs.', [
        ['food.diet', 'I am a vegetarian who also skips eggs', 'Vegetarian who also skips eggs'],
      ]),
    ).toEqual(['blocked_by_person']);
    // Not about the subject at all.
    expect(
      await say(scope, 'On trains I like a window seat.', [
        ['travel.seat.train', 'On trains I like a window seat', 'Prefers window seats on trains'],
      ]),
    ).toEqual([]);
    expect(await held(scope)).toEqual(['travel.seat.train :: Prefers window seats on trains']);
  });

  test('anything about a subject holds for the narrower subjects under it; just a detail does not', async () => {
    const scope = await createScope(store);
    await say(scope, 'When I fly I always book an aisle seat. I live in Lisbon.', [
      [
        'travel.seat',
        'When I fly I always book an aisle seat',
        'Always books an aisle seat when flying',
      ],
      ['home.city', 'I live in Lisbon', 'Lives in Lisbon'],
    ]);
    expect(await blockAs('topic', scope, /aisle/)).toEqual(['topic']);
    expect(await blockAs('detail', scope, /Lisbon/)).toEqual(['detail']);
    // Under the subject, as real models filed these: "Anything about Travel seat".
    for (const [text, subject, content] of [
      [
        'On trains I prefer a window seat.',
        'travel.seat.window',
        'Prefers a window seat on trains',
      ],
      ['On trains I prefer a window seat.', 'travel.seat.train', 'Prefers a window seat on trains'],
      ['On long flights I like extra legroom.', 'travel.seat.legroom', 'Likes extra legroom'],
    ] as const)
      expect(await say(scope, text, [[subject, text.slice(0, -1), content]])).toEqual([
        'blocked_by_person',
      ]);
    // Beside it, not under it, is another subject.
    expect(
      await say(scope, 'On long flights I like extra legroom.', [
        ['travel.legroom', 'On long flights I like extra legroom', 'Likes extra legroom'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'I always pack carry-on only.', [
        ['travel.luggage', 'I always pack carry-on only', 'Packs carry-on only'],
      ]),
    ).toEqual([]);
    expect(
      await say(scope, 'I like to see the cabin map first.', [
        [
          'travel.seating_chart',
          'I like to see the cabin map first',
          'Looks at the cabin map first',
        ],
      ]),
    ).toEqual([]);
    // A block on just a detail reaches no narrower subject for a different detail.
    expect(
      await say(scope, 'Before Lisbon I lived in Madrid.', [
        ['home.city.previous', 'Before Lisbon I lived in Madrid', 'Previously lived in Madrid'],
      ]),
    ).toEqual([]);
    expect(await held(scope)).toEqual([
      'home.city.previous :: Previously lived in Madrid',
      'travel.legroom :: Likes extra legroom',
      'travel.luggage :: Packs carry-on only',
      'travel.seating_chart :: Looks at the cabin map first',
    ]);

    // Blocks kept for their subject, from before the choice, reach as far, under
    // the older names of the person's own subjects too.
    const legacy = await createScope(store);
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_allergy', ${legacy.spaceId}, 'health.allergy', null, 'Health allergy'),
      ('mb_user_city', ${legacy.spaceId}, 'person.user.city', null, 'Your city'),
      ('mb_general', ${legacy.spaceId}, 'general', null, 'General')`;
    expect(
      await say(legacy, "I'm also allergic to shellfish.", [
        ['health.allergy.shellfish', 'allergic to shellfish', 'Allergic to shellfish'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(
      await say(legacy, 'Before that I lived in Madrid.', [
        ['self.city.previous', 'Before that I lived in Madrid', 'Previously lived in Madrid'],
      ]),
    ).toEqual(['blocked_by_person']);
    // A heading that names nothing is no topic to reach under.
    expect(
      await say(legacy, 'I have asthma. My timezone is Lisbon time.', [
        ['health.condition', 'I have asthma', 'Has asthma'],
        ['general.timezone', 'My timezone is Lisbon time', 'Timezone is Lisbon time'],
      ]),
    ).toEqual([]);
    expect(await held(legacy)).toEqual([
      'general.timezone :: Timezone is Lisbon time',
      'health.condition :: Has asthma',
    ]);

    // In a room, a member's block reaches under its subject for that member only.
    const room: MemoryScope = {
      ...(await createScope(store)),
      audience: 'space',
      publisher: 'room',
    };
    const bob = 'prn_bob_narrower';
    const bobs = `travel.seat.member_${stableId('member', bob).slice(0, 12)}`;
    await store.sql`insert into memory_blocks (id, space_id, domain_key, key, label) values
      ('mb_room_narrower', ${room.spaceId}, ${bobs}, null, 'Travel seat')`;
    const fromBob = await memberSaid(room, bob, 'On trains I want a window seat.');
    await commitExtraction(store.sql, room, fromBob, {
      proposals: [
        add(
          fromBob,
          'travel.seat.train',
          'On trains I want a window seat',
          'Window seat on trains',
        ),
      ],
    });
    const fromAlice = await memberSaid(
      room,
      'prn_alice_narrower',
      'On trains I want a window seat.',
    );
    await commitExtraction(store.sql, room, fromAlice, {
      proposals: [
        add(
          fromAlice,
          'travel.seat.train',
          'On trains I want a window seat',
          'Window seat on trains',
        ),
      ],
    });
    expect(await held(room)).toEqual(['travel.seat.train :: Window seat on trains']);
  });

  test('just this detail, in a script whose words are not compared, blocks anything about its subject', async () => {
    const scope = await createScope(store);
    await say(scope, 'Я живу в Лиссабоне.', [
      ['home.city', 'Я живу в Лиссабоне', 'Живу в Лиссабоне'],
    ]);
    expect(await blockAs('detail', scope, /Лиссабон/)).toEqual(['topic']);
    expect(
      (await listBlocks(store.sql, scope)).blocks.map((row) => [row.label, row.scope]),
    ).toEqual([['Anything about Home city', 'topic']]);
    expect(
      await say(scope, 'I moved to Porto last month.', [
        ['home.city', 'I moved to Porto', 'Lives in Porto'],
      ]),
    ).toEqual(['blocked_by_person']);
    expect(await held(scope)).toEqual([]);
  });

  test('a block on anything about a subject reads as one kept for its subject where the choice is not known', async () => {
    const scope = await createScope(store);
    const topic = blockedSubject(scope.spaceId, 'home.city', 'Lives in Lisbon', 'topic');
    const detail = blockedSubject(scope.spaceId, 'home.city', 'Lives in Lisbon', 'detail');
    expect(topic.scope).toBe('topic');
    expect(detail.scope).toBe('detail');
    // Both keep the detail's tags, never its words; they differ only in the check.
    const [, topicTags] = topic.subject.split(':detail:');
    const [, detailTags] = detail.subject.split(':detail:');
    expect(topicTags?.split('.').slice(1)).toEqual(detailTags?.split('.').slice(1));
    expect(topic.subject.toLowerCase()).not.toContain('lisbon');
    // A reader that compares the check as it was before sees one that never matches.
    expect(topicTags?.split('.')[0]).not.toBe(detailTags?.split('.')[0]);
    expect(topicTags?.split('.')[0]).not.toMatch(/^[0-9a-f]{6}$/);
  });
});
