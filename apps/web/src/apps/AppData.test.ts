/**
 * What the Responses and data review dialogs show: a response's fields as
 * lines, clipped, and the keys a new data version adds, changes and removes.
 * And the one message Melete sends an app unasked, that data it read changed.
 */
import { expect, test } from 'bun:test';
import { responseLines, updateLines } from './AppData.tsx';
import { notifyChanged } from './bridge.ts';

test("a response's fields read as name and value, long values clipped", () => {
  expect(responseLines({ note: 'Clear', rating: 5, tags: ['a'] })).toEqual([
    { key: 'note', text: 'Clear' },
    { key: 'rating', text: '5' },
    { key: 'tags', text: '["a"]' },
  ]);
  expect(responseLines({ note: 'x'.repeat(400) })[0]?.text).toHaveLength(301);
});

test('a data update lists the keys it adds, changes and removes, and says when there are more', () => {
  const update = {
    binding: 'deals',
    path: 'data/deals.json',
    artifact_id: 'art_1',
    written_at: '2026-10-02T08:00:00Z',
    size: 27,
    size_before: 18,
    summary: 'Keys: 1 added, 1 changed, 18 → 27 bytes',
  };
  expect(
    updateLines({
      ...update,
      changes: { added: ['lost'], removed: [], changed: ['open'], truncated: false },
    }),
  ).toEqual(['Added: lost', 'Changed: open']);
  expect(
    updateLines({
      ...update,
      changes: { added: ['a'], removed: ['b'], changed: [], truncated: true },
    }),
  ).toEqual(['Added: a, and more', 'Removed: b, and more']);
  expect(updateLines({ ...update, changes: null })).toEqual([]);
});

test('an app is told which data changed, and only by a name it could have read', () => {
  const sent: unknown[] = [];
  const frame = {
    contentWindow: {
      postMessage: (message: unknown, target: string) => sent.push([message, target]),
    },
  } as unknown as HTMLIFrameElement;
  notifyChanged(frame, 'deals');
  notifyChanged(frame, '../deals');
  notifyChanged(null, 'deals');
  expect(sent).toEqual([[{ type: 'melete.changed', name: 'deals' }, '*']]);
});
