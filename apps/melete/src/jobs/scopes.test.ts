import { describe, expect, test } from 'bun:test';
import { connectionServesJob } from './scopes.ts';

describe('which connections a job may use', () => {
  test('every connection in a personal space serves its jobs, whatever it is marked', () => {
    for (const sharedUse of ['owner', 'room'])
      expect(
        connectionServesJob({ kind: 'personal', spaceOwnerId: 'a', principalId: 'a' }, sharedUse),
      ).toBe(true);
  });

  test("a shared space's owner connections serve its owner's own jobs and nobody else's", () => {
    const shared = (principalId: string | null) => ({
      kind: 'shared',
      spaceOwnerId: 'owner',
      principalId,
    });
    expect(connectionServesJob(shared('owner'), 'owner')).toBe(true);
    expect(connectionServesJob(shared('member'), 'owner')).toBe(false);
    expect(connectionServesJob(shared(null), 'owner')).toBe(false);
  });

  test("a connection marked for the room serves none of a person's own jobs", () => {
    for (const principalId of ['owner', 'member'])
      expect(
        connectionServesJob({ kind: 'shared', spaceOwnerId: 'owner', principalId }, 'room'),
      ).toBe(false);
  });
});

describe("a room's requests", () => {
  const request = { kind: 'shared', spaceOwnerId: 'owner', principalId: 'room', audience: 'room' };

  test('a request made of the room is served by the connections marked for the room and no others', () => {
    expect(connectionServesJob(request, 'room')).toBe(true);
    expect(connectionServesJob(request, 'owner')).toBe(false);
  });

  test("an owner's own job in the room is still served only by the owner's connections", () => {
    const own = {
      kind: 'shared',
      spaceOwnerId: 'owner',
      principalId: 'owner',
      audience: 'principal',
    };
    expect(connectionServesJob(own, 'owner')).toBe(true);
    expect(connectionServesJob(own, 'room')).toBe(false);
  });
});
