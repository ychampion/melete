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
 * Bumped whenever the columns change. An index file written by an older build
 * is thrown away and rebuilt rather than migrated: it is derived from the
 * Markdown, so the cheapest correct thing to do is start again.
 */
const INDEX_SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL
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
`;

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
    db.run('PRAGMA journal_mode = WAL');
    const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    if ((row?.user_version ?? 0) !== INDEX_SCHEMA_VERSION) {
      db.run(DROP);
      db.run(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
    }
    db.run(SCHEMA);
    return new SpaceIndex(db, space);
  }

  /** Throw away the index and build it again from the files. Cheap and honest. */
  rebuild(records: readonly IndexedRecord[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM record');
      this.db.run('DELETE FROM record_fts');
      for (const record of records) this.insert(record);
    })();
  }

  upsert(record: IndexedRecord): void {
    this.db.transaction(() => {
      this.deleteRows(record.id);
      this.insert(record);
    })();
  }

  /**
   * Remove a record from the index. Retraction and hard deletion both call
   * this, which is why retrieval cannot return a retracted record after a
   * restart: the row is gone, not filtered.
   */
  remove(id: string): void {
    this.db.transaction(() => this.deleteRows(id))();
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

  private deleteRows(id: string): void {
    this.db.run('DELETE FROM record WHERE id = ?', [id]);
    this.db.run('DELETE FROM record_fts WHERE id = ?', [id]);
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
