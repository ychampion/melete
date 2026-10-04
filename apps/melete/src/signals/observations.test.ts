import { describe, expect, test } from 'bun:test';
import {
  diffCalendar,
  fieldsVersion,
  type KeptOccurrence,
  mailObservation,
  occurrenceFields,
  occurrenceKey,
} from './observations.ts';
import type { Occurrence } from './types.ts';

const CONNECTION = 'conn_calendar01';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const WINDOW = { from: '2026-10-05T12:00:00.000Z', to: '2026-10-19T12:00:00.000Z' };

const occurrence = (overrides: Partial<Occurrence> = {}): Occurrence => ({
  uid: 'standup@example.test',
  occurrence: '2026-10-06T16:00:00.000Z',
  title: 'Standup',
  start: '2026-10-06T16:00:00.000Z',
  end: '2026-10-06T16:15:00.000Z',
  all_day: false,
  location: 'Room 1',
  status: 'confirmed',
  attendees: 3,
  time_zone: 'America/Los_Angeles',
  ...overrides,
});

const kept = (item: Occurrence): KeptOccurrence => {
  const fields = occurrenceFields(item);
  return { subject_key: occurrenceKey(CONNECTION, item), version: fieldsVersion(fields), fields };
};

const diff = (input: {
  kept?: KeptOccurrence[];
  read: Occurrence[];
  previous?: string | null;
  complete?: boolean;
}) =>
  diffCalendar({
    connectionId: CONNECTION,
    kept: input.kept ?? [],
    read: { items: input.read, complete: input.complete ?? true },
    previous: input.previous === null ? null : { window_end: input.previous ?? WINDOW.to },
    window: WINDOW,
    now: NOW,
  });

describe('calendar observations', () => {
  test('the first read keeps everything quietly: watching starts there', () => {
    const result = diff({ read: [occurrence()], previous: null });
    expect(result.observations).toEqual([]);
    expect(result.upsert).toHaveLength(1);
  });

  test('an unchanged read says nothing and writes nothing', () => {
    const result = diff({ kept: [kept(occurrence())], read: [occurrence()] });
    expect(result).toMatchObject({ observations: [], upsert: [], remove: [] });
  });

  test('a moved occurrence is one change, naming what changed and what it was', () => {
    const moved = occurrence({
      start: '2026-10-06T17:00:00.000Z',
      end: '2026-10-06T17:15:00.000Z',
    });
    const result = diff({ kept: [kept(occurrence())], read: [moved] });
    expect(result.observations).toHaveLength(1);
    const [changed] = result.observations;
    expect(changed?.event_name).toBe('calendar.event.changed');
    expect(changed?.payload).toMatchObject({
      kind: 'calendar.event.changed',
      about: { type: 'calendar_occurrence', key: occurrenceKey(CONNECTION, moved) },
      origin: 'external_content',
      start: '2026-10-06T17:00:00.000Z',
      changed: ['start', 'end'],
      previous: { start: '2026-10-06T16:00:00.000Z', end: '2026-10-06T16:15:00.000Z' },
    });
    // The same change read again carries the same key, so it is one event.
    expect(diff({ kept: [kept(occurrence())], read: [moved] }).observations[0]?.dedup_key).toBe(
      changed?.dedup_key,
    );
  });

  test('a new occurrence inside what was already covered is created; one that only came into view is not', () => {
    const fresh = occurrence({ uid: 'new@example.test', occurrence: null });
    const later = occurrence({
      uid: 'far@example.test',
      occurrence: null,
      start: '2026-10-18T16:00:00.000Z',
      end: '2026-10-18T17:00:00.000Z',
    });
    const result = diff({ read: [fresh, later], previous: '2026-10-17T12:00:00.000Z' });
    expect(result.observations.map((item) => [item.event_name, item.payload.uid])).toEqual([
      ['calendar.event.created', 'new@example.test'],
    ]);
    expect(result.upsert).toHaveLength(2);
  });

  test('a cancelled status is a cancellation; an occurrence gone from the read is one too', () => {
    const cancelled = diff({
      kept: [kept(occurrence())],
      read: [occurrence({ status: 'cancelled' })],
    });
    expect(cancelled.observations.map((item) => [item.event_name, item.payload.reason])).toEqual([
      ['calendar.event.cancelled', 'cancelled'],
    ]);
    const removed = diff({ kept: [kept(occurrence())], read: [] });
    expect(removed.observations.map((item) => [item.event_name, item.payload.reason])).toEqual([
      ['calendar.event.cancelled', 'removed'],
    ]);
    expect(removed.remove).toEqual([occurrenceKey(CONNECTION, occurrence())]);
  });

  test('an occurrence that has ended leaves quietly', () => {
    const over = occurrence({ start: '2026-10-05T09:00:00.000Z', end: '2026-10-05T10:00:00.000Z' });
    const result = diff({ kept: [kept(over)], read: [] });
    expect(result.observations).toEqual([]);
    expect(result.remove).toEqual([occurrenceKey(CONNECTION, over)]);
  });

  test('a read that stopped early takes nothing past where it stopped as removed', () => {
    const early = occurrence();
    const late = occurrence({
      uid: 'late@example.test',
      start: '2026-10-12T16:00:00.000Z',
      end: '2026-10-12T17:00:00.000Z',
    });
    const result = diff({ kept: [kept(early), kept(late)], read: [early], complete: false });
    expect(result.observations).toEqual([]);
    expect(result.remove).toEqual([]);
    expect(result.window_end).toBe(early.start);
  });
});

describe('mail observations', () => {
  test('a new message carries headers only, marked as outside content, keyed by the message', () => {
    const observed = mailObservation(
      'conn_mail00001',
      {
        key: 'msgid:<a1@shop.example>',
        read_key: 42,
        message_id: '<a1@shop.example>',
        from: 'Shop <orders@shop.example>',
        from_addresses: ['orders@shop.example'],
        to: 'me@example.test',
        to_addresses: ['me@example.test'],
        subject: 'Your order shipped',
        text: 'Secret body text',
        html: '<p>Secret body text</p>',
        date: '2026-10-05T11:59:00.000Z',
        automated: true,
      },
      '2026-10-05T12:00:00.000Z',
    );
    expect(observed).toEqual({
      event_name: 'mail.received',
      dedup_key: 'mail.received:msgid:<a1@shop.example>',
      payload: {
        kind: 'mail.received',
        about: { type: 'mail_message', key: 'mail:conn_mail00001:msgid:<a1@shop.example>' },
        occurred_at: '2026-10-05T11:59:00.000Z',
        origin: 'external_content',
        message_id: '<a1@shop.example>',
        read_key: 42,
        from: 'Shop <orders@shop.example>',
        sender: 'orders@shop.example',
        sender_domain: 'shop.example',
        subject: 'Your order shipped',
        received_at: '2026-10-05T11:59:00.000Z',
        to_count: 1,
        in_reply_to: null,
        automated: true,
      },
    });
    expect(JSON.stringify(observed)).not.toContain('Secret body text');
  });
});
