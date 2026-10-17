import { describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import {
  saveRefused,
  storageAmount,
  storagePerPersonBytes,
  storedChanges,
  storedPlace,
  uploadRefused,
} from './per-person.ts';

const MB = 1024 * 1024;

describe('the per-person storage setting', () => {
  test('is off unless the operator sets it', () => {
    expect(storagePerPersonBytes(loadEnv({ NODE_ENV: 'test' }))).toBeNull();
    expect(
      storagePerPersonBytes(loadEnv({ NODE_ENV: 'test', MELETE_STORAGE_PER_PERSON_MB: '' })),
    ).toBeNull();
    expect(
      storagePerPersonBytes(loadEnv({ NODE_ENV: 'test', MELETE_STORAGE_PER_PERSON_MB: '2048' })),
    ).toBe(2048 * MB);
  });

  test('refuses a value that is not a whole number of MB', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', MELETE_STORAGE_PER_PERSON_MB: '0' })).toThrow();
    expect(() => loadEnv({ NODE_ENV: 'test', MELETE_STORAGE_PER_PERSON_MB: '1.5' })).toThrow();
  });
});

describe('what a refusal says', () => {
  test('amounts read as a person reads them', () => {
    expect(storageAmount(512)).toBe('512 bytes');
    expect(storageAmount(300 * 1024)).toBe('300 KB');
    expect(storageAmount(12.5 * MB)).toBe('12.5 MB');
    expect(storageAmount(2048 * MB)).toBe('2 GB');
    expect(storageAmount(1.25 * 1024 * MB)).toBe('1.3 GB');
  });

  test('an upload says what is used, what the file adds and how to free space', () => {
    const said = uploadRefused({
      used: 1900 * MB,
      quota: 2048 * MB,
      name: 'deck.pdf',
      bytes: 200 * MB,
    });
    expect(said).toContain('You are using 1.9 GB of the 2 GB');
    expect(said).toContain('deck.pdf is 200 MB');
    expect(said).toContain('Delete files you no longer need in Files');
  });

  test('a save tells the agent to pass it on, with how to free space', () => {
    const known = saveRefused({ used: 2048 * MB, quota: 2048 * MB, bytes: 3 * MB });
    expect(known).toContain('they are using 2 GB of the 2 GB each person has here');
    expect(known).toContain('this would add 3 MB');
    expect(known).toContain('nothing was saved');
    expect(known).toContain('deleting files they no longer need in Files');
    expect(saveRefused({ used: 2048 * MB, quota: 2048 * MB, bytes: null })).not.toContain(
      'would add',
    );
  });
});

describe('what a receipt keeps', () => {
  const job = 'job_one';

  test('places are one key for the Files and one per chat folder', () => {
    expect(storedPlace('artifacts', 'reports/plan.md', job)).toEqual({
      place: 'files:reports/plan.md',
      jobId: null,
    });
    expect(storedPlace('work', 'notes/a.txt', job)).toEqual({
      place: `chat:${job}:notes/a.txt`,
      jobId: job,
    });
    expect(storedPlace(undefined, 'a.txt', job)?.place).toBe(`chat:${job}:a.txt`);
    expect(storedPlace('artifacts', '../escape', job)).toBeNull();
    expect(storedPlace('artifacts', 7, job)).toBeNull();
  });

  test('a write sets its place to the bytes written', () => {
    expect(
      storedChanges({
        kind: 'files.write',
        jobId: job,
        payload: { path: 'plan.md', area: 'artifacts', content: 'x' },
        detail: { path: 'plan.md', area: 'artifacts', bytes: 12, content_hash: 'h' },
      }),
    ).toEqual([{ op: 'set', place: 'files:plan.md', jobId: null, bytes: 12 }]);
  });

  test('a saved attachment is a file in the chat folder', () => {
    expect(
      storedChanges({
        kind: 'files.save_attachment',
        jobId: job,
        payload: { attachment_id: 'file_a', path: 'in/a.pdf' },
        detail: { path: 'in/a.pdf', area: 'work', bytes: 400 },
      }),
    ).toEqual([{ op: 'set', place: `chat:${job}:in/a.pdf`, jobId: job, bytes: 400 }]);
  });

  test('a move takes the bytes to the new place', () => {
    expect(
      storedChanges({
        kind: 'files.move',
        jobId: job,
        payload: { from: 'out.csv', to: 'data/out.csv', to_area: 'artifacts' },
        detail: {
          from: 'out.csv',
          to: 'data/out.csv',
          area: 'work',
          to_area: 'artifacts',
          bytes: 9,
        },
      }),
    ).toEqual([
      {
        op: 'move',
        from: `chat:${job}:out.csv`,
        place: 'files:data/out.csv',
        jobId: null,
        bytes: 9,
      },
    ]);
  });

  test('a delete marks its place, and a restore of that trash counts it again', () => {
    expect(
      storedChanges({
        kind: 'files.delete',
        jobId: job,
        payload: { path: 'old', area: 'artifacts' },
        detail: { path: 'old', area: 'artifacts', deleted: 'folder', trash_id: 'del_1' },
      }),
    ).toEqual([{ op: 'trash', place: 'files:old', trashId: 'del_1' }]);
    expect(
      storedChanges({
        kind: 'files.restore',
        jobId: job,
        payload: { trash_id: 'del_1' },
        detail: { trash_id: 'del_1', area: 'artifacts', restored_count: 2 },
      }),
    ).toEqual([{ op: 'restore', trashId: 'del_1' }]);
  });

  test('generated and published files land in the Files', () => {
    expect(
      storedChanges({
        kind: 'audio.synthesize',
        jobId: job,
        payload: {},
        detail: { kind: 'artifact', path: 'artifacts/hello.wav', bytes: 2048 },
      }),
    ).toEqual([{ op: 'set', place: 'files:hello.wav', jobId: null, bytes: 2048 }]);
    expect(
      storedChanges({
        kind: 'artifact.publish',
        jobId: job,
        payload: {},
        detail: { destination: 'space_artifacts', path: 'out/report.pdf', bytes: 77 },
      }),
    ).toEqual([{ op: 'set', place: 'files:out/report.pdf', jobId: null, bytes: 77 }]);
    // An email keeps nothing here.
    expect(
      storedChanges({
        kind: 'artifact.publish',
        jobId: job,
        payload: {},
        detail: { destination: 'email', bytes: 77 },
      }),
    ).toEqual([]);
  });

  test("a file copied into a room is kept in the room's Files", () => {
    expect(
      storedChanges({
        kind: 'room.add_file',
        jobId: job,
        payload: { room_id: 'sp_room', path: 'deck.pdf', name: 'deck.pdf' },
        detail: { room_id: 'sp_room', name: 'deck.pdf', content_hash: 'h', bytes: 5 },
      }),
    ).toEqual([{ op: 'set', place: 'files:deck.pdf', jobId: null, bytes: 5, spaceId: 'sp_room' }]);
  });

  test('steps that keep nothing change nothing', () => {
    expect(
      storedChanges({ kind: 'files.read', jobId: job, payload: { path: 'a' }, detail: {} }),
    ).toEqual([]);
    expect(
      storedChanges({
        kind: 'files.write',
        jobId: job,
        payload: { path: 'a' },
        detail: { path: 'a', bytes: -1 },
      }),
    ).toEqual([]);
  });
});
