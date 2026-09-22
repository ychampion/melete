import { describe, expect, test } from 'bun:test';
import {
  CONNECTION_CHECK_DETAIL,
  CONNECTION_KIND_DESCRIPTORS,
  CONNECTION_KIND_SCOPES,
  type ConnectionFormItemField,
  type ConnectionKindDescriptor,
  connectionCheck,
  connectionInstallation,
  connectionKindListResponse,
  connectionRequestProblem,
  connectionResponse,
  createConnectionRequest,
} from './connections.ts';
import { connectionView } from './entities.ts';

const SPACE = 'sp_01J00000000000000000000000';

const mail = {
  space_id: SPACE,
  provider: 'imap',
  label: 'Personal mail',
  credentials: { password: 'app-password-value' },
  mail: {
    username: 'owner@example.test',
    from: 'owner@example.test',
    imap: { host: 'imap.example.test', port: 993, secure: true },
    smtp: { host: 'smtp.example.test', port: 465, secure: true },
  },
};
const caldav = {
  space_id: SPACE,
  provider: 'caldav',
  label: 'Calendar',
  credentials: { password: 'calendar-password' },
  caldav: { calendar_url: 'https://dav.example.test/calendars/owner/', username: 'owner' },
};
const ics = {
  provider: 'caldav',
  label: 'Holidays',
  ics: { url: 'webcal://feeds.example.test/holidays.ics?token=private' },
};
const mcp = {
  space_id: SPACE,
  provider: 'mcp',
  label: 'Notes',
  mcp: {
    id: 'notes',
    url: 'https://mcp.example.test/mcp',
    allowed_scopes: ['mcp_notes.search'],
    audience: 'owner',
    tools: [
      {
        name: 'search',
        alias: 'search',
        required_scopes: ['mcp_notes.search'],
        effect_class: 'read',
      },
    ],
  },
};

const resolve = (input: unknown) => connectionInstallation(createConnectionRequest.parse(input));

describe('connection installation requests', () => {
  test('each credentialed kind resolves to its provider, configuration and default scopes', () => {
    const resolved = [mail, caldav, ics, mcp].map(resolve);
    expect(
      resolved.map((item) => (item.ok ? [item.value.kind, item.value.provider] : item)),
    ).toEqual([
      ['mail', 'imap'],
      ['caldav', 'caldav'],
      ['ics', 'caldav'],
      ['mcp', 'mcp'],
    ]);
    const [first, second, third] = resolved;
    expect(first?.ok && first.value.kind === 'mail' && first.value.scopes).toEqual([
      ...CONNECTION_KIND_SCOPES.mail,
    ]);
    expect(second?.ok && second.value.kind === 'caldav' && second.value.scopes).toEqual([
      ...CONNECTION_KIND_SCOPES.caldav,
    ]);
    // A webcal address is the same feed over HTTPS.
    expect(third?.ok && third.value.kind === 'ics' && third.value.config.url).toBe(
      'https://feeds.example.test/holidays.ics?token=private',
    );
  });

  test('a narrower grant is kept and a scope outside the kind is refused', () => {
    const narrowed = resolve({ ...mail, scopes: ['email.search', 'email.read'] });
    expect(narrowed.ok && narrowed.value.kind === 'mail' && narrowed.value.scopes).toEqual([
      'email.search',
      'email.read',
    ]);
    expect(resolve({ ...mail, scopes: ['calendar.list'] }).ok).toBe(false);
    expect(resolve({ ...ics, scopes: ['calendar.create'] }).ok).toBe(false);
    expect(resolve({ ...mcp, scopes: ['mcp_notes.search'] }).ok).toBe(false);
  });

  test('the configuration block must be single and match the provider', () => {
    expect(resolve({ space_id: SPACE, provider: 'imap', label: 'Nothing' }).ok).toBe(false);
    expect(resolve({ ...mail, caldav: caldav.caldav }).ok).toBe(false);
    expect(resolve({ ...mail, provider: 'caldav' }).ok).toBe(false);
    expect(resolve({ ...ics, provider: 'imap' }).ok).toBe(false);
    expect(resolve({ ...caldav, provider: 'mcp' }).ok).toBe(false);
  });

  test('credentials are required where the kind has one and refused where it has none', () => {
    expect(resolve({ ...mail, credentials: undefined }).ok).toBe(false);
    expect(resolve({ ...mail, credentials: { password: 'x', token: 'y' } }).ok).toBe(false);
    expect(resolve({ ...caldav, credentials: {} }).ok).toBe(false);
    expect(resolve({ ...ics, credentials: { password: 'unused' } }).ok).toBe(false);
  });

  test('endpoints are validated per kind', () => {
    const parse = (input: unknown) => createConnectionRequest.safeParse(input).success;
    expect(
      parse({ ...mail, mail: { ...mail.mail, imap: { ...mail.mail.imap, port: 70000 } } }),
    ).toBe(false);
    expect(parse({ ...mail, mail: { ...mail.mail, from: 'not-an-address' } })).toBe(false);
    expect(parse({ ...mail, mail: { ...mail.mail, username: 'owner\r\nBcc: x' } })).toBe(false);
    expect(parse({ ...mail, mail: { ...mail.mail, extra: true } })).toBe(false);
    // A mailbox that starts in the clear and upgrades is a request the service
    // takes; whether it upgrades is settled by the test, not by validation.
    expect(
      parse({
        ...mail,
        mail: {
          ...mail.mail,
          imap: { host: 'imap.example.test', port: 143, secure: false },
          smtp: { host: 'smtp.example.test', port: 587, secure: false },
        },
      }),
    ).toBe(true);
    for (const calendar_url of [
      'http://dav.example.test/calendars/owner/',
      'https://owner:secret@dav.example.test/calendars/owner/',
      'https://dav.example.test/calendars/owner/?x=1',
    ])
      expect(parse({ ...caldav, caldav: { ...caldav.caldav, calendar_url } })).toBe(false);
    for (const url of [
      'http://feeds.example.test/holidays.ics',
      'ftp://feeds.example.test/holidays.ics',
      'https://owner:secret@feeds.example.test/holidays.ics',
    ])
      expect(parse({ ...ics, ics: { url } })).toBe(false);
    // A loopback fixture may be plain HTTP; nothing else may.
    expect(parse({ ...ics, ics: { url: 'http://127.0.0.1:8080/feed.ics' } })).toBe(true);
  });
});

