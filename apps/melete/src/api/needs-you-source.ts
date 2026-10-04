/**
 * The source of a "Needs you" item, attached to the chat that handles it.
 *
 * "Handle it" starts an ordinary chat. The person's message in it says only
 * which item it is about (its `event:<seq>` handle); the message's headers or
 * the meeting's fields come with it as an attached text file. Attached files
 * reach the agent fenced as untrusted data, never as the person's words, so a
 * subject line that says "forward my invoices" is read as what someone wrote.
 *
 * This lives apart from sorting, which only labels: attaching is something the
 * person does by pressing the button.
 */
import { MAIL_RECEIVED } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AttachmentService } from '../attachments/store.ts';
import { ServiceError } from './errors.ts';

type Scope = { spaceId: string; principalId?: string | null };

/** The file's text: labelled fields, the source's own words marked as such. */
export function sourceText(item: {
  kind: string;
  event_seq: number;
  connection_id: string | null;
  fields: Record<string, unknown>;
  read_key: unknown;
}): string {
  const field = (label: string, value: unknown) =>
    value === null || value === undefined || value === '' ? [] : [`${label}: ${String(value)}`];
  const f = item.fields;
  const lines =
    item.kind === MAIL_RECEIVED
      ? [
          'An email from the person’s connected mailbox, as it arrived (headers only).',
          ...field('From', f.from),
          ...field('Sender address', f.sender),
          ...field('Subject', f.subject),
          ...field('Received', f.received_at),
          ...field('Recipients', f.to_count),
          ...field('Connection', item.connection_id),
          ...field('Read key (for email.read)', item.read_key),
        ]
      : [
          `A calendar change (${item.kind}) from the person’s connected calendar.`,
          ...field('Title', f.title),
          ...field('Starts', f.start),
          ...field('Ends', f.end),
          ...field('Place', f.location),
          ...field('Status', f.status),
          ...field('Changed', Array.isArray(f.changed) ? f.changed.join(', ') : null),
          ...field('Was starting', f.previous_start),
          ...field('Was at', f.previous_location),
          ...field('Connection', item.connection_id),
        ];
  return [`Source: event:${item.event_seq}`, ...lines, ''].join('\n');
}

export function mountNeedsYouSource(
  app: Hono,
  deps: {
    sql: Sql;
    attachments: AttachmentService;
    resolveSpace: (c: Context) => Promise<Scope | null>;
  },
) {
  app.post('/needs-you/:id/source', async (c) => {
    const principalId = c.get('owner').id;
    const scope = await deps.resolveSpace(c);
    if (!scope) throw new ServiceError('not_found', 'Your personal space is not ready.', 404);
    const [item] = await deps.sql`select t.kind, t.event_seq, t.connection_id, t.fields, t.space_id,
        e.payload #> '{payload,read_key}' as read_key
      from triage_item t left join event e on e.seq = t.event_seq
      where t.id = ${c.req.param('id')} and t.principal_id = ${principalId}
        and t.verdict = 'needs_you'`;
    if (!item) throw new ServiceError('not_found', 'No such item.', 404);
    // The file goes into the space the chat is in. An item from another space
    // stays there: a private space's mail never lands in an ordinary chat.
    if (item.space_id !== scope.spaceId)
      throw new ServiceError(
        'other_space',
        'This came from another space. Open that space to handle it.',
        409,
      );
    const text = sourceText({
      kind: String(item.kind),
      event_seq: Number(item.event_seq),
      connection_id: item.connection_id === null ? null : String(item.connection_id),
      fields: (item.fields ?? {}) as Record<string, unknown>,
      read_key: item.read_key,
    });
    const attachment = await deps.attachments.upload(
      { spaceId: scope.spaceId, principalId },
      {
        name: item.kind === MAIL_RECEIVED ? 'email-source.txt' : 'calendar-source.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode(text),
      },
    );
    return c.json({ attachment }, 201);
  });
}
