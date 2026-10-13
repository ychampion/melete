import { expect, test } from 'bun:test';
import { DEFAULT_STARTERS, fillStarter, STARTER_ICONS } from '@melete/contracts/starters';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_PATHS } from '../design/icons.tsx';
import { StarterList, starterSelection } from './Starters.tsx';

const offered = DEFAULT_STARTERS.map((starter) => fillStarter(starter, 'Chicago'));

test('every icon a starter may name is one the app draws', () => {
  for (const name of STARTER_ICONS) expect([name, name in ICON_PATHS]).toEqual([name, true]);
});

test('a tap selects the blank, so typing replaces it; with none the cursor goes to the end', () => {
  const coffee = offered[0];
  if (!coffee) throw new Error('no starter');
  const { start, end } = starterSelection(coffee);
  expect(coffee.text.slice(start, end)).toBe('Chicago');
  const stretch = offered[1];
  if (!stretch) throw new Error('no starter');
  expect(starterSelection(stretch)).toEqual({
    start: stretch.text.length,
    end: stretch.text.length,
  });
  // A range that does not fit the words is not trusted.
  expect(starterSelection({ text: 'Hi', select: { start: 1, end: 9 } })).toEqual({
    start: 2,
    end: 2,
  });
});

test('each starter is a button that fills the box, and they can be put away', () => {
  const html = renderToStaticMarkup(
    <StarterList starters={offered} onPick={() => {}} onDismiss={() => {}} />,
  );
  expect(html.match(/<button type="button" class="starter"/g)).toHaveLength(6);
  expect(html).toContain('>Hide these</button>');
  expect(html).toContain('Try one to start');
  expect(html).toContain('Coffee shops nearby');
  // The words that go in the box are there to read before tapping.
  expect(html).toContain('title="Plan a 3-day trip to a city on a budget."');
  expect(
    renderToStaticMarkup(<StarterList starters={[]} onPick={() => {}} onDismiss={() => {}} />),
  ).toBe('');
});
