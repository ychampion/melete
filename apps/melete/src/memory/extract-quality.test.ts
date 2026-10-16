/**
 * What memory keeps from a message: lasting details only, each said once, in
 * the person's own plain words. A memory page in real use held 26 beliefs
 * after half an hour, with a heating repair, a week's work updates and the
 * same allergy under two subjects among them.
 */
import { describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import {
  EXTRACTION_INSTRUCTIONS,
  fileOwnDetails,
  type HeldClaim,
  mergeIntoHeld,
  readExtractionReply,
  sameDetail,
} from './extract.ts';
import { ownTopicRun, relatedSubject, someoneFirst, twoPeople, whoseDetail } from './labels.ts';

const span = {
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  start: 0,
  end: 5,
  quote: 'hello',
};
const proposal = (domain_key: string, content: string, extra = {}) =>
  ({
    op: 'add',
    expected_revision: null,
    domain_key,
    content,
    kind: 'user_statement',
    factual_status: 'attributed',
    valid_from: '2026-09-29T10:00:00Z',
    valid_until: null,
    sources: [span],
    ...extra,
  }) as ExtractionProposal;
const kept = (entry: unknown) =>
  readExtractionReply(JSON.stringify({ proposals: [entry] })).proposals.map((item) => item.op);
const contentOf = (entry: unknown) => {
  const [read] = readExtractionReply(JSON.stringify({ proposals: [entry] })).proposals;
  return read && 'content' in read ? read.content : null;
};

describe('a detail of one task, trip or week is not kept', () => {
  const momentary: [string, string][] = [
    ['home.heating_issue', 'Heating has been broken for a week'],
    ['work.weekly_recap', 'Shipped the onboarding redesign'],
    ['work.update', 'Shipped the onboarding redesign this week'],
    ['trip.tokyo', 'Wants an indoor plan in Tokyo today'],
  ];
  for (const [key, content] of momentary)
    test(`dropped: ${content}`, () => {
      expect(kept(proposal(key, content))).toEqual(['no-op']);
    });

  test('the model saying it is for this task only drops it, except a temporary exception', () => {
    expect(
      kept(proposal('trip.tokyo.budget', 'About $250 a day', { about: 'this_task_only' })),
    ).toEqual(['no-op']);
    expect(
      kept(
        proposal('person.me.away', 'Away until Friday', {
          kind: 'exception',
          about: 'this_task_only',
          valid_until: '2026-10-10T00:00:00Z',
        }),
      ),
    ).toEqual(['add']);
    expect(
      kept(
        proposal('person.lena.city', 'Sister Lena lives in Seattle', {
          about: 'someone_they_know',
        }),
      ),
    ).toEqual(['add']);
  });

  test('a standing instruction said today still holds, and so does a lasting fact', () => {
    expect(kept(proposal('pref.calls', 'Never schedule calls before 10, starting today'))).toEqual([
      'add',
    ]);
    expect(kept(proposal('person.lena.city', 'Sister Lena lives in Seattle'))).toEqual(['add']);
    expect(kept(proposal('person.me.job', 'Works as a product designer at Figma'))).toEqual([
      'add',
    ]);
  });
});

test('a detail is written about the person, never about "the user"', () => {
  expect(contentOf(proposal('person.lena', "Lena, the user's sister, lives in Seattle"))).toBe(
    'Lena, your sister, lives in Seattle',
  );
  expect(contentOf(proposal('person.me.diet', "The user's diet is vegetarian"))).toBe(
    'Your diet is vegetarian',
  );
  // As a note: no subject, the article kept.
  expect(contentOf(proposal('person.me.job', 'The user is a product designer at Figma'))).toBe(
    'A product designer at Figma',
  );
  expect(contentOf(proposal('person.me.home', 'The user lives in the Mission'))).toBe(
    'Lives in the Mission',
  );
  expect(contentOf(proposal('person.sam', 'Sam calls the user on Sundays'))).toBe(
    'Sam calls you on Sundays',
  );
  // "the user" only: another person is left alone, an owner included.
  expect(contentOf(proposal('home.rent', 'The owner said the rent goes up in March'))).toBe(
    'The owner said the rent goes up in March',
  );
  expect(contentOf(proposal('person.lena', "The owner's dog bit Lena"))).toBe(
    "The owner's dog bit Lena",
  );
  expect(contentOf(proposal('person.baker', 'Met the person who runs the bakery'))).toBe(
    'Met the person who runs the bakery',
  );
  // A keyed value is the person's words as said, and is never rewritten.
  expect(
    contentOf(proposal('pref.travel.seat', "the user's aisle seat", { key: 'pref.travel.seat' })),
  ).toBe("the user's aisle seat");
});

test('two wordings of one detail are the same; different people or a reversal are not', () => {
  expect(sameDetail('Allergic to shellfish', 'Has a shellfish allergy')).toBe(true);
  expect(sameDetail('Sister Lena lives in Seattle', 'Lena, your sister, lives in Seattle')).toBe(
    true,
  );
  expect(sameDetail('Vegetarian', 'vegetarian.')).toBe(true);
  expect(sameDetail('Sister Lena lives in Seattle', 'Brother Sam lives in Seattle')).toBe(false);
  expect(sameDetail("Lena's birthday is March 3", "Sam's birthday is March 3")).toBe(false);
  expect(sameDetail('Eats meat', "Doesn't eat meat")).toBe(false);
  expect(sameDetail('Likes Thai food', 'Dislikes Thai food')).toBe(false);
  expect(sameDetail('Works at Figma', 'Lives in the Mission')).toBe(false);
  expect(sameDetail('Prefers aisle seats', 'Prefers window seats')).toBe(false);
});

const held: HeldClaim[] = [
  {
    id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA1',
    domain_key: 'health.allergy.shellfish',
    key: null,
    content: 'Allergic to shellfish',
  },
  {
    id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA2',
    domain_key: 'pref.travel.seat',
    key: 'pref.travel.seat',
    content: 'aisle seat',
  },
  {
    id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA3',
    domain_key: 'reading_list.item.dune',
    key: null,
    content: 'Dune by Frank Herbert',
  },
];

describe('what memory already holds is merged, not added again', () => {
  test('another wording of a held detail is filed under that detail', () => {
    const [merged] = mergeIntoHeld(
      [proposal('pref.diet.shellfish_allergy', 'Has a shellfish allergy')],
      held,
    );
    // Saying no more than the held wording, it is more evidence for that wording:
    // memory's own meaning check attaches it to the one claim.
    expect(merged).toMatchObject({
      op: 'add',
      domain_key: 'health.allergy.shellfish',
      content: 'Allergic to shellfish',
    });
    // Saying more, it is the update, in its own words, on the same claim.
    const [fuller] = mergeIntoHeld(
      [proposal('food.allergies', 'Allergic to shellfish, severely')],
      held,
    );
    expect(fuller).toMatchObject({
      domain_key: 'health.allergy.shellfish',
      content: 'Allergic to shellfish, severely',
    });
  });

  test('a keyed detail said again in other words is not added a second time', () => {
    const [seat] = mergeIntoHeld([proposal('travel.seating', 'Aisle seat')], held);
    expect(seat?.op).toBe('no-op');
  });

  test('something new is left as it is', () => {
    const [fresh] = mergeIntoHeld(
      [proposal('person.lena.city', 'Sister Lena lives in Seattle')],
      held,
    );
    expect(fresh).toMatchObject({ op: 'add', domain_key: 'person.lena.city' });
  });

  test('one message never adds a detail twice, nor beside a change to the same detail', () => {
    const twice = mergeIntoHeld(
      [
        proposal('person.lena.city', 'Sister Lena lives in Seattle'),
        proposal('family.sister.location', 'Lena, your sister, lives in Seattle'),
        // Two adds on one subject would refuse the whole message.
        proposal('person.lena.city', 'Lena moved to Seattle from Portland'),
      ],
      [],
    );
    expect(twice.map((item) => item.op)).toEqual(['add', 'no-op', 'no-op']);
    const changing = mergeIntoHeld(
      [
        {
          op: 'supersede',
          claim_id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA1',
          expected_revision: 1,
          domain_key: 'health.allergy.shellfish',
          content: 'Severely allergic to shellfish',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-09-29T10:00:00Z',
          valid_until: null,
          sources: [span],
        },
        proposal('pref.diet.shellfish', 'Allergic to shellfish'),
      ],
      held,
    );
    expect(changing.map((item) => item.op)).toEqual(['supersede', 'no-op']);
  });

  test("a list's items and a temporary exception keep their own subjects", () => {
    const [item] = mergeIntoHeld(
      [proposal('reading_list.item.dune_messiah', 'Dune Messiah by Frank Herbert')],
      held,
    );
    expect(item).toMatchObject({ op: 'add', domain_key: 'reading_list.item.dune_messiah' });
    const [away] = mergeIntoHeld(
      [proposal('health.allergy.shellfish.away', 'Allergic to shellfish', { kind: 'exception' })],
      held,
    );
    expect(away).toMatchObject({ op: 'add', domain_key: 'health.allergy.shellfish.away' });
  });
});

/** A proposal citing the words the person said. */
const said = (domain_key: string, content: string, quote: string, extra = {}) =>
  proposal(domain_key, content, { sources: [{ ...span, end: quote.length, quote }], ...extra });
const subjects = (proposals: ExtractionProposal[]) =>
  proposals.map((item) => (item.op === 'add' ? item.domain_key : item.op));

describe("the person's own details are filed under them, never as someone in their life", () => {
  test('a change keeps the subject of the detail it changes', () => {
    // Told to file the person's details under topics, real models moved a
    // change to a detail saved earlier under a person heading onto the new
    // topic, and the whole message was refused.
    expect(EXTRACTION_INSTRUCTIONS).toContain("a supersede keeps that claim's domain_key");
  });

  /** Read a model's answer the way extraction does, and file what it proposed. */
  const filed = (entries: unknown[], heldSubjects: string[] = []) => {
    const reply = readExtractionReply(JSON.stringify({ proposals: entries }));
    return subjects(fileOwnDetails(reply.proposals, reply.about, heldSubjects));
  };

  test('the subjects a real model gave the person’s allergy, diet and seat', () => {
    // As two real models filed them on a fresh install.
    expect(
      filed([
        said('person.user.allergy.peanuts', 'Allergic to peanuts', 'I am allergic to peanuts', {
          about: 'the_person',
        }),
        said('person.diet.vegetarian', 'Vegetarian', 'I am vegetarian', { about: 'preference' }),
        said(
          'person.flight_seating.prefers_aisle',
          'Prefers aisle seats when flying',
          'I prefer aisle seats when I fly',
          { about: 'preference' },
        ),
        said(
          'contact.owner.availability',
          'Can be home Thursday afternoon if that works for the repair',
          'I can be home Thursday afternoon if that works for the repair',
        ),
        said('person.job.title', 'Product designer', 'I work as a product designer', {
          about: 'the_person',
        }),
        // Plain words in a subject are not a name, even where the detail says them.
        said('person.lives_in.pune', 'Lives in Pune', 'I live in Pune', { about: 'the_person' }),
        said('person.diet', 'Vegetarian', 'my diet is vegetarian', { about: 'preference' }),
      ]),
    ).toEqual([
      'self.allergy.peanuts',
      'self.diet.vegetarian',
      'self.flight_seating.prefers_aisle',
      'self.availability',
      'self.job.title',
      'self.lives_in.pune',
      'self.diet',
    ]);
  });

  test('someone in their life stays theirs, whatever the model said it is about', () => {
    expect(
      filed([
        said('person.maya.city', 'Sister Maya lives in Lisbon', 'My sister Maya lives in Lisbon', {
          about: 'someone_they_know',
        }),
        // The model called it the person's own, but the words name Maya.
        said('person.maya.allergy', 'Allergic to peanuts', 'Maya is allergic to peanuts', {
          about: 'the_person',
        }),
        said('person.landlord.mr_patel', 'Landlord is Mr. Patel', 'My landlord is Mr. Patel', {
          about: 'the_person',
        }),
        // Said to be about someone they know, it stays theirs under any heading.
        said(
          'person.user.sister',
          'Sister Maya lives in Lisbon',
          'My sister Maya lives in Lisbon',
          {
            about: 'someone_they_know',
          },
        ),
        // With no word on whose it is, a subject naming nobody said is left alone.
        said('person.priya.role', 'Runs the design team', 'runs the design team'),
        said('person.diet', 'Vegetarian', 'vegetarian'),
      ]),
    ).toEqual([
      'person.maya.city',
      'person.maya.allergy',
      'person.landlord.mr_patel',
      'person.user.sister',
      'person.priya.role',
      'person.diet',
    ]);
  });

  test("a detail filed under a bare topic whose words name someone else is not the person's own", () => {
    // The model got both the subject and what it is about wrong.
    expect(
      filed([
        said('person.allergy', 'Maya is allergic to peanuts', 'Maya is allergic to peanuts', {
          about: 'the_person',
        }),
        said('person.diet', "Sam's diet is vegan", 'Sam is vegan', { about: 'the_person' }),
        said('person.city', 'My sister lives in Lisbon', 'my sister lives in Lisbon', {
          about: 'the_person',
        }),
        said('person.diet', 'My friend sam is vegetarian', 'my friend sam is vegetarian', {
          about: 'preference',
        }),
        // The person's own, however the model wrote it.
        said('person.allergy', 'Allergic to peanuts', 'I am allergic to peanuts', {
          about: 'the_person',
        }),
        said('person.city', 'User lives in Lisbon', 'I live in Lisbon', { about: 'the_person' }),
        said('person.travel', 'Will be away until Friday', 'I will be away until Friday', {
          about: 'temporary_exception',
        }),
        said('person.city', 'Lives in Lisbon with Maya', 'I live in Lisbon with Maya', {
          about: 'the_person',
        }),
      ]),
    ).toEqual([
      'person.maya.allergy',
      'person.sam.diet',
      'person.sister.city',
      'person.friend.sam.diet',
      'self.allergy',
      'self.city',
      'self.travel',
      'self.city',
    ]);
    expect(whoseDetail('person.allergy', 'Maya is allergic to peanuts')).toEqual({
      kind: 'other',
      who: 'maya',
    });
    expect(whoseDetail('person.allergy', 'Allergic to peanuts').kind).toBe('unknown');
    // Only words that start with someone name them.
    expect(someoneFirst('Maya is allergic to peanuts')).toEqual({ name: 'maya' });
    expect(someoneFirst('Sister Maya is vegetarian')).toEqual({ name: 'maya', relation: 'sister' });
    expect(someoneFirst("Mom's birthday is in May")).toEqual({ relation: 'mom' });
    for (const own of [
      'maya is allergic to peanuts',
      'Loves dogs',
      'Hates mushrooms',
      'Has two cats',
      'Is vegetarian',
      'May be late on Mondays',
      'The user is vegetarian',
      'She is allergic to peanuts',
      'Vegetarian and gluten free',
    ])
      expect(someoneFirst(own)).toBeNull();
    // Nor is it merged into the person's own allergy held in the same words.
    const [maya] = mergeIntoHeld(
      [said('person.allergy', 'Maya is allergic to peanuts', 'Maya is allergic to peanuts')],
      [
        {
          id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA4',
          domain_key: 'health.allergy',
          key: null,
          content: 'Allergic to peanuts',
        },
      ],
    );
    expect(maya?.op === 'add' ? maya.domain_key : maya?.op).toBe('person.allergy');
  });

  test('a detail filed under the person alone gets a subject of its own', () => {
    expect(
      filed([
        said('person.user', 'Works as a nurse', 'I work as a nurse', { about: 'the_person' }),
        said('person.user', 'Has two cats', 'I have two cats', { about: 'the_person' }),
        said('contact.owner', 'Speaks Portuguese and English', 'I speak Portuguese and English', {
          about: 'the_person',
        }),
        said('person.me', '!!!', 'I am', { about: 'the_person' }),
      ]),
    ).toEqual([
      'self.about.nurse',
      'self.about.2_cats',
      'self.about.english_portuguese_speak',
      'self.about',
    ]);
  });

  test('a detail filed under the person alone keeps one subject however it is said again, and another detail another', () => {
    const own = (content: string) =>
      filed([said('person.user', content, content, { about: 'the_person' })])[0] ?? '';
    // Said again in other words: one subject.
    expect(own('Usually works at night')).toBe(own('Works nights'));
    expect(own('Is a nurse')).toBe(own('Works as a nurse'));
    expect(own('Nurse')).toBe(own('Works as a nurse'));
    // Different details: two subjects, however many words they start with alike.
    expect(own('Works night shifts on weekends')).not.toBe(
      own('Works night shifts at the hospital'),
    );
    expect(own("Doesn't eat meat")).not.toBe(own('Eats meat'));
    expect(own('Has two dogs')).not.toBe(own('Has two cats'));
    expect(own('Has 2 cats')).toBe(own('Has two cats'));
    // A long detail still gets a subject of its own that memory can hold.
    const long = (end: string) =>
      own(`Volunteers at the animal shelter near the old harbour every second Saturday ${end}`);
    expect(long('with friends').length).toBeLessThanOrEqual(120);
    expect(long('with friends')).not.toBe(long('with family'));
    expect(long('with friends')).toBe(long('with friends'));
    // With a topic in its subject, the topic is its subject.
    expect(
      filed([
        said('person.user.work', 'Works as a nurse', 'I work as a nurse', { about: 'the_person' }),
      ]),
    ).toEqual(['self.work']);
  });

  test('a word that only starts the detail, as a thing or a place does, is not someone', () => {
    // A capital at the start of a sentence says nothing of a name.
    for (const own of [
      'Coffee is a must',
      'Coffee is a must for me',
      'Lisbon is home now',
      'Python is my main language',
      "Maya's cat makes me sneeze",
    ])
      expect(someoneFirst(own)).toBeNull();
    expect(
      filed([
        said('person.preference', 'Coffee is a must', 'Coffee is a must', { about: 'preference' }),
        said('person.city', 'Lisbon is home now', 'Lisbon is home now', { about: 'the_person' }),
        said('person.language', 'Python is my main language', 'Python is my main language', {
          about: 'the_person',
        }),
        said('person.allergy', "Maya's cat makes me sneeze", "Maya's cat makes me sneeze", {
          about: 'the_person',
        }),
      ]),
    ).toEqual(['self.preference', 'self.city', 'self.language', 'self.allergy']);
    // Someone they still are.
    expect(someoneFirst('Maya is allergic to peanuts')).toEqual({ name: 'maya' });
    expect(someoneFirst('Maya is a teacher')).toEqual({ name: 'maya' });
    expect(someoneFirst('Maya is my sister')).toEqual({ name: 'maya' });
    expect(someoneFirst('Maya is my best friend')).toEqual({ name: 'maya' });
    expect(someoneFirst('Sam lives near me')).toEqual({ name: 'sam' });
    expect(someoneFirst('Maya has two kids')).toEqual({ name: 'maya' });
    expect(someoneFirst("Sam's diet is vegan")).toEqual({ name: 'sam' });
    expect(someoneFirst("Sam's birthday is the same day as mine")).toEqual({ name: 'sam' });
    expect(someoneFirst("Sam's dog is a labrador")).toEqual({ name: 'sam' });
  });

  test('a subject memory already holds, and a registry key, are never moved', () => {
    expect(
      filed(
        [
          said('person.user.city', 'Lives in Delhi', 'I live in Delhi now', {
            about: 'the_person',
          }),
        ],
        ['person.user.city'],
      ),
    ).toEqual(['person.user.city']);
    expect(
      filed([
        said('contact.owner.email', 'me@example.test', 'my email is me@example.test', {
          key: 'contact.owner.email',
          about: 'the_person',
        }),
      ]),
    ).toEqual(['contact.owner.email']);
  });
});

describe('a detail is the same only when it is about the same someone', () => {
  const allergy: HeldClaim = {
    id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA4',
    domain_key: 'health.allergy',
    key: null,
    content: 'Allergic to peanuts',
  };

  test("someone else's detail in the same words is not merged into the person's own", () => {
    const [sister] = mergeIntoHeld(
      [said('person.maya.allergy', 'Allergic to peanuts', 'My sister Maya is allergic to peanuts')],
      [allergy],
    );
    expect(sister).toMatchObject({ op: 'add', domain_key: 'person.maya.allergy' });
  });

  test('a detail about someone, filed under a topic that names them, is theirs', () => {
    const [again] = mergeIntoHeld(
      [
        said(
          'person.priya.project',
          'Priya owns the Atlas project',
          'Priya owns the Atlas project',
        ),
      ],
      [
        {
          id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA7',
          domain_key: 'project.atlas.owner',
          key: null,
          content: 'Priya owns the Atlas project',
        },
      ],
    );
    expect(again).toMatchObject({ op: 'add', domain_key: 'project.atlas.owner' });
  });

  test("two people's same-shaped details in one message are both kept", () => {
    const both = mergeIntoHeld(
      [
        said('person.maya.city', 'Lives in Lisbon', 'My sister Maya lives in Lisbon'),
        said('person.sam.city', 'Lives in Lisbon', 'My brother Sam lives in Lisbon too'),
      ],
      [],
    );
    expect(subjects(both)).toEqual(['person.maya.city', 'person.sam.city']);
  });

  test("the person's own detail said again under another subject is still merged", () => {
    const [again] = mergeIntoHeld(
      [said('self.food.peanut_allergy', 'Allergic to peanuts', 'peanuts, I am allergic')],
      [allergy],
    );
    expect(again).toMatchObject({ op: 'add', domain_key: 'health.allergy' });
    // An older subject naming nobody (saved before details were filed under
    // the person) still takes the person's own detail said again.
    const [older] = mergeIntoHeld(
      [said('self.allergy', 'Allergic to peanuts', 'I am allergic to peanuts')],
      [{ ...allergy, domain_key: 'person.allergy.peanuts' }],
    );
    expect(older).toMatchObject({ op: 'add', domain_key: 'person.allergy.peanuts' });
  });

  test('a changed value is not taken for the detail it changes', () => {
    const city: HeldClaim = {
      id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA5',
      domain_key: 'self.city',
      key: null,
      content: 'Lives in Pune',
    };
    // The same subject with a new value is kept as written, so memory
    // publishes it as the next revision of that claim (see the integration test).
    const [moved] = mergeIntoHeld(
      [said('self.city', 'Lives in Delhi', 'I have moved from Pune to Delhi')],
      [city],
    );
    expect(moved).toMatchObject({ op: 'add', domain_key: 'self.city', content: 'Lives in Delhi' });
    const [elsewhere] = mergeIntoHeld(
      [said('home.city', 'Lives in Delhi', 'I live in Delhi now')],
      [city],
    );
    expect(elsewhere).toMatchObject({
      op: 'add',
      domain_key: 'home.city',
      content: 'Lives in Delhi',
    });
  });

  test('a temporary exception said again is the one memory holds', () => {
    const away = {
      kind: 'exception',
      valid_from: '2026-10-13T09:00:00Z',
      valid_until: '2026-10-18T23:59:59Z',
    };
    const held: HeldClaim = {
      id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA6',
      domain_key: 'self.away.goa:exception:2026-10-11T02:15:09.921Z:2026-10-18T23:59:59Z',
      key: null,
      content: 'Away in Goa until Sunday',
      valid_from: '2026-10-11T02:15:09.921Z',
      valid_until: '2026-10-18T23:59:59Z',
    };
    const [again] = mergeIntoHeld(
      [said('self.travel.away', 'Away in Goa until Sunday', 'in Goa until Sunday', away)],
      [held],
    );
    expect(again?.op).toBe('no-op');
    // Said twice in one message, under two subjects, it is added once.
    const twice = mergeIntoHeld(
      [
        said('self.availability', 'Can be home Thursday afternoon', 'home Thursday afternoon'),
        said(
          'self.availability.thursday',
          'Can be home Thursday afternoon',
          'home Thursday afternoon',
          away,
        ),
      ],
      [],
    );
    expect(twice.map((item) => item.op)).toEqual(['add', 'no-op']);
    const exceptionFirst = mergeIntoHeld(
      [
        said(
          'self.availability.thursday',
          'Can be home Thursday afternoon',
          'home Thursday afternoon',
          away,
        ),
        said('self.availability', 'Can be home Thursday afternoon', 'home Thursday afternoon'),
      ],
      [],
    );
    expect(exceptionFirst.map((item) => item.op)).toEqual(['add', 'no-op']);
    // A different exception is its own.
    const [other] = mergeIntoHeld(
      [said('self.travel.away', 'Away in Goa until Tuesday', 'Goa until Tuesday', away)],
      [held],
    );
    expect(other?.op).toBe('add');
  });

  test('the same words for another stretch of time are another absence', () => {
    const held: HeldClaim = {
      id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA8',
      domain_key: 'travel.away:exception:2026-10-01T10:00:00Z:2026-10-05T00:00:00Z',
      key: null,
      content: 'Away in Goa until Sunday',
      valid_from: '2026-10-01T10:00:00Z',
      valid_until: '2026-10-05T00:00:00Z',
    };
    // Said again weeks later, for a later trip, it is kept.
    const [later] = mergeIntoHeld(
      [
        said('travel.away', 'Away in Goa until Sunday', 'in Goa until Sunday', {
          kind: 'exception',
          valid_from: '2026-10-20T10:00:00Z',
          valid_until: '2026-10-26T00:00:00Z',
        }),
      ],
      [held],
    );
    expect(later).toMatchObject({ op: 'add', valid_until: '2026-10-26T00:00:00Z' });
    // Two stretches in one message, in the same words, are both kept.
    const both = mergeIntoHeld(
      [
        said('travel.away', 'Away for work', 'away for work this week', {
          kind: 'exception',
          valid_from: '2026-10-01T10:00:00Z',
          valid_until: '2026-10-05T00:00:00Z',
        }),
        said('travel.away.later', 'Away for work', 'and the week of the 20th', {
          kind: 'exception',
          valid_from: '2026-10-20T00:00:00Z',
          valid_until: '2026-10-26T00:00:00Z',
        }),
      ],
      [],
    );
    expect(both.map((item) => item.op)).toEqual(['add', 'add']);
  });

  test('a name written in lowercase, or not written at all, is still someone else', () => {
    const own = (domain_key: string, content: string): HeldClaim => ({
      id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA9',
      domain_key,
      key: null,
      content,
    });
    // "My sister Lena is visiting. She's allergic to peanuts."
    const [lena] = mergeIntoHeld(
      [said('person.lena.allergy', 'Allergic to peanuts', "She's allergic to peanuts")],
      [own('health.allergy', 'Allergic to peanuts')],
    );
    expect(lena).toMatchObject({ op: 'add', domain_key: 'person.lena.allergy' });
    const [sam] = mergeIntoHeld(
      [said('person.sam.diet', 'Vegetarian', 'my friend sam is vegetarian')],
      [own('food.diet', 'Vegetarian')],
    );
    expect(sam).toMatchObject({ op: 'add', domain_key: 'person.sam.diet' });
    // Two people's details are two, however their names were written.
    const [lenaDiet] = mergeIntoHeld(
      [said('person.lena.diet', 'Vegetarian', "she's vegetarian")],
      [own('person.sam.diet', 'Vegetarian')],
    );
    expect(lenaDiet).toMatchObject({ op: 'add', domain_key: 'person.lena.diet' });
    // A subject an older extraction gave the person's own detail is never someone else's.
    const [maya] = mergeIntoHeld(
      [said('person.maya.allergy', 'Allergic to peanuts', 'Maya is allergic to peanuts')],
      [own('person.allergy.peanuts', 'Allergic to peanuts')],
    );
    expect(maya).toMatchObject({ op: 'add', domain_key: 'person.maya.allergy' });
    const [older] = mergeIntoHeld(
      [said('person.allergy.peanuts', 'Allergic to peanuts', 'I am allergic to peanuts')],
      [own('person.maya.allergy', 'Allergic to peanuts')],
    );
    expect(older).toMatchObject({ op: 'add', domain_key: 'person.allergy.peanuts' });
    // A word that is also someone's name names them only when written as a name.
    const [mine] = mergeIntoHeld(
      [said('food.diet', 'Vegetarian, may eat fish', 'I am vegetarian but may eat fish')],
      [own('person.may.diet', 'Vegetarian, may eat fish')],
    );
    expect(mine).toMatchObject({ op: 'add', domain_key: 'food.diet' });
    // Nor is it filed as the person's own when the model calls it theirs.
    const reply = readExtractionReply(
      JSON.stringify({
        proposals: [
          said('person.maya.allergy', 'Allergic to peanuts', 'maya is allergic to peanuts', {
            about: 'the_person',
          }),
          said('person.sam.diet', 'Vegetarian', 'sam is vegetarian', { about: 'preference' }),
          said('person.will.city', 'Lives in Berlin', 'will lives in Berlin', {
            about: 'the_person',
          }),
        ],
      }),
    );
    expect(subjects(fileOwnDetails(reply.proposals, reply.about, []))).toEqual([
      'person.maya.allergy',
      'person.sam.diet',
      'person.will.city',
    ]);
  });
});

describe('people of one name, and words that only look like names', () => {
  const held = (domain_key: string, content: string): HeldClaim => ({
    id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FB1',
    domain_key,
    key: null,
    content,
  });

  test('a sentence of the person\'s own starting "Will be" or "May be" does not name Will or May', () => {
    const [away] = mergeIntoHeld(
      [said('travel.availability', 'Will be away until Friday', 'I will be away until Friday')],
      [held('person.will.availability', 'Will is away until Friday')],
    );
    expect(away).toMatchObject({ op: 'add', domain_key: 'travel.availability' });
    const [late] = mergeIntoHeld(
      [said('work.schedule', 'May be late on Mondays', 'I may be late on Mondays')],
      [held('person.may.schedule', 'May is late on Mondays')],
    );
    expect(late).toMatchObject({ op: 'add', domain_key: 'work.schedule' });
    // Will and May named at the start of a sentence are still Will and May.
    const [will] = mergeIntoHeld(
      [said('work.absence', 'Will is away until Friday', 'Will is away until Friday')],
      [held('person.will.availability', 'Will is away until Friday')],
    );
    expect(will).toMatchObject({ op: 'add', domain_key: 'person.will.availability' });
    const [birthday] = mergeIntoHeld(
      [said('dates.birthday', "Will's birthday is March 3", "Will's birthday is March 3")],
      [held('person.will.birthday', "Will's birthday is March 3")],
    );
    expect(birthday).toMatchObject({ op: 'add', domain_key: 'person.will.birthday' });
    const [may] = mergeIntoHeld(
      [
        said(
          'work.accounts',
          'May from accounting is allergic to shellfish',
          'May from accounting is allergic to shellfish',
        ),
      ],
      [held('person.may.allergy', 'May from accounting is allergic to shellfish')],
    );
    expect(may).toMatchObject({ op: 'add', domain_key: 'person.may.allergy' });
  });

  test('two people of one name are two when the person relates them differently', () => {
    const two = (a: [string, string], b: [string, string]) =>
      twoPeople(whoseDetail(a[0], a[1]), a[1], whoseDetail(b[0], b[1]), b[1]);
    const friend: [string, string] = ['person.sam.city', 'Friend Sam lives in Lisbon'];
    const brother: [string, string] = ['person.sam.city', 'Brother Sam lives in Lisbon'];
    expect(two(friend, brother)).toBe(true);
    expect(two(brother, friend)).toBe(true);
    expect(
      two(
        ['person.sam.job', 'My colleague Sam is a nurse'],
        ['person.sam.job', 'Sam, my neighbour, is a nurse'],
      ),
    ).toBe(true);
    expect(two(['person.brother.sam.city', 'Lives in Lisbon'], friend)).toBe(true);
    expect(
      two(
        ['person.lena.city', 'Sister Lena lives in Rome'],
        ['person.lena.city', 'My mum Lena lives in Rome'],
      ),
    ).toBe(true);
    // The same one, said twice or said without a relation.
    expect(two(friend, ['person.sam.city', 'Friend Sam moved to Porto'])).toBe(false);
    expect(two(friend, ['person.sam.city', 'Sam moved to Porto'])).toBe(false);
    expect(two(friend, ['person.sam.city', 'Sam, my colleague, lives in Porto'])).toBe(false);
    expect(
      two(['person.mum.city', 'Mum lives in Pune'], ['person.mum.city', 'My mother lives in Pune']),
    ).toBe(false);
    expect(two(brother, ['person.sam.city', 'My sibling Sam lives in Lisbon'])).toBe(false);
    expect(
      two(
        ['person.sam.city', 'Wife Sam lives in Lisbon'],
        ['person.sam.city', 'My partner Sam lives in Lisbon'],
      ),
    ).toBe(false);
    // Two people of one name are not merged, even in the same words.
    const [brotherSam] = mergeIntoHeld(
      [said('person.brother.sam.home', 'Sam lives in Lisbon', 'my brother Sam lives in Lisbon')],
      [held('person.friend.sam.city', 'Sam lives in Lisbon')],
    );
    expect(brotherSam).toMatchObject({ op: 'add', domain_key: 'person.brother.sam.home' });
    const [sameSam] = mergeIntoHeld(
      [said('person.friend.sam.home', 'Sam lives in Lisbon', 'my friend Sam lives in Lisbon')],
      [held('person.sam.city', 'Sam lives in Lisbon')],
    );
    expect(sameSam).toMatchObject({ op: 'add', domain_key: 'person.sam.city' });
    // Two sisters are two, whether or not a detail says "Sister".
    const [maya] = mergeIntoHeld(
      [said('person.sister.maya.city', 'Lives in Lisbon', 'my sister Maya lives in Lisbon')],
      [held('person.sister.lena.city', 'Lives in Lisbon')],
    );
    expect(maya).toMatchObject({ op: 'add', domain_key: 'person.sister.maya.city' });
    const [sisterMaya] = mergeIntoHeld(
      [said('person.sister.maya.city', 'Sister lives in Lisbon', 'my sister Maya lives in Lisbon')],
      [held('person.lena.city', 'Sister lives in Lisbon')],
    );
    expect(sisterMaya).toMatchObject({ op: 'add', domain_key: 'person.sister.maya.city' });
    // Sister Maya's detail, said under a topic, is hers by her name.
    const [birthday] = mergeIntoHeld(
      [said('dates.birthday', "Maya's birthday is March 3", "Maya's birthday is March 3")],
      [held('person.sister.maya.birthday', "Maya's birthday is March 3")],
    );
    expect(birthday).toMatchObject({ op: 'add', domain_key: 'person.sister.maya.birthday' });
    const [hers] = mergeIntoHeld(
      [
        said(
          'person.sister.maya.birthday',
          "Maya's birthday is March 3",
          "Maya's birthday is March 3",
        ),
      ],
      [held('dates.birthday', "Maya's birthday is March 3")],
    );
    expect(hers).toMatchObject({ op: 'add', domain_key: 'dates.birthday' });
    // A relation of Sam's is not how the person knows Sam.
    expect(two(friend, ['person.sam.sister', "Sam's sister lives in Rome"])).toBe(false);
    expect(two(brother, ['person.sam.city', "Friend Sam's sister lives in Lisbon"])).toBe(true);
  });

  test("a detail about the owner of something is someone else's; details saved under owner stay the person's", () => {
    const reply = readExtractionReply(
      JSON.stringify({
        proposals: [
          said(
            'person.owner.city',
            'The owner of my flat lives upstairs',
            'The owner of my flat lives upstairs',
            {
              about: 'the_person',
            },
          ),
          said('person.owner.city', 'Lives in Pune', 'I live in Pune', { about: 'the_person' }),
        ],
      }),
    );
    expect(subjects(fileOwnDetails(reply.proposals, reply.about, []))).toEqual([
      'person.owner.city',
      'self.city',
    ]);
    expect(whoseDetail('contact.owner.availability', 'Can be home Thursday afternoon')).toEqual({
      kind: 'self',
    });
    expect(whoseDetail('person.owner.phone', "The café owner's number is 555 0101").kind).toBe(
      'other',
    );
  });

  test('how a detail relates someone is read only from the words about them', () => {
    const two = (a: [string, string], b: [string, string]) =>
      twoPeople(whoseDetail(a[0], a[1]), a[1], whoseDetail(b[0], b[1]), b[1]);
    // "Sam and my brother" says nothing of how the person knows Sam.
    expect(
      two(
        ['person.sam.city', 'Sam and my brother moved to Rome'],
        ['person.sam.city', 'Friend Sam lives in Lisbon'],
      ),
    ).toBe(false);
    // A friend who is also a colleague may be a neighbour's namesake or the neighbour.
    expect(
      two(
        ['person.friend.sam.city', 'My colleague Sam lives in Lisbon'],
        ['person.sam.city', 'Sam, my neighbour, lives in Lisbon'],
      ),
    ).toBe(false);
    // Brother Sam beside a friend named Sam is kept under the brother, once.
    const brother = 'My brother Sam lives in Oslo';
    expect(
      relatedSubject(
        'person.friend.sam.city',
        whoseDetail('person.friend.sam.city', brother),
        brother,
      ),
    ).toBe('person.brother.sam.city');
    // Which room member's detail it is changes nothing of whose it is.
    expect(whoseDetail('person.brother.member_0123456789ab', 'Brother lives in Oslo')).toEqual(
      whoseDetail('person.brother', 'Brother lives in Oslo'),
    );
    // A name at the start of a sentence, followed by what Will does, is Will.
    const [teaches] = mergeIntoHeld(
      [said('work.schedule', 'Will teaches piano on Fridays', 'Will teaches piano on Fridays')],
      [held('person.will.schedule', 'Will teaches piano on Fridays')],
    );
    expect(teaches).toMatchObject({ op: 'add', domain_key: 'person.will.schedule' });
  });

  test("the owner of something's detail is not merged into the person's own", () => {
    const [landlord] = mergeIntoHeld(
      [
        said(
          'person.owner.city',
          'The owner of my flat lives in Pune',
          'The owner of my flat lives in Pune',
        ),
      ],
      [held('home.city', 'Lives in Pune')],
    );
    expect(landlord).toMatchObject({ op: 'add', domain_key: 'person.owner.city' });
  });

  test('a subject of one run of words that says what kind of detail it is names no one', () => {
    expect(ownTopicRun('person.peanut_allergy', 'Allergic to peanuts')).toBe(true);
    expect(ownTopicRun('contact.aisle_seat', 'Aisle seats only')).toBe(true);
    // A name in the run, written as one in the sentence, is someone.
    expect(ownTopicRun('person.sam_city', 'Lives in the same city as Sam')).toBe(false);
    // No word of it says what kind of detail it is: it may be a name.
    expect(ownTopicRun('person.maya_lena', 'Allergic to peanuts')).toBe(false);
    expect(ownTopicRun('person.vegetarian', 'Vegetarian')).toBe(false);
    // Only a run directly under a person heading.
    expect(ownTopicRun('person.sam_city.notes', 'Lives in Lisbon')).toBe(false);
    expect(ownTopicRun('travel.aisle_seat', 'Aisle seats only')).toBe(false);
  });
});
