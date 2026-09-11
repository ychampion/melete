/**
 * @melete/knowledge turns a directory of Markdown files into something a job
 * can search, and turns an agent's wish to write into a diff a person approves.
 * For memory records, Postgres owns evidence and claims; these files and their
 * SQLite search index are rebuildable views and never authorize model context.
 */
export * from './frontmatter.ts';
export * from './fts.ts';
export * from './layout.ts';
export * from './mediation.ts';
export * from './store.ts';
