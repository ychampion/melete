/**
 * Removing a record from the index has to remove its words from the index
 * file, not only from query results. SQLite normally leaves deleted rows in
 * place as free space, and FTS5 keeps a deleted document's terms in its older
 * segments until they are merged, so without care anyone who can read the file
 * (or a backup or export of the space) can still read what was forgotten.
 *
 * Every test here closes the index before looking, the way a request does, and
 * then reads the raw bytes of the index file and its write-ahead log.
 */

import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { aRecord, createSpaceTemplate, fixedClock, IDS } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import { type IndexedRecord, SpaceIndex } from './fts.ts';
import type { SpacePaths } from './layout.ts';
import { hardDelete, retract } from './records.ts';
import { commitRecord } from './space.ts';
import { buildIndex, loadSpace, openIndex } from './store.ts';

/** A word that appears nowhere else, so any copy of it in the file is a leak. */
const MARKER = 'Quillfeather7713';
const SECRET_FILE = 'knowledge/door-code.md';

let root: string;
let paths: SpacePaths;
let template: Awaited<ReturnType<typeof createSpaceTemplate>>;
const now = fixedClock();

beforeAll(
  async () => {
    template = await createSpaceTemplate('melete-erase-', async (paths) => {
      await commitRecord(
        paths,
        SECRET_FILE,
        serializeRecord(
          aRecord({ id: IDS.landlord, title: `Door code ${MARKER}`, type: 'fact', tags: ['home'] }),
          `The building door code is ${MARKER}, and the side gate uses the same one.`,
        ),
        { proposedBy: 'user', now },
      );
      await commitRecord(
        paths,
        'knowledge/prefers-bun.md',
        serializeRecord(aRecord({ id: IDS.bun }), 'Zara uses bun for every package operation.'),
        { proposedBy: 'user', now },
      );
    });
  },
  Math.max(20_000, Number(process.env.MELETE_TEST_CHILD_TIMEOUT_MS ?? 0) || 0),
);

beforeEach(() => {
  ({ root, paths } = template.copy());
});

afterAll(() => template?.close());

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const occurrences = (bytes: Buffer, needle: string): number => {
  let count = 0;
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) count += 1;
  return count;
};

/**
 * Copies of the marker in the index file and its log. FTS5 keeps terms folded
 * to lower case and the stored columns as written, so both spellings count.
 */
const copiesOnDisk = (): number => {
  let count = 0;
  for (const file of [paths.indexDb, `${paths.indexDb}-wal`]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    count += occurrences(bytes, MARKER) + occurrences(bytes, MARKER.toLowerCase());
  }
  return count;
};

const findSecret = () => {
  const record = loadSpace(paths).records.find((r) => r.frontmatter.id === IDS.landlord);
  if (!record) throw new Error('the fixture record is missing');
  return record;
};

