/**
 * Asks of one kind the work made together read as one card, and one press
 * answers every ask the card shows: eight empty files to delete are one
 * question, not eight.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionCard } from '../chat/parts.tsx';
import { foldedOptions, foldTogether, seenTogether } from './together.ts';
import type { Permission } from './types.ts';

const AT = '2026-10-09T16:00:00.000Z';
const ask = (n: number, over: Partial<Permission> = {}): Permission => ({
  id: `apr_${n}`,
  conversation_id: 'job_1',
  what: `Delete art_${n}.txt from your Files`,
  why: ['This change needs your permission before it happens.'],
  options: ['allow_once', 'always', 'deny'],
  version: `v_${n}`,
  preview: null,
  created_at: AT,
  group: 'grp_delete',
  ...over,
});

test('asks of one group fold under the first, in order; others stand alone', () => {
  const draft = ask(9, { group: undefined, what: 'Send the reply to Sam' });
  const other = ask(10, { group: 'grp_other' });
  const folded = foldTogether([ask(1), draft, ask(2), other, ask(3)], (item) => item);
  expect(folded.map(({ item, together }) => [item.id, together.map((p) => p.id)])).toEqual([
    ['apr_1', ['apr_2', 'apr_3']],
    ['apr_9', []],
    ['apr_10', []],
  ]);
  expect(seenTogether(folded[0]?.together ?? [])).toEqual([
    { id: 'apr_2', version: 'v_2' },
    { id: 'apr_3', version: 'v_3' },
  ]);
});

test('an answered ask no longer folds with the ones still waiting', () => {
  const blocks = [
    { permission: ask(1), decided: 'allow_once' },
    { permission: ask(2), decided: null },
    { permission: ask(3), decided: null },
  ];
  const folded = foldTogether(
    blocks,
    (block) => block.permission,
    (block) => String(block.decided),
  );
  expect(folded.map(({ item, together }) => [item.permission.id, together.length])).toEqual([
    ['apr_1', 0],
    ['apr_2', 1],
  ]);
});

test('a folded card offers no standing rule, and only what every ask in it offers', () => {
  expect(foldedOptions(ask(1), [])).toEqual(['allow_once', 'always', 'deny']);
  expect(foldedOptions(ask(1), [ask(2)])).toEqual(['allow_once', 'deny']);
  expect(foldedOptions(ask(1), [ask(2, { options: ['deny'] })])).toEqual(['deny']);
});

test('the folded card names every ask it answers, and asks once', () => {
  const html = renderToStaticMarkup(
    <PermissionCard
      permission={ask(1)}
      decided={null}
      together={[2, 3, 4, 5, 6, 7, 8].map((n) => ask(n))}
      onDecide={() => {}}
    />,
  );
  expect(html).toContain('Delete art_1.txt from your Files, and 7 more like it');
  for (let n = 2; n <= 8; n += 1) expect(html).toContain(`Delete art_${n}.txt from your Files`);
  expect(html.match(/Allow once/g)).toHaveLength(1);
  expect(html.match(/>Deny</g)).toHaveLength(1);
  expect(html).not.toContain('Always allow');
});
