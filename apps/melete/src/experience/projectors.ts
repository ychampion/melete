import {
  type ActionReview,
  type BecauseLink,
  DEVICE_LIMITS,
  type ExperienceDecision,
  type ExperienceDraft,
  type ExperienceSource,
  experienceDecision,
  experienceDraft,
  experienceReceipt,
  permissionCard,
  type ResultCard,
  resultCard,
  type TrailStep,
} from '@melete/contracts';
import type { action, artifact, connection } from '../db/schema.ts';
import { namesLocalNetwork } from '../devices/paths.ts';

export type ActionRow = Pick<
  typeof action.$inferSelect,
  | 'id'
  | 'jobId'
  | 'attemptId'
  | 'connectionId'
  | 'kind'
  | 'effectClass'
  | 'canonicalPayload'
  | 'receipt'
  | 'status'
  | 'createdAt'
  | 'resolvedAt'
>;
export type ConnectionRow = Pick<typeof connection.$inferSelect, 'id' | 'label' | 'provider'>;
export const object = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
const array = (input: unknown): unknown[] => (Array.isArray(input) ? input : []);
export const BACKEND_VOCABULARY =
  /\b(?:email|calendar|files|web|test)\.[a-z_][\w.-]*|\b(?:canonical_payload|payload_hash|tool_call|model_actual|access_token|refresh_token|chain.of.thought)\b|\b(?:gpt-|claude-|deepseek)[\w.-]*/i;

