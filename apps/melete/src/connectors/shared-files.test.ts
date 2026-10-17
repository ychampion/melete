import { expect, test } from 'bun:test';
import { mayChange, theirFiles } from './shared-files.ts';

const write = (path: string, hash: string, extra: Record<string, unknown> = {}) => ({
  kind: 'files.write',
  canonical_payload: { path, area: 'artifacts', content: 'x' },
  receipt: { detail: { path, area: 'artifacts', content_hash: hash, ...extra } },
});

test('a file is theirs only when their work made it new, or saved over their own', () => {
  const theirs = theirFiles([
    write('new.md', 'a', { created: true }),
    // Saved over their own: still theirs, with the new content.
    write('new.md', 'b', { replaced: 'a' }),
    // A save that says nothing of what it replaced, as older ones do: not theirs.
    write('old.md', 'c'),
    // One that replaced content they never left there: not theirs either.
    write('taken.md', 'd', { created: true }),
    write('taken.md', 'e', { replaced: 'someone else' }),
    // In their own workspace: never the space's Files.
    {
      kind: 'files.write',
      canonical_payload: { path: 'scratch.md', content: 'x' },
      receipt: { detail: { path: 'scratch.md', area: 'work', content_hash: 'f', created: true } },
    },
  ]);
  expect([...theirs.keys()]).toEqual(['new.md']);
  const rule = { limited: true as const, theirs };
  expect(mayChange(rule, 'new.md', 'b')).toBe(true);
  expect(mayChange(rule, 'new.md', 'a')).toBe(false);
  expect(mayChange(rule, 'new.md', null)).toBe(false);
  expect(mayChange(rule, 'old.md', 'c')).toBe(false);
  expect(mayChange({ limited: false }, 'anything.md', null)).toBe(true);
});

test('moves carry a file of theirs to its new name; deletes end it', () => {
  const move = (from: string, to: string, hash: string, area = 'artifacts', toArea = area) => ({
    kind: 'files.move',
    canonical_payload: { from, to, area, to_area: toArea },
    receipt: { detail: { from, to, area, to_area: toArea, content_hash: hash } },
  });
  const theirs = theirFiles([
    write('a/one.md', '1', { created: true }),
    write('a/two.md', '2', { created: true }),
    move('a/one.md', 'b/one.md', '1'),
    // From their own workspace into the Files: theirs.
    move('draft.md', 'c/draft.md', '3', 'work', 'artifacts'),
    // Someone else's file they moved, before the rule: not theirs at the new name.
    move('owners.md', 'd/owners.md', '4'),
    // Taken out of the Files into their workspace: no longer in the Files.
    move('a/two.md', 'two.md', '2', 'artifacts', 'work'),
    write('e/gone.md', '5', { created: true }),
    { kind: 'files.delete', canonical_payload: { path: 'e', area: 'artifacts' }, receipt: {} },
  ]);
  expect([...theirs.keys()].sort()).toEqual(['b/one.md', 'c/draft.md']);
});
