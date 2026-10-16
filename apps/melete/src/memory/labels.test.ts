import { describe, expect, test } from 'bun:test';
import {
  relationsIn,
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
  });
});
