import {
  type ExperienceDecision,
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
export function answerText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    BACKEND_VOCABULARY.test(value) ||
    /^[\s]*[[{]/.test(value) ||
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
};
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
          pageTitle(detail.body) ?? safeUrl(detail.final_url ?? detail.url),
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
const pageTitle = (value: unknown) =>
  typeof value === 'string'
    ? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(value)?.[1]?.replace(/&amp;/g, '&')
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
  });
}

export function projectCards(row: ActionRow, connection: ConnectionRow): ResultCard[] {
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

/**
 * A decided permission as the conversation shows it. An approval that saved a
 * standing rule was "always"; any other approval was this once.
 */
export function projectPermissionDecision(input: {
  approvalId: string;
  decision: unknown;
  ruleSaved: boolean;
  at: Date;
}): ExperienceDecision {
  return experienceDecision.parse({
    kind: 'permission',
    id: input.approvalId,
    outcome: input.decision === 'denied' ? 'deny' : input.ruleSaved ? 'always' : 'allow_once',
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
  const what = input.action.kind.endsWith('.send') ? `${base} to ${recipientText(payload)}` : base;
  const facts = [
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
    created_at: input.requestedAt.toISOString(),
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
