import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aRecord, fixedClock } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import { git, runGit } from './git.ts';
import type { SpacePaths } from './layout.ts';
import {
  commitRecord,
  commitRemoval,
  headSha,
  history,
  initSpace,
  openSpace,
  readAtHead,
  revert,
} from './space.ts';

let root: string;
let paths: SpacePaths;
const now = fixedClock();

const write = (body: string, over = {}) => serializeRecord(aRecord(over), body);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-space-'));
  paths = await initSpace(root, 'personal');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('creating a space', () => {
  test('lays out the directories and the generated files', () => {
    for (const file of ['SCHEMA.md', 'index.md', 'log.md', '.gitignore']) {
      expect(existsSync(join(paths.root, file))).toBe(true);
    }
    for (const dir of [paths.knowledge, paths.raw, paths.skills, paths.proposed]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  test('is a git repository with one commit in it', async () => {
    const log = await git(paths.root, ['log', '--oneline']);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(log).toContain('Create the personal space');
  });

  test('does not track the derived index or the staging area', async () => {
    const ignored = readFileSync(join(paths.root, '.gitignore'), 'utf8');
    expect(ignored).toContain('.index/');
    expect(ignored).toContain('.proposed/');
    const check = await runGit(paths.root, ['check-ignore', '.index/fts.sqlite']);
    expect(check.code).toBe(0);
  });

  test('running it twice leaves the existing space alone', async () => {
    const before = await headSha(paths);
    await initSpace(root, 'personal');
    expect(await headSha(paths)).toBe(before);
  });

  test('opening a directory that is not a space says so', () => {
    expect(() => openSpace(root, 'nothing-here')).toThrow('no space at');
  });
});

describe('committing a record', () => {
  test('writes the file and names who proposed it', async () => {
    const commit = await commitRecord(paths, 'knowledge/prefers-bun.md', write('bun everywhere'), {
      proposedBy: 'agent',
      approvedBy: 'zara',
      subject: 'Record the package manager preference',
      now,
    });

    expect(commit.committed).toBe(true);
    expect(commit.changed).toContain('knowledge/prefers-bun.md');
    const message = await git(paths.root, ['log', '-1', '--format=%B']);
    expect(message).toContain('Record the package manager preference');
    expect(message).toContain('Melete-Proposed-By: agent');
    expect(message).toContain('Melete-Approved-By: zara');
  });

  test('commits as melete, whatever the host git config says', async () => {
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('bun everywhere'), {
      proposedBy: 'agent',
      now,
    });
    const who = await git(paths.root, ['log', '-1', '--format=%an <%ae> | %cn <%ce>']);
    expect(who.trim()).toBe('melete <melete@localhost> | melete <melete@localhost>');
  });

  test('brings the catalog and the chronicle along in the same commit', async () => {
    const commit = await commitRecord(paths, 'knowledge/prefers-bun.md', write('bun everywhere'), {
      proposedBy: 'agent',
      now,
    });
    expect(commit.changed.sort()).toEqual(['index.md', 'knowledge/prefers-bun.md', 'log.md']);
    expect(readFileSync(paths.index, 'utf8')).toContain('knowledge/prefers-bun.md');
    expect(readFileSync(paths.log, 'utf8')).toContain('proposed by agent');
  });

  test('an identical write commits nothing rather than an empty change', async () => {
    const content = write('bun everywhere');
    const first = await commitRecord(paths, 'knowledge/prefers-bun.md', content, {
      proposedBy: 'agent',
      now,
    });
    const second = await commitRecord(paths, 'knowledge/prefers-bun.md', content, {
      proposedBy: 'agent',
      now,
    });
    expect(second.committed).toBe(false);
    expect(second.changed).toEqual([]);
    expect(second.sha).toBe(first.sha);
  });

  test('a path that climbs out of the space is refused before anything is written', async () => {
    await expect(
      commitRecord(paths, '../other/leak.md', write('x'), { proposedBy: 'agent', now }),
    ).rejects.toThrow('outside the space root');
  });
});

describe('history and undo', () => {
  test('history reads newest first and says who asked', async () => {
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('first version'), {
      proposedBy: 'agent',
      subject: 'Write the first version',
      now,
    });
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('second version'), {
      proposedBy: 'user',
      approvedBy: 'zara',
      subject: 'Correct it by hand',
      now,
    });

    const entries = await history(paths, 'knowledge/prefers-bun.md');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.subject).toBe('Correct it by hand');
    expect(entries[0]?.proposedBy).toBe('user');
    expect(entries[0]?.approvedBy).toBe('zara');
    expect(entries[1]?.subject).toBe('Write the first version');
    expect(entries[1]?.approvedBy).toBeNull();
  });

  test('history of a file that was never written is empty, not an error', async () => {
    expect(await history(paths, 'knowledge/never.md')).toEqual([]);
  });

  test('reverting a commit puts the earlier text back and keeps both commits', async () => {
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('first version'), {
      proposedBy: 'agent',
      now,
    });
    const second = await commitRecord(paths, 'knowledge/prefers-bun.md', write('second version'), {
      proposedBy: 'agent',
      now,
    });

    const undone = await revert(paths, second.sha, { proposedBy: 'zara', now });
    expect(undone.committed).toBe(true);

    const file = readFileSync(join(paths.knowledge, 'prefers-bun.md'), 'utf8');
    expect(file).toContain('first version');
    expect(file).not.toContain('second version');

    const log = await git(paths.root, ['log', '--format=%s']);
    expect(log).toContain('Revert');
    expect(await history(paths, 'knowledge/prefers-bun.md')).toHaveLength(3);
  });

  test('reverting the removal of a record brings the record back', async () => {
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('bun everywhere'), {
      proposedBy: 'agent',
      now,
    });
    const removal = await commitRemoval(paths, 'knowledge/prefers-bun.md', {
      proposedBy: 'zara',
      now,
    });
    expect(existsSync(join(paths.knowledge, 'prefers-bun.md'))).toBe(false);

    await revert(paths, removal.sha, { proposedBy: 'zara', now });
    expect(existsSync(join(paths.knowledge, 'prefers-bun.md'))).toBe(true);
  });

  test('the version in the last commit is readable, and a new file has none', async () => {
    expect(await readAtHead(paths, 'knowledge/prefers-bun.md')).toBeNull();
    await commitRecord(paths, 'knowledge/prefers-bun.md', write('bun everywhere'), {
      proposedBy: 'agent',
      now,
    });
    expect(await readAtHead(paths, 'knowledge/prefers-bun.md')).toContain('bun everywhere');
  });
});
