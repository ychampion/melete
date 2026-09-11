import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { parseRecord, serializeRecord } from './frontmatter.ts';
import { query, SpaceIndex, toMatchQuery } from './fts.ts';
import { recordPath, resolveInSpace, slugify, type spacePaths } from './layout.ts';
import { renderUnifiedDiff } from './mediation.ts';
import { buildIndex, ensureSpaceDirs, loadSpace } from './store.ts';

const ID = {
  bun: 'k_01J8ZP3QWABCDEFGHJKMNPQRST',
  flights: 'k_01J8ZP3QWABCDEFGHJKMNPQRSV',
  landlord: 'k_01J8ZP3QWABCDEFGHJKMNPQRSW',
};

const frontmatter = (over: Partial<KnowledgeFrontmatter>): KnowledgeFrontmatter => ({
  id: ID.bun,
  title: 'Prefers bun over npm for all package management',
  space: 'personal',
  audience: 'private',
  type: 'preference',
  status: 'active',
  confidence: 'high',
  asserted_by: 'user',
  source: {
    kind: 'statement',
    ref: 'session:2026-09-10T14:22:31Z',
    quote: 'always use bun instead of npm',
    sha256: null,
  },
  observed_at: '2026-09-10',
  valid_from: '2026-07-10',
  valid_until: null,
  supersedes: [],
  superseded_by: null,
  created: '2026-09-10',
  updated: '2026-09-10',
  tags: ['tooling', 'javascript'],
  links: [],
  schema_version: 1,
  ...over,
});