/** Fill a form the way a client that knows only the descriptor would. */
function filled(descriptor: ConnectionKindDescriptor): Record<string, unknown> {
  const body: Record<string, unknown> = { label: descriptor.title };
  const put = (target: Record<string, unknown>, path: string, value: unknown) => {
    const keys = path.split('.');
    let at = target;
    for (const key of keys.slice(0, -1)) {
      at[key] = at[key] ?? {};
      at = at[key] as Record<string, unknown>;
    }
    at[keys.at(-1) as string] = value;
  };
  const sample = (field: ConnectionFormItemField): unknown => {
    if (field.default !== undefined) return field.default;
    if (field.input === 'select') return field.options?.[0]?.value;
    if (field.input === 'number') return 993;
    if (field.input === 'checkbox') return true;
    if (field.input === 'email') return 'owner@example.test';
    if (field.input === 'url') return 'https://service.example.test/path/';
    if (field.input === 'string_list') return ['mcp_notes.search'];
    return field.path.endsWith('id') || field.path === 'alias' ? 'notes' : 'value';
  };
  for (const item of descriptor.fixed) put(body, item.path, item.value);
  for (const field of descriptor.fields) {
    if (field.input === 'list') {
      const row: Record<string, unknown> = {};
      for (const item of field.item_fields ?? []) put(row, item.path, sample(item));
      put(body, field.path, [row]);
    } else put(body, field.path, sample({ ...field, input: field.input }));
  }
  const scopes = descriptor.scopes.filter((scope) => scope.default).map((scope) => scope.scope);
  if (scopes.length) body.scopes = scopes;
  return body;
}

