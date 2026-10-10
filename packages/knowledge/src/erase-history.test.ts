import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aRecord, fixedClock } from './fixtures.ts';
import { serializeRecord } from './frontmatter.ts';
import { git, runGit } from './git.ts';
import type { SpacePaths } from './layout.ts';
import { commitRecord, eraseFromHistory, initSpace, readAtHead } from './space.ts';

const VIEW = 'knowledge/k_01HZZZZZZZZZZZZZZZZZZZZZZZ.md';
const GLOB = 'knowledge/k_*.md';
const isView = (path: string) => /^knowledge\/k_[0-7][0-9A-HJKMNP-TV-Z]{25}\.md$/.test(path);

let root: string;
let paths: SpacePaths;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'melete-erase-'));
  paths = await initSpace(root, 'personal');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const everyObject = async () =>
  (await runGit(paths.root, ['cat-file', '--batch-all-objects', '--batch'])).stdout;
async function commitFile(path: string, value: string, message: string, extra: string[] = []) {
  await Bun.write(join(paths.root, path), `${value}\n`);
  await git(paths.root, ['add', '-f', '--', path]);
  await git(paths.root, [...extra, 'commit', '--quiet', '-m', message]);
}

describe('erasing views from history, beyond the current branch', () => {
  test('a view committed only on another branch is erased too', async () => {
    await git(paths.root, ['checkout', '--quiet', '-b', 'elsewhere']);
    await commitFile(VIEW, 'Sister lives in Lisbon', 'Refresh memory inspection records');
    await git(paths.root, ['checkout', '--quiet', '-']);
    expect(await eraseFromHistory(paths, GLOB, isView)).toBe(true);
    expect(await everyObject()).not.toContain('Lisbon');
    expect(await git(paths.root, ['log', '--all', '--format=%H', '--', VIEW])).toBe('');
  });

  test('nothing an earlier reset left in ORIG_HEAD keeps a view, and the repository stays whole', async () => {
    await commitFile(VIEW, 'Allergic to penicillin', 'Refresh memory inspection records');
    await commitFile('notes.md', 'mine', 'A note of my own');
    await git(paths.root, ['reset', '--quiet', '--hard', 'HEAD~1']);
    await commitFile('notes.md', 'mine again', 'A note of my own, again');
    expect(await eraseFromHistory(paths, GLOB, isView)).toBe(true);
    expect(await everyObject()).not.toContain('penicillin');
    expect((await runGit(paths.root, ['fsck', '--full'])).code).toBe(0);
  });
});

describe('erasing views from history while a record is written', () => {
  test('a record committed during the erase is kept, in the history and on disk', async () => {
    // A long history, so the rewrite takes long enough for a write to land inside it.
    let stream = '';
    const head = (await git(paths.root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(paths.root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    for (let i = 1; i <= 3000; i += 1) {
      const body = `value ${i}\n`;
      stream += `commit refs/heads/${branch}\nmark :${i}\ncommitter P <p@x> ${1700000000 + i} +0000\ndata 3\nmsg\n`;
      stream += `from ${i === 1 ? head : `:${i - 1}`}\nM 100644 inline ${i % 2 ? VIEW : 'notes.md'}\ndata ${body.length}\n${body}\n`;
    }
    const proc = Bun.spawn(['git', '-C', paths.root, 'fast-import', '--quiet'], { stdin: 'pipe' });
    proc.stdin.write(stream);
    await proc.stdin.end();
    await proc.exited;
    await git(paths.root, ['reset', '--quiet', '--hard']);
    const record = serializeRecord(
      aRecord({ id: 'k_01J8ZP3QWABCDEFGHJKMNPQRSX' }),
      'kept while erasing',
    );
    await Promise.all([
      eraseFromHistory(paths, GLOB, isView),
      (async () => {
        await Bun.sleep(30);
        await commitRecord(paths, 'knowledge/kept.md', record, {
          proposedBy: 'user',
          now: fixedClock(),
        });
      })(),
    ]);
    expect(await readAtHead(paths, 'knowledge/kept.md')).toContain('kept while erasing');
    expect(await git(paths.root, ['log', '--all', '--format=%H', '--', VIEW])).toBe('');
  }, 30_000);
});

describe('erasing views from history: what it also survives', () => {
  // `git fast-export` aborts on a commit with its own encoding header unless
  // --reencode is given, so the erase throws on every use of that space.
  test('a commit written with its own encoding does not stop the erase', async () => {
    await commitFile('notes.md', 'mine', 'A note of my own', [
      '-c',
      'i18n.commitEncoding=ISO-8859-1',
    ]);
    await commitFile(VIEW, 'Sister lives in Lisbon', 'Refresh memory inspection records');
    expect(await eraseFromHistory(paths, GLOB, isView)).toBe(true);
    expect(await everyObject()).not.toContain('Lisbon');
  });

  // The cheap "anything to do?" check must use `match`, not only the glob, or a person's
  // own `knowledge/k_notes.md` makes every call rewrite the history and wipe the reflog.
  test('a file of the person that only looks like a view leaves the history alone', async () => {
    await commitFile('knowledge/k_notes.md', 'mine', 'A note of my own');
    expect(await eraseFromHistory(paths, GLOB, isView)).toBe(false);
  });
});