/** Titles and labels are content, never a channel for an internal record or credential. */
export function plainText(value: unknown, fallback: string, limit = 4000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    BACKEND_VOCABULARY.test(value) ||
    /^[\s]*[[{]/.test(value) ||
    /\b(?:Bearer\s+|sk-[A-Za-z0-9]{12})/.test(value)
  )
    return fallback;
  return value
    .replace(/\p{Cc}/gu, (character) => (['\n', '\r', '\t'].includes(character) ? character : ''))
    .trim()
    .slice(0, limit);
}
/** A whole JSON object or array: an internal record, not something the agent said. */
function isRecord(value: string): boolean {
  const text = value.trim();
  if (!/^[[{]/.test(text)) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Answer text, whole or one streamed piece of it. A piece that merely starts
 * with a bracket ("[your name]", a Markdown link) is prose and is kept.
 */
export function answerText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    BACKEND_VOCABULARY.test(value) ||
    isRecord(value) ||
    /\b(?:Bearer\s+|sk-[A-Za-z0-9]{12})/.test(value)
  )
    return '';
  return value;
}
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || BACKEND_VOCABULARY.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return undefined;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}
export function appName(row: ConnectionRow): string {
  const names: Record<string, string> = {
    caldav: 'Calendar',
    imap: 'Mail',
    files: 'Files',
    web: 'Web',
    test: 'Test connection',
    device: 'Computer',
  };
  return names[row.provider] ?? 'Connected app';
}
const LABELS: Record<string, string> = {
  'calendar.list': 'Checked your calendar',
  'calendar.create': 'Created an event',
  'calendar.update': 'Updated an event',
  'calendar.delete': 'Removed an event',
  'email.search': 'Checked your mail',
  'email.read': 'Read a message',
  'email.draft': 'Prepared a draft',
  'email.send': 'Sent a message',
  'email.discard': 'Discarded a draft',
  'files.list': 'Checked your files',
  'files.read': 'Read a file',
  'files.write': 'Saved a file',
  'files.move': 'Moved a file',
  'files.restore': 'Restored a file',
  'web.fetch': 'Read a web page',
  'test.read': 'Checked the connected app',
  'test.send': 'Sent a message',
};
/** How each connector verb reads while it runs and once it is done. */
export const ACTION_VERBS: Record<string, [doing: string, done: string]> = {
  'calendar.list': ['Checking your calendar', 'Checked your calendar'],
  'calendar.create': ['Adding an event', 'Added an event'],
  'calendar.update': ['Updating an event', 'Updated an event'],
  'calendar.delete': ['Removing an event', 'Removed an event'],
  'email.search': ['Searching your mail', 'Searched your mail'],
  'email.read': ['Reading a message', 'Read a message'],
  'email.draft': ['Drafting a message', 'Drafted a message'],
  'email.send': ['Sending the email', 'Sent the email'],
  'email.discard': ['Discarding a draft', 'Discarded a draft'],
  'files.list': ['Looking through your files', 'Looked through your files'],
  'files.read': ['Reading a file', 'Read a file'],
  'files.write': ['Saving a file', 'Saved a file'],
  'files.move': ['Moving a file', 'Moved a file'],
  'files.restore': ['Restoring a file', 'Restored a file'],
  'web.fetch': ['Reading a web page', 'Read a web page'],
  'exec.run': ['Running a command', 'Ran a command'],
  'exec.python': ['Running code', 'Ran code'],
  'terminal.run': ['Running a command', 'Ran a command'],
  'browser.open': ['Opening a page', 'Opened a page'],
  'browser.observe': ['Looking at the page', 'Looked at the page'],
  'browser.fill': ['Filling in a form', 'Filled in a form'],
  'browser.click': ['Clicking on the page', 'Clicked on the page'],
  'browser.select': ['Choosing an option', 'Chose an option'],
  'browser.read': ['Reading the page', 'Read the page'],
  'browser.submit': ['Submitting a form', 'Submitted a form'],
  'artifact.publish': ['Publishing a file', 'Published a file'],
  'audio.synthesize': ['Making audio', 'Made audio'],
  'test.read': ['Checking the connected app', 'Checked the connected app'],
  'test.send': ['Sending a message', 'Sent a message'],
  'device.status': ['Checking your computer', 'Checked your computer'],
  'device.list_files': [
    'Looking through files on your computer',
    'Looked through files on your computer',
  ],
  'device.read_file': ['Reading a file on your computer', 'Read a file on your computer'],
  'device.write_file': ['Saving a file on your computer', 'Saved a file on your computer'],
  'device.run': ['Running a command on your computer', 'Ran a command on your computer'],
  'device.open_url': ['Opening a page on your computer', 'Opened a page on your computer'],
  'device.screenshot': ['Looking at your screen', 'Looked at your screen'],
  'device.browser_open': ['Opening a page in your browser', 'Opened a page in your browser'],
  'device.browser_read': ['Reading a page in your browser', 'Read a page in your browser'],
  'device.browser_click': ['Clicking in your browser', 'Clicked in your browser'],
  'device.browser_type': [
    'Filling in a field in your browser',
    'Filled in a field in your browser',
  ],
  'device.browser_screenshot': [
    'Looking at a page in your browser',
    'Looked at a page in your browser',
  ],
};
/** What a permission card asks for a connected computer, before anything has run. */
const DEVICE_ASKS: Record<string, string> = {
  'device.run': 'Run a command on your computer',
  'device.write_file': 'Save a file on your computer',
  'device.open_url': 'Open a page on your computer',
  'device.screenshot': 'Look at your screen',
  'device.browser_click': 'Click in your browser',
  'device.browser_type': 'Fill in a field in your browser',
};

/**
 * Characters that change how text around them reads without showing
 * themselves: direction overrides and isolates, zero-width characters, other
 * format characters, and controls apart from newline and tab. On a permission
 * card each is written out as its code point, so what is approved reads the
 * way it will run.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0]/gu;
export function showInvisible(text: string): string {
  return text.replace(INVISIBLE, (char) =>
    char === '\n' || char === '\t'
      ? char
      : `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

/**
 * The exact command, folder, file or page a permission is for, as it will be
 * sent. A command is never longer than this limit (the connector refuses a
 * longer one), so it is always shown whole, with anything invisible in it
 * written out.
 */
/** An element as a person reads it: `button "Delete account"`, and what it shows or leads to when that says more. */
function describeElement(element: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const role = text(element.role) || 'element';
  return [
    `${role} "${text(element.name)}"`,
    ...(text(element.shows) ? [`showing "${text(element.shows)}"`] : []),
    ...(text(element.target) ? [`going to ${text(element.target)}`] : []),
  ].join(', ');
}

function deviceFacts(kind: string, payload: Record<string, unknown>) {
  if (!kind.startsWith('device.')) return [];
  const expected =
    payload.expect && typeof payload.expect === 'object'
      ? (payload.expect as { url?: unknown; title?: unknown; element?: unknown })
      : undefined;
  const element =
    expected?.element && typeof expected.element === 'object'
      ? (expected.element as Record<string, unknown>)
      : undefined;
  const fact = (label: string, value: unknown, limit: number = DEVICE_LIMITS.max_command_chars) =>
    typeof value === 'string' && value.length
      ? [
          {
            label,
            value: showInvisible(value.length > limit ? `${value.slice(0, limit)}…` : value),
          },
        ]
      : [];
  return [
    ...fact('Command', payload.command),
    ...fact('Runs in', payload.cwd),
    ...fact('File', payload.path),
    ...fact('Content', payload.content),
    ...fact('Page', payload.url),
    // A click or an entry names what the person saw in the latest read of the
    // tab: its address without the query, its title, and the element.
    ...fact('Page', expected?.url),
    ...fact('Title', expected?.title),
    ...fact('Element', element ? describeElement(element) : undefined),
    ...fact('Text', payload.text, DEVICE_LIMITS.max_typed_chars),
    ...(payload.submit === true ? [{ label: 'Then', value: 'Press Enter to submit' }] : []),
    ...(namesLocalNetwork(payload.url)
      ? [{ label: 'Network', value: 'This page is on your computer or your local network' }]
      : []),
  ];
}

export function actionLabel(row: ActionRow, connection?: ConnectionRow): string {
  return (
    LABELS[row.kind] ??
    ACTION_VERBS[row.kind]?.[1] ??
    (connection
      ? `Used ${plainText(connection.label, appName(connection), 60)}`
      : 'Completed a step')
  );
}

export function actionSources(row: ActionRow, connection: ConnectionRow): ExperienceSource[] {
  if (row.status !== 'succeeded') return [];
  const detail = object(object(row.receipt).detail);
  const payload = object(row.canonicalPayload);
  const source = (
    kind: ExperienceSource['kind'],
    title: unknown,
    fallback: string,
    address?: unknown,
  ): ExperienceSource => {
    const url = safeUrl(address);
    return {
      app: appName(connection),
      title: plainText(title, fallback),
      kind,
      connection_id: connection.id,
      ...(url ? { url } : {}),
    };
  };
  switch (row.kind) {
    case 'calendar.list':
      return array(detail.events).map((item) =>
        source('event', object(item).summary, 'Calendar event', object(item).url),
      );
    case 'calendar.create':
    case 'calendar.update':
    case 'calendar.delete':
      return [source('event', payload.summary ?? detail.summary, 'Calendar event')];
    case 'email.search':
      return array(detail.messages).map((item) =>
        source('message', object(item).subject, 'Message'),
      );
    case 'email.read':
      return [source('message', object(detail.message).subject, 'Message')];
    case 'email.draft':
      return [source('draft', payload.subject, 'Draft')];
    case 'email.send':
      return [source('message', payload.subject, 'Sent message')];
    case 'files.list':
      return array(detail.entries)
        .filter((item) => object(item).kind === 'file')
        .map((item) => source('file', object(item).name, 'File'));
    case 'files.read':
    case 'files.write':
    case 'files.move':
    case 'files.restore':
      return [source('file', filename(detail.path ?? detail.to ?? payload.path), 'File')];
    case 'web.fetch':
      return [
        source(
          'page',
          pageTitle(detail) ?? safeUrl(detail.final_url ?? detail.url),
          'Web page',
          detail.final_url ?? detail.url,
        ),
      ];
    default:
      return [];
  }
}
const filename = (value: unknown) =>
  typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() : undefined;
/** A read page names its title; a receipt from before that carries the page itself. */
const pageTitle = (detail: Record<string, unknown>) =>
  typeof detail.title === 'string' && detail.title.trim()
    ? detail.title
    : typeof detail.body === 'string'
      ? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(detail.body)?.[1]?.replace(/&amp;/g, '&')
      : undefined;

export function projectActionGroup(
  rows: Array<{ action: ActionRow; connection: ConnectionRow }>,
): Extract<TrailStep, { type: 'action' }> | null {
  const succeeded = rows.filter(({ action }) => action.status === 'succeeded');
  if (!succeeded.length) return null;
  const labels = [
    ...new Set(succeeded.map(({ action, connection }) => actionLabel(action, connection))),
  ];
  const sources = succeeded.flatMap(({ action, connection }) => actionSources(action, connection));
  return {
    type: 'action',
    label: labels.join(', '),
    meta: `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`,
    sources,
  };
}

export function projectReceipt(
  row: ActionRow,
  connection: ConnectionRow,
  undo?: { handle: string; valid_until: string },
  review?: ActionReview | null,
  because?: BecauseLink[],
) {
  if (
    row.status !== 'succeeded' ||
    !['write_external', 'write_reversible', 'spend'].includes(row.effectClass) ||
    !row.receipt
  )
    return null;
  return experienceReceipt.parse({
    id: row.id,
    what: actionLabel(row),
    where: plainText(connection.label, appName(connection)),
    when: row.resolvedAt?.toISOString() ?? row.createdAt.toISOString(),
    ...(undo ? { undo } : {}),
    // Only an approval auto-review gave is shown here; an escalation was the person's call.
    ...(review?.outcome === 'auto_approved' ? { review } : {}),
    ...(because?.length ? { because } : {}),
  });
}

/**
 * A prepared draft the person can still send carries the send action, keyed by
 * the draft's id, which is what the send route takes. One already sent, waiting
 * on a decision, discarded, or unreadable in full has none.
 */
function sendAction(row: ActionRow, draft: ExperienceDraft['status'] | undefined) {
  if (row.kind !== 'email.draft' || row.status !== 'succeeded') return null;
  if (draft !== 'draft' && draft !== 'denied') return null;
  if (!draftForReview(row)) return null;
  return { kind: 'send' as const, label: 'Review and send', handle: row.id };
}

/** `draft` is the draft's status when the action prepared one; a fresh draft is `draft`. */
export function projectCards(
  row: ActionRow,
  connection: ConnectionRow,
  draft?: ExperienceDraft['status'],
): ResultCard[] {
  const send = sendAction(row, draft);
  const sources = actionSources(row, connection);
  const payload = object(row.canonicalPayload);
  const detail = object(object(row.receipt).detail);
  return sources.map((source, index) => {
    const event = row.kind === 'calendar.list' ? object(array(detail.events)[index]) : payload;
    const facts: Array<{ label: string; value: string }> = [];
    if (source.kind === 'event')
      for (const [field, label] of [
        ['start', 'Starts'],
        ['end', 'Ends'],
        ['location', 'Place'],
      ] as const) {
        const value = plainText(event[field], '');
        if (value) facts.push({ label, value });
      }
    if (source.kind === 'draft') facts.push({ label: 'To', value: recipientText(payload) });
    return resultCard.parse({
      id: `${row.id}:${index}`,
      title: source.title,
      meta: source.app,
      facts,
      primary_action: source.url
        ? { kind: 'open', label: 'Open', handle: `${row.id}:${index}`, url: source.url }
        : source.kind === 'draft'
          ? send
          : null,
      secondary_actions: [],
      source_connection: connection.id,
    });
  });
}
export function recipientText(payload: Record<string, unknown>): string {
  const raw = payload.to ?? payload.recipient;
  return plainText(Array.isArray(raw) ? raw.join(', ') : raw, 'The selected recipient');
}
export function projectArtifact(row: typeof artifact.$inferSelect): ResultCard {
  return resultCard.parse({
    id: row.id,
    title: plainText(filename(row.path), 'File'),
    meta: 'File',
    facts: [{ label: 'Size', value: `${row.size} bytes` }],
    primary_action: null,
    secondary_actions: [],
    source_connection: null,
  });
}
/** Approval must show the exact recipients and complete body, without hiding unsafe content. */
export function draftForReview(row: ActionRow) {
  const payload = object(row.canonicalPayload);
  const addresses = (value: unknown) =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? (value as string[])
        : [];
  const to = addresses(payload.to);
  const cc = addresses(payload.cc);
  const bcc = addresses(payload.bcc);
  const safe = (value: unknown, limit: number) =>
    typeof value === 'string' &&
    value.length <= limit &&
    (!value || plainText(value, '', limit) === value.trim());
  if (
    !to.length ||
    ![...to, ...cc, ...bcc].every((value) => safe(value, 4000)) ||
    !safe(payload.body, 100000) ||
    !safe(payload.subject, 1000) ||
    ![to, cc, bcc].every((addresses) => safe(addresses.join(', '), 4000))
  )
    return null;
  const parsed = experienceDraft.safeParse({
    id: row.id,
    recipient: to.join(', '),
    channel: 'email',
    body: payload.body,
    subject: payload.subject,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    connection_id: row.connectionId,
    status: 'draft',
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The address a message would leave from, read off the connection it would
 * leave through.
 *
 * It is not part of the message payload — a send names only its recipients, and
 * the mailbox is a property of the connection — so a person cannot see it in
 * the words they are approving unless it is put there. Someone with two
 * mailboxes connected is being asked a different question depending on which
 * one this is, and they should be able to tell which.
 *
 * Unknown is unknown: an operator-configured mailbox keeps its address in the
 * environment rather than on the row, and nothing is invented to fill the gap.
 */
export function senderAddress(configuration: unknown): string | null {
  const stored = object(configuration);
  const value = object(stored.mail).from ?? stored.from;
  if (typeof value !== 'string' || !value.trim()) return null;
  // Held to the same bar as the recipients beside it: shown exactly, or not at
  // all. A fallback string in this row would read as an address and not be one.
  return plainText(value, '', 4000) === value.trim() ? value.trim() : null;
}

/** The note on a permission a later message in its conversation made stale. */
export const SUPERSEDED_NOTE = 'replaced';

/**
 * A decided permission as the conversation shows it. An approval that saved a
 * standing rule was "always"; any other approval was this once.
 */
export function projectPermissionDecision(input: {
  approvalId: string;
  decision: unknown;
  ruleSaved: boolean;
  /** Why it was decided, when the service decided it rather than the person. */
  note?: unknown;
  at: Date;
}): ExperienceDecision {
  return experienceDecision.parse({
    kind: 'permission',
    id: input.approvalId,
    outcome:
      input.decision === 'denied'
        ? input.note === SUPERSEDED_NOTE
          ? 'replaced'
          : 'deny'
        : input.ruleSaved
          ? 'always'
          : 'allow_once',
    answer: null,
    decided_at: input.at.toISOString(),
  });
}

/** A closed question: answered with the chosen text, or withdrawn by another input. */
export function projectQuestionDecision(input: {
  questionId: string;
  state: unknown;
  answer: string | null;
  at: Date;
}): ExperienceDecision {
  const answered = input.state === 'answered';
  return experienceDecision.parse({
    kind: 'question',
    id: input.questionId,
    outcome: answered ? 'answered' : 'withdrawn',
    answer: answered && input.answer ? plainText(input.answer, '', 4000) || null : null,
    decided_at: input.at.toISOString(),
  });
}

export function projectPermission(input: {
  id: string;
  version: string;
  action: ActionRow;
  connection: ConnectionRow & { sender?: string | null };
  reasons: string[];
  canAlways: boolean;
  /** When permission was asked for. */
  requestedAt: Date;
  /** Why auto-review sent this to the person, when it looked first. */
  review?: ActionReview | null;
  /** The beliefs the action rested on, when any were recorded. */
  because?: BecauseLink[];
}) {
  const payload = object(input.action.canonicalPayload);
  const isSend = input.action.kind.endsWith('.send');
  const draft = isSend ? draftForReview(input.action) : null;
  const canApprove = !isSend || Boolean(draft);
  const base = actionLabel(input.action)
    .replace(/^Sent /, 'Send ')
    .replace(/^Created /, 'Create ')
    .replace(/^Updated /, 'Update ')
    .replace(/^Removed /, 'Remove ');
  const what = input.action.kind.endsWith('.send')
    ? `${base} to ${recipientText(payload)}`
    : (DEVICE_ASKS[input.action.kind] ?? base);
  const facts = [
    ...deviceFacts(input.action.kind, payload),
    ...(draft
      ? [
          ...(input.connection.sender ? [{ label: 'From', value: input.connection.sender }] : []),
          { label: 'To', value: draft.recipient },
          ...(draft.cc?.length ? [{ label: 'Cc', value: draft.cc.join(', ') }] : []),
          ...(draft.bcc?.length ? [{ label: 'Bcc', value: draft.bcc.join(', ') }] : []),
        ]
      : []),
    ...(typeof payload.subject === 'string'
      ? [{ label: 'Subject', value: plainText(payload.subject, 'Message') }]
      : []),
    ...(typeof payload.body === 'string'
      ? [
          {
            label:
              typeof payload.body === 'string' && payload.body.length > 4000
                ? 'Message preview'
                : 'Message',
            value: plainText(payload.body, 'Message content is not available for preview.'),
          },
        ]
      : []),
    ...(typeof payload.summary === 'string'
      ? [{ label: 'Event', value: plainText(payload.summary, 'Event') }]
      : []),
    ...(['start', 'end', 'location'] as const).flatMap((key) =>
      typeof payload[key] === 'string'
        ? [
            {
              label: key === 'start' ? 'Starts' : key === 'end' ? 'Ends' : 'Place',
              value: plainText(payload[key], 'Not specified'),
            },
          ]
        : [],
    ),
  ];
  return permissionCard.parse({
    id: input.id,
    conversation_id: input.action.jobId,
    what,
    why: canApprove
      ? input.reasons
      : [
          ...input.reasons,
          'The full message cannot be shown safely. Prepare a new draft before sending.',
        ],
    ...(draft ? { draft } : {}),
    options: !canApprove
      ? ['deny']
      : input.canAlways
        ? ['allow_once', 'always', 'deny']
        : ['allow_once', 'deny'],
    version: input.version,
    ...(input.review?.outcome === 'escalated' ? { review: input.review } : {}),
    created_at: input.requestedAt.toISOString(),
    ...(input.because?.length ? { because: input.because } : {}),
    preview: {
      id: input.id,
      title: what,
      meta: appName(input.connection),
      facts,
      primary_action: null,
      secondary_actions: [],
      source_connection: input.connection.id,
    },
  });
}
