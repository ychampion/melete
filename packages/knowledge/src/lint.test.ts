import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFrontmatter } from '@melete/contracts';
import { runLint } from './cli/lint.ts';
import type { Check } from './findings.ts';
import { aRecord, fixedClock, IDS, seededSpace } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import type { SpacePaths } from './layout.ts';
import { lintSpace } from './lint.ts';
import { commitRecord, refreshCatalog } from './space.ts';

let root: string;
let paths: SpacePaths;
const now = fixedClock();

const put = (name: string, frontmatter: KnowledgeFrontmatter, body: string): void => {
  writeFileSync(join(paths.knowledge, name), serializeRecord(frontmatter, body), 'utf8');
};

const checksOf = (findings: readonly { check: Check }[]): Check[] =>
  [...new Set(findings.map((f) => f.check))].sort();

let seed: Awaited<ReturnType<typeof seededSpace>>;
beforeAll(async () => {
  seed = await seededSpace(async (paths) => {
    await commitRecord(
      paths,
      'knowledge/prefers-bun.md',
      serializeRecord(aRecord({}), 'Zara uses bun for every package operation.'),
      { proposedBy: 'user', now },
    );
  });
}, 30_000);
afterAll(() => seed?.close());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'melete-lint-'));
  paths = seed.copy(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a space that is in order', () => {
  test('lints clean', async () => {
    const report = await lintSpace(paths);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.records).toBe(1);
  });
});

describe('what the lint catches', () => {
  test('two records sharing an id', async () => {
    put('duplicate.md', aRecord({ title: 'A second file with the first id' }), 'Body.');
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).toContain('ids-unique');
  });

  test('a record whose space does not match the directory it is in', async () => {
    put('wrong-space.md', aRecord({ id: IDS.flights, space: 'team-acme' }), 'Body.');
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).toContain('space-equals-directory');
  });

  test('a supersedes that the older record does not agree with', async () => {
    put(
      'newer.md',
      aRecord({ id: IDS.flights, title: 'The newer record', supersedes: [IDS.bun] }),
      'Body.',
    );
    refreshCatalog(paths);
    const checks = checksOf((await lintSpace(paths)).findings);
    expect(checks).toContain('supersede-symmetry');
  });

  test('a superseded record that is still marked active', async () => {
    put(
      'prefers-bun.md',
      aRecord({ superseded_by: IDS.flights, status: 'active' }),
      'Zara uses bun for every package operation.',
    );
    put(
      'newer.md',
      aRecord({ id: IDS.flights, title: 'The newer record', supersedes: [IDS.bun] }),
      'Body.',
    );
    refreshCatalog(paths);
    const messages = (await lintSpace(paths)).findings.map((f) => f.message).join(' ');
    expect(messages).toContain('is still active');
  });

  test('a status that moved somewhere it cannot move to', async () => {
    const superseded = aRecord({ status: 'superseded', superseded_by: IDS.flights });
    put('prefers-bun.md', superseded, 'Zara uses bun.');
    put(
      'newer.md',
      aRecord({ id: IDS.flights, title: 'The newer record', supersedes: [IDS.bun] }),
      'Body.',
    );
    refreshCatalog(paths);
    await commitRecord(
      paths,
      'knowledge/newer.md',
      serializeRecord(
        aRecord({ id: IDS.flights, title: 'The newer record', supersedes: [IDS.bun] }),
        'Body.',
      ),
      { proposedBy: 'user', now },
    );
    await commitRecord(
      paths,
      'knowledge/prefers-bun.md',
      serializeRecord(superseded, 'Zara uses bun.'),
      {
        proposedBy: 'user',
        now,
      },
    );

    // Now walk it back by hand, which is the move the lint exists to catch.
    put('prefers-bun.md', aRecord({ status: 'active' }), 'Zara uses bun.');
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).toContain('status-transition');
  });

  test('a tag that was never declared in SCHEMA.md', async () => {
    put('prefers-bun.md', aRecord({ tags: ['tooling', 'undeclared-tag'] }), 'Zara uses bun.');
    refreshCatalog(paths);
    const report = await lintSpace(paths);
    expect(checksOf(report.findings)).toContain('tags-declared');
    expect(report.findings.map((f) => f.message).join(' ')).toContain('undeclared-tag');
  });

  test('an index.md that no longer matches the records', async () => {
    writeFileSync(paths.index, '# Index\n\nSomething a person typed.\n', 'utf8');
    expect(checksOf((await lintSpace(paths)).findings)).toContain('index-in-sync');
  });

  test('a page that has grown past the cap', async () => {
    put(
      'prefers-bun.md',
      aRecord({}),
      Array.from({ length: 205 }, (_, i) => `Line ${i}.`).join('\n'),
    );
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).toContain('page-length');
  });

  test('a link to a file that is not there', async () => {
    put('prefers-bun.md', aRecord({}), 'See [the lease](../raw/lease.md) for the wording.');
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).toContain('orphan-links');
  });

  test('but not a link to a file that is', async () => {
    writeFileSync(join(paths.raw, 'lease.md'), 'The lease.\n', 'utf8');
    put('prefers-bun.md', aRecord({}), 'See [the lease](../raw/lease.md) for the wording.');
    refreshCatalog(paths);
    expect(checksOf((await lintSpace(paths)).findings)).not.toContain('orphan-links');
  });

  test('and not a link out to the web', async () => {
    put('prefers-bun.md', aRecord({}), 'See [the docs](https://bun.sh/docs) for the wording.');
    refreshCatalog(paths);
    expect((await lintSpace(paths)).findings).toEqual([]);
  });

  test('a file that does not parse as a record at all', async () => {
    writeFileSync(join(paths.knowledge, 'broken.md'), '---\nnot: a record\n---\nbody\n', 'utf8');
    expect(checksOf((await lintSpace(paths)).findings)).toContain('record-parses');
  });
});

describe('the lint command', () => {
  test('says nothing is wrong and exits zero', async () => {
    const result = await runLint([paths.root]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('personal: 1 record, 0 errors, 0 warnings');
  });

  test('lists what is wrong and exits non-zero', async () => {
    put('duplicate.md', aRecord({ title: 'A second file with the first id' }), 'Body.');
    const result = await runLint([paths.root]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('ids-unique');
    expect(result.output).toContain('index-in-sync');
    expect(result.output).toContain('error');
  });

  test('finds a space by name under the spaces directory', async () => {
    const result = await runLint(['personal'], { MELETE_SPACES_DIR: root });
    expect(result.code).toBe(0);
  });

  test('says how to use it when given nothing', async () => {
    const result = await runLint([]);
    expect(result.code).toBe(2);
    expect(result.output).toContain('usage:');
  });

  test('says so when the space is not there', async () => {
    const result = await runLint([join(root, 'no-such-space')]);
    expect(result.code).toBe(2);
    expect(result.output).toContain('no space at');
  });
});
