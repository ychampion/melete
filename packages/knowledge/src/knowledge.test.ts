import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { parseRecord, serializeRecord } from './frontmatter.ts';
import { SpaceIndex, toMatchQuery } from './fts.ts';
import { recordPath, resolveInSpace, slugify, type spacePaths } from './layout.ts';
import { ProposalStore, renderDiff } from './mediation.ts';
import { buildIndex, hardDelete, initSpace, knownIds, loadSpace } from './store.ts';

const ID = {
  bun: 'k_01J8ZP3QWABCDEFGHJKMNPQRST',
  flights: 'k_01J8ZP3QWABCDEFGHJKMNPQRSV',
  landlord: 'k_01J8ZP3QWABCDEFGHJKMNPQRSW',
  missing: 'k_01J8ZP3QWABCDEFGHJKMNPQRSX',
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
  paths = initSpace(root, 'personal');

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

  test('a retracted record never enters the index, before or after a rebuild', () => {
    const index = SpaceIndex.open(':memory:');
    try {
      index.rebuild([
        { id: ID.bun, path: 'a.md', title: 'Bun', tags: [], body: 'bun', status: 'active' },
        {
          id: ID.flights,
          path: 'b.md',
          title: 'Flights',
          tags: [],
          body: 'flights',
          status: 'retracted',
        },
      ]);
      expect(index.search('flights')).toEqual([]);
      expect(index.search('bun')).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test('removing a record takes it out of the index immediately', () => {
    const index = SpaceIndex.open(':memory:');
    try {
      index.upsert({
        id: ID.bun,
        path: 'a.md',
        title: 'Bun',
        tags: [],
        body: 'bun',
        status: 'active',
      });
      expect(index.search('bun')).toHaveLength(1);
      index.remove(ID.bun);
      expect(index.search('bun')).toEqual([]);
    } finally {
      index.close();
    }
  });

  test('an index written to disk survives being reopened', () => {
    const { index } = buildIndex(paths);
    index.close();
    const reopened = SpaceIndex.open(paths.indexDb);
    try {
      expect(reopened.search('landlord')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  test('hard deletion removes the file and the row in one operation', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'melete-delete-'));
    const scratch = initSpace(scratchRoot, 'personal');
    writeFileSync(
      join(scratch.knowledge, 'prefers-bun.md'),
      serializeRecord(frontmatter({}), 'bun everywhere'),
      'utf8',
    );
    const { index, contents } = buildIndex(scratch);
    try {
      expect(index.search('bun')).toHaveLength(1);
      const record = contents.records[0];
      expect(record).toBeDefined();
      if (record) expect(hardDelete(scratch, index, record)).toBe(true);
      expect(index.search('bun')).toEqual([]);
      expect(loadSpace(scratch).records).toEqual([]);
    } finally {
      index.close();
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe('write mediation', () => {
  const store = () =>
    new ProposalStore({
      paths,
      spacesRoot: root,
      knownIds: knownIds(loadSpace(paths)),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
    });

  test('a valid proposal is staged and rendered as a diff', () => {
    const result = store().propose({
      space: 'personal',
      path: 'knowledge/new-record.md',
      frontmatter: frontmatter({ id: ID.missing, title: 'A new thing' }),
      body: 'Something Melete learned today.',
      rationale: 'The owner said it in passing.',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diff).toContain('+++ b/knowledge/new-record.md');
      expect(result.diff).toContain('+Something Melete learned today.');
      expect(
        store()
          .list()
          .map((p) => p.path),
      ).toContain('knowledge/new-record.md');
      expect(store().discard(result.proposal.id)).toBe(true);
    }
  });

  test('a proposal that would escape the space is refused', () => {
    const result = store().propose({
      space: 'personal',
      path: '../team-acme/knowledge/leak.md',
      frontmatter: frontmatter({ id: ID.missing }),
      body: 'x',
      rationale: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.findings[0]?.message).toContain('outside the space root');
  });

  test('a proposal naming another space is refused', () => {
    const result = store().propose({
      space: 'team-acme',
      path: 'knowledge/x.md',
      frontmatter: frontmatter({ id: ID.missing, space: 'team-acme' }),
      body: 'x',
      rationale: 'x',
    });
    expect(result.ok).toBe(false);
  });

  test('a proposal with a dangling supersedes is refused', () => {
    const result = store().propose({
      space: 'personal',
      path: 'knowledge/x.md',
      frontmatter: frontmatter({ id: ID.missing, supersedes: ['k_01J8ZP3QWZZZZZZZZZZZZZZZZZ'] }),
      body: 'x',
      rationale: 'x',
    });
    expect(result.ok).toBe(false);
  });

  test('applying refuses loudly rather than half-writing a space', () => {
    expect(() => store().apply('anything')).toThrow('git store');
  });
});

describe('renderDiff', () => {
  test('shows a new file as all additions', () => {
    const diff = renderDiff('', 'one\ntwo\n', 'a.md');
    expect(diff).toContain('+one');
    expect(diff).toContain('+two');
    expect(diff).not.toContain('-one');
  });

  test('shows a changed line as a removal and an addition', () => {
    const diff = renderDiff('one\ntwo\n', 'one\nthree\n', 'a.md');
    expect(diff).toContain(' one');
    expect(diff).toContain('-two');
    expect(diff).toContain('+three');
  });
});
