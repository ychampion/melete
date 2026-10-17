/**
 * A card can point at a place in Melete itself, such as Settings → Models
 * after the model provider refused the key. It moves this page there, in the
 * same tab; anything that is not one of Melete's own views draws no link.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResultCard as ResultCardData } from '../experience/types.ts';
import { ResultCard } from './parts.tsx';

const card = (handle: string): ResultCardData => ({
  id: 'provider-failure:att_1',
  title: 'The model key was not accepted',
  meta: 'Settings → Models',
  facts: [],
  primary_action: { label: 'Open model settings', kind: 'open', handle },
  secondary_actions: [],
  source_connection: null,
});

test('a card that names Settings → Models opens it in this tab', () => {
  const html = renderToStaticMarkup(<ResultCard card={card('#/settings/models')} />);
  expect(html).toContain('href="#/settings/models"');
  expect(html).toContain('Open model settings');
  expect(html).not.toContain('target="_blank"');
});

test('a handle that is not a place in Melete draws no link', () => {
  for (const handle of ['javascript:alert(1)', '#/../settings', 'https://example.test/'])
    expect(renderToStaticMarkup(<ResultCard card={card(handle)} />)).not.toContain('href=');
});