let root: string;
let paths: ReturnType<typeof spacePaths>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'melete-knowledge-'));
  paths = ensureSpaceDirs(root, 'personal');

  const records: Array<[string, KnowledgeFrontmatter, string]> = [
    [
      'prefers-bun.md',
      frontmatter({}),
      'Zara uses bun for every package operation, including scratch clones and CI.',
    ],
    [
      'prefers-morning-flights.md',
      frontmatter({
        id: ID.flights,
        title: 'Prefers morning flights',
        type: 'preference',
        tags: ['travel'],
      }),
      'Books departures before eleven whenever the fare difference is under forty euro.',
    ],
    [
      'landlord-contact.md',
      frontmatter({
        id: ID.landlord,
        title: 'Landlord contact and renewal window',
        type: 'fact',
        tags: ['housing'],
      }),
      'The lease renews in March. The landlord answers email but never the phone.',
    ],
  ];

  for (const [name, fm, body] of records) {
    writeFileSync(join(paths.knowledge, name), serializeRecord(fm, body), 'utf8');
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('frontmatter round trip', () => {
  test('a serialized record parses back to the same record', () => {
    const original = frontmatter({});
    const text = serializeRecord(original, 'A short body.');
    const parsed = parseRecord(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.frontmatter).toEqual(original);
      expect(parsed.record.body).toBe('A short body.');
    }
  });

  test('an unquoted YAML date survives as the string a person typed', () => {
    const text = `---
id: ${ID.bun}
title: Dates
space: personal
audience: private
type: fact
status: active
confidence: high
asserted_by: user
source:
  kind: statement
  ref: "session:1"
  quote: ""
  sha256: null
observed_at: 2026-09-10
valid_from: 2026-07-10
valid_until: null
created: 2026-09-10
updated: 2026-09-10
schema_version: 1
---
Body.
`;
    const parsed = parseRecord(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.record.frontmatter.observed_at).toBe('2026-09-10');
      expect(parsed.record.frontmatter.valid_from).toBe('2026-07-10');
    }
  });

  test('a file with no frontmatter is reported, not thrown', () => {
    const parsed = parseRecord('Just some prose.\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toContain('frontmatter');
  });

  test('a record missing a required field names the field', () => {
    const parsed = parseRecord('---\nid: k_1\n---\nBody\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('title');
  });

  test('the content hash tracks the body and ignores frontmatter formatting', () => {
    const a = parseRecord(serializeRecord(frontmatter({}), 'Same body.'));
    const b = parseRecord(serializeRecord(frontmatter({ tags: ['different'] }), 'Same body.'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.record.contentHash).toBe(b.record.contentHash);
  });
});

describe('layout', () => {
  test('a path that escapes the space root is refused', () => {
    expect(resolveInSpace(paths, '../other/secret.md')).toBeNull();
    expect(resolveInSpace(paths, '/etc/passwd')).toBeNull();
    expect(resolveInSpace(paths, 'knowledge/ok.md')).not.toBeNull();
  });

  test('slugs stay readable', () => {
    expect(slugify('Prefers morning flights!')).toBe('prefers-morning-flights');
    expect(recordPath('Landlord contact')).toBe('knowledge/landlord-contact.md');
  });
});

describe('loading a space', () => {
  test('reads all three sample records', () => {
    const contents = loadSpace(paths);
    expect(contents.failures).toEqual([]);
    expect(contents.records.map((r) => r.frontmatter.id).sort()).toEqual(
      [ID.bun, ID.flights, ID.landlord].sort(),
    );
  });

  test('a malformed file is reported without stopping the rest', () => {
    const bad = join(paths.knowledge, 'broken.md');
    writeFileSync(bad, '---\nnot: a record\n---\nbody\n', 'utf8');
    const contents = loadSpace(paths);
    expect(contents.records).toHaveLength(3);
    expect(contents.failures).toHaveLength(1);
    expect(contents.failures[0]?.path).toBe('knowledge/broken.md');
    rmSync(bad);
  });
});

describe('the full-text index', () => {
  test('finds a record by a word from its body', () => {
    const { index } = buildIndex(paths);
    try {
      const hits = index.search('landlord');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe(ID.landlord);
      expect(hits[0]?.path).toBe('knowledge/landlord-contact.md');
    } finally {
      index.close();
    }
  });

  test('finds a record by a word from its title and one from its tags', () => {
    const { index } = buildIndex(paths);
    try {
      expect(index.search('flights')[0]?.id).toBe(ID.flights);
      expect(index.search('javascript')[0]?.id).toBe(ID.bun);
      expect(index.count()).toBe(3);
    } finally {
      index.close();
    }
  });

  test('ranks the better match first', () => {
    const { index } = buildIndex(paths);
    try {
      const hits = index.search('bun package management');
      expect(hits[0]?.id).toBe(ID.bun);
    } finally {
      index.close();
    }
  });

  test('a query with no usable tokens returns nothing rather than everything', () => {
    const { index } = buildIndex(paths);
    try {
      expect(index.search('   ')).toEqual([]);
      expect(toMatchQuery('!!!')).toBeNull();
    } finally {
      index.close();
    }
  });

  test('a query full of FTS5 syntax is searched for, not interpreted', () => {
    const { index } = buildIndex(paths);
    try {
      expect(() => index.search('landlord AND "unclosed')).not.toThrow();
    } finally {
      index.close();
    }
  });

  test('a handle knows the one space it can ever see', () => {
    const { index } = buildIndex(paths);
    try {
      expect(index.space).toBe('personal');
    } finally {
      index.close();
    }
  });

  test('a type filter narrows the hits', () => {
    const { index } = buildIndex(paths);
    try {
      expect(query(index, 'flights', { type: 'fact' })).toEqual([]);
      expect(query(index, 'flights', { type: 'preference' })).toHaveLength(1);
      expect(query(index, 'flights', { type: ['fact', 'preference'] })).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('a tag filter matches whole tags, not substrings', () => {
    const { index } = buildIndex(paths);
    try {
      expect(query(index, 'bun', { tags: ['tooling'] })).toHaveLength(1);
      expect(query(index, 'bun', { tags: ['tool'] })).toEqual([]);
      expect(query(index, 'bun', { tags: ['tooling', 'housing'] })).toEqual([]);
    } finally {
      index.close();
    }
  });

  test('a limit is respected', () => {
    const { index } = buildIndex(paths);
    try {
      expect(query(index, 'the lease renews', { limit: 1 })).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('a retracted record never enters the index, before or after a rebuild', () => {
    const index = SpaceIndex.memory('personal');
    try {
      index.rebuild([
        {
          id: ID.bun,
          path: 'a.md',
          title: 'Bun',
          tags: [],
          body: 'bun',
          status: 'active',
          type: 'preference',
        },
        {
          id: ID.flights,
          path: 'b.md',
          title: 'Flights',
          tags: [],
          body: 'flights',
          status: 'retracted',
          type: 'preference',
        },
      ]);
      expect(index.search('flights')).toEqual([]);
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('a superseded record is not indexed either', () => {
    const index = SpaceIndex.memory('personal');
    try {
      index.upsert({
        id: ID.flights,
        path: 'b.md',
        title: 'Flights',
        tags: [],
        body: 'flights',
        status: 'superseded',
        type: 'preference',
      });
      expect(index.search('flights')).toEqual([]);
      expect(index.count()).toBe(0);
    } finally {
      index.close();
    }
  });

  test('removing a record takes it out of the index immediately', () => {
    const index = SpaceIndex.memory('personal');
    try {
      index.upsert({
        id: ID.bun,
        path: 'a.md',
        title: 'Bun',
        tags: [],
        body: 'bun',
        status: 'active',
        type: 'preference',
      });
      expect(index.search('bun')).toHaveLength(1);
      index.remove(ID.bun);
      expect(index.search('bun')).toEqual([]);
      expect(index.has(ID.bun)).toBe(false);
    } finally {
      index.close();
    }
  });

  test('an index written to disk survives being reopened', () => {
    const { index } = buildIndex(paths);
    index.close();
    const reopened = SpaceIndex.open(paths);
    try {
      expect(reopened.search('landlord')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('renderUnifiedDiff', () => {
  test('shows a new file as all additions', () => {
    const diff = renderUnifiedDiff('', 'one\ntwo\n', 'a.md');
    expect(diff).toContain('--- a/dev/null');
    expect(diff).toContain('+one');
    expect(diff).toContain('+two');
    expect(diff).not.toContain('-one');
  });

  test('shows a changed line as a removal and an addition', () => {
    const diff = renderUnifiedDiff('one\ntwo\n', 'one\nthree\n', 'a.md');
    expect(diff).toContain(' one');
    expect(diff).toContain('-two');
    expect(diff).toContain('+three');
  });

  test('counts the lines on both sides', () => {
    expect(renderUnifiedDiff('one\n', 'one\ntwo\n', 'a.md')).toContain('@@ -1,1 +1,2 @@');
  });
});
