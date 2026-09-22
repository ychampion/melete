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

const mcpStdio = {
  space_id: SPACE,
  provider: 'mcp',
  label: 'Files',
  mcp_stdio: {
    id: 'files',
    runner: 'npx',
    source: '@modelcontextprotocol/server-filesystem@2026.1.14',
    args: ['/data'],
    secret_env: [{ name: 'FILES_TOKEN', value: 'sealed-on-arrival' }],
    allowed_scopes: ['mcp_files.read'],
    audience: 'owner',
    tools: [
      {
        name: 'read_file',
        alias: 'read',
        required_scopes: ['mcp_files.read'],
        effect_class: 'read',
      },
    ],
  },
};

const resolve = (input: unknown) => connectionInstallation(createConnectionRequest.parse(input));

describe('connection installation requests', () => {
  test('each credentialed kind resolves to its provider, configuration and default scopes', () => {
    const resolved = [mail, caldav, ics, mcp, mcpStdio].map(resolve);
    expect(
      resolved.map((item) => (item.ok ? [item.value.kind, item.value.provider] : item)),
    ).toEqual([
      ['mail', 'imap'],
      ['caldav', 'caldav'],
      ['ics', 'caldav'],
      ['mcp', 'mcp'],
      ['mcp_stdio', 'mcp'],
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

  test('a stdio MCP launch names only a registry package or an image, never a flag, URL or path', () => {
    const parse = (patch: Record<string, unknown>) =>
      createConnectionRequest.safeParse({
        ...mcpStdio,
        mcp_stdio: { ...mcpStdio.mcp_stdio, ...patch },
      }).success;
    expect(parse({})).toBe(true);
    for (const source of [
      'mcp-server-fetch',
      'mcp-server-fetch==2026.1.1',
      'mcp-server-git[extra]>=1.0,<2',
      'mcp-server-time@2026.1.0',
    ])
      expect([source, parse({ runner: 'uvx', source })]).toEqual([source, true]);
    expect(parse({ runner: 'image', source: 'ghcr.io/example/server:1.0' })).toBe(true);
    expect(
      parse({ runner: 'image', source: `registry.local:5000/server@sha256:${'a'.repeat(64)}` }),
    ).toBe(true);
    for (const source of [
      '--registry=https://evil.example',
      'git+https://example.test/repo.git',
      'user/repo',
      'file:../local',
      'https://example.test/pkg.tgz',
      'npm:other@1',
      'name with space',
    ])
      expect([source, parse({ source })]).toEqual([source, false]);
    expect(parse({ runner: 'uvx', source: '--with=evil' })).toBe(false);
    expect(parse({ runner: 'image', source: 'Uppercase/Image' })).toBe(false);
    expect(parse({ command: '--eval' })).toBe(false);
    expect(parse({ egress: ['api.example.com', 'api.example.com:8443'] })).toBe(true);
    for (const egress of [
      ['localhost'],
      ['10.0.0.1'],
      ['api.example.com:0'],
      ['a.b', 'a.b'],
      ['*.example.com'],
    ])
      expect([egress, parse({ egress })]).toEqual([egress, false]);
    for (const name of ['HOME', 'HTTPS_PROXY', 'lower', 'A-B'])
      expect([name, parse({ secret_env: [{ name, value: 'x' }] })]).toEqual([name, false]);
    expect(
      parse({
        secret_env: [
          { name: 'TOKEN', value: 'x' },
          { name: 'TOKEN', value: 'y' },
        ],
      }),
    ).toBe(false);
    // Its secrets are named variables in the block; the generic credentials record is refused.
    expect(resolve({ ...mcpStdio, credentials: { password: 'x' } }).ok).toBe(false);
    expect(resolve({ ...mcpStdio, scopes: ['mcp_files.read'] }).ok).toBe(false);
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
    if (field.path.endsWith('egress')) return ['registry.example.test'];
    if (field.input === 'string_list') return ['mcp_notes.search'];
    if (field.path.endsWith('source')) return '@example/notes-server';
    if (field.path === 'name') return 'NOTES_TOKEN';
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
    expect([...new Set(parsed.kinds.map((kind) => kind.kind))].sort()).toEqual([
      'caldav',
      'ics',
      'mail',
      'mcp',
      'mcp_stdio',
    ]);
    const ids = parsed.kinds.map((kind) => kind.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every kind keeps an entry for a server no provider entry names.
    for (const kind of ['caldav', 'ics', 'mail', 'mcp', 'mcp_stdio']) expect(ids).toContain(kind);
    for (const kind of parsed.kinds) {
      const secrets = kind.fields.flatMap((field) => [
        ...(field.secret ? [field.path] : []),
        ...(field.item_fields ?? [])
          .filter((item) => item.secret)
          .map((item) => `${field.path}.${item.path}`),
      ]);
      expect(
        secrets.every(
          (path) =>
            path.startsWith('credentials.') ||
            path === 'ics.url' ||
            path === 'mcp_stdio.secret_env.value',
        ),
      ).toBe(true);
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
      if (descriptor.kind === 'mcp' || descriptor.kind === 'mcp_stdio')
        expect(descriptor.scopes).toEqual([]);
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

describe('an address that is not a web address', () => {
  test('is refused as invalid rather than failing the request', () => {
    for (const body of [
      { ...ics, ics: { url: 'not a link' } },
      { ...caldav, caldav: { ...caldav.caldav, calendar_url: 'dav.example.test/calendars' } },
      {
        provider: 'mcp',
        label: 'Notes',
        mcp: {
          id: 'notes',
          url: 'mcp.example.test',
          audience: 'owner',
          allowed_scopes: ['mcp_notes.search'],
          tools: [{ name: 'search', alias: 'search', required_scopes: ['mcp_notes.search'] }],
        },
      },
    ]) {
      const parsed = createConnectionRequest.safeParse(body);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(connectionRequestProblem(parsed.error.issues)).toMatch(
          /^(Feed address|Calendar address|Server address) is not a web address\.$/,
        );
    }
  });
});

describe('a mailbox sender', () => {
  test('is the account name when that is an address, so a person types it once', () => {
    const { from: _, ...rest } = mail.mail;
    const resolved = connectionInstallation(createConnectionRequest.parse({ ...mail, mail: rest }));
    expect(
      resolved.ok && resolved.value.kind === 'mail' ? resolved.value.config.from : resolved,
    ).toBe('owner@example.test');
  });

  test('is asked for when the account name is not an address', () => {
    const { from: _, ...rest } = mail.mail;
    const resolved = connectionInstallation(
      createConnectionRequest.parse({ ...mail, mail: { ...rest, username: 'owner' } }),
    );
    expect(resolved).toEqual({
      ok: false,
      error: 'Send as is needed when the account name is not an email address.',
    });
  });
});

describe('a CalDAV calendar', () => {
  test('may be named by its calendar service instead of its own address, never both', () => {
    const service = { server_url: 'https://caldav.example.test/', username: 'owner' };
    const resolved = resolve({ ...caldav, caldav: service });
    expect(resolved.ok && resolved.value.config).toEqual(service);
    const both = createConnectionRequest.safeParse({
      ...caldav,
      caldav: { ...caldav.caldav, server_url: service.server_url },
    });
    expect(both.success ? 'accepted' : connectionRequestProblem(both.error.issues)).toBe(
      'Calendar address: Give either the calendar address or the calendar service address.',
    );
    const plain = createConnectionRequest.safeParse({
      ...caldav,
      caldav: { server_url: 'http://caldav.example.test/', username: 'owner' },
    });
    expect(plain.success).toBe(false);
  });
});

describe('providers whose servers are known', () => {
  const providers = CONNECTION_KIND_DESCRIPTORS.filter((kind) => kind.id !== kind.kind);

  test('ask only for an address and an app password, or a feed address', () => {
    expect(providers.map((kind) => kind.id)).toEqual([
      'gmail',
      'icloud-mail',
      'fastmail',
      'yahoo-mail',
      'icloud-calendar',
      'fastmail-calendar',
      'google-calendar-feed',
    ]);
    for (const kind of providers) {
      const shown = kind.fields.map((field) => field.path).sort();
      expect(shown).toEqual(
        kind.kind === 'ics'
          ? ['ics.url']
          : [`${kind.kind}.username`, 'credentials.password'].sort(),
      );
      expect(kind.fields.find((field) => field.secret)?.help).toBeTruthy();
    }
  });

  test('fill in their servers, so what the person typed becomes a complete installation', () => {
    const typed = (kind: ConnectionKindDescriptor) =>
      kind.kind === 'ics'
        ? { ics: { url: 'https://calendar.google.com/calendar/ical/me/private-x/basic.ics' } }
        : {
            [kind.kind]: { username: 'me@example.test' },
            credentials: { password: 'app-password' },
          };
    const installed = Object.fromEntries(
      providers.map((kind) => {
        const body: Record<string, unknown> = { label: kind.title };
        for (const { path, value } of kind.fixed) {
          const keys = path.split('.');
          let at = body;
          for (const key of keys.slice(0, -1)) {
            at[key] = at[key] ?? {};
            at = at[key] as Record<string, unknown>;
          }
          at[keys.at(-1) as string] = value;
        }
        const extra = typed(kind) as Record<string, Record<string, unknown>>;
        for (const [key, value] of Object.entries(extra))
          body[key] = { ...((body[key] as object) ?? {}), ...value };
        const resolved = connectionInstallation(createConnectionRequest.parse(body));
        if (!resolved.ok) throw new Error(`${kind.id}: ${resolved.error}`);
        return [kind.id, resolved.value.kind === 'mcp' ? null : resolved.value.config];
      }),
    );
    expect(installed.gmail).toEqual({
      username: 'me@example.test',
      from: 'me@example.test',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    });
    // iCloud sends over STARTTLS on 587, which the connector demands before it signs in.
    expect(installed['icloud-mail']).toMatchObject({
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    });
    expect(installed['icloud-calendar']).toEqual({
      server_url: 'https://caldav.icloud.com/',
      username: 'me@example.test',
    });
  });
});
