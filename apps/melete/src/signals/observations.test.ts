import { describe, expect, test } from 'bun:test';
import {
  diffCalendar,
  fieldsVersion,
  type KeptOccurrence,
  keyOf,
  mailDedupKey,
  mailObservation,
  occurrenceFields,
  occurrenceKey,
  vanished,
} from './observations.ts';
import type { Confirmed, Lookup, Occurrence } from './types.ts';

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
  confirmed?: Map<string, Lookup>;
}) =>
  diffCalendar({
    connectionId: CONNECTION,
    kept: input.kept ?? [],
    read: { items: input.read, complete: input.complete ?? true },
    previous: input.previous === null ? null : { window_end: input.previous ?? WINDOW.to },
    window: WINDOW,
    now: NOW,
    ...(input.confirmed ? { confirmed: input.confirmed } : {}),
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

  test('a cancelled status is a cancellation; an occurrence the provider says is gone is one too', () => {
    const cancelled = diff({
      kept: [kept(occurrence())],
      read: [occurrence({ status: 'cancelled' })],
    });
    expect(cancelled.observations.map((item) => [item.event_name, item.payload.reason])).toEqual([
      ['calendar.event.cancelled', 'cancelled'],
    ]);
    const key = occurrenceKey(CONNECTION, occurrence());
    const removed = diff({
      kept: [kept(occurrence())],
      read: [],
      confirmed: new Map<string, Confirmed>([[key, 'gone']]),
    });
    expect(removed.observations.map((item) => [item.event_name, item.payload.reason])).toEqual([
      ['calendar.event.cancelled', 'removed'],
    ]);
    expect(removed.remove).toEqual([key]);
  });

  test('a meeting moved past the window is a change, never a cancellation', () => {
    const key = occurrenceKey(CONNECTION, occurrence());
    const moved = occurrence({
      start: '2026-11-20T16:00:00.000Z',
      end: '2026-11-20T16:15:00.000Z',
    });
    const result = diff({
      kept: [kept(occurrence())],
      read: [],
      confirmed: new Map<string, Confirmed>([[key, moved]]),
    });
    expect(result.observations.map((item) => [item.event_name, item.payload.changed])).toEqual([
      ['calendar.event.changed', ['start', 'end']],
    ]);
    // Kept where it now is, so the next read, which cannot see it, asks nothing.
    expect(result.upsert.map((entry) => entry.fields.start)).toEqual(['2026-11-20T16:00:00.000Z']);
    expect(
      vanished({
        connectionId: CONNECTION,
        kept: result.upsert,
        read: { items: [], complete: true },
        previous: { window_end: WINDOW.to },
        window: WINDOW,
        now: NOW,
      }),
    ).toEqual([]);
  });

  test('an occurrence nobody can account for leaves quietly', () => {
    const key = occurrenceKey(CONNECTION, occurrence());
    const result = diff({
      kept: [kept(occurrence())],
      read: [],
      confirmed: new Map<string, Lookup>([[key, 'unknown']]),
    });
    expect(result.observations).toEqual([]);
    expect(result.remove).toEqual([key]);
  });

  test('an occurrence whose lookup failed is kept and asked about again, and let go after three failures', () => {
    const key = occurrenceKey(CONNECTION, occurrence());
    let rows = [kept(occurrence())];
    for (const tries of [1, 2]) {
      const result = diff({
        kept: rows,
        read: [],
        confirmed: new Map<string, Lookup>([[key, 'failed']]),
      });
      expect(result.observations).toEqual([]);
      expect(result.remove).toEqual([]);
      expect(result.upsert.map((entry) => entry.fields.unconfirmed)).toEqual([tries]);
      rows = result.upsert;
    }
    // Past the lookup cap, nothing was asked: kept as it was, no try counted.
    const skipped = diff({ kept: rows, read: [] });
    expect([skipped.upsert, skipped.remove, skipped.observations]).toEqual([[], [], []]);
    // Then the calendar says it is gone: one cancellation, without the count in it.
    const gone = diff({
      kept: rows,
      read: [],
      confirmed: new Map<string, Lookup>([[key, 'gone']]),
    });
    expect(gone.observations.map((item) => [item.event_name, item.payload.reason])).toEqual([
      ['calendar.event.cancelled', 'removed'],
    ]);
    expect(gone.observations[0]?.payload.unconfirmed).toBeUndefined();
    // Or a third failure: let go, and the person is told why.
    const third = diff({
      kept: rows,
      read: [],
      confirmed: new Map<string, Lookup>([[key, 'failed']]),
    });
    expect([third.observations, third.remove]).toEqual([[], [key]]);
    expect(third.note).toContain('could not be checked');
  });

  test('an unconfirmed occurrence whose start has passed is let go, with a reason', () => {
    const over = occurrence({ start: '2026-10-05T09:00:00.000Z', end: '2026-10-05T10:00:00.000Z' });
    const row = kept(over);
    const result = diff({
      kept: [{ ...row, fields: { ...row.fields, unconfirmed: 1 } }],
      read: [],
    });
    expect([result.observations, result.remove]).toEqual([[], [row.subject_key]]);
    expect(result.note).toContain('started before');
  });

  test('a provider id of any length makes a key of fixed length', () => {
    const long = occurrence({ uid: 'x'.repeat(4096) });
    const result = diff({ read: [long, occurrence()], previous: '2026-10-17T12:00:00.000Z' });
    expect(result.observations).toHaveLength(2);
    for (const item of result.observations) {
      expect(item.dedup_key.length).toBeLessThan(200);
      expect(String((item.payload.about as { key: string }).key).length).toBeLessThan(200);
    }
    expect(String(result.observations[0]?.payload.uid).length).toBeLessThanOrEqual(500);
    expect(occurrenceKey(CONNECTION, long)).not.toBe(occurrenceKey(CONNECTION, occurrence()));
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
      dedup_key: mailDedupKey('msgid:<a1@shop.example>'),
      payload: {
        kind: 'mail.received',
        about: {
          type: 'mail_message',
          key: `mail:conn_mail00001:${keyOf('msgid:<a1@shop.example>')}`,
        },
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
        references: [],
        automated: true,
        sender_auth: 'none',
        in_inbox: true,
      },
    });
    expect(JSON.stringify(observed)).not.toContain('Secret body text');
  });

  test('a Message-ID of any length makes a key of fixed length', () => {
    const id = `<${'a'.repeat(64 * 1024)}@x>`;
    const observed = mailObservation(
      'conn_mail00001',
      {
        key: `msgid:${id}`,
        read_key: 7,
        message_id: id,
        from: 'a@example.test',
        to: '',
        subject: 'Hello',
        text: '',
        html: '',
      },
      '2026-10-05T12:00:00.000Z',
    );
    expect(observed.dedup_key.length).toBeLessThan(200);
    expect(String(observed.payload.message_id).length).toBeLessThanOrEqual(500);
  });
});
