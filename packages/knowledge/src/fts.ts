/**
 * The per-space full-text index. One SQLite file per space, derived from the
 * Markdown and rebuildable at any time.
 *
 * Isolation is structural. A handle is opened from one space's paths and keeps
 * that space's name; there is no argument anywhere in this file that selects a
 * space, so a caller holding a handle to the personal space cannot reach a
 * shared one however it is asked. Cross-space search is impossible rather than
 * disallowed.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRetrievable, type KnowledgeRecordStatus, type KnowledgeType } from '@melete/contracts';
import type { SpacePaths } from './layout.ts';

export type IndexedRecord = {
  id: string;
  path: string;
  title: string;
  tags: string[];
  body: string;
  status: KnowledgeRecordStatus;
  type: KnowledgeType;
};

export type SearchHit = {
  id: string;
  path: string;
  title: string;
  excerpt: string;
  status: KnowledgeRecordStatus;
  type: KnowledgeType;
  /** Lower is a better match in FTS5; negated here so higher is better. */
  score: number;
};

export type QueryOptions = {
  /** Restrict to one or more record types. */
  type?: KnowledgeType | readonly KnowledgeType[];
  /** Every tag named here must be present on the record. */
  tags?: readonly string[];
  limit?: number;
};

/**
 * Bumped whenever the columns change, or when an older file may hold something
 * it should not. An index file written by an older build is thrown away and
 * rebuilt rather than migrated: it is derived from the Markdown, so the
 * cheapest correct thing to do is start again.
 *
 * Version 4 is the first that erases a removed record's words from the file
 * itself. A version 3 file can still hold the words of anything forgotten or
 * deleted while it was in use, so it is wiped, not just emptied.
 */
