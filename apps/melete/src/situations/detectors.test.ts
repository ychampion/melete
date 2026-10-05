/**
 * The built-in detectors as plain functions: what makes a situation, how soon
 * the person hears, and that words from an account never become Melete's own.
 */
import { describe, expect, test } from 'bun:test';
import { googleOccurrence } from '../connectors/google-calendar.ts';
import { graphOccurrence } from '../connectors/outlook-calendar.ts';
import {
  answers,
  dueWords,
  endOfLocalDay,
  type KeptMeeting,
  localInstant,
  meetingChange,
  meetingConflicts,
  replyVerdict,
  situationKey,
  urgencyFor,
  withinDay,
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

  test('a key names the person, the space, the kind, the subject and the window', () => {
    const due = '2026-10-05T15:00:00.000Z';
    const sam = { spaceId: 'sp_a', principalId: 'own_sam' };
    const tia = { spaceId: 'sp_a', principalId: 'own_tia' };
    expect(situationKey(sam, 'deadline.at_risk', 'doc:a', due)).toBe(
      situationKey(sam, 'deadline.at_risk', 'doc:a', due),
    );
    expect(situationKey(sam, 'deadline.at_risk', 'doc:a', due)).not.toBe(
      situationKey(tia, 'deadline.at_risk', 'doc:a', due),
    );
    expect(situationKey(sam, 'deadline.at_risk', 'doc:a', due)).not.toBe(
      situationKey({ ...sam, spaceId: 'sp_b' }, 'deadline.at_risk', 'doc:a', due),
    );
    expect(situationKey(sam, 'deadline.at_risk', 'doc:a', due)).not.toBe(
      situationKey(sam, 'deadline.at_risk', 'doc:a', '2026-10-05T16:00:00.000Z'),
    );
    expect(situationKey(sam, 'meeting.changed', 'doc:a')).toHaveLength(40);
  });
});

