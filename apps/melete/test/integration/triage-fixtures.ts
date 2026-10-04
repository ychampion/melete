/**
 * A seeded inbox and calendar for sorting: observations written as the signal
 * poller delivers them. Thirty-three changes, three of which need the person.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { mailObservation } from '../../src/signals/observations.ts';

/** The subjects of the three that need the person. */
export const NEEDS_YOU = [
  'Can you sign the renewal by Friday?',
  'Lunch tomorrow - please confirm the time',
  'Board review',
];

export function triageInbox(sql: Sql) {
  let seq = 0;
  async function deliverMail(
    connection: string,
    mail: { from: string; subject: string; automated?: boolean },
  ) {
    seq++;
    const observation = mailObservation(
      connection,
      {
        key: `<m${seq}-${randomUUID()}@example.test>`,
        read_key: seq,
        message_id: `<m${seq}@example.test>`,
        from: mail.from,
        to: 'me@example.test',
        subject: mail.subject,
        text: '',
        html: '',
        date: new Date().toISOString(),
        automated: mail.automated === true,
      },
      new Date().toISOString(),
    );
    await deliver(connection, observation.event_name, observation.dedup_key, observation.payload);
  }

  async function deliverCalendar(
    connection: string,
    kind: 'calendar.event.created' | 'calendar.event.changed',
    event: { title: string; changed?: string[]; key?: string },
  ) {
    seq++;
    const start = new Date(Date.now() + 26 * 3600_000).toISOString();
    await deliver(connection, kind, `${kind}:${seq}`, {
      kind,
      about: {
        type: 'calendar_occurrence',
        key: event.key ?? `calendar:${connection}:occ${seq}`,
      },
      occurred_at: new Date().toISOString(),
      origin: 'external_content',
      title: event.title,
      start,
      end: new Date(Date.parse(start) + 3600_000).toISOString(),
      location: 'Room 2',
      status: 'confirmed',
      attendees: kind === 'calendar.event.changed' ? 4 : 0,
      changed: event.changed ?? [],
      previous: event.changed ? { start: new Date(Date.now() + 25 * 3600_000).toISOString() } : {},
    });
  }

  async function deliver(
    connection: string,
    eventName: string,
    dedupKey: string,
    payload: Record<string, unknown>,
  ) {
    await sql`insert into event (job_id, type, payload, dedup_key)
    values (null, 'notice', ${JSON.stringify({
      kind: 'connector_event',
      connection_id: connection,
      event_name: eventName,
      cursor: 'c',
      dedup_key: dedupKey,
      payload,
      connection_generation: 0,
      policy_generation: 0,
    })}::text::jsonb, ${`connector:${connection}:${dedupKey}`})`;
  }

  /** Three that need the person, and thirty that don't. */
  async function seedInbox(connectionId: string) {
    await deliverMail(connectionId, {
      from: 'Dana Kim <dana@client.example>',
      subject: 'Can you sign the renewal by Friday?',
    });
    await deliverMail(connectionId, {
      from: 'Sam Ortiz <sam@friends.example>',
      subject: 'Lunch tomorrow - please confirm the time',
    });
    await deliverCalendar(connectionId, 'calendar.event.changed', {
      title: 'Board review',
      changed: ['start'],
    });
    for (let n = 0; n < 12; n++)
      await deliverMail(connectionId, {
        from: `Weekly Digest <digest${n}@news.example>`,
        subject: `Your weekly digest #${n}`,
        automated: true,
      });
    for (let n = 0; n < 5; n++)
      await deliverMail(connectionId, {
        from: `Shop <no-reply@shop${n}.example>`,
        subject: `Your order ${1000 + n} has shipped`,
      });
    const offers = [
      'Fall sale: 50% off everything',
      'URGENT: last chance to save',
      'New features in your workspace',
      'Your receipt from Coffee Co',
      'Someone viewed your profile',
      'Webinar recording is ready',
      'Your statement is available',
      'Tips for getting started',
      'We miss you',
      'Your monthly summary',
    ];
    for (const subject of offers)
      await deliverMail(connectionId, { from: `Updates <hello@vendor.example>`, subject });
    for (const title of ['Focus time', 'Gym', 'Read'])
      await deliverCalendar(connectionId, 'calendar.event.created', { title });
  }

  return { deliverMail, deliverCalendar, seedInbox };
}
