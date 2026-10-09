/**
 * A card that hands the work to the person: its Take over is the card's own
 * button, and it takes over the surface the work was on.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardAction, ResultCard as ResultCardData } from '../experience/types.ts';
import { ResultCard } from './parts.tsx';
import { takeOverFromCard } from './take-over.ts';

const handedOver = (surface: 'browser' | 'computer'): ResultCardData => ({
  id: 'handoff_41',
  title: 'Over to you at shop.example',
  meta: 'Needs you',
  facts: [
    { label: 'About', value: 'Take over the computer, pass the check, then hand it back.' },
    { label: 'Done so far', value: 'Opened shop.example' },
  ],
  primary_action: { label: 'Take over', kind: 'take_over', handle: 'sbx_1', surface },
  secondary_actions: [],
  source_connection: null,
});

test('a hand-off card shows what is left, what is done, and a Take over of its own', () => {
  const html = renderToStaticMarkup(
    <ResultCard card={handedOver('computer')} onTakeOver={() => {}} />,
  );
  expect(html).toContain('Over to you at shop.example');
  expect(html).toContain('pass the check');
  expect(html).toContain('Opened shop.example');
  // The card's main button, not an undo; it waits for a way to take over.
  expect(html).toMatch(
    /<button[^>]*class="[^"]*btn-primary[^"]*"[^>]*><span>Take over<\/span><\/button>/,
  );
  expect(html).not.toContain('disabled');
  const without = renderToStaticMarkup(<ResultCard card={handedOver('computer')} />);
  expect(without).toMatch(/<button[^>]*disabled[^>]*><span>Take over<\/span><\/button>/);
});

test('Take over takes the surface the work was on, and says why when it cannot', async () => {
  const asked: string[] = [];
  const ok = { data: {}, error: null, unavailable: null } as const;
  const calls = {
    takeOver: async (id: string) => {
      asked.push(`browser ${id}`);
      return ok as never;
    },
    sandboxTakeOver: async (id: string) => {
      asked.push(`computer ${id}`);
      return ok as never;
    },
  };
  const action = (surface: 'browser' | 'computer'): CardAction => ({
    label: 'Take over',
    kind: 'take_over',
    handle: surface === 'browser' ? 'bs_1' : 'sbx_1',
    surface,
  });
  expect(await takeOverFromCard(action('computer'), calls)).toEqual({ ok: true, what: 'computer' });
  expect(await takeOverFromCard(action('browser'), calls)).toEqual({ ok: true, what: 'browser' });
  expect(asked).toEqual(['computer sbx_1', 'browser bs_1']);
  const refused = await takeOverFromCard(action('computer'), {
    ...calls,
    sandboxTakeOver: async () =>
      ({
        data: null,
        error: 'Someone else is already watching this computer.',
        unavailable: null,
      }) as never,
  });
  expect(refused).toEqual({ ok: false, error: 'Someone else is already watching this computer.' });
});