const INDEX_SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(
  id UNINDEXED,
  title,
  tags,
  body,
  tokenize = 'unicode61'
);
`;

const DROP = `
DROP TABLE IF EXISTS record;
DROP TABLE IF EXISTS record_fts;
DROP TABLE IF EXISTS meta;
`;

/** Ids per DELETE statement, well under SQLite's limit on bound parameters. */
const DELETE_CHUNK = 500;

const userVersion = (db: Database): number =>
  db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;

/**
 * Wipe a file written by an older build. Dropping the tables zeroes their pages,
 * because secure_delete is on by now; VACUUM then rewrites the file, which
 * clears the pages freed before that, and those still hold old text.
 *
 * Two processes can open the same old file at once. The version is checked
 * again under the write lock, so a file another process has already brought up
 * to date, and perhaps refilled, is left alone. It is written only after VACUUM,
 * so a wipe that is cut short runs again on the next open.
 */
function wipeOlderIndex(db: Database): void {
  const dropped = db
    .transaction(() => {
      if (userVersion(db) === INDEX_SCHEMA_VERSION) return false;
      db.run(DROP);
      return true;
    })
    .immediate();
  if (!dropped) return;
  db.run('VACUUM');
  db.run(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
}

/**
 * Turn on FTS5's secure-delete, which takes a deleted record's words out of the
 * segments that hold them instead of leaving them there until a later merge.
 * The setting is stored with the table, so this writes only once. SQLite before
 * 3.44 does not have it; the index then merges its segments after a removal
 * instead, which costs more on a large space but leaves nothing behind either.
 */
function eraseTermsOnDelete(db: Database): boolean {
  const row = db
    .query<{ v: number }, []>("SELECT v FROM record_fts_config WHERE k = 'secure-delete'")
    .get();
  if (row?.v === 1) return true;
  try {
    db.run("INSERT INTO record_fts (record_fts, rank) VALUES ('secure-delete', 1)");
    return true;
  } catch {
    return false;
  }
}

/** Tags are stored space-delimited and space-padded, so a filter is a whole-word match. */
const packTags = (tags: readonly string[]): string =>
  tags.length === 0 ? ' ' : ` ${tags.join(' ')} `;

/**
 * Turn a person's words into an FTS5 query. Every token is quoted, so a stray
 * quote or a bare `AND` is searched for rather than interpreted.
 */
export function toMatchQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export class SpaceIndex {
  private constructor(
    private readonly db: Database,
    /** The one space this handle can ever see. */
    readonly space: string,
    /** Whether FTS5 erases a removed record's words itself; see `eraseTermsOnDelete`. */
    private erasesTerms: boolean,
  ) {}

  /**
   * Open the index for one space, creating the file and schema when this space
   * has never been indexed. The path comes from the space handle, never from a
   * caller's argument.
   */
  static open(paths: SpacePaths): SpaceIndex {
    mkdirSync(dirname(paths.indexDb), { recursive: true });
    return SpaceIndex.attach(new Database(paths.indexDb, { create: true }), paths.space);
  }

  /** An index that lives only in memory, for tests and for a dry run. */
  static memory(space: string): SpaceIndex {
    return SpaceIndex.attach(new Database(':memory:'), space);
  }

  private static attach(db: Database, space: string): SpaceIndex {
    // Another process may hold the write lock for a moment; wait rather than fail.
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA journal_mode = WAL');
    // A deleted row is overwritten with zeros, not left in the file as free space.
    db.run('PRAGMA secure_delete = ON');
    const wiped = userVersion(db) !== INDEX_SCHEMA_VERSION;
    if (wiped) wipeOlderIndex(db);
    db.run(SCHEMA);
    const index = new SpaceIndex(db, space, eraseTermsOnDelete(db));
    if (wiped) index.flush();
    return index;
  }

  /**
   * Throw away the index and build it again. Cheap and honest.
   *
   * The fingerprint goes with it. An index rebuilt from a list of records has
   * no claim about which files on disk it matches; the store makes that claim
   * afterwards, once it knows. An index that wrongly says it is current is
   * worse than one that admits it does not know.
   */
  rebuild(records: readonly IndexedRecord[]): void {
    this.db.transaction(() => {
      // The tables are dropped rather than emptied row by row. Their pages are
      // zeroed either way, and FTS5's secure-delete makes a row-by-row delete
      // of a large space take minutes.
      this.db.run(DROP);
      this.db.run(SCHEMA);
      this.erasesTerms = eraseTermsOnDelete(this.db);
      for (const record of records) this.insert(record);
    })();
    this.flush();
  }

  /** What the files looked like when this index was last known to match them. */
  fingerprint(): string | null {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'fingerprint'")
      .get();
    return row?.value ?? null;
  }

  setFingerprint(value: string): void {
    this.db.run(
      `INSERT INTO meta (key, value) VALUES ('fingerprint', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value],
    );
  }

  upsert(record: IndexedRecord): void {
    const replaced = this.db.transaction(() => {
      const removed = this.deleteRows([record.id]);
      this.insert(record);
      return removed;
    })();
    if (replaced) this.afterRemoval();
  }

  /**
   * Remove a record from the index. Retraction and hard deletion both call
   * this, which is why retrieval cannot return a retracted record after a
   * restart: the row is gone, not filtered. Its words go from the file too.
   */
  remove(id: string): void {
    this.removeMany([id]);
  }

  /**
   * Remove several records in one go. Their words leave the file before this
   * returns, as with `remove`, but the file is rewritten once for the whole
   * set rather than once per record. On a large space that turns most of a
   * minute, with nothing else able to run, into a second or two.
   */
  removeMany(ids: readonly string[]): void {
    if (this.db.transaction(() => this.deleteRows(ids))()) this.afterRemoval();
  }

  /** Search this space. There is no parameter that could reach another one. */
  query(text: string, options: QueryOptions = {}): SearchHit[] {
    const match = toMatchQuery(text);
    if (!match) return [];

    const clauses: string[] = ['record_fts MATCH ?'];
    const parameters: Array<string | number> = [match];

    const types =
      options.type === undefined ? [] : Array.isArray(options.type) ? options.type : [options.type];
    if (types.length > 0) {
      clauses.push(`r.type IN (${types.map(() => '?').join(', ')})`);
      parameters.push(...(types as string[]));
    }
    for (const tag of options.tags ?? []) {
      clauses.push('instr(r.tags, ?) > 0');
      parameters.push(` ${tag} `);
    }
    parameters.push(options.limit ?? 10);

    const rows = this.db
      .query<
        {
          id: string;
          path: string;
          title: string;
          status: string;
          type: string;
          excerpt: string;
          rank: number;
        },
        Array<string | number>
      >(
        `SELECT r.id AS id, r.path AS path, r.title AS title, r.status AS status, r.type AS type,
                snippet(record_fts, 3, '', '', ' ... ', 12) AS excerpt,
                bm25(record_fts) AS rank
         FROM record_fts
         JOIN record r ON r.id = record_fts.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...parameters);

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      excerpt: row.excerpt,
      status: row.status as KnowledgeRecordStatus,
      type: row.type as KnowledgeType,
      score: -row.rank,
    }));
  }

  /** The plain form: words in, hits out. */
  search(text: string, limit = 10): SearchHit[] {
    return this.query(text, { limit });
  }

  count(): number {
    const row = this.db.query<{ n: number }, []>('SELECT count(*) AS n FROM record').get();
    return row?.n ?? 0;
  }

  has(id: string): boolean {
    return Boolean(
      this.db.query<{ id: string }, [string]>('SELECT id FROM record WHERE id = ?').get(id),
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Whether there was anything to delete. The id column of the full-text table
   * is not indexed, so each statement reads the whole table once; a batch of
   * ids goes in one statement rather than one per id.
   */
  private deleteRows(ids: readonly string[]): boolean {
    let changes = 0;
    for (let at = 0; at < ids.length; at += DELETE_CHUNK) {
      const chunk = ids.slice(at, at + DELETE_CHUNK);
      const list = chunk.map(() => '?').join(', ');
      changes += this.db.run(`DELETE FROM record WHERE id IN (${list})`, chunk).changes;
      changes += this.db.run(`DELETE FROM record_fts WHERE id IN (${list})`, chunk).changes;
    }
    return changes > 0;
  }

  /**
   * Once words have left the index, make sure no copy of them is left in the
   * file. First the segments are merged when FTS5 could not erase the words
   * itself. Then VACUUM: secure_delete zeroes a row where it lies, but when
   * SQLite moves rows between pages it leaves older copies in the unused part
   * of a page, and only rewriting the file from what is live clears those.
   * Last, the change goes into the file and the write-ahead log, which still
   * holds the pages as they were, is emptied.
   *
   * VACUUM costs time in proportion to the index, under a second for tens of
   * thousands of records, and this runs only when something is taken out.
   */
  private afterRemoval(): void {
    if (!this.erasesTerms) this.db.run("INSERT INTO record_fts (record_fts) VALUES ('optimize')");
    this.db.run('VACUUM');
    this.flush();
  }

  /**
   * Copy the write-ahead log into the file and truncate it. Closing the last
   * handle does the same; this covers a handle another request still holds.
   */
  private flush(): void {
    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Only retrievable records enter the index at all. A superseded or retracted
   * record is not indexed and then hidden; it is never there.
   */
  private insert(record: IndexedRecord): void {
    if (!isRetrievable(record.status)) return;
    const tags = packTags(record.tags);
    this.db.run(
      'INSERT INTO record (id, path, title, tags, type, status) VALUES (?, ?, ?, ?, ?, ?)',
      [record.id, record.path, record.title, tags, record.type, record.status],
    );
    this.db.run('INSERT INTO record_fts (id, title, tags, body) VALUES (?, ?, ?, ?)', [
      record.id,
      record.title,
      tags,
      record.body,
    ]);
  }
}

/**
 * The free form of `SpaceIndex.query`, for callers that read better with the
 * space handle first. The handle is the only way to name a space.
 */
export const query = (index: SpaceIndex, text: string, options: QueryOptions = {}): SearchHit[] =>
  index.query(text, options);
