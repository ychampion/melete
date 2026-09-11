import {
  type ExperienceSource,
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
  if (typeof value !== 'string' || BACKEND_VOCABULARY.test(value) || /^[\s]*[[{]/.test(value))
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
export function actionLabel(row: ActionRow): string {
  return LABELS[row.kind] ?? 'Completed a step';
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
  const labels = [...new Set(succeeded.map(({ action }) => actionLabel(action)))];
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
export function projectPermission(input: {
  id: string;
  version: string;
  action: ActionRow;
  connection: ConnectionRow;
  reasons: string[];
  canAlways: boolean;
}) {
  const payload = object(input.action.canonicalPayload);
  const base = actionLabel(input.action)
    .replace(/^Sent /, 'Send ')
    .replace(/^Created /, 'Create ')
    .replace(/^Updated /, 'Update ')
    .replace(/^Removed /, 'Remove ');
  const what = input.action.kind.endsWith('.send') ? `${base} to ${recipientText(payload)}` : base;
  const facts = [
    ...(typeof payload.subject === 'string'
      ? [{ label: 'Subject', value: plainText(payload.subject, 'Message') }]
      : []),
    ...(typeof payload.body === 'string'
      ? [
          {
            label: 'Message',
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
    why: input.reasons,
    options: input.canAlways ? ['allow_once', 'always', 'deny'] : ['allow_once', 'deny'],
    version: input.version,
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
