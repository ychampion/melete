import { expect, test } from 'bun:test';
import { CHATS_WITH_YOU, leavesComputer } from './ModelConnect.tsx';

test("Settings says the person's messages use the primary, and a chat a watch wakes follows scheduled work", () => {
  expect(CHATS_WITH_YOU.name).toBe('Chats with you');
  expect(CHATS_WITH_YOU.hint).toBe(
    'Your messages always use the primary. When a watch or schedule wakes a chat, it follows Scheduled and repeating jobs.',
  );
  expect(CHATS_WITH_YOU.hint).not.toContain('Always the primary');
});

test('the warning names chats a watch or schedule wakes among what leaves this computer', () => {
  expect(leavesComputer('Fireworks')).toBe(
    'Scheduled work, and chats woken by a watch or schedule, will leave this computer and go to Fireworks.',
  );
});
