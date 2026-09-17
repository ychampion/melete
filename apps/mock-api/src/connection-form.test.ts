/**
 * The web form for installing a connection knows no kind of connection: it
 * follows the descriptors `GET /connection-kinds` serves. This runs that same
 * form logic against the mock, whose `POST /connections` validates with the
 * contract schemas, so a descriptor and the request it describes cannot drift.
 */
import { expect, test } from 'bun:test';
import { connectionKindListResponse, connectionResponse } from '@melete/contracts';
import {
  emptyForm,
  emptyRow,
  type FormValues,
  missing,
  requestBody,
} from '../../web/src/experience/connection-form.ts';
import { createMock } from './index.ts';

const TYPED: Record<string, string> = {
  'mail.username': 'me@example.test',
  'mail.from': 'me@example.test',
  'credentials.password': '  spaced secret  ',
  'mail.imap.host': 'imap.example.test',
  'mail.smtp.host': 'smtp.example.test',
  'caldav.calendar_url': 'https://dav.example.test/calendars/me/home/',
  'caldav.username': 'me',
  'ics.url': 'webcal://feeds.example.test/private-token/feed.ics',
  'mcp.id': 'notes',
  'mcp.url': 'https://mcp.example.test/mcp',
  'credentials.access_token': 'token-value',
  'mcp.allowed_scopes': 'mcp_notes.search, mcp_notes.add',
};
const ROWS = [
  { name: 'search', alias: 'search', required_scopes: 'mcp_notes.search', effect_class: 'read' },
  { name: 'add', alias: 'add', required_scopes: 'mcp_notes.add', effect_class: 'write_external' },
];

test('a form drawn only from the served descriptors installs every kind', async () => {
  const mock = createMock({ speed: 0 });
  const json = async (path: string, body?: unknown) => {
    const response = await mock.app.fetch(
      new Request(`http://mock.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, text: await response.text() };
  };
  const kinds = connectionKindListResponse.parse(
    JSON.parse((await json('/connection-kinds')).text),
  ).kinds;
  expect(kinds.map((kind) => kind.kind).sort()).toEqual(['caldav', 'ics', 'mail', 'mcp']);

  for (const kind of kinds) {
    const values: FormValues = emptyForm(kind);
    // An untouched form names what is missing instead of sending a request the service would refuse.
    expect(missing(kind, values)).not.toBeNull();
    for (const field of kind.fields) {
      if (field.input === 'list')
        values.lists[field.path] = ROWS.map((row) => ({
          ...emptyRow(field.item_fields ?? []),
          ...row,
        }));
      else if (TYPED[field.path] !== undefined) values.fields[field.path] = TYPED[field.path] ?? '';
    }
    expect(missing(kind, values)).toBeNull();

    const body = requestBody(kind, values);
    const created = await json('/connections', body);
    expect([kind.kind, created.status]).toEqual([kind.kind, 201]);
    const view = connectionResponse.parse(JSON.parse(created.text));
    expect(view.check?.code).toBe('ok');
    for (const field of kind.fields.filter((item) => item.secret))
      expect(created.text).not.toContain(String(values.fields[field.path]).trim());
    if (kind.kind === 'mail') {
      // Numbers and switches arrive typed, optional blanks are left out, a password is not trimmed.
      expect(body).toMatchObject({
        provider: 'imap',
        credentials: { password: '  spaced secret  ' },
        mail: { imap: { port: 993, secure: true }, smtp: { port: 465, secure: true } },
      });
      expect(Object.keys((body.mail ?? {}) as object)).not.toContain('inbox');
      expect(view.connection.scopes).toEqual([
        'email.search',
        'email.read',
        'email.draft',
        'email.send',
      ]);
    }
    if (kind.kind === 'mcp')
      expect(view.connection.scopes).toEqual(['mcp_notes.search', 'mcp_notes.add']);
  }

  // Unticking a grant narrows the request; unticking all of them is caught before sending.
  const mail = kinds.find((kind) => kind.kind === 'mail');
  if (!mail) throw new Error('Missing mail descriptor');
  const narrowed = emptyForm(mail);
  for (const [path, value] of Object.entries(TYPED))
    if (path in narrowed.fields) narrowed.fields[path] = value;
  narrowed.scopes['email.send'] = false;
  expect(requestBody(mail, narrowed).scopes).toEqual(['email.search', 'email.read', 'email.draft']);
  for (const scope of Object.keys(narrowed.scopes)) narrowed.scopes[scope] = false;
  expect(missing(mail, narrowed)).toBe('Choose at least one thing this connection may do.');
});
