/**
 * The per-space full-text index. One SQLite file per space, derived from the
 * Markdown and rebuildable at any time, so isolation is a matter of which file
 * the process opened rather than a filter the model was trusted to pass.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRetrievable, type KnowledgeRecordStatus } from '@melete/contracts';

export type IndexedRecord = {
  id: string;
  path: string;
  title: string;
  tags: string[];
  body: string;
  status: KnowledgeRecordStatus;
};

export type SearchHit = {
  id: string;
  path: string;
  title: string;
  excerpt: string;
  status: KnowledgeRecordStatus;
  /** Lower is a better match in FTS5; negated here so higher is better. */
  score: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
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
  private constructor(private readonly db: Database) {}

  /** Open, creating the file and schema if this space has never been indexed. */
  static open(path: string): SpaceIndex {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run(SCHEMA);
    return new SpaceIndex(db);
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

  search(query: string, limit = 10): SearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    const rows = this.db
      .query<
        { id: string; path: string; title: string; status: string; excerpt: string; rank: number },
        [string, number]
      >(
        `SELECT r.id AS id, r.path AS path, r.title AS title, r.status AS status,
                snippet(record_fts, 3, '', '', ' ... ', 12) AS excerpt,
                bm25(record_fts) AS rank
         FROM record_fts
         JOIN record r ON r.id = record_fts.id
         WHERE record_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit);

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      excerpt: row.excerpt,
      status: row.status as KnowledgeRecordStatus,
      score: -row.rank,
    }));
  }

  count(): number {
    const row = this.db.query<{ n: number }, []>('SELECT count(*) AS n FROM record').get();
    return row?.n ?? 0;
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
    const tags = record.tags.join(' ');
    this.db.run('INSERT INTO record (id, path, title, tags, status) VALUES (?, ?, ?, ?, ?)', [
      record.id,
      record.path,
      record.title,
      tags,
      record.status,
    ]);
    this.db.run('INSERT INTO record_fts (id, title, tags, body) VALUES (?, ?, ?, ?)', [
      record.id,
      record.title,
      tags,
      record.body,
    ]);
  }
}
