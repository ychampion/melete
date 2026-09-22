/**
 * Connections a person installs through the API.
 *
 * Each credentialed kind has its own validated configuration and its own
 * credential shape. A request carries exactly one configuration block; the
 * service seals what is secret on arrival and no response carries it back. The
 * descriptors at the end of this file say which fields a kind needs, so a
 * client can draw its form from the contract instead of knowing the kinds.
 */
import { z } from 'zod';
import { effectClass } from './broker.ts';
import { err, ID_PREFIXES, ok, prefixedId, type Result, timestamp } from './common.ts';
import { connectionProvider, connectionView } from './entities.ts';
import { mcpConnectionConfig } from './mcp.ts';

export const CONNECTION_KINDS = ['mail', 'caldav', 'ics', 'mcp'] as const;
export const connectionKind = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof connectionKind>;

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];
const singleLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]*$/);

/** TLS everywhere; plain HTTP only reaches a loopback fixture. */
const secureUrl = (protocols: readonly string[]) =>
  z
    .url()
    .max(2048)
    .refine((value) => {
      // The format check above has already refused what is not an address.
      if (!URL.canParse(value)) return true;
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        (protocols.includes(url.protocol) ||
          (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))
      );
    }, 'The address must use TLS and carry no credentials or fragment');

/**
 * A function rather than one shared schema: each endpoint is its own instance,
 * so the generated API document inlines it instead of hoisting a shared entry.
 */
const mailEndpoint = () =>
  z
    .object({
      host: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[A-Za-z0-9._:-]+$/),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
    })
    .strict();

/** One mailbox: IMAP to read and SMTP to send, under the same account. */
export const mailConnectionConfig = z
  .object({
    username: singleLine(320),
    from: z.email().max(320),
    imap: mailEndpoint(),
    smtp: mailEndpoint(),
    inbox: singleLine(200).optional(),
    sent: singleLine(200).optional(),
  })
  .strict();
export type MailConnectionConfig = z.infer<typeof mailConnectionConfig>;
/** As installed: the sender may be left out when the account name is an address. */
const mailConnectionRequest = mailConnectionConfig.extend({
  from: z.email().max(320).optional(),
});

export const passwordCredentials = z.object({ password: z.string().min(1).max(1024) }).strict();
export type PasswordCredentials = z.infer<typeof passwordCredentials>;

export const caldavConnectionConfig = z
  .object({
    calendar_url: secureUrl(['https:']).refine(
      (value) => !URL.canParse(value) || !new URL(value).search,
      'A calendar collection address carries no query string',
    ),
    username: singleLine(320),
  })
  .strict();
export type CaldavConnectionConfig = z.infer<typeof caldavConnectionConfig>;
/**
 * As installed: one calendar's own address, or the address of the calendar
 * service, from which the service finds the account's first calendar of events.
 */
const caldavConnectionRequest = caldavConnectionConfig
  .extend({
    calendar_url: caldavConnectionConfig.shape.calendar_url.optional(),
    server_url: secureUrl(['https:']).optional(),
  })
  .refine((value) => (value.calendar_url === undefined) !== (value.server_url === undefined), {
    message: 'Give either the calendar address or the calendar service address.',
    path: ['calendar_url'],
  });
export type CaldavConnectionRequest = z.infer<typeof caldavConnectionRequest>;

/**
 * A read-only calendar feed. The address usually embeds a private token, so
 * the whole address is sealed like a password and never returned.
 */
export const icsConnectionConfig = z
  .object({
    url: secureUrl(['https:', 'webcal:']).transform((value) =>
      value.replace(/^webcal:/i, 'https:'),
    ),
  })
  .strict();
export type IcsConnectionConfig = z.infer<typeof icsConnectionConfig>;

/** The grants each kind may receive. MCP grants are declared in its own operator policy. */
export const CONNECTION_KIND_SCOPES = {
  mail: ['email.search', 'email.read', 'email.draft', 'email.send'],
  caldav: ['calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete'],
  ics: ['calendar.list'],
} as const satisfies Record<Exclude<ConnectionKind, 'mcp'>, readonly string[]>;

