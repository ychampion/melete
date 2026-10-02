import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionKind } from '../experience/types.ts';
import {
  AccountSignIn,
  ConnectionActions,
  KindForm,
  Linked,
  type SignInEntry,
} from './ConnectionInstall.tsx';

/** A kind this application has never heard of: the form has only the descriptor to go on. */
const invented = {
  id: 'pigeon-post',
  kind: 'mail',
  title: 'Pigeon post',
  description: 'Messages carried by a bird you keep.',
  fixed: [{ path: 'provider', value: 'imap' }],
  fields: [
    { path: 'loft.name', label: 'Loft name', input: 'text', required: true, secret: false },
    {
      path: 'loft.perches',
      label: 'Perches',
      input: 'number',
      required: true,
      secret: false,
      default: 12,
    },
    {
      path: 'credentials.whistle',
      label: 'Whistle',
      input: 'password',
      required: true,
      secret: true,
      help: 'Kept sealed.',
    },
    {
      path: 'loft.covered',
      label: 'Covered loft',
      input: 'checkbox',
      required: true,
      secret: false,
      default: true,
    },
    {
      path: 'loft.beacon',
      label: 'Beacon address',
      input: 'url',
      required: true,
      secret: true,
      placeholder: 'https://beacon.example.test/loft',
    },
    { path: 'loft.notes', label: 'Notes', input: 'text', required: false, secret: false },
    {
      path: 'loft.birds',
      label: 'Birds',
      input: 'list',
      required: true,
      secret: false,
      item_fields: [
        { path: 'ring', label: 'Ring number', input: 'text', required: true, secret: false },
        {
          path: 'range',
          label: 'Range',
          input: 'select',
          required: true,
          secret: false,
          options: [
            { value: 'near', label: 'Near' },
            { value: 'far', label: 'Far' },
          ],
        },
      ],
    },
  ],
  scopes: [
    {
      scope: 'pigeon.read',
      label: 'Read arrivals',
      effect_class: 'read',
      asks_first: false,
      default: true,
    },
    {
      scope: 'pigeon.send',
      label: 'Send a bird',
      effect_class: 'write_external',
      asks_first: true,
      default: true,
    },
  ],
} satisfies ConnectionKind;

test('the form draws exactly what a served descriptor carries', () => {
  const html = renderToStaticMarkup(<KindForm kind={invented} onDone={() => {}} />);
  for (const text of [
    'Pigeon post',
    'Messages carried by a bird you keep.',
    'Loft name',
    'Perches',
    'Whistle',
    'Kept sealed.',
    'Beacon address',
    'Covered loft',
    'Notes (optional)',
    'Birds',
    'Ring number',
    'Range',
    'Near',
    'Far',
    'Read arrivals',
    'Send a bird',
    'Connect and test',
  ])
    expect(html).toContain(text);
  // A secret is a password input the browser is told not to remember.
  expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="new-password"/i);
  // What the service seals is masked whatever kind of value it holds: a feed
  // address kept like a password is not shown in the clear.
  expect(html).toMatch(
    /<input[^>]*type="password"[^>]*placeholder="https:\/\/beacon\.example\.test\/loft"/i,
  );
  expect(html).not.toContain('type="url"');
  expect(html).toMatch(/<input[^>]*type="number"[^>]*value="12"/);
  // Only the grant that waits for approval says so, and it says so once.
  expect(html.split('Asks you first')).toHaveLength(2);
  // Nothing can be sent until what is required has been typed, and the form says what is missing.
  expect(html).toContain('Loft name is needed.');
  expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  // The values a request always carries are never inputs.
  expect(html).not.toContain('imap');
});

test('a connection the service keeps in every space is tested here and not removed', () => {
  const kept = renderToStaticMarkup(
    <ConnectionActions id="conn_files" label="Files" removable={false} onChanged={() => {}} />,
  );
  expect(kept).toContain('Test');
  expect(kept).not.toContain('Remove');
  const installed = renderToStaticMarkup(
    <ConnectionActions id="conn_mail" label="Mail" removable onChanged={() => {}} />,
  );
  expect(installed).toContain('Test');
  expect(installed).toContain('Remove');
});

/** A catalog entry for Google, as the service serves it. */
const SCOPES = [
  { scope: 'openid', label: 'Confirm who you are' },
  { scope: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Read your Gmail messages' },
];
const googleEntry = (extra: Partial<SignInEntry>): SignInEntry => ({
  id: 'google',
  title: 'Google',
  description: 'Sign in with Google to connect Gmail and Google Calendar.',
  covers: ['mail', 'calendar'],
  connect: {
    method: 'sign_in',
    provider: 'google',
    start: '/google-sign-ins',
    issuer: 'https://accounts.google.com',
    scopes: SCOPES,
  },
  available: true,
  ...extra,
});

test('before signing in, the person sees where and everything that is asked for', () => {
  const html = renderToStaticMarkup(
    <AccountSignIn entry={googleEntry({})} onDone={() => {}} onInstalled={() => {}} />,
  );
  expect(html).toContain('You sign in at <strong>accounts.google.com</strong>');
  for (const scope of SCOPES) expect(html).toContain(scope.label);
  expect(html).toContain('Continue to Google');
});

test('an entry this server is not set up for says so, links the setup guide, and never names settings', () => {
  for (const setup_hint of [
    undefined,
    'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
  ]) {
    const html = renderToStaticMarkup(
      <AccountSignIn
        entry={googleEntry({
          available: false,
          unavailable_reason: 'Signing in with Google is not set up on this Melete yet.',
          ...(setup_hint ? { setup_hint } : {}),
        })}
        onDone={() => {}}
        onInstalled={() => {}}
      />,
    );
    expect(html).toContain('Available when your server is set up for it.');
    expect(html).toContain('docs/mail-calendar.md#signing-in-with-google');
    expect(html).not.toContain('GOOGLE_OAUTH');
    expect(html).not.toContain('Continue to Google');
  }
});

test('an address in help text is a link', () => {
  const html = renderToStaticMarkup(
    <Linked text="Open myaccount.google.com/apppasswords, create one named Melete." />,
  );
  expect(html).toContain('href="https://myaccount.google.com/apppasswords"');
  expect(html).toContain('create one named Melete.');
});
