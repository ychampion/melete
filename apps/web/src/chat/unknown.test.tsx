/**
 * An effect sent once with no answer asks the person whether it arrived.
 * Saying it did not leaves it open to another attempt, and the card says so
 * both before the choice and after it.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LedgerAction } from '../experience/types.ts';
import { RETRY_HINT, UnknownCard } from './parts.tsx';

const action = (status: string) =>
  ({
    id: 'act_1',
    status,
    canonical_payload: { to: ['help@ternandco.example'] },
  }) as unknown as LedgerAction;

test('"It did not" is described by the retry hint before the choice', () => {
  const html = renderToStaticMarkup(
    <UnknownCard action={action('unknown')} onResolve={() => {}} />,
  );
  expect(RETRY_HINT).toBe('Melete may try again, and asks you first.');
  expect(html).toContain('If it did not, Melete may try again, and asks you first.');
  const described = html.match(
    /<button[^>]*aria-describedby="([^"]+)"[^>]*>(?:(?!<\/button>)[\s\S])*It did not/,
  );
  expect(described).not.toBeNull();
  expect(html).toContain(`id="${described?.[1]}"`);
});

test('once the person says it did not, the card says Melete may try again and asks first', () => {
  const html = renderToStaticMarkup(<UnknownCard action={action('failed')} onResolve={() => {}} />);
  expect(html).toContain('It did not');
  expect(html).toContain(RETRY_HINT);
  expect(html).not.toContain('It arrived</button>');
});
