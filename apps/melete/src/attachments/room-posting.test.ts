import { expect, test } from 'bun:test';
import type { Transaction } from '../db/transaction.ts';
import type { AttachmentRow } from './schema.ts';
import { holdForRoomMessage } from './store.ts';

const upload: AttachmentRow = {
  id: 'file_1',
  spaceId: 'room_1',
  principalId: 'person_1',
  jobId: null,
  turnId: null,
  roomMessageId: null,
  position: 0,
  name: 'note.txt',
  mediaType: 'text/plain',
  kind: 'text',
  size: 5,
  blobKey: 'blob_1',
  previewKey: null,
  text: 'hello',
  pages: null,
  createdAt: new Date(),
  sentAt: null,
};
const input = {
  messageId: 'message_2',
  spaceId: 'room_1',
  principalId: 'person_1',
  ids: ['file_1'],
};

function transaction(rows: AttachmentRow[]) {
  let updates = 0;
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => rows }) }) }),
    update: () => ({
      set: (change: Partial<AttachmentRow>) => ({
        where: () => ({
          returning: async () => {
            updates++;
            return rows.map((row) => ({ ...row, ...change }));
          },
        }),
      }),
    }),
  } as unknown as Transaction;
  return { tx, updates: () => updates };
}

test('reposting your own file explains that it is already posted and leaves it attached to the first message', async () => {
  const { tx, updates } = transaction([{ ...upload, roomMessageId: 'message_1' }]);
  await expect(holdForRoomMessage(tx, input)).rejects.toMatchObject({
    status: 409,
    code: 'attachment_sent',
    message: 'This file is already posted. Remove it from this message or attach a new copy.',
  });
  expect(updates()).toBe(0);
});

test('a file already handed to a request cannot be posted again', async () => {
  const { tx, updates } = transaction([{ ...upload, jobId: 'job_1' }]);
  await expect(holdForRoomMessage(tx, input)).rejects.toMatchObject({
    status: 409,
    code: 'attachment_sent',
  });
  expect(updates()).toBe(0);
});

test('someone else’s upload or another room’s file never reveals whether it was posted', async () => {
  for (const rows of [
    [],
    [{ ...upload, principalId: 'person_2', roomMessageId: 'message_1' }],
    [{ ...upload, spaceId: 'room_2', roomMessageId: 'message_1' }],
  ]) {
    const { tx, updates } = transaction(rows);
    await expect(holdForRoomMessage(tx, input)).rejects.toMatchObject({
      status: 409,
      code: 'attachment_unavailable',
      message: 'One of the files is no longer available. Remove it and attach it again.',
    });
    expect(updates()).toBe(0);
  }
});

test('an unposted upload still attaches normally', async () => {
  const { tx, updates } = transaction([upload]);
  expect(await holdForRoomMessage(tx, input)).toMatchObject([
    { id: 'file_1', roomMessageId: 'message_2' },
  ]);
  expect(updates()).toBe(1);
});
