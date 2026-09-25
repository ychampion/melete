/**
 * Each learned item says what it does, where it came from and whether it is in
 * use, and offers only the actions the service allowed it, each named for the
 * item so a screen reader hears which one it acts on.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearnedItem } from '../experience/types.ts';
import { expiryLine, LearnedRow, originLine, stateBadge } from './Learned.tsx';

const item = (over: Partial<LearnedItem> = {}): LearnedItem => ({
  id: 'pc_1',
  source: 'correction',
  name: 'Chasing a company',
  does: ['Quote back the date they gave you', 'Keep it to five lines'],
  applies_when: ['chase'],
  space_id: 'sp_01M0000000000000000000000A',
  shared: false,
  state: 'active',
  reason: null,
  reason_code: null,
  definition_hash: 'a'.repeat(64),
  learned_at: '2026-09-22T09:00:00.000Z',
  expires_at: null,
  expiring_soon: false,
  actions: ['pause', 'remove'],
  ...over,
});

const row = (value: LearnedItem) =>
  renderToStaticMarkup(<LearnedRow item={value} busy={false} onAct={async () => true} />);

test('a lesson shows its steps, when it applies, where it came from and its state', () => {
  const html = row(item());
  expect(html).toContain('Chasing a company');
  expect(html).toContain('<li');
  expect(html).toContain('Quote back the date they gave you');
  expect(html).toContain('When you ask to “chase”');
  expect(html).toContain('Learned from your correction · Sep 22');
  expect(html).toContain('In use');
});

test('only the actions the service allowed are offered, each named for the item', () => {
  const html = row(item());
  expect(html).toContain('aria-label="Pause: Chasing a company"');
  expect(html).toContain('aria-label="Remove: Chasing a company"');
  expect(html).not.toContain('Resume');
  expect(html).not.toContain('Try it');
  const held = row(
    item({
      source: 'engine',
      name: 'refund-follow-up',
      state: 'proposed',
      actions: ['approve', 'edit', 'remove', 'stop'],
    }),
  );
  for (const label of ['Approve', 'Edit', 'Remove', 'Don’t do this'])
    expect(held).toContain(`aria-label="${label}: refund-follow-up"`);
  expect(held).toContain('Waiting for your OK');
});

test('the badge follows the state and the source', () => {
  expect(stateBadge(item({ state: 'proposed' })).text).toBe('New');
  expect(stateBadge(item({ state: 'proposed', source: 'engine' })).text).toBe(
    'Waiting for your OK',
  );
  expect(stateBadge(item({ state: 'trial' })).text).toBe('On trial');
  expect(stateBadge(item({ state: 'paused' })).text).toBe('Paused');
  expect(stateBadge(item({ state: 'reverted' })).text).toBe('Stopped');
});

test('origin and expiry are said in plain words, expiry only when it is close', () => {
  expect(originLine(item({ source: 'engine', shared: true }))).toBe(
    'Melete wrote this for itself · Sep 22 · Shared with your space',
  );
  expect(expiryLine(item())).toBeNull();
  expect(expiryLine(item({ expiring_soon: true, expires_at: '2026-09-30T09:00:00.000Z' }))).toBe(
    'Leaves this list on Sep 30 unless you try it',
  );
});

test('a stopped item says why', () => {
  const html = row(
    item({ state: 'reverted', reason: 'You said not to do this.', actions: ['remove'] }),
  );
  expect(html).toContain('Stopped');
  expect(html).toContain('You said not to do this.');
});
