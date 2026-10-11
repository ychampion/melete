/**
 * What memory keeps from a message: lasting details only, each said once, in
 * the person's own plain words. A memory page in real use held 26 beliefs
 * after half an hour, with a heating repair, a week's work updates and the
 * same allergy under two subjects among them.
 */
import { describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import {
  fileOwnDetails,
  type HeldClaim,
  mergeIntoHeld,
  readExtractionReply,
  sameDetail,
} from './extract.ts';

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
      ]),
    ).toEqual([
      'person.maya.city',
      'person.maya.allergy',
      'person.landlord.mr_patel',
      'person.user.sister',
      'person.priya.role',
    ]);
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
    const away = { kind: 'exception', valid_until: '2026-10-18T23:59:59Z' };
    const held: HeldClaim = {
      id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FA6',
      domain_key: 'self.away.goa:exception:2026-10-11T02:15:09.921Z:2026-10-18T23:59:59Z',
      key: null,
      content: 'Away in Goa until Sunday',
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
});