export const createConnectionRequest = z.object({
  /** Left out, the space of the signed-in session. */
  space_id: prefixedId(ID_PREFIXES.space).optional(),
  provider: connectionProvider,
  label: z.string().min(1).max(120),
  /** Left empty, every grant the kind offers. An MCP installation declares its grants in `mcp`. */
  scopes: z.array(z.string()).default([]),
  /**
   * Sealed with the master key on arrival and never returned. Mail and CalDAV
   * take `password`; MCP takes its token fields; a calendar feed takes none.
   */
  credentials: z.record(z.string(), z.string()).optional(),
  mcp: mcpConnectionConfig.optional(),
  mail: mailConnectionRequest.optional(),
  caldav: caldavConnectionRequest.optional(),
  ics: icsConnectionConfig.optional(),
});
export type CreateConnectionRequest = z.infer<typeof createConnectionRequest>;

export type ConnectionInstallation =
  | {
      kind: 'mail';
      provider: 'imap';
      config: MailConnectionConfig;
      credentials: PasswordCredentials;
      scopes: string[];
    }
  | {
      kind: 'caldav';
      provider: 'caldav';
      /** With `server_url`, the calendar is found before anything is stored. */
      config: CaldavConnectionRequest;
      credentials: PasswordCredentials;
      scopes: string[];
    }
  | { kind: 'ics'; provider: 'caldav'; config: IcsConnectionConfig; scopes: string[] }
  | {
      kind: 'mcp';
      provider: 'mcp';
      config: z.infer<typeof mcpConnectionConfig>;
      credentials: Record<string, string> | undefined;
    };

const KIND_PROVIDER = { mail: 'imap', caldav: 'caldav', ics: 'caldav', mcp: 'mcp' } as const;

/** Decide which kind a parsed request installs, or say in plain words why it installs none. */
export function connectionInstallation(
  request: CreateConnectionRequest,
): Result<ConnectionInstallation, string> {
  const present = CONNECTION_KINDS.filter((kind) => request[kind] !== undefined);
  const [kind] = present;
  if (present.length !== 1 || !kind) return err('Supply exactly one of mail, caldav, ics or mcp.');
  if (request.provider !== KIND_PROVIDER[kind])
    return err(`A ${kind} connection uses the ${KIND_PROVIDER[kind]} provider.`);
  if (kind === 'mcp') {
    if (!request.mcp || request.scopes.length)
      return err('Supply MCP endpoint and operator policy in mcp.');
    return ok({ kind, provider: 'mcp', config: request.mcp, credentials: request.credentials });
  }
  const allowed: readonly string[] = CONNECTION_KIND_SCOPES[kind];
  if (
    !request.scopes.every((scope) => allowed.includes(scope)) ||
    new Set(request.scopes).size !== request.scopes.length
  )
    return err(`A ${kind} connection grants only: ${allowed.join(', ')}.`);
  const scopes = request.scopes.length ? request.scopes : [...allowed];
  if (kind === 'ics') {
    if (!request.ics || request.credentials)
      return err('A calendar feed takes its address and no other credential.');
    return ok({ kind, provider: 'caldav', config: request.ics, scopes });
  }
  const credentials = passwordCredentials.safeParse(request.credentials);
  if (!credentials.success) return err(`A ${kind} connection needs credentials.password only.`);
  if (kind === 'mail' && request.mail) {
    const from = request.mail.from ?? request.mail.username;
    if (!z.email().safeParse(from).success)
      return err('Send as is needed when the account name is not an email address.');
    return ok({
      kind,
      provider: 'imap',
      config: { ...request.mail, from },
      credentials: credentials.data,
      scopes,
    });
  }
  if (kind === 'caldav' && request.caldav)
    return ok({
      kind,
      provider: 'caldav',
      config: request.caldav,
      credentials: credentials.data,
      scopes,
    });
  return err('Supply exactly one of mail, caldav, ics or mcp.');
}

/**
 * The outcome of testing a connection. The code is one of a fixed set and the
 * detail is the sentence that belongs to that code, so a check can never carry
 * a transport message, an address or a credential back to the caller.
 */
export const CONNECTION_CHECK_CODES = [
  'ok',
  'degraded',
  'unavailable',
  'not_running',
  'revoked',
] as const;
export const connectionCheckCode = z.enum(CONNECTION_CHECK_CODES);
export type ConnectionCheckCode = z.infer<typeof connectionCheckCode>;

