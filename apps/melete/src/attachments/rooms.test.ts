import { expect, spyOn, test } from 'bun:test';
import type { Database } from '../db/client.ts';
import type { activityRecord } from '../db/schema.ts';
import { OPEN_NOTED_FOR_MS, roomAttachments } from './rooms.ts';

type Note = typeof activityRecord.$inferInsert;

/** A summaries-only room and the activity log's unique action id constraint. */
function room() {
  const notes = new Map<string, Note>();
  const db = {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: async () =>
          'on' in columns ? [{ on: true }] : [{ name: 'Member', email: 'member@example.test' }],
      }),
    }),
    insert: () => ({
      values: (note: Note) => ({
        onConflictDoNothing: async () => {
          if (!notes.has(note.actionId)) notes.set(note.actionId, note);
        },
      }),
    }),
  } as unknown as Database;
  return { notes, files: roomAttachments(db) };
}

const open = {
  roomId: 'room_1',
  fileId: 'file_1',
  viewer: 'member_1',
  uploader: 'uploader',
  mediaType: 'image/png',
  read: 'original' as const,
};

test('within one five-minute block, each person and each file gets its own activity note', async () => {
  const now = spyOn(Date, 'now').mockReturnValue(100 * OPEN_NOTED_FOR_MS + 1);
  try {
    const { files, notes } = room();
    await files.admit(open);
    await files.admit(open);
    await files.admit({ ...open, viewer: 'member_2' });
    await files.admit({ ...open, fileId: 'file_2' });
    expect(notes.size).toBe(3);
    expect([...notes.values()].map((note) => note.principalId)).toEqual([
      'member_1',
      'member_2',
      'member_1',
    ]);
    expect([...notes.values()].every((note) => note.destination === 'A picture')).toBe(true);
    expect(JSON.stringify([...notes.values()])).not.toContain('file_1');
  } finally {
    now.mockRestore();
  }
});

test('a new five-minute block gets a new note for the same person and file', async () => {
  const now = spyOn(Date, 'now').mockReturnValue(100 * OPEN_NOTED_FOR_MS + 1);
  try {
    const { files, notes } = room();
    await files.admit(open);
    now.mockReturnValue(101 * OPEN_NOTED_FOR_MS + 1);
    await files.admit(open);
    expect(notes.size).toBe(2);
  } finally {
    now.mockRestore();
  }
});

test('activity names the kind of original without its filename', async () => {
  for (const [mediaType, label] of [
    ['image/jpeg', 'A picture'],
    ['audio/webm', 'A recording'],
    ['application/pdf', 'A PDF document'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'A Word document'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'A spreadsheet'],
    ['text/csv', 'A spreadsheet'],
    ['text/plain', 'A text document'],
  ]) {
    const { files, notes } = room();
    await files.admit({ ...open, mediaType: mediaType ?? '' });
    expect([...notes.values()].map((note) => note.destination)).toEqual([label]);
  }
});
