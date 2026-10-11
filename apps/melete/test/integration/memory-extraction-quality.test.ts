/**
 * Extraction as a person meets it: saying something again keeps one copy and
 * loses nothing said beside it, and an update to something said long ago
 * reaches the claim it updates.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { beliefCategoryOf } from '../../src/memory/beliefs.ts';
import { commitExtraction } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { proposeExtraction } from '../../src/memory/extract.ts';
import { buildViews } from '../../src/memory/views.ts';
import { claimWork } from '../../src/memory/work.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { record } from './properties-fixtures.ts';

const db = await createTestDatabase();
afterAll(async () => {
  await db?.close();
});
const withDb = db ? describe : describe.skip;

withDb('extraction keeps what matters once', () => {
  /** Ingest one message and hand back its work, the way the extraction worker would. */
  const said = async (
    db2: NonNullable<typeof db>,
    scope: MemoryScope,
    name: string,
    text: string,
    eventAt = '2026-08-10T09:00:00Z',
  ) => {
    await ingest(db2.sql, scope, {
      stream: 'chat',
      source_identity: name,
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: eventAt,
      text,
    });
    const batch = await claimWork(db2.sql, scope);
    if (!batch) throw new Error(`no work for ${name}`);
    return batch;
  };
  const unkeyed = (
    batch: NonNullable<Awaited<ReturnType<typeof claimWork>>>,
    domain: string,
    quote: string,
    content = quote,
  ): ExtractionProposal => {
    const start = batch.work.segment_start + batch.text.indexOf(quote);
    return {
      op: 'add',
      expected_revision: null,
      domain_key: domain,
      content,
      kind: 'user_statement',
      factual_status: 'attributed',
      valid_from: '2026-08-10T09:00:00Z',
      valid_until: null,
      sources: [
        {
          source_id: batch.source.source_id,
          source_version: '1',
          start,
          end: start + quote.length,
          quote,
        },
      ],
    } as ExtractionProposal;
  };

  test('repeating a fact keeps one copy and loses nothing said alongside it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const first = await said(db, scope, 'owner', 'Priya owns the Atlas project.');
    await commitExtraction(db.sql, scope, first, {
      proposals: [unkeyed(first, 'project.atlas.owner', 'Priya owns the Atlas project')],
    });
    const second = await said(
      db,
      scope,
      'again',
      'Priya owns the Atlas project. Atlas ships in October.',
    );
    const result = await commitExtraction(db.sql, scope, second, {
      proposals: [
        unkeyed(second, 'project.atlas.owner', 'Priya owns the Atlas project'),
        unkeyed(second, 'project.atlas.ship', 'Atlas ships in October'),
      ],
    });
    expect(result.status).toBe('committed');
    const claims = await db.sql`select c.domain_key, count(r.*)::int as active from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.status = 'active'
      where c.space_id = ${scope.spaceId} and not c.hidden group by c.domain_key order by c.domain_key`;
    expect(claims.map((row) => [row.domain_key, row.active])).toEqual([
      ['project.atlas.owner', 1],
      ['project.atlas.ship', 1],
    ]);
  });

  test('extraction sees the claim a message is about even when it was said long ago', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await record(
      db,
      scope,
      {
        identity: 'ana',
        text: "Ana's email is ana@studio.example.",
        eventAt: '2026-08-01T09:00:00Z',
      },
      [
        {
          key: 'contact.ana.email',
          content: 'ana@studio.example',
          quote: 'ana@studio.example',
          kind: 'user_statement',
        },
      ],
    );
    for (let i = 0; i < 40; i++) {
      const batch = await said(
        db,
        scope,
        `errand-${i}`,
        `Errand number ${i}: collect parcel ${i}.`,
      );
      await commitExtraction(db.sql, scope, batch, {
        proposals: [unkeyed(batch, `errand.n${i}`, `collect parcel ${i}`)],
      });
    }
    await buildViews(db.sql, scope);
    const update = await said(
      db,
      scope,
      'ana-new',
      'Ana changed jobs, her email is now ana@atlas.example.',
    );
    // The claim the message is about leads the snapshot, ahead of newer ones.
    expect(update.claims[0]?.key).toBe('contact.ana.email');
  });

  /** Each detail memory holds now: its subject, its words and how many messages it rests on. */
  const heldNow = async (database: NonNullable<typeof db>, scope: MemoryScope) => {
    const rows = await database.sql`select c.domain_key, c.head_revision, b.content,
        (select count(distinct ref.source_id)::int from memory_references ref
          where ref.claim_id = c.id and ref.revision = c.head_revision) as messages
      from memory_claims c join memory_revision_content b
        on b.claim_id = c.id and b.revision = c.head_revision
      where c.space_id = ${scope.spaceId} and not c.hidden order by c.domain_key`;
    return rows.map((row) => [row.domain_key, row.content, row.messages, row.head_revision]);
  };

  test('a detail said again in the same words is one detail, even when extraction was not shown it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const first = await said(
      db,
      scope,
      'repair',
      'I can be home Thursday afternoon if that works for the repair.',
    );
    await commitExtraction(db.sql, scope, first, {
      proposals: [
        unkeyed(
          first,
          'self.availability',
          'be home Thursday afternoon if that works for the repair',
          'Can be home Thursday afternoon if that works for the repair',
        ),
      ],
    });
    const again = await said(
      db,
      scope,
      'repair-again',
      'Can be home Thursday afternoon if that works for the repair.',
      '2026-08-11T09:00:00Z',
    );
    // A large memory shows extraction the most related details, not all of
    // them; here it was shown none, and filed the detail under a subject of its own.
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...again, claims: [] },
      {
        proposals: [
          unkeyed(
            again,
            'contact.owner.availability-thursday',
            'Can be home Thursday afternoon if that works for the repair',
            'can be home Thursday afternoon if that works for the repair.',
          ),
        ],
      },
    );
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['self.availability', 'Can be home Thursday afternoon if that works for the repair', 2, 1],
    ]);
  });

  test('the same words about two people, or about the person and someone else, stay two details', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const maya = await said(db, scope, 'maya', 'My sister Maya lives in Lisbon.');
    await commitExtraction(db.sql, scope, maya, {
      proposals: [
        unkeyed(maya, 'person.maya.city', 'My sister Maya lives in Lisbon', 'Lives in Lisbon'),
      ],
    });
    const mine = await said(db, scope, 'mine', 'I am allergic to peanuts.');
    await commitExtraction(db.sql, scope, mine, {
      proposals: [unkeyed(mine, 'self.allergy', 'allergic to peanuts', 'Allergic to peanuts')],
    });
    const others = await said(
      db,
      scope,
      'others',
      'My brother Sam lives in Lisbon. My sister Maya is allergic to peanuts.',
      '2026-08-11T09:00:00Z',
    );
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...others, claims: [] },
      {
        proposals: [
          unkeyed(others, 'person.sam.city', 'My brother Sam lives in Lisbon', 'Lives in Lisbon'),
          unkeyed(
            others,
            'person.maya.allergy',
            'My sister Maya is allergic to peanuts',
            'Allergic to peanuts',
          ),
        ],
      },
    );
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['person.maya.allergy', 'Allergic to peanuts', 1, 1],
      ['person.maya.city', 'Lives in Lisbon', 1, 1],
      ['person.sam.city', 'Lives in Lisbon', 1, 1],
      ['self.allergy', 'Allergic to peanuts', 1, 1],
    ]);
  });

  test('a name written in lowercase, or not written in the words, never joins the person’s own detail', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const lena = await said(
      db,
      scope,
      'lena',
      "My sister Lena is visiting. She's allergic to peanuts.",
    );
    await commitExtraction(db.sql, scope, lena, {
      proposals: [
        unkeyed(lena, 'person.lena.allergy', "She's allergic to peanuts", 'Allergic to peanuts'),
      ],
    });
    const sam = await said(db, scope, 'sam', 'my friend sam is vegetarian.');
    await commitExtraction(db.sql, scope, sam, {
      proposals: [unkeyed(sam, 'person.sam.diet', 'sam is vegetarian', 'Vegetarian')],
    });
    const mine = await said(
      db,
      scope,
      'mine',
      "I'm allergic to peanuts and I'm vegetarian.",
      '2026-08-11T09:00:00Z',
    );
    // Extraction was shown neither detail, and filed the person's own under topics.
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...mine, claims: [] },
      {
        proposals: [
          unkeyed(mine, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
          unkeyed(mine, 'food.diet', 'vegetarian', 'Vegetarian'),
        ],
      },
    );
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['food.diet', 'Vegetarian', 1, 1],
      ['health.allergy', 'Allergic to peanuts', 1, 1],
      ['person.lena.allergy', 'Allergic to peanuts', 1, 1],
      ['person.sam.diet', 'Vegetarian', 1, 1],
    ]);
  });

  test('an absence said again for the same days is the one held, and for other days is another', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const first = await said(db, scope, 'goa', "I'm in Goa until Sunday.");
    await commitExtraction(db.sql, scope, first, {
      proposals: [
        {
          ...unkeyed(first, 'travel.away', 'in Goa until Sunday', 'Away in Goa until Sunday'),
          kind: 'exception',
          valid_until: '2026-08-16T23:59:59Z',
        } as ExtractionProposal,
      ],
    });
    /** What a model answered: the same words, for the days given. */
    const answer = (valid_from: string, valid_until: string) => ({
      chat: async () =>
        JSON.stringify({
          proposals: [
            {
              op: 'add',
              claim_id: null,
              expected_revision: null,
              domain_key: 'travel.away',
              content: 'Away in Goa until Sunday',
              kind: 'exception',
              factual_status: 'attributed',
              valid_from,
              valid_until,
              lasting: true,
              about: 'temporary_exception',
              sources: [{ quote: 'in Goa until Sunday' }],
            },
          ],
        }),
    });
    const again = await said(
      db,
      scope,
      'goa-again',
      "Reminder: I'm in Goa until Sunday.",
      '2026-08-12T09:00:00Z',
    );
    const same = await proposeExtraction(
      db.sql,
      scope,
      again,
      answer('2026-08-12T09:00:00Z', '2026-08-16T23:59:59Z'),
    );
    expect(same.map((item) => item.op)).toEqual(['no-op']);
    await commitExtraction(db.sql, scope, again, { proposals: same });
    const later = await said(
      db,
      scope,
      'goa-later',
      "I'm in Goa until Sunday.",
      '2026-09-14T09:00:00Z',
    );
    const other = await proposeExtraction(
      db.sql,
      scope,
      later,
      answer('2026-09-14T09:00:00Z', '2026-09-20T23:59:59Z'),
    );
    expect(other.map((item) => item.op)).toEqual(['add']);
    await commitExtraction(db.sql, scope, later, { proposals: other });
    const held = await db.sql`select c.domain_key from memory_claims c
      where c.space_id = ${scope.spaceId} and not c.hidden order by c.domain_key`;
    expect(held.map((row) => String(row.domain_key))).toEqual([
      'travel.away:exception:2026-08-10T09:00:00Z:2026-08-16T23:59:59Z',
      'travel.away:exception:2026-09-14T09:00:00Z:2026-09-20T23:59:59Z',
    ]);
  });

  test('a lasting detail in the same words as an absence is not filed under the absence', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const away = await said(db, scope, 'away', 'I work from home on Thursdays this month.');
    await commitExtraction(db.sql, scope, away, {
      proposals: [
        {
          ...unkeyed(
            away,
            'work.location',
            'work from home on Thursdays',
            'Works from home on Thursdays',
          ),
          kind: 'exception',
          valid_until: '2026-08-31T23:59:59Z',
        } as ExtractionProposal,
      ],
    });
    const lasting = await said(
      db,
      scope,
      'lasting',
      'I work from home on Thursdays.',
      '2026-08-12T09:00:00Z',
    );
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...lasting, claims: [] },
      {
        proposals: [
          unkeyed(
            lasting,
            'work.schedule',
            'work from home on Thursdays',
            'Works from home on Thursdays',
          ),
        ],
      },
    );
    expect(result.status).toBe('committed');
    expect(
      (await heldNow(db, scope)).map(([domainKey]) => String(domainKey).split(':')[0]),
    ).toEqual(['work.location', 'work.schedule']);
  });

  test('a detail learned in a private conversation is never matched from an ordinary one', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const hidden = await said(db, scope, 'private', 'I am allergic to peanuts.');
    await commitExtraction(db.sql, scope, hidden, {
      proposals: [unkeyed(hidden, 'health.allergy', 'allergic to peanuts', 'Allergic to peanuts')],
    });
    await db.sql`update memory_sources set private_origin = 'health' where id = ${hidden.source.source_id}`;
    const ordinary = await said(
      db,
      scope,
      'ordinary',
      "I'm allergic to peanuts.",
      '2026-08-11T09:00:00Z',
    );
    expect(ordinary.private_origin).toBeNull();
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...ordinary, claims: [] },
      {
        proposals: [
          unkeyed(ordinary, 'food.allergy', 'allergic to peanuts', 'Allergic to peanuts'),
        ],
      },
    );
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['food.allergy', 'Allergic to peanuts', 1, 1],
      ['health.allergy', 'Allergic to peanuts', 1, 1],
    ]);
  });

  test('a change to the person’s own detail, proposed under its topic, updates the claim under its older subject', async () => {
    if (!db) return;
    const scope = await createScope(db);
    // Saved, as a real model filed them, before the person's details were filed under them.
    const before = await said(
      db,
      scope,
      'before',
      'I live in Pune. My sister Maya lives in Lisbon. I am travelling until the 20th.',
    );
    await commitExtraction(db.sql, scope, before, {
      proposals: [
        unkeyed(before, 'person.location.city', 'I live in Pune', 'Lives in Pune'),
        unkeyed(
          before,
          'person.maya.city',
          'My sister Maya lives in Lisbon',
          'Sister Maya lives in Lisbon',
        ),
        {
          ...unkeyed(
            before,
            'person.travel.away',
            'travelling until the 20th',
            'Travelling until the 20th',
          ),
          kind: 'exception',
          valid_until: '2026-08-20T00:00:00Z',
        } as ExtractionProposal,
      ],
    });
    const away = 'exception:2026-08-10T09:00:00Z:2026-08-20T00:00:00Z';
    const supersede = (
      batch: NonNullable<Awaited<ReturnType<typeof claimWork>>>,
      held: string,
      domain_key: string,
      quote: string,
      content: string,
    ): ExtractionProposal => {
      const claim = batch.claims.find((item) => item.domain_key === held);
      if (!claim) throw new Error(`${held} was not shown`);
      const {
        op: _op,
        expected_revision: _revision,
        ...rest
      } = unkeyed(batch, domain_key, quote, content) as Extract<ExtractionProposal, { op: 'add' }>;
      return {
        ...rest,
        op: 'supersede',
        claim_id: claim.id,
        expected_revision: claim.head_revision,
        valid_from: '2026-08-12T09:00:00Z',
      } as ExtractionProposal;
    };
    const moved = await said(
      db,
      scope,
      'moved',
      'I have moved to Delhi now.',
      '2026-08-12T09:00:00Z',
    );
    const result = await commitExtraction(db.sql, scope, moved, {
      proposals: [
        supersede(moved, 'person.location.city', 'home.city', 'moved to Delhi', 'Lives in Delhi'),
      ],
    });
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['person.location.city', 'Lives in Delhi', 1, 2],
      ['person.maya.city', 'Sister Maya lives in Lisbon', 1, 1],
      [`person.travel.away:${away}`, 'Travelling until the 20th', 1, 1],
    ]);
    // Someone else's detail, the person's own about another thing or changed as
    // someone else's, and an absence are still not changed under another subject.
    for (const [held, proposed] of [
      ['person.maya.city', 'home.city'],
      ['person.location.city', 'food.diet'],
      ['person.location.city', 'person.maya.city'],
      [`person.travel.away:${away}`, 'travel.away'],
    ] as const) {
      const again = await said(
        db,
        scope,
        `again-${held}-${proposed}`,
        'It is Berlin now.',
        '2026-08-13T09:00:00Z',
      );
      const refused = await commitExtraction(db.sql, scope, again, {
        proposals: [supersede(again, held, proposed, 'Berlin', 'Lives in Berlin')],
      });
      expect(refused).toMatchObject({ status: 'rejected', reason: 'target_mismatch' });
    }
    expect((await heldNow(db, scope)).map(([, content]) => content)).toEqual([
      'Lives in Delhi',
      'Sister Maya lives in Lisbon',
      'Travelling until the 20th',
    ]);
    // Two changes to it in one message are refused together, as for any one detail.
    const twice = await said(
      db,
      scope,
      'twice',
      'I live in Mumbai now, in Mumbai.',
      '2026-08-14T09:00:00Z',
    );
    const doubled = await commitExtraction(db.sql, scope, twice, {
      proposals: [
        supersede(twice, 'person.location.city', 'home.city', 'Mumbai now', 'Lives in Mumbai'),
        supersede(twice, 'person.location.city', 'location.city', 'in Mumbai', 'Lives in Mumbai'),
      ],
    });
    expect(doubled).toMatchObject({ status: 'rejected', reason: 'conflicting_changeset' });
  });

  test('a changed value is the next revision of its detail, with the old one in its history', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const pune = await said(db, scope, 'pune', 'I live in Pune.');
    await commitExtraction(db.sql, scope, pune, {
      proposals: [unkeyed(pune, 'self.city', 'live in Pune', 'Lives in Pune')],
    });
    const delhi = await said(
      db,
      scope,
      'delhi',
      'I have moved from Pune to Delhi, so I live in Delhi now.',
      '2026-08-12T09:00:00Z',
    );
    const result = await commitExtraction(db.sql, scope, delhi, {
      proposals: [unkeyed(delhi, 'self.city', 'I live in Delhi now', 'Lives in Delhi')],
    });
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([['self.city', 'Lives in Delhi', 1, 2]]);
    const history = await db.sql`select r.revision, r.status, b.content from memory_revisions r
      join memory_claims c on c.id = r.claim_id
      join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
      where c.space_id = ${scope.spaceId} order by r.revision`;
    expect(history.map((row) => [row.revision, row.status, row.content])).toEqual([
      [1, 'superseded', 'Lives in Pune'],
      [2, 'active', 'Lives in Delhi'],
    ]);
  });

  test("the person's own detail held under an older subject is updated there", async () => {
    if (!db) return;
    const scope = await createScope(db);
    const pune = await said(db, scope, 'pune', 'I live in Pune.');
    // Saved before the person's details were filed under them.
    await commitExtraction(db.sql, scope, pune, {
      proposals: [unkeyed(pune, 'person.user.city', 'live in Pune', 'Lives in Pune')],
    });
    const delhi = await said(db, scope, 'delhi', 'I live in Delhi now.', '2026-08-12T09:00:00Z');
    const result = await commitExtraction(
      db.sql,
      scope,
      { ...delhi, claims: [] },
      { proposals: [unkeyed(delhi, 'self.city', 'I live in Delhi now', 'Lives in Delhi')] },
    );
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([['person.user.city', 'Lives in Delhi', 1, 2]]);
  });

  test('a detail the person blocked under an older subject is not learned again under theirs', async () => {
    if (!db) return;
    const scope = await createScope(db);
    await db.sql`insert into memory_blocks (id, space_id, domain_key, key, label)
      values ('mb_older_subject', ${scope.spaceId}, 'person.user.allergy.peanuts', null, 'Allergic to peanuts')`;
    const batch = await said(db, scope, 'again', 'I am allergic to peanuts.');
    const result = await commitExtraction(db.sql, scope, batch, {
      proposals: [
        unkeyed(batch, 'self.allergy.peanuts', 'allergic to peanuts', 'Allergic to peanuts'),
      ],
    });
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([]);
    const [refused] =
      await db.sql`select reason from memory_rejections where work_id = ${batch.work.id}`;
    expect(refused?.reason).toBe('blocked_by_person');
  });

  test('a detail the person blocked under an older subject is not learned again under its topic', async () => {
    if (!db) return;
    const scope = await createScope(db);
    // Blocked on an install where a real model filed the allergy under a person heading.
    await db.sql`insert into memory_blocks (id, space_id, domain_key, key, label)
      values ('mb_older_topic', ${scope.spaceId}, 'person.allergy.peanuts', null, 'Allergy peanuts')`;
    const batch = await said(
      db,
      scope,
      'again',
      'I am allergic to peanuts, keep the peanut allergy in mind for dinner bookings. I am also allergic to shellfish. My sister Lena is allergic to peanuts.',
    );
    const result = await commitExtraction(db.sql, scope, batch, {
      proposals: [
        unkeyed(batch, 'health.allergy.peanuts', 'allergic to peanuts', 'Allergic to peanuts'),
        unkeyed(
          batch,
          'food.instruction.dinner_bookings.allergy',
          'keep the peanut allergy in mind for dinner bookings',
          'Keep the peanut allergy in mind for dinner bookings',
        ),
        unkeyed(
          batch,
          'health.allergy.shellfish',
          'allergic to shellfish',
          'Allergic to shellfish',
        ),
        unkeyed(
          batch,
          'person.lena.allergy',
          'My sister Lena is allergic to peanuts',
          'Sister Lena is allergic to peanuts',
        ),
      ],
    });
    expect(result.status).toBe('committed');
    expect(await heldNow(db, scope)).toEqual([
      ['health.allergy.shellfish', 'Allergic to shellfish', 1, 1],
      ['person.lena.allergy', 'Sister Lena is allergic to peanuts', 1, 1],
    ]);
    const refused =
      await db.sql`select reason from memory_rejections where work_id = ${batch.work.id}`;
    expect(refused.map((row) => row.reason)).toEqual(['blocked_by_person', 'blocked_by_person']);
  });

  test("the person's own allergy, diet and seat are filed under them, as a real model answered", async () => {
    if (!db) return;
    const scope = await createScope(db);
    const batch = await said(
      db,
      scope,
      'about-me',
      'I am allergic to peanuts and I am vegetarian. I prefer aisle seats. My sister Maya lives in Lisbon.',
    );
    // The answer a real model gave this message on a fresh install.
    const answer = {
      proposals: [
        [
          'person.user.allergy.peanuts',
          'Allergic to peanuts',
          'I am allergic to peanuts',
          'the_person',
        ],
        ['person.user.diet.vegetarian', 'Vegetarian', 'I am vegetarian', 'preference'],
        [
          'person.user.preference.aisle_seat',
          'Prefers aisle seats on flights',
          'I prefer aisle seats',
          'preference',
        ],
        [
          'person.maya.city',
          'Sister Maya lives in Lisbon',
          'My sister Maya lives in Lisbon',
          'someone_they_know',
        ],
      ].map(([domain_key, content, quote, about]) => ({
        op: 'add',
        claim_id: null,
        expected_revision: null,
        domain_key,
        content,
        kind: 'user_statement',
        factual_status: 'attributed',
        valid_from: '2026-08-10T09:00:00Z',
        valid_until: null,
        lasting: true,
        about,
        sources: [{ quote }],
      })),
    };
    const proposals = await proposeExtraction(db.sql, scope, batch, {
      chat: async () => JSON.stringify(answer),
    });
    expect((await commitExtraction(db.sql, scope, batch, { proposals })).status).toBe('committed');
    const filed = (await heldNow(db, scope)).map(([domainKey, content]) => [
      domainKey,
      beliefCategoryOf({
        key: null,
        domainKey: String(domainKey),
        kind: 'user_statement',
        content: String(content),
      }),
    ]);
    expect(filed).toEqual([
      ['person.maya.city', 'people'],
      ['self.allergy.peanuts', 'preferences'],
      ['self.diet.vegetarian', 'preferences'],
      ['self.preference.aisle_seat', 'preferences'],
    ]);
  });
});
