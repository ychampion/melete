/**
 * The two generated files at the top of a space: `SCHEMA.md`, which declares
 * the taxonomy a record may use, and `index.md`, the one-line-per-record
 * catalog.
 *
 * The schema file is the deliberate act that keeps tags from drifting. A tag
 * has to be written here before a record may use it, so the taxonomy stays
 * something a person chose rather than something that accumulated.
 */
import { KNOWLEDGE_TYPES } from '@melete/contracts';

/** What `index.md` needs to know about one record. */
export type IndexEntry = {
  id: string;
  path: string;
  title: string;
  type: string;
  status: string;
  tags: readonly string[];
};

/** Tags a new space starts with. A person adds to this list, Melete does not. */
export const DEFAULT_TAGS: readonly string[] = [
  'admin',
  'finance',
  'health',
  'housing',
  'people',
  'tooling',
  'travel',
  'work',
];

const TYPE_NOTES: Readonly<Record<string, string>> = {
  fact: 'something that is the case, with a source',
  preference: 'how this person likes things done',
  decision: 'a choice that was made, and what it rules out',
  procedure: 'the steps for something done more than once',
  reference: 'a pointer to material held elsewhere',
  event: 'something that happened at a time',
};

/** The starting schema for a new space. Written once, then owned by the person. */
export function defaultSchema(space: string): string {
  const types = KNOWLEDGE_TYPES.map((t) => `- \`${t}\` — ${TYPE_NOTES[t] ?? ''}`).join('\n');
  const tags = DEFAULT_TAGS.map((t) => `- \`${t}\``).join('\n');
  return [
    `# Schema for the ${space} space`,
    '',
    'Read this before writing a record. The lint refuses a record whose tag is',
    'not declared below, so adding a tag is a deliberate act: write the line',
    'here first, then write the record that uses it.',
    '',
    '## Types',
    '',
    types,
    '',
    '## Tags',
    '',
    tags,
    '',
    '## Rules',
    '',
    '- A record lives in `knowledge/` and its `space` field equals this directory.',
    '- A record that replaces another names it in `supersedes`, and the older',
    '  record points back with `superseded_by` and a status of `superseded`.',
    '- A retracted record keeps its text and its reason. Deleting is a separate,',
    '  louder operation that removes the file and the index row together.',
    '- A page stays under 200 lines. Longer than that, split it.',
    '',
  ].join('\n');
}

/**
 * Read the declared tags out of a schema file. Anything in a list item under
 * the Tags heading counts, whether or not it is written in backticks, because a
 * person editing this file by hand should not have to remember the formatting.
 */
export function declaredTags(schemaMarkdown: string): Set<string> {
  const tags = new Set<string>();
  let inTags = false;
  for (const raw of schemaMarkdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      inTags = /^#+\s+tags\b/i.test(line);
      continue;
    }
    if (!inTags) continue;
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (!item?.[1]) continue;
    const first = item[1].trim();
    const quoted = /^`([^`]+)`/.exec(first);
    const word = quoted?.[1] ?? first.split(/[\s—–-]/)[0] ?? '';
    if (word) tags.add(word.trim());
  }
  return tags;
}

const INDEX_HEADER = [
  '# Index',
  '',
  'One line per record, generated from the files. Do not edit it by hand: every',
  'write through the mediator rewrites it, and the lint fails when it drifts.',
  '',
];

/**
 * Render the catalog. Ordering is by path and tags are sorted, so the same set
 * of records always produces the same bytes and a diff means a real change.
 */
export function renderIndex(entries: readonly IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((entry) => {
    const tags = [...entry.tags].sort();
    const tagText = tags.length > 0 ? ` · tags: ${tags.join(', ')}` : '';
    return `- [${entry.title}](${entry.path}) — \`${entry.id}\` · ${entry.type} · ${entry.status}${tagText}`;
  });
  const body = lines.length > 0 ? lines.join('\n') : '_No records yet._';
  return `${[...INDEX_HEADER, body].join('\n')}\n`;
}

const LOG_HEADER = [
  '# Log',
  '',
  'An append-only chronicle of what was done to this space and why.',
  '',
];

export const defaultLog = (): string => `${LOG_HEADER.join('\n')}\n`;

/** One chronicle line. Kept parseable by eye rather than by machine. */
export const logLine = (at: Date, what: string): string =>
  `- ${at.toISOString()} — ${what.replace(/\r?\n/g, ' ')}\n`;

/** What a new space's `.gitignore` holds: the derived index and the staging area. */
export const defaultGitignore = (): string =>
  ['# Derived from the files; rebuildable at any time.', '.index/', '', '.proposed/', ''].join(
    '\n',
  );
