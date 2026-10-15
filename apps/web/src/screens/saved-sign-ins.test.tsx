/**
 * Settings → Saved sign-ins: a saved sign-in says when it was last used and
 * how that went, a change sends only what changed, and a blank password or
 * code secret keeps the saved one.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppContext, type AppContextValue } from '../experience/hooks.ts';
import type { SavedSignIn } from '../experience/types.ts';
import { createBody, SavedSignIns, updateBody, usedLine } from './SavedSignIns.tsx';

const NOW = Date.parse('2026-10-10T15:00:00.000Z');

const signIn = (over: Partial<SavedSignIn> = {}): SavedSignIn => ({
  id: 'ssi_01',
  origin: 'https://example.com',
  site: 'example.com',
  label: 'Example',
  username: 'jo@example.com',
  password: '••••••••',
  has_code: true,
  policy: 'whenever_needed',
  created_at: '2026-10-01T09:00:00.000Z',
  updated_at: '2026-10-01T09:00:00.000Z',
  last_used_at: null,
  last_outcome: null,
  ...over,
});

const draft = {
  site: '',
  username: 'jo@example.com',
  password: '',
  code_secret: '',
  label: 'Example',
  ask_first: false,
  remove_code: false,
};

test('a sign-in says whether and when it was used, and how it went', () => {
  expect(usedLine(signIn(), NOW)).toBe('Not used yet');
  expect(
    usedLine(signIn({ last_used_at: '2026-10-10T09:00:00.000Z', last_outcome: 'signed_in' }), NOW),
  ).toBe('Last used today, signed in');
  expect(
    usedLine(signIn({ last_used_at: '2026-10-02T09:00:00.000Z', last_outcome: 'needs_code' }), NOW),
  ).toBe('Last used Oct 2, the site asked for a code');
});

test('a new sign-in leaves out what was left blank', () => {
  expect(
    createBody({
      ...draft,
      site: ' example.com ',
      password: 'pw',
      label: ' ',
      code_secret: '',
      ask_first: true,
    }),
  ).toEqual({
    site: 'example.com',
    username: 'jo@example.com',
    password: 'pw',
    policy: 'ask_first',
  });
});

test('an edit sends only what changed; blank keeps the saved password and code', () => {
  expect(updateBody(signIn(), draft)).toBeNull();
  expect(updateBody(signIn(), { ...draft, password: 'new one' })).toEqual({ password: 'new one' });
  expect(updateBody(signIn(), { ...draft, remove_code: true })).toEqual({ code_secret: null });
  expect(updateBody(signIn(), { ...draft, code_secret: ' JBSWY3DPEHPK3PXP ' })).toEqual({
    code_secret: 'JBSWY3DPEHPK3PXP',
  });
  expect(updateBody(signIn(), { ...draft, ask_first: true, label: 'Work' })).toEqual({
    policy: 'ask_first',
    label: 'Work',
  });
  // An emptied name is sent as "", which puts the site's own name back.
  expect(updateBody(signIn(), { ...draft, label: '  ' })).toEqual({ label: '' });
});

test('saved sign-ins are not shown where there is no browser', () => {
  const app = { capabilities: { browser: false } } as unknown as AppContextValue;
  expect(
    renderToStaticMarkup(
      <AppContext.Provider value={app}>
        <SavedSignIns />
      </AppContext.Provider>,
    ),
  ).toBe('');
});
