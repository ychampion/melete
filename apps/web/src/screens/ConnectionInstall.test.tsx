import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionKind } from '../experience/types.ts';
import { ConnectionActions, KindForm } from './ConnectionInstall.tsx';

/** A kind this application has never heard of: the form has only the descriptor to go on. */
const invented = {
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
