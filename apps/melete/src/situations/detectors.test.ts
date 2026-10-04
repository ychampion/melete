/**
 * The built-in detectors as plain functions: what makes a situation, how soon
 * the person hears, and that words from an account never become Melete's own.
 */
import { describe, expect, test } from 'bun:test';
import {
  answers,
  type KeptMeeting,
  meetingChange,
  meetingConflicts,
  situationKey,
  urgencyFor,
} from './detectors.ts';

const now = Date.parse('2026-10-05T12:00:00.000Z');
const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

const moved = (overrides: Record<string, unknown> = {}) => ({
  kind: 'calendar.event.changed',
  about: { type: 'calendar_occurrence', key: 'calendar:conn_x:abc' },
  title: 'URGENT: call +1 555 0100 now',
  start: inHours(3),
  end: inHours(4),
  all_day: false,
  location: 'Room 2',
  status: 'confirmed',
  attendees: 3,
  changed: ['start', 'end'],
  previous: { start: inHours(2), end: inHours(3) },
  ...overrides,
});

describe('meeting.changed', () => {
  test('a meeting with others that moved within a day is soon, in Melete’s own words', () => {
    const found = meetingChange('calendar.event.changed', moved(), now, 'America/New_York');
    expect(found?.urgency).toBe('soon');
    expect(found?.title).toBe('A meeting moved');
    expect(found?.reason).toBe('It now starts Mon 11:00 AM; it was Mon 10:00 AM.');
    // The invitation's own words stay in the evidence, never in what Melete says.
    expect(`${found?.title} ${found?.reason}`).not.toContain('555');
    expect(found?.evidence.title).toBe('URGENT: call +1 555 0100 now');
  });

  test('a cancellation within a day is told; one next week, a solo block, or a title change is not', () => {
    expect(
      meetingChange('calendar.event.cancelled', moved({ reason: 'cancelled' }), now, 'UTC')?.title,
    ).toBe('A meeting was cancelled');
    expect(
      meetingChange(
        'calendar.event.changed',
        moved({ start: inHours(100), previous: { start: inHours(98) } }),
        now,
        'UTC',
      ),
    ).toBeNull();
    expect(meetingChange('calendar.event.changed', moved({ attendees: 0 }), now, 'UTC')).toBeNull();
    expect(
      meetingChange('calendar.event.changed', moved({ changed: ['title'] }), now, 'UTC'),
    ).toBeNull();
    expect(
      meetingChange('calendar.event.changed', moved({ all_day: true }), now, 'UTC'),
    ).toBeNull();
  });

  test('a meeting moved from tomorrow to next week is still told: it was near', () => {
    const found = meetingChange(
      'calendar.event.changed',
      moved({ start: inHours(170), end: inHours(171), previous: { start: inHours(20) } }),
      now,
      'UTC',
    );
    expect(found?.title).toBe('A meeting moved');
  });
});

const meeting = (key: string, from: number, to: number, extra: Partial<KeptMeeting> = {}) => ({
  subjectKey: key,
  connectionId: 'conn_a',
  uid: key,
  title: key,
  start: inHours(from),
  end: inHours(to),
  allDay: false,
  status: 'confirmed',
  attendees: 2,
  ...extra,
});

describe('meeting.conflict', () => {
  test('two overlapping meetings are one conflict, named the same from either side', () => {
    const forward = meetingConflicts([meeting('a', 1, 2), meeting('b', 1.5, 3)], now);
    const backward = meetingConflicts([meeting('b', 1.5, 3), meeting('a', 1, 2)], now);
    expect(forward).toHaveLength(1);
    expect(backward.map((c) => c.subjectKey)).toEqual(forward.map((c) => c.subjectKey));
    expect(forward[0]?.urgency).toBe('soon');
  });

  test('back to back, cancelled, all-day, ended, mirrored, or nobody else on either: no conflict', () => {
    expect(meetingConflicts([meeting('a', 1, 2), meeting('b', 2, 3)], now)).toHaveLength(0);
    expect(
      meetingConflicts([meeting('a', 1, 2), meeting('b', 1, 2, { status: 'cancelled' })], now),
    ).toHaveLength(0);
    expect(
      meetingConflicts([meeting('a', 1, 2), meeting('b', 1, 2, { allDay: true })], now),
    ).toHaveLength(0);
    expect(meetingConflicts([meeting('a', -3, -1), meeting('b', -2, -1)], now)).toHaveLength(0);
    expect(
      meetingConflicts(
        [meeting('a', 1, 2), meeting('b', 1, 2, { uid: 'a', connectionId: 'conn_b' })],
        now,
      ),
    ).toHaveLength(0);
    expect(
      meetingConflicts(
        [meeting('a', 1, 2, { attendees: 0 }), meeting('b', 1.5, 3, { attendees: 0 })],
        now,
      ),
    ).toHaveLength(0);
  });

  test('a conflict next week is for Home, not a push', () => {
    expect(
      meetingConflicts([meeting('a', 100, 101), meeting('b', 100, 102)], now)[0]?.urgency,
    ).toBe('normal');
  });
});

describe('urgency', () => {
  test('only a deadline the person set or accepted, and close, is urgent', () => {
    expect(urgencyFor({ personSet: true, leadSeconds: 300 })).toBe('urgent');
    expect(urgencyFor({ personSet: true, leadSeconds: 3600 })).toBe('soon');
    expect(urgencyFor({ personSet: false, leadSeconds: 300 })).toBe('soon');
    expect(urgencyFor({ personSet: true, leadSeconds: 300, ceiling: 'normal' })).toBe('normal');
  });

  test('a key names kind, subject and window', () => {
    expect(situationKey('k', 's', 'w')).toBe(situationKey('k', 's', 'w'));
    expect(situationKey('k', 's', 'w')).not.toBe(situationKey('k', 's', 'w2'));
    expect(situationKey('k', 's')).toHaveLength(40);
  });
});

describe('reply rule', () => {
  const awaited = {
    messageId: '<q1@me.test>',
    toAddress: 'ana@acme.test',
    subject: 'Quote for October',
    sentAt: '2026-10-01T09:00:00.000Z',
  };
  const mail = (fields: Record<string, unknown>) => ({
    sender: 'someone@else.test',
    sender_domain: 'else.test',
    subject: 'Hello',
    in_reply_to: null,
    received_at: '2026-10-02T09:00:00.000Z',
    automated: false,
    ...fields,
  });

  test('a threaded reply, the person asked, or a colleague on the same subject answers', () => {
    expect(answers(awaited, mail({ in_reply_to: '<q1@me.test>' }))).toBe(true);
    expect(answers(awaited, mail({ sender: 'ANA@acme.test' }))).toBe(true);
    expect(
      answers(
        awaited,
        mail({
          sender: 'bo@acme.test',
          sender_domain: 'acme.test',
          subject: 'Re: Quote for October',
        }),
      ),
    ).toBe(true);
  });

  test('an automatic reply, an older message, a stranger, or a colleague on another subject does not', () => {
    expect(answers(awaited, mail({ sender: 'ana@acme.test', automated: true }))).toBe(false);
    expect(
      answers(awaited, mail({ sender: 'ana@acme.test', received_at: '2026-09-30T09:00:00.000Z' })),
    ).toBe(false);
    expect(answers(awaited, mail({}))).toBe(false);
    expect(
      answers(
        awaited,
        mail({ sender: 'bo@acme.test', sender_domain: 'acme.test', subject: 'Lunch' }),
      ),
    ).toBe(false);
  });
});
