import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connection, ConnectionKind } from '../experience/types.ts';
import {
  AccountSignIn,
  AppConnect,
  type AppEntry,
  ConnectionActions,
  KindForm,
  Linked,
  type SignInEntry,
} from './ConnectionInstall.tsx';
import { ToolChoices } from './McpServerAdd.tsx';
import { ConnectionCard } from './Settings.tsx';

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
  expect(kept).not.toContain('Disconnect');
  const installed = renderToStaticMarkup(
    <ConnectionActions id="conn_mail" label="Mail" removable onChanged={() => {}} />,
  );
  expect(installed).toContain('Test');
  expect(installed).toContain('Disconnect');
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

/** A catalog app, as the service serves it. */
const stripeEntry = (extra: Partial<AppEntry> = {}): AppEntry => ({
  id: 'stripe',
  title: 'Stripe',
  description: 'Look up customers, payments, invoices and subscriptions in Stripe.',
  covers: ['tools'],
  connect: {
    method: 'mcp_sign_in',
    url: 'https://mcp.stripe.com',
    suggested_id: 'stripe',
    start: '/mcp-sign-ins',
    tools: [
      { label: 'List customers', effect_class: 'read', asks_first: false },
      { label: 'Add a customer', effect_class: 'write_reversible', asks_first: false },
      { label: 'Refund a payment', effect_class: 'spend', asks_first: true },
    ],
  },
  available: true,
  warning: 'Stripe can move money: refunds each wait for your approval.',
  ...extra,
});

test('before connecting an app, the person sees what it looks up, what it changes, and what asks first', () => {
  const html = renderToStaticMarkup(
    <AppConnect entry={stripeEntry()} onDone={() => {}} onInstalled={() => {}} />,
  );
  expect(html).toContain('Connect Stripe');
  expect(html).toContain('Looks things up');
  expect(html).toContain('List customers');
  expect(html).toContain('Makes changes');
  // Only the tool that waits for approval says so.
  expect(html.split('Asks you first')).toHaveLength(2);
  expect(html.indexOf('Asks you first')).toBeGreaterThan(html.indexOf('Refund a payment'));
  expect(html).toContain('Stripe can move money');
  expect(html).toContain('Continue to Stripe');
});

test('an app that needs an app registered for it says what is missing, and only its operator sees the setting', () => {
  const reason =
    'GitHub only accepts apps registered with GitHub ahead of time, and this Melete does not have one yet. Whoever runs it can register one.';
  const github = (extra: Partial<AppEntry>) =>
    renderToStaticMarkup(
      <AppConnect
        entry={stripeEntry({
          id: 'github',
          title: 'GitHub',
          available: false,
          unavailable_reason: reason,
          ...extra,
        })}
        onDone={() => {}}
        onInstalled={() => {}}
      />,
    );
  const person = github({});
  expect(person).toContain('only accepts apps registered with GitHub');
  expect(person).not.toContain('Available when your server is set up for it.');
  expect(person).toContain('docs/CONNECTORS.md#connecting-github');
  expect(person).not.toContain('GITHUB_MCP');
  expect(person).not.toContain('Continue to GitHub');
  // The service sends the setting to whoever runs this Melete, and no one else.
  const operator = github({
    setup_hint:
      'Register an OAuth app, then set GITHUB_MCP_CLIENT_ID and GITHUB_MCP_CLIENT_SECRET.',
  });
  expect(operator).toContain('GITHUB_MCP_CLIENT_ID');
});

test('the tools a server listed are each kept or dropped, with how far each may act, and none is typed', () => {
  const html = renderToStaticMarkup(
    <ToolChoices
      choices={[
        { name: 'read_wiki_contents', effect_class: 'read', keep: true },
        { name: 'post_update', effect_class: 'write_external', keep: true, description: 'Posts.' },
        { name: 'create_refund', effect_class: 'spend', keep: false },
      ]}
      onChange={() => {}}
    />,
  );
  expect(html).toContain('2 of 3 kept');
  for (const name of ['read_wiki_contents', 'post_update', 'create_refund'])
    expect(html).toContain(`How far ${name} may act`);
  expect(html).toContain('Looks only');
  expect(html).toContain('Spends money (asks you first)');
  expect(html).not.toContain('<input type="text"');
});

test('a connected app shows whether it runs, and why not when it fails', () => {
  const base: Connection = {
    id: 'conn_notion',
    app: 'Notion',
    label: 'Notion',
    status: 'connected',
    access: 'asks_before_acting',
    catalog_id: 'notion',
  };
  const running = renderToStaticMarkup(<ConnectionCard connection={base} />);
  expect(running).toContain('Connected');
  expect(running).toContain('aria-label="Notion"');
  const failing = renderToStaticMarkup(
    <ConnectionCard
      connection={{
        ...base,
        status: 'error',
        problem: {
          kind: 'failing',
          detail: 'Its last check failed. Press Test to check it again.',
        },
      }}
    />,
  );
  expect(failing).toContain('Failing');
  expect(failing).toContain('Its last check failed. Press Test to check it again.');
  const stopped = renderToStaticMarkup(
    <ConnectionCard
      connection={{
        ...base,
        status: 'error',
        problem: { kind: 'not_running', detail: 'Installed, but not running on this server.' },
      }}
    />,
  );
  expect(stopped).toContain('Not running');
  expect(stopped).toContain('Installed, but not running on this server.');
});

test('two tools that read the same to a person are one line, and the one that asks first decides', () => {
  const html = renderToStaticMarkup(
    <AppConnect
      entry={stripeEntry({
        connect: {
          method: 'mcp_sign_in',
          url: 'https://mcp.stripe.com',
          suggested_id: 'stripe',
          start: '/mcp-sign-ins',
          tools: [
            { label: 'Read an invoice', effect_class: 'read', asks_first: false },
            { label: 'Read an invoice', effect_class: 'read', asks_first: false },
            { label: 'Change an invoice', effect_class: 'write_reversible', asks_first: false },
            { label: 'Change an invoice', effect_class: 'spend', asks_first: true },
          ],
        },
      })}
      onDone={() => {}}
      onInstalled={() => {}}
    />,
  );
  expect(html.split('Read an invoice')).toHaveLength(2);
  expect(html.split('Change an invoice')).toHaveLength(2);
  expect(html).toContain('Asks you first');
});