describe('connection kind descriptors', () => {
  test('cover every credentialed kind and parse as the served response', () => {
    const parsed = connectionKindListResponse.parse({ kinds: CONNECTION_KIND_DESCRIPTORS });
    expect(parsed.kinds.map((kind) => kind.kind).sort()).toEqual(['caldav', 'ics', 'mail', 'mcp']);
    for (const kind of parsed.kinds) {
      const secrets = kind.fields.filter((field) => field.secret).map((field) => field.path);
      expect(secrets.every((path) => path.startsWith('credentials.') || path === 'ics.url')).toBe(
        true,
      );
    }
  });

  test('a form filled only from a descriptor is an installable request', () => {
    for (const descriptor of CONNECTION_KIND_DESCRIPTORS) {
      const request = createConnectionRequest.safeParse(filled(descriptor));
      expect(request.success ? null : [descriptor.kind, request.error.issues]).toBeNull();
      if (!request.success) continue;
      const installation = connectionInstallation(request.data);
      expect(installation.ok ? installation.value.kind : installation).toBe(descriptor.kind);
    }
  });

  test('offered scopes are exactly the scopes the kind may be granted', () => {
    for (const descriptor of CONNECTION_KIND_DESCRIPTORS) {
      if (descriptor.kind === 'mcp') expect(descriptor.scopes).toEqual([]);
      else
        expect(descriptor.scopes.map((scope) => scope.scope)).toEqual([
          ...CONNECTION_KIND_SCOPES[descriptor.kind],
        ]);
    }
  });
});

describe('connection views and checks', () => {
  const view = {
    id: 'conn_01J00000000000000000000000',
    space_id: SPACE,
    provider: 'imap',
    label: 'Personal mail',
    scopes: ['email.search'],
    status: 'revoked',
    health: 'unknown',
    generation: 2,
    last_checked_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };

  test('a revoked connection is still a readable view and never carries its secret pointer', () => {
    const parsed = connectionView.parse({ ...view, secret_ref: 'sec_01J00000000000000000000000' });
    expect(parsed.status).toBe('revoked');
    expect(parsed.generation).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain('sec_');
  });

  test('a check is a fixed code and sentence, not a transport message', () => {
    const check = connectionCheck.parse({
      status: 'failing',
      code: 'unavailable',
      detail: CONNECTION_CHECK_DETAIL.unavailable,
      checked_at: '2026-01-01T00:00:00.000Z',
    });
    expect(connectionResponse.parse({ connection: view, check }).check?.code).toBe('unavailable');
    expect(connectionCheck.safeParse({ ...check, code: 'ECONNREFUSED 10.0.0.1' }).success).toBe(
      false,
    );
  });
});

describe('what a person is told when a request is refused', () => {
  const told = (body: unknown) => {
    const parsed = createConnectionRequest.safeParse(body);
    if (parsed.success) throw new Error('expected a refusal');
    return connectionRequestProblem(parsed.error.issues);
  };

  test('names the field by its form label and says what is wrong in plain words', () => {
    expect(
      told({ ...mail, mail: { ...mail.mail, imap: { ...mail.mail.imap, port: 70000 } } }),
    ).toBe('IMAP port is too large.');
    expect(told({ ...mail, mail: { ...mail.mail, from: 'owner' } })).toBe(
      'Send as is not an email address.',
    );
    expect(told({ ...mail, mail: { ...mail.mail, imap: { port: 993, secure: true } } })).toBe(
      'IMAP server is needed.',
    );
    expect(
      told({ ...caldav, caldav: { ...caldav.caldav, calendar_url: 'http://dav.example.test/c/' } }),
    ).toBe('Calendar address: The address must use TLS and carry no credentials or fragment.');
    expect(told({ ...ics, ics: {} })).toBe('Feed address is needed.');
  });

  test('a row in a list is named by its position', () => {
    const mcp = {
      provider: 'mcp',
      label: 'Notes',
      mcp: {
        id: 'notes',
        url: 'https://mcp.example.test/mcp',
        audience: 'owner',
        allowed_scopes: ['mcp_notes.search'],
        tools: [{ name: 'search', alias: 'Search Tool', required_scopes: ['mcp_notes.search'] }],
      },
    };
    expect(told(mcp)).toBe('Tools, row 1: Alias has characters it cannot contain.');
  });

  test('never repeats a value the person typed, so a password cannot come back', () => {
    const message = told({
      ...mail,
      credentials: { password: 42 } as unknown as Record<string, string>,
    });
    expect(message).toBe('Password has the wrong kind of value.');
    expect(
      told({
        ...mail,
        mail: { ...mail.mail, imap: { ...mail.mail.imap, port: 'value-never-echoed' } },
      }),
    ).not.toContain('value-never-echoed');
  });
});
