import { describe, expect, test } from 'bun:test';
import { ownsSessionSpace } from './session-space.ts';

describe("owner's surfaces", () => {
  test('only the owner of the selected space owns it: a member, a guest, any other role or no selection does not', () => {
    expect(ownsSessionSpace({ role: 'owner' })).toBe(true);
    for (const role of ['member', 'guest', 'agent', 'reader', ''])
      expect([role, ownsSessionSpace({ role } as never)]).toEqual([role, false]);
    expect(ownsSessionSpace(undefined)).toBe(false);
  });
});
