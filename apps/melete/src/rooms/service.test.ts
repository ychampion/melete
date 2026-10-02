import { describe, expect, test } from 'bun:test';
import { mentionsOf } from './service.ts';
import { distinctNames } from './transcript.ts';

describe('which messages ask a room agent', () => {
  test('a message that names the agent asks it, by its own name or as Melete', () => {
    expect(mentionsOf('@Melete what is on Friday?', 'Iris').asks).toBe(true);
    expect(mentionsOf('can you check, @iris?', 'Iris').asks).toBe(true);
    expect(mentionsOf('Thanks @Ada Lovelace bot, done', 'Ada Lovelace bot').asks).toBe(true);
  });

  test('a message that only talks about the agent, or names someone else, does not', () => {
    expect(mentionsOf('Melete said Friday', 'Iris').asks).toBe(false);
    expect(mentionsOf('@bob can you look?', 'Iris').asks).toBe(false);
    expect(mentionsOf('mail me at bob@melete.example', 'Iris').asks).toBe(false);
    expect(mentionsOf('@Meletes is not a name here', 'Iris').asks).toBe(false);
  });

  test('every name a message mentions is kept in order', () => {
    expect(mentionsOf('@bob and @Melete, see @alice.', 'Iris').mentions).toEqual([
      'bob',
      'Melete',
      'alice',
    ]);
  });
});

describe('names in a room', () => {
  test("a name two people share carries each one's email, and a unique name stands alone", () => {
    const names = distinctNames([
      { id: 'a', displayName: 'Sam', email: 'sam@one.test' },
      { id: 'b', displayName: null, email: 'SAM@two.test' },
      { id: 'c', displayName: 'Lee', email: 'lee@one.test' },
    ]);
    expect([...names.values()]).toEqual(['Sam (sam@one.test)', 'SAM (SAM@two.test)', 'Lee']);
  });
});