export const CONNECTION_CHECK_DETAIL: Record<ConnectionCheckCode, string> = {
  ok: 'The connection answered.',
  degraded: 'The connection answered with a warning.',
  unavailable:
    'The destination could not be reached or refused the credential. Check the address, the account and the password.',
  not_running:
    'This connection has no running connector. Check the master key and the service log, then test again.',
  revoked: 'This connection was removed and can no longer be used.',
};

export const connectionCheck = z
  .object({
    status: z.enum(['ok', 'degraded', 'failing']),
    code: connectionCheckCode,
    detail: z.string().max(240),
    checked_at: timestamp,
  })
  .meta({ id: 'ConnectionCheck' });
export type ConnectionCheck = z.infer<typeof connectionCheck>;

export const connectionListResponse = z.object({ connections: z.array(connectionView) });
/** Installing a connection tests it once, and says how that went. */
export const connectionResponse = z.object({
  connection: connectionView,
  check: connectionCheck.optional(),
});
export const connectionCheckResponse = z.object({
  connection: connectionView,
  check: connectionCheck,
});

// --------------------------------------------------------------------------
// what a form needs to know about each kind
// --------------------------------------------------------------------------

const formValue = z.union([z.string(), z.number(), z.boolean()]);
const formInput = z.enum([
  'text',
  'email',
  'url',
  'number',
  'password',
  'checkbox',
  'select',
  'string_list',
]);
const formFieldShape = {
  /** Where the value goes in the create request, as a dotted path. Inside a list, relative to the row. */
  path: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  help: z.string().max(240).optional(),
  required: z.boolean(),
  /** Sealed on arrival and never shown again. */
  secret: z.boolean(),
  placeholder: z.string().max(120).optional(),
  default: formValue.optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
};
const formItemField = z.object({ ...formFieldShape, input: formInput });
export type ConnectionFormItemField = z.infer<typeof formItemField>;
export const connectionFormField = z
  .object({
    ...formFieldShape,
    input: z.union([formInput, z.literal('list')]),
    /** The fields of one row when `input` is `list`. */
    item_fields: z.array(formItemField).optional(),
  })
  .meta({ id: 'ConnectionFormField' });
export type ConnectionFormField = z.infer<typeof connectionFormField>;

