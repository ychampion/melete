import { describe, expect, test } from 'bun:test';
import { relationsIn, twoPeople, whoseDetail } from './labels.ts';

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
    expect([...relationsIn('Sam, my colleague, lives in Oslo', 'Sam')]).toEqual(['colleague']);
    // A hyphenated name is still the name.
    expect([...relationsIn('My friend Jean-Luc lives in Lyon', 'Jean-Luc')]).toEqual(['friend']);
  });
});
