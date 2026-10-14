/**
 * "Forget and don't learn again" holds for the detail the person forgot,
 * wherever a later message files it, and not for a different detail filed
 * under the same subject. The block keeps no word of what was forgotten. The
 * proposals below are the subjects and sentences real models wrote for these
 * messages.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtractionProposal } from '@melete/contracts';
import { blockBelief, listBeliefs, listBlocks } from '../../src/memory/beliefs.ts';
import { blockedSubject } from '../../src/memory/blocks.ts';
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
  /** One message, read as a model filed it: [subject, words quoted, sentence saved]. */
  const say = async (scope: MemoryScope, text: string, proposals: [string, string, string][]) => {
    const batch = await said(scope, text);
    const result = await commitExtraction(store.sql, scope, batch, {
      proposals: proposals.map(([subject, quote, content]) => add(batch, subject, quote, content)),
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
  /** Forget each held detail whose words match, and don't learn it again. */
  const block = async (scope: MemoryScope, ...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const belief = (await listBeliefs(store.sql, scope, 'UTC')).find((item) =>
        pattern.test(item.value),
      );
      if (!belief) throw new Error(`nothing held matches ${pattern}`);
      await blockBelief(store.sql, scope, belief.id, await journal());
    }
  };
  /** Someone who said four things about themselves, then blocked all four. */
  const blockedFour = async () => {
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
    await block(scope, /aisle/, /peanut/, /vegetarian/i, /lisbon/i);
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
    // Each said by someone who blocked the four details above, so none lands on another.
    for (const [text, [subject, quote, content]] of nearby) {
      const scope = await blockedFour();
      expect(await say(scope, text, [[subject, quote, content]])).toEqual([]);
      expect(await held(scope)).toEqual([`${subject} :: ${content}`]);
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
    const kept = blockedSubject(scope.spaceId, 'person.peanut_allergy', 'Allergic to peanuts');
    expect(kept.detail).toBe(true);
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
      'Health allergy',
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
      'Health allergy',
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

    // Kept for its subject, it is not a block on a subject it narrows to, as before.
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
      'Health allergy peanuts',
      'Home city',
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
});