export const connectionKindDescriptor = z
  .object({
    /**
     * Names this entry. A kind can appear more than once: a provider's entry
     * fixes its servers so the person gives only an address and an app password.
     */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: connectionKind,
    title: z.string(),
    description: z.string(),
    /** Values the request always carries for this kind; never shown as inputs. */
    fixed: z.array(z.object({ path: z.string(), value: formValue })),
    fields: z.array(connectionFormField),
    /** Grants a person may untick. Empty when the kind declares its grants in its own fields. */
    scopes: z.array(
      z.object({
        scope: z.string(),
        label: z.string(),
        effect_class: effectClass,
        /** True when every use waits for the person's approval. */
        asks_first: z.boolean(),
        default: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ConnectionKind' });
export type ConnectionKindDescriptor = z.infer<typeof connectionKindDescriptor>;
export const connectionKindListResponse = z.object({ kinds: z.array(connectionKindDescriptor) });

const text = (
  path: string,
  label: string,
  extra: Partial<ConnectionFormItemField> = {},
): ConnectionFormItemField => ({
  path,
  label,
  input: 'text',
  required: true,
  secret: false,
  ...extra,
});
const EFFECT_OPTIONS = [
  { value: 'read', label: 'Reads only' },
  { value: 'write_reversible', label: 'Changes that can be undone' },
  { value: 'write_external', label: 'Changes elsewhere (asks first)' },
  { value: 'spend', label: 'Spends money (asks first)' },
];

type KindScopes = ConnectionKindDescriptor['scopes'];
const MAIL_SCOPES: KindScopes = [
  {
    scope: 'email.search',
    label: 'Search the mailbox',
    effect_class: 'read',
    asks_first: false,
    default: true,
  },
  {
    scope: 'email.read',
    label: 'Read a message',
    effect_class: 'read',
    asks_first: false,
    default: true,
  },
  {
    scope: 'email.draft',
    label: 'Prepare a draft',
    effect_class: 'write_reversible',
    asks_first: false,
    default: true,
  },
  {
    scope: 'email.send',
    label: 'Send a message',
    effect_class: 'write_external',
    asks_first: true,
    default: true,
  },
];
const CALDAV_SCOPES: KindScopes = [
  {
    scope: 'calendar.list',
    label: 'List events',
    effect_class: 'read',
    asks_first: false,
    default: true,
  },
  {
    scope: 'calendar.create',
    label: 'Create an event',
    effect_class: 'write_external',
    asks_first: true,
    default: true,
  },
  {
    scope: 'calendar.update',
    label: 'Change an event',
    effect_class: 'write_external',
    asks_first: true,
    default: true,
  },
  {
    scope: 'calendar.delete',
    label: 'Remove an event',
    effect_class: 'write_external',
    asks_first: true,
    default: true,
  },
];
const FEED_SCOPES: KindScopes = CALDAV_SCOPES.filter((scope) => scope.scope === 'calendar.list');

/** A mailbox whose servers are known: the person gives the address and an app password. */
const mailProvider = (
  id: string,
  title: string,
  imap: [host: string, port: number, secure: boolean],
  smtp: [host: string, port: number, secure: boolean],
  passwordHelp: string,
): ConnectionKindDescriptor => ({
  id,
  kind: 'mail',
  title,
  description: `Read, search and draft in ${title}, and send after you approve each message.`,
  fixed: [
    { path: 'provider', value: 'imap' },
    { path: 'mail.imap.host', value: imap[0] },
    { path: 'mail.imap.port', value: imap[1] },
    { path: 'mail.imap.secure', value: imap[2] },
    { path: 'mail.smtp.host', value: smtp[0] },
    { path: 'mail.smtp.port', value: smtp[1] },
    { path: 'mail.smtp.secure', value: smtp[2] },
  ],
  fields: [
    text('mail.username', 'Email address', { input: 'email', placeholder: 'you@example.com' }),
    text('credentials.password', 'App password', {
      input: 'password',
      secret: true,
      help: passwordHelp,
    }),
  ],
  scopes: MAIL_SCOPES,
});

/** A calendar service that finds the account's calendar from the address and an app password. */
const calendarProvider = (
  id: string,
  title: string,
  serverUrl: string,
  passwordHelp: string,
): ConnectionKindDescriptor => ({
  id,
  kind: 'caldav',
  title,
  description: `List the events of your ${title}, and create, change or remove an event after you approve it.`,
  fixed: [
    { path: 'provider', value: 'caldav' },
    { path: 'caldav.server_url', value: serverUrl },
  ],
  fields: [
    text('caldav.username', 'Email address', { input: 'email', placeholder: 'you@example.com' }),
    text('credentials.password', 'App password', {
      input: 'password',
      secret: true,
      help: passwordHelp,
    }),
  ],
  scopes: CALDAV_SCOPES,
});

/**
 * What `GET /connection-kinds` serves, in the order a person reads it: the
 * providers whose servers are known first, then each kind for any other server.
 */
export const CONNECTION_KIND_DESCRIPTORS: ConnectionKindDescriptor[] = [
  mailProvider(
    'gmail',
    'Gmail',
    ['imap.gmail.com', 993, true],
    ['smtp.gmail.com', 465, true],
    'Create one at myaccount.google.com/apppasswords. Google asks for 2-Step Verification first.',
  ),
  mailProvider(
    'icloud-mail',
    'iCloud Mail',
    ['imap.mail.me.com', 993, true],
    ['smtp.mail.me.com', 587, false],
    'Create an app-specific password at account.apple.com, under Sign-In and Security.',
  ),
  mailProvider(
    'fastmail',
    'Fastmail',
    ['imap.fastmail.com', 993, true],
    ['smtp.fastmail.com', 465, true],
    'Create one in Fastmail under Settings, then Privacy and Security.',
  ),
  mailProvider(
    'yahoo-mail',
    'Yahoo Mail',
    ['imap.mail.yahoo.com', 993, true],
    ['smtp.mail.yahoo.com', 465, true],
    'Create one in your Yahoo account under Account security.',
  ),
  {
    id: 'mail',
    kind: 'mail',
    title: 'Other mail (IMAP)',
    description:
      'Read and search one mailbox over IMAP, prepare drafts, and send over SMTP after you approve each message.',
    fixed: [{ path: 'provider', value: 'imap' }],
    fields: [
      text('mail.username', 'Account name', { placeholder: 'you@example.com' }),
      text('mail.from', 'Send as', {
        input: 'email',
        required: false,
        placeholder: 'you@example.com',
        help: 'Left empty, the account name, when that is an email address.',
      }),
      text('credentials.password', 'Password', {
        input: 'password',
        secret: true,
        help: 'An app password where the provider offers one.',
      }),
      text('mail.imap.host', 'IMAP server', { placeholder: 'imap.example.com' }),
      text('mail.imap.port', 'IMAP port', { input: 'number', default: 993 }),
      text('mail.imap.secure', 'IMAP uses TLS from the first byte', {
        input: 'checkbox',
        default: true,
        help: 'Off means the connection upgrades with STARTTLS.',
      }),
      text('mail.smtp.host', 'SMTP server', { placeholder: 'smtp.example.com' }),
      text('mail.smtp.port', 'SMTP port', { input: 'number', default: 465 }),
      text('mail.smtp.secure', 'SMTP uses TLS from the first byte', {
        input: 'checkbox',
        default: true,
        help: 'Off means the connection upgrades with STARTTLS.',
      }),
      text('mail.inbox', 'Inbox folder', { required: false, placeholder: 'INBOX' }),
      text('mail.sent', 'Sent folder', { required: false, placeholder: 'Sent' }),
    ],
    scopes: MAIL_SCOPES,
  },
  calendarProvider(
    'icloud-calendar',
    'iCloud Calendar',
    'https://caldav.icloud.com/',
    'Create an app-specific password at account.apple.com, under Sign-In and Security.',
  ),
  calendarProvider(
    'fastmail-calendar',
    'Fastmail Calendar',
    'https://caldav.fastmail.com/',
    'Create one in Fastmail under Settings, then Privacy and Security.',
  ),
  {
    id: 'google-calendar-feed',
    kind: 'ics',
    title: 'Google Calendar (read only)',
    description:
      'Read the events of a Google calendar through its private address. A feed can be read but never changed.',
    fixed: [{ path: 'provider', value: 'caldav' }],
    fields: [
      text('ics.url', 'Secret address in iCal format', {
        input: 'url',
        secret: true,
        placeholder: 'https://calendar.google.com/calendar/ical/.../basic.ics',
        help: 'In Google Calendar settings, open the calendar and copy its secret address in iCal format.',
      }),
    ],
    scopes: FEED_SCOPES,
  },
  {
    id: 'caldav',
    kind: 'caldav',
    title: 'Other calendar (CalDAV)',
    description:
      'List the events of one calendar collection, and create, change or remove an event after you approve it.',
    fixed: [{ path: 'provider', value: 'caldav' }],
    fields: [
      text('caldav.calendar_url', 'Calendar address', {
        input: 'url',
        placeholder: 'https://dav.example.com/calendars/you/personal/',
        help: 'The address of one calendar collection, over HTTPS.',
      }),
      text('caldav.username', 'Account name'),
      text('credentials.password', 'Password', { input: 'password', secret: true }),
    ],
    scopes: CALDAV_SCOPES,
  },
  {
    id: 'ics',
    kind: 'ics',
    title: 'Calendar feed (ICS)',
    description: 'Read the events of a published calendar feed. A feed can never be changed.',
    fixed: [{ path: 'provider', value: 'caldav' }],
    fields: [
      text('ics.url', 'Feed address', {
        input: 'url',
        secret: true,
        placeholder: 'https://calendar.example.com/feed.ics',
        help: 'Kept like a password, because a private feed address is one.',
      }),
    ],
    scopes: FEED_SCOPES,
  },
  {
    id: 'mcp',
    kind: 'mcp',
    title: 'MCP server (HTTP)',
    description:
      'Expose named tools of an MCP server you operate. You choose each tool, its grant and how far it may act; the server cannot.',
    fixed: [
      { path: 'provider', value: 'mcp' },
      { path: 'mcp.audience', value: 'owner' },
    ],
    fields: [
      text('mcp.id', 'Short name', {
        placeholder: 'notes',
        help: 'Lower-case letters, digits and underscores. Tools appear as mcp_<name>.<alias>.',
      }),
      text('mcp.url', 'Server address', {
        input: 'url',
        placeholder: 'https://mcp.example.com/mcp',
      }),
      text('credentials.access_token', 'Access token', {
        input: 'password',
        secret: true,
        required: false,
        help: 'Only sent over HTTPS.',
      }),
      text('mcp.allowed_scopes', 'Grants', {
        input: 'string_list',
        placeholder: 'mcp_notes.search',
        help: 'One per tool, written mcp_<name>.<alias>.',
      }),
      {
        path: 'mcp.tools',
        label: 'Tools',
        input: 'list',
        required: true,
        secret: false,
        item_fields: [
          text('name', 'Tool name on the server', { placeholder: 'search' }),
          text('alias', 'Alias', { placeholder: 'search' }),
          text('required_scopes', 'Grants it needs', {
            input: 'string_list',
            placeholder: 'mcp_notes.search',
          }),
          text('effect_class', 'How far it may act', {
            input: 'select',
            options: EFFECT_OPTIONS,
            default: 'write_external',
          }),
        ],
      },
    ],
    scopes: [],
  },
];

// --------------------------------------------------------------------------
// saying why a request was refused
// --------------------------------------------------------------------------

type RequestIssue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  origin?: string;
  format?: string;
};

/** The generic entries come last, so their labels win over a provider's. */
const FIELD_LABELS: ReadonlyMap<string, string> = new Map(
  [
    ...CONNECTION_KIND_DESCRIPTORS.filter((kind) => kind.id !== kind.kind),
    ...CONNECTION_KIND_DESCRIPTORS.filter((kind) => kind.id === kind.kind),
  ].flatMap((kind) => kind.fields.map((field) => [field.path, field.label] as const)),
);
const ITEM_LABELS: ReadonlyMap<string, { label: string; items: Map<string, string> }> = new Map(
  CONNECTION_KIND_DESCRIPTORS.flatMap((kind) =>
    kind.fields
      .filter((field) => field.input === 'list')
      .map(
        (field) =>
          [
            field.path,
            {
              label: field.label,
              items: new Map((field.item_fields ?? []).map((item) => [item.path, item.label])),
            },
          ] as const,
      ),
  ),
);

/** The form's own name for a field, so the person can find it; a row in a list by its position. */
function fieldLabel(path: readonly PropertyKey[]): string {
  const parts = path.map(String);
  for (let at = parts.length; at > 0; at--) {
    const head = parts.slice(0, at).join('.');
    const list = ITEM_LABELS.get(head);
    const row = Number(parts[at]);
    if (list && Number.isInteger(row)) {
      const item = list.items.get(parts.slice(at + 1).join('.'));
      return item ? `${list.label}, row ${row + 1}: ${item}` : `${list.label}, row ${row + 1}`;
    }
    const label = FIELD_LABELS.get(head);
    if (label && at === parts.length) return label;
  }
  return parts.length ? `The setting ${parts.join('.')}` : 'The request';
}

function problem(issue: RequestIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return /received undefined/.test(issue.message) ? 'is needed' : 'has the wrong kind of value';
    case 'too_big':
      return issue.origin === 'string'
        ? 'is too long'
        : issue.origin === 'array'
          ? 'has too many entries'
          : 'is too large';
    case 'too_small':
      return issue.origin === 'string'
        ? 'is needed'
        : issue.origin === 'array'
          ? 'needs at least one entry'
          : 'is too small';
    case 'invalid_format':
      return issue.format === 'email'
        ? 'is not an email address'
        : issue.format === 'url'
          ? 'is not a web address'
          : 'has characters it cannot contain';
    case 'unrecognized_keys':
      return 'has a setting this kind does not take';
    default:
      return 'is not valid';
  }
}

/**
 * One sentence a person can act on, naming the field as the form labels it.
 * Only the service's own words are used, never a value from the request, so a
 * password typed into the wrong box cannot come back in an error.
 */
export function connectionRequestProblem(issues: readonly RequestIssue[]): string {
  const [first] = issues;
  if (!first) return 'The request could not be read.';
  const label = fieldLabel(first.path);
  if (first.code === 'custom') return `${label}: ${first.message.replace(/\.?$/, '.')}`;
  return `${label} ${problem(first)}.`;
}
