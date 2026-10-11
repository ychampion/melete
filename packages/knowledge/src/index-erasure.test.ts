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
import { SpaceIndex } from './fts.ts';
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
