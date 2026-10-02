import { describe, expect, test } from 'bun:test';
import { mentionsOf } from './service.ts';
import { personLabel, roomHandle } from './transcript.ts';

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
  const room = 'sp_01J00000000000000000000000';
  const alice = { id: 'own_01J0000000000000000000000A', email: 'alice@example.test' };
  const carol = { id: 'own_01J0000000000000000000000C', email: 'carol@example.test' };

  test('every person is named with the handle the room gives them, and never with their email', () => {
    const label = personLabel({ ...alice, displayName: 'Alice' }, room);
    expect(label).toBe(`Alice <${roomHandle(room, alice.id)}>`);
    expect(label).not.toContain('example.test');
    expect(roomHandle(room, alice.id)).toMatch(/^[a-z2-9]{6}$/);
    // A look-alike name, or the very same name, still carries the handle of the person who chose it.
    expect(personLabel({ ...carol, displayName: 'Alice' }, room)).toBe(
      `Alice <${roomHandle(room, carol.id)}>`,
    );
    expect(roomHandle(room, carol.id)).not.toBe(roomHandle(room, alice.id));
    expect(personLabel({ id: carol.id, displayName: null, email: 'sam@example.test' }, room)).toBe(
      `sam <${roomHandle(room, carol.id)}>`,
    );
  });

  test('a handle is the same in one room every time, and differs from room to room', () => {
    const other = 'sp_01J0000000000000000000000Z';
    expect(roomHandle(room, alice.id)).toBe(roomHandle(room, alice.id));
    expect(roomHandle(other, alice.id)).not.toBe(roomHandle(room, alice.id));
  });
});