describe('dates and invitations', () => {
  test('a commitment due on a date is due until that day ends where the person is, and named by its day', () => {
    // 2026-10-10 is a Saturday. Midnight UTC would read as Friday afternoon in Los Angeles.
    const due = endOfLocalDay('2026-10-10', 'America/Los_Angeles');
    expect(new Date(due).toISOString()).toBe('2026-10-11T07:00:00.000Z');
    expect(dueWords(new Date(due).toISOString(), 'America/Los_Angeles', '2026-10-10')).toBe(
      'Sat, Oct 10',
    );
    expect(new Date(endOfLocalDay('2026-10-10', 'Asia/Tokyo')).toISOString()).toBe(
      '2026-10-10T15:00:00.000Z',
    );
  });

  test('a look that would fall outside the person’s day waits for the start of it', () => {
    const day = { start: '08:00', end: '22:00', timeZone: 'America/Los_Angeles' };
    const quiet = (at: number) => {
      const hour = Number(
        new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hourCycle: 'h23',
          timeZone: day.timeZone,
        }).format(at),
      );
      return hour < 8 || hour >= 22;
    };
    // 11:45 PM Tuesday in Los Angeles waits for 8:00 AM Wednesday.
    const late = localInstant('2026-10-06', '23:45', day.timeZone);
    expect(new Date(withinDay(late, day, quiet)).toISOString()).toBe(
      new Date(localInstant('2026-10-07', '08:00', day.timeZone)).toISOString(),
    );
    // 2:00 AM waits for 8:00 AM the same day; 5:00 PM stays.
    const early = localInstant('2026-10-07', '02:00', day.timeZone);
    expect(withinDay(early, day, quiet)).toBe(localInstant('2026-10-07', '08:00', day.timeZone));
    const evening = localInstant('2026-10-07', '17:00', day.timeZone);
    expect(withinDay(evening, day, quiet)).toBe(evening);
  });

  test('an invitation the person has not accepted is not their meeting', () => {
    for (const response of ['needs_action', 'declined', 'tentative'])
      expect(meetingChange('calendar.event.changed', moved({ response }), now, 'UTC')).toBeNull();
    expect(
      meetingChange('calendar.event.changed', moved({ response: 'accepted' }), now, 'UTC')?.title,
    ).toBe('A meeting moved');
    expect(
      meetingConflicts(
        [meeting('a', 1, 2), meeting('b', 1.5, 3, { response: 'needs_action' })],
        now,
      ),
    ).toHaveLength(0);
    expect(
      meetingConflicts([meeting('a', 1, 2, { response: 'organizer' }), meeting('b', 1.5, 3)], now),
    ).toHaveLength(1);
  });

  test('an invitation whose answer the calendar cannot show is not their meeting', () => {
    // Sent to a list the person is on: the calendar lists others, never them.
    const viaList = googleOccurrence({
      id: 'evt1',
      status: 'confirmed',
      start: { dateTime: inHours(3) },
      end: { dateTime: inHours(4) },
      organizer: { email: 'stranger@example.test' },
      attendees: [{ email: 'everyone@lists.example.test', responseStatus: 'needsAction' }],
    });
    // An answer Graph reports as none.
    const unanswered = graphOccurrence({
      id: 'evt2',
      subject: 'Sync',
      start: { dateTime: inHours(3), timeZone: 'UTC' },
      end: { dateTime: inHours(4), timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'stranger@example.test' } }],
      isOrganizer: false,
      responseStatus: { response: 'none' },
    } as never);
    for (const occurrence of [viaList, unanswered]) {
      const response = occurrence?.response;
      expect(meetingChange('calendar.event.changed', moved({ response }), now, 'UTC')).toBeNull();
      expect(
        meetingConflicts([meeting('a', 1, 2), meeting('b', 1.5, 3, { response })], now),
      ).toHaveLength(0);
    }
    // A feed that keeps no answers still counts what it lists.
    expect(meetingChange('calendar.event.changed', moved(), now, 'UTC')?.title).toBe(
      'A meeting moved',
    );
  });

  test('a conflict is the same while its meetings stay put, and new once either moves', () => {
    const [before] = meetingConflicts([meeting('a', 1, 2), meeting('b', 1.5, 3)], now);
    const [same] = meetingConflicts([meeting('b', 1.5, 3), meeting('a', 1, 2)], now);
    const [moved] = meetingConflicts([meeting('a', 1, 2), meeting('b', 1.75, 3)], now);
    expect(same?.fingerprint).toBe(before?.fingerprint);
    expect(moved?.subjectKey).toBe(before?.subjectKey);
    expect(moved?.fingerprint).not.toBe(before?.fingerprint);
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
    expect(answers(awaited, mail({ sender: 'ANA@acme.test', sender_auth: 'pass' }))).toBe(true);
    expect(
      answers(
        awaited,
        mail({
          sender: 'bo@acme.test',
          sender_domain: 'acme.test',
          subject: 'Re: Quote for October',
          sender_auth: 'pass',
        }),
      ),
    ).toBe(true);
  });

  test('a forged From address, unauthenticated or failing DMARC, leaves the wait open', () => {
    for (const sender_auth of ['none', 'fail', undefined])
      expect(replyVerdict(awaited, mail({ sender: 'ana@acme.test', sender_auth }))).toBe(
        'unverified',
      );
    expect(
      replyVerdict(
        awaited,
        mail({
          sender: 'bo@acme.test',
          sender_domain: 'acme.test',
          subject: 'Re: Quote for October',
          sender_auth: 'fail',
        }),
      ),
    ).toBe('unverified');
  });

  test("a reply naming the person's own Message-ID answers without authentication, unless it went to spam", () => {
    expect(
      answers(
        awaited,
        mail({ references: ['<older@me.test>', '<q1@me.test>'], sender_auth: 'none' }),
      ),
    ).toBe(true);
    expect(answers(awaited, mail({ in_reply_to: '<q1@me.test>', sender_auth: 'fail' }))).toBe(true);
    expect(
      replyVerdict(
        awaited,
        mail({
          sender: 'ana@acme.test',
          in_reply_to: '<q1@me.test>',
          sender_auth: 'none',
          in_inbox: false,
        }),
      ),
    ).toBe('unverified');
    // Another of the person's messages in the thread is not this one.
    expect(answers(awaited, mail({ references: ['<other@me.test>'] }))).toBe(false);
  });

  test('an automatic reply, an older message, a stranger, or a colleague on another subject does not', () => {
    expect(
      answers(awaited, mail({ sender: 'ana@acme.test', automated: true, sender_auth: 'pass' })),
    ).toBe(false);
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
