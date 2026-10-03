/**
 * An effect sent once with no answer asks the person whether it arrived.
 * Saying it did not leaves it open to another attempt, and the card says so
 * both before the choice and after it.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LedgerAction } from '../experience/types.ts';
import { describeAction, ownComputerStep, RETRY_HINT, UnknownCard } from './parts.tsx';

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

test("a step on the agent's own computer is never put to the person", () => {
  expect(ownComputerStep({ kind: 'terminal.run' })).toBe(true);
  expect(ownComputerStep({ kind: 'computer.click' })).toBe(true);
  expect(ownComputerStep({ kind: 'email.send' })).toBe(false);
  expect(ownComputerStep({ kind: 'device.run' })).toBe(false);
});

test('a file step says what it did to the file', () => {
  const file = (kind: string) =>
    describeAction({
      id: 'act_2',
      kind,
      status: 'unknown',
      canonical_payload: { path: 'device/screenshot-1.png' },
    } as unknown as LedgerAction);
  expect(file('files.read')).toBe('reading “screenshot-1.png”');
  expect(file('files.write')).toBe('saving “screenshot-1.png”');
  expect(file('files.list')).toBe('looking in “screenshot-1.png”');
});

test('a file move is told as one, never as a message to the file', () => {
  const move = {
    id: 'act_2',
    kind: 'files.move',
    status: 'unknown',
    canonical_payload: {
      from: 'shots/capture.png',
      to: 'random-org-screenshot.png',
      to_area: 'artifacts',
    },
  } as unknown as LedgerAction;
  const html = renderToStaticMarkup(<UnknownCard action={move} onResolve={() => {}} />);
  expect(html).toContain('I tried this once and couldn’t confirm it finished.');
  expect(html).toContain('moving “capture.png” to “random-org-screenshot.png”');
  expect(html).not.toContain('a message');
  expect(html).toContain('It didn’t');
  expect(html).not.toContain('It arrived');
});