describe('forgotten text leaves the index file', () => {
  test('the index holds the text while the record is live', () => {
    buildIndex(paths).index.close();
    // Without this, the tests below would pass for the wrong reason.
    expect(copiesOnDisk()).toBeGreaterThan(0);
  });

  test('retracting a record erases its words from the file', async () => {
    const { index } = buildIndex(paths);
    try {
      expect(index.search(MARKER)).toHaveLength(1);
      await retract(paths, index, findSecret(), { reason: 'wrong door', by: 'zara', now });
      expect(index.search(MARKER)).toEqual([]);
    } finally {
      index.close();
    }
    expect(copiesOnDisk()).toBe(0);
    // The rest of the space is still searchable.
    const reopened = openIndex(paths).index;
    try {
      expect(reopened.search('bun')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  test('deleting a record erases its words from the file', async () => {
    const { index } = buildIndex(paths);
    try {
      await hardDelete(paths, index, findSecret(), { reason: 'never keep this', by: 'zara', now });
      expect(index.search(MARKER)).toEqual([]);
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
    expect(copiesOnDisk()).toBe(0);
  });

  test('a file removed outside Melete is erased when the index catches up', () => {
    buildIndex(paths).index.close();
    rmSync(join(paths.root, SECRET_FILE));

    const { index, rebuilt } = openIndex(paths);
    try {
      expect(rebuilt).toBe(true);
      expect(index.search(MARKER)).toEqual([]);
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
    expect(copiesOnDisk()).toBe(0);
  });

  test('a handle left open does not keep the text in the file', async () => {
    const { index } = buildIndex(paths);
    // A second handle, as a concurrent request would hold, stops the first
    // close from tidying up after it.
    const other = SpaceIndex.open(paths);
    try {
      await retract(paths, index, findSecret(), { reason: 'wrong door', by: 'zara', now });
      index.close();
      expect(copiesOnDisk()).toBe(0);
    } finally {
      other.close();
    }
  });
});

describe('an index written before forgotten text was erased', () => {
  /**
   * Build an index file the way earlier versions did: same tables, schema
   * version 3, plain deletes. The marker's row is inserted and deleted, which
   * leaves its words behind in free space and in an old FTS5 segment.
   */
  const writeOldIndex = () => {
    mkdirSync(dirname(paths.indexDb), { recursive: true });
    const db = new Database(paths.indexDb, { create: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA user_version = 3');
    db.run(`
      CREATE TABLE record (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL,
        tags TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE record_fts USING fts5(id UNINDEXED, title, tags, body, tokenize = 'unicode61');
    `);
    const insert = (id: string, title: string, body: string) => {
      db.run('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        `knowledge/${id}.md`,
        title,
        ' ',
        'fact',
        'active',
      ]);
      db.run('INSERT INTO record_fts (id, title, tags, body) VALUES (?, ?, ?, ?)', [
        id,
        title,
        ' ',
        body,
      ]);
    };
    insert('k_one', 'Someone else', 'ordinary words');
    insert('k_secret', `Door code ${MARKER}`, `The door code is ${MARKER}.`);
    insert('k_two', 'Another', 'more ordinary words');
    db.run("DELETE FROM record WHERE id = 'k_secret'");
    db.run("DELETE FROM record_fts WHERE id = 'k_secret'");
    // Enough of them to fill whole pages, which go back to the file's free
    // list as they were when they are emptied.
    for (let i = 0; i < 100; i += 1)
      insert(`k_bulk_${i}`, `Bulk ${MARKER}`, `${MARKER} `.repeat(40));
    db.run("DELETE FROM record WHERE id LIKE 'k_bulk_%'");
    db.run("DELETE FROM record_fts WHERE id LIKE 'k_bulk_%'");
    db.close();
  };

  test('is cleaned the first time it is opened', () => {
    writeOldIndex();
    expect(copiesOnDisk()).toBeGreaterThan(0);

    SpaceIndex.open(paths).close();

    expect(copiesOnDisk()).toBe(0);
  });

  test('is cleaned once, and then works as usual', () => {
    writeOldIndex();

    const { index, rebuilt } = openIndex(paths);
    try {
      // What the old file said it matched is gone with it, so the files win.
      expect(rebuilt).toBe(true);
      expect(index.search('bun')).toHaveLength(1);
      expect(index.count()).toBe(2);
    } finally {
      index.close();
    }

    // Opening again neither cleans nor rebuilds.
    const again = openIndex(paths);
    try {
      expect(again.rebuilt).toBe(false);
      expect(again.index.count()).toBe(2);
    } finally {
      again.index.close();
    }
  });
});

describe('forgetting at scale', () => {
  /** A small fixed generator, so a failure is the same case on every run. */
  const sequence = (seed: number) => {
    let state = seed;
    return (n: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
  };

  const indexed = (id: string, title: string, body: string): IndexedRecord => ({
    id,
    path: `knowledge/${id}.md`,
    title,
    tags: ['x'],
    body,
    status: 'active',
    type: 'fact',
  });

  /** Which of these words still appear in the index file or its log. */
  const wordsOnDisk = (words: Iterable<string>): string[] => {
    const files = [paths.indexDb, `${paths.indexDb}-wal`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file));
    return [...words].filter((word) =>
      files.some((bytes) => bytes.includes(word) || bytes.includes(word.toLowerCase())),
    );
  };

  /** Counts the VACUUMs any index runs until restored. */
  const countVacuums = () => {
    const original = Database.prototype.run;
    let count = 0;
    Database.prototype.run = function (this: Database, ...args: Parameters<Database['run']>) {
      if (/^\s*VACUUM\b/i.test(String(args[0]))) count += 1;
      return original.apply(this, args);
    } as Database['run'];
    return {
      count: () => count,
      restore: () => {
        Database.prototype.run = original;
      },
    };
  };

  test('forgetting many records at once rewrites the file once', () => {
    const kept = Array.from({ length: 200 }, (_, i) =>
      indexed(`k_kept_${i}`, `Note ${i}`, `ordinary words number${i}`),
    );
    const forgotten = Array.from({ length: 20 }, (_, i) =>
      indexed(`k_gone_${i}`, `Gone ${i}`, `the code is ${MARKER}${i}`),
    );
    const index = SpaceIndex.open(paths);
    try {
      index.rebuild([...kept, ...forgotten]);
      const vacuums = countVacuums();
      try {
        index.removeMany(forgotten.map((record) => record.id));
        expect(vacuums.count()).toBe(1);
      } finally {
        vacuums.restore();
      }
      expect(index.count()).toBe(kept.length);
      expect(index.search(MARKER)).toEqual([]);
      expect(index.search('number7')).toHaveLength(1);
    } finally {
      index.close();
    }
    expect(copiesOnDisk()).toBe(0);
  });

  test('a long run of edits and removals leaves none of the old words behind', () => {
    // Records of mixed sizes make SQLite move rows between pages, which
    // leaves stale copies behind that only rewriting the file clears.
    for (let seed = 1; seed <= 3; seed += 1) {
      rmSync(dirname(paths.indexDb), { recursive: true, force: true });
      const next = sequence(seed * 7919);
      const live = new Map<string, string>();
      const gone = new Set<string>();
      const index = SpaceIndex.open(paths);
      try {
        for (let step = 0; step < 400; step += 1) {
          const edit = next(10) < 6;
          const id = `k${next(300)}`;
          const old = live.get(id);
          if (edit) {
            const word = `Mk${step.toString(36)}zq`;
            const length = 1 + next(60);
            const body = Array.from({ length }, (_, j) => `w${j % 50} ${word}`).join(' ');
            if (old) gone.add(old);
            live.set(id, word);
            index.upsert(indexed(id, `T ${word}`, body));
          } else if (old) {
            gone.add(old);
            live.delete(id);
            index.remove(id);
          }
        }
        for (const word of live.values()) expect(index.search(word)).toHaveLength(1);
      } finally {
        index.close();
      }
      expect({ seed, left: wordsOnDisk(gone) }).toEqual({ seed, left: [] });
    }
  }, 60_000);

  test('rebuilding leaves nothing of the records it dropped', () => {
    const kept = Array.from({ length: 50 }, (_, i) =>
      indexed(`k_kept_${i}`, `Note ${i}`, `ordinary words number${i}`),
    );
    // More than what is kept, so pages they used are still free after the
    // rebuild rather than written over by it.
    const dropped = Array.from({ length: 100 }, (_, i) =>
      indexed(`k_drop_${i}`, `Title ${MARKER}`, `${MARKER}${i} `.repeat(40)),
    );

    const first = SpaceIndex.open(paths);
    first.rebuild([...kept, ...dropped]);
    first.close();
    expect(copiesOnDisk()).toBeGreaterThan(0);

    const second = SpaceIndex.open(paths);
    try {
      second.rebuild(kept);
      expect(second.count()).toBe(kept.length);
      expect(second.search('number7')).toHaveLength(1);
    } finally {
      second.close();
    }
    expect(copiesOnDisk()).toBe(0);
  });
});
