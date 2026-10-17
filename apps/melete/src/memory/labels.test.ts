import { describe, expect, test } from 'bun:test';
import {
  relationsIn,
  relativeName,
  relativeNamed,
  relativeOf,
  relativeSubject,
  subjectRelative,
  twoPeople,
  whoseDetail,
} from './labels.ts';

describe('whose detail a subject under "owner" holds', () => {
  test("the person's own business is theirs; the owner of something they use is someone else", () => {
    expect(whoseDetail('contact.owner.business', 'Owner of a café in Lisbon')).toEqual({
      kind: 'self',
    });
    expect(whoseDetail('contact.owner.work', 'Owner of two bakeries in Porto').kind).toBe('self');
    expect(
      whoseDetail('contact.owner.city', 'The owner of the flat said the rent goes up').kind,
    ).toBe('other');
    expect(whoseDetail('person.owner.city', 'Owner of my flat lives upstairs').kind).toBe('other');
    expect(whoseDetail('person.owner.phone', "The café owner's number is 555 0101").kind).toBe(
      'other',
    );
  });
});

describe('how a text relates the person to someone it names', () => {
  test('a relation by marriage or a former one is its own, not a brother or a partner', () => {
    expect([...relationsIn('My brother-in-law Sam lives in Oslo', 'Sam')]).toEqual([
      'brother-in-law',
    ]);
    expect([...relationsIn('My ex-boyfriend Sam lives in Oslo', 'Sam')]).toEqual(['ex-boyfriend']);
    expect([...relationsIn('Sam, my sister-in-law, lives in Oslo', 'Sam')]).toEqual([
      'sister-in-law',
    ]);
    // So a brother-in-law is not taken for the brother of the same name.
    expect(
      twoPeople(
        whoseDetail('person.sam.city', 'My brother-in-law Sam lives in Oslo'),
        'My brother-in-law Sam lives in Oslo',
        whoseDetail('person.brother.sam.city', 'Brother Sam lives in Rome'),
        'Brother Sam lives in Rome',
      ),
    ).toBe(true);
  });

  test("someone's relation is theirs, not the person's", () => {
    expect([...relationsIn("My friend's brother Sam lives in Oslo", 'Sam')]).toEqual([]);
    expect([...relationsIn("My brother's friend Sam lives in Oslo", 'Sam')]).toEqual([]);
    expect([...relationsIn("Sam's sister lives in Oslo", 'Sam')]).toEqual([]);
    // Still read: the person's own relation, before or after the name.
    expect([...relationsIn('My brother Sam lives in Oslo', 'Sam')]).toEqual(['brother']);
    // "It's" is not anyone's.
    expect([...relationsIn("It's brother Sam's birthday on Friday", 'Sam')]).toEqual(['brother']);
    expect([...relationsIn('Sam, my colleague, lives in Oslo', 'Sam')]).toEqual(['colleague']);
    // A hyphenated name is still the name.
    expect([...relationsIn('My friend Jean-Luc lives in Lyon', 'Jean-Luc')]).toEqual(['friend']);
  });

  test("a text named someone only as a relative's is about that relative", () => {
    for (const [text, relative] of [
      ["Sam's brother moved to Faro", 'brother'],
      ["My friend Sam's brother moved to Faro", 'brother'],
      ['My friend Sam’s sister lives in Faro', 'sister'],
      ["Sam's mom lives in Faro", 'mother'],
      ["Sam's older brother lives in Faro", 'brother'],
      ["My brother Sam's wife moved to Faro", 'partner'],
      ["Sam's brother-in-law lives in Faro", 'brother-in-law'],
      ["Jean-Luc's sister lives in Lyon", 'sister'],
      // A name ending in "s" may take only the apostrophe.
      ["James' brother moved to Faro", 'brother'],
      ['James’ sister lives in Faro', 'sister'],
    ] as const)
      expect([
        text,
        relativeOf(
          text,
          text.includes('Jean') ? 'jean luc' : text.includes('James') ? 'james' : 'sam',
        ),
      ]).toEqual([text, relative]);
    for (const text of [
      'My brother Sam moved to Faro',
      'Sam (my brother) moved to Faro',
      'Sam moved to Faro',
      "Sams' brother moved to Faro",
      "Sam's flat is in Faro",
      "Sam's moving to Faro",
      "Sam's brother says Sam moved to Faro",
      'His brother moved to Faro',
    ])
      expect([text, relativeOf(text, 'sam')]).toEqual([text, null]);
  });

  test("a relative of someone's is kept under their name", () => {
    expect(relativeSubject('person.sam.city', 'sam', 'brother')).toBe('person.sam.brother.city');
    expect(relativeSubject('person.brother.sam.city', 'sam', 'brother', 'friend')).toBe(
      'person.friend.sam.brother.city',
    );
    expect(relativeSubject('person.sam.mother.city', 'sam', 'father')).toBe(
      'person.sam.father.city',
    );
    expect(relativeSubject('person.jean_luc.city', 'jean luc', 'sister')).toBe(
      'person.jean_luc.sister.city',
    );
    expect(subjectRelative('person.sam.brother.city', 'sam')).toBe('brother');
    expect(subjectRelative('person.sam.mom.city', 'sam')).toBe('mother');
    expect(subjectRelative('person.brother.sam.city', 'sam')).toBeNull();
    // Someone else's relative is kept under the someone whose relative they are.
    expect(relativeSubject('person.brother.sam.city', 'sam', 'brother', 'friend', 'alex')).toBe(
      'person.friend.alex.brother.city',
    );
    expect(subjectRelative('person.sam.bro.city', 'sam')).toBe('brother');
  });

  test('a short word for a relation is that relation', () => {
    expect([...relationsIn('My bro Sam lives in Oslo', 'Sam')]).toEqual(['brother']);
    expect([...relationsIn('Maya, my sis, lives in Oslo', 'Maya')]).toEqual(['sister']);
    expect(relativeOf("Sam's bro moved to Faro", 'sam')).toBe('brother');
    expect(relativeOf('My friend Sam’s little sis lives in Faro', 'sam')).toBe('sister');
    expect(whoseDetail('person.sis.maya.city', 'Sis Maya lives in Oslo')).toEqual({
      kind: 'other',
      who: 'sis',
      name: 'maya',
      relation: 'sis',
    });
    // Said to anyone, it relates no one: "Thanks bro, Sam moved".
    expect([...relationsIn('Thanks bro, Sam moved to Faro', 'Sam')]).toEqual([]);
    expect([...relationsIn('Sam, bro, moved to Faro', 'Sam')]).toEqual([]);
    expect([...relationsIn('Hey sis! Maya lives in Oslo now', 'Maya')]).toEqual([]);
    expect([...relationsIn('My little bro Sam lives in Oslo', 'Sam')]).toEqual(['brother']);
    // So "my bro Sam" is not "my friend Sam".
    expect(
      twoPeople(
        whoseDetail('person.sam.city', 'My bro Sam lives in Oslo'),
        'My bro Sam lives in Oslo',
        whoseDetail('person.friend.sam.city', 'Friend Sam lives in Rome'),
        'Friend Sam lives in Rome',
      ),
    ).toBe(true);
  });

  test("a text named someone only as another's relative is about that relative", () => {
    for (const [text, of, relative] of [
      ["Alex's brother Sam moved to Faro", 'alex', 'brother'],
      ["My friend Alex's older brother Sam moved to Faro", 'alex', 'brother'],
      ['Alex’s sister, Sam, lives in Faro', 'alex', 'sister'],
      ["Alex's bro Sam lives in Faro", 'alex', 'brother'],
      ["James' brother Sam moved to Faro", 'james', 'brother'],
      ["Alex's brother-in-law Sam moved to Faro", 'alex', 'brother-in-law'],
    ] as const)
      expect([text, relativeNamed(text, 'sam')]).toEqual([text, { of, relative }]);
    for (const text of [
      'My brother Sam moved to Faro',
      'Sam moved to Faro',
      "Sam's brother moved to Faro",
      "Sam's brother Alex moved to Faro",
      // A relative of one of the person's own, or no one's.
      "My friend's brother Sam moved to Faro",
      "Mom's brother Sam moved to Faro",
      "It's brother Sam's birthday on Friday",
      "Alex's dog Sam is in Faro",
      // Sam is also named on his own, or the text is about his own relative.
      "Alex's brother Sam says Sam moved to Faro",
      "Alex's brother Sam's wife moved to Faro",
      // Anyone's, not someone's to keep him under.
      "Everyone's friend Sam moved to Faro",
      "Somebody's brother Sam moved to Faro",
    ])
      expect([text, relativeNamed(text, 'sam')]).toEqual([text, null]);
    // The name such a relative is given.
    expect(relativeName("Alex's brother Sam lives in Faro", 'alex')).toBe('sam');
    expect(relativeName('My friend Alex’s little sis Maya lives in Faro', 'alex')).toBe('maya');
    expect(relativeName("Alex's brother lives in Faro", 'alex')).toBeNull();
    expect(relativeName("Alex's brother moved to Faro", 'alex')).toBeNull();
  });

  test('a name with an apostrophe is read as one name, never as whose something is', () => {
    for (const name of ['o brien', 'obrien', "o'brien"]) {
      expect([name, [...relationsIn("My brother O'Brien lives in Oslo", name)]]).toEqual([
        name,
        ['brother'],
      ]);
      expect([name, [...relationsIn("O'Brien, my colleague, lives in Oslo", name)]]).toEqual([
        name,
        ['colleague'],
      ]);
      expect([name, [...relationsIn("O'Brien's sister lives in Oslo", name)]]).toEqual([name, []]);
      expect([name, relativeOf("My friend O'Brien's sister moved to Faro", name)]).toEqual([
        name,
        'sister',
      ]);
      expect([name, relativeOf("O'Brien moved to Faro", name)]).toEqual([name, null]);
      expect([name, relativeOf("My brother O'Brien moved to Faro", name)]).toEqual([name, null]);
    }
    expect([...relationsIn('My cousin D’Angelo lives in Rome', 'd angelo')]).toEqual(['cousin']);
    expect(relativeOf("D'Angelo's mom lives in Rome", 'd angelo')).toBe('mother');
    expect(relativeNamed("O'Brien's brother Sam moved to Faro", 'sam')).toEqual({
      of: 'obrien',
      relative: 'brother',
    });
    // A name that only ends like one is another name, and an initial inside a name stays one.
    expect([...relationsIn("My brother O'Brien lives in Oslo", 'brien')]).toEqual([]);
    expect([...relationsIn('My friend Jo D Smith lives in Oslo', 'jo d smith')]).toEqual([
      'friend',
    ]);
    // A name that starts with an initial is still read word by word.
    for (const name of ['d smith', 'l smith', 'o smith']) {
      const written = name.replace(/^./, (letter) => letter.toUpperCase()).replace(' s', ' S');
      expect([name, [...relationsIn(`My friend ${written} lives in Oslo`, name)]]).toEqual([
        name,
        ['friend'],
      ]);
      expect([name, relativeOf(`${written}'s sister moved to Faro`, name)]).toEqual([
        name,
        'sister',
      ]);
      expect([name, relativeOf(`${written} moved to Faro`, name)]).toEqual([name, null]);
    }
  });
});
