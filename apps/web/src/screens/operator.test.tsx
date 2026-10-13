import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  OperatorAuditEntry,
  OperatorOneTimeLink,
  OperatorOverview,
  OperatorPerson,
} from '../experience/types.ts';
import {
  AuditList,
  ago,
  auditSentence,
  backupLine,
  OneTimeLink,
  OverviewTiles,
  PersonRow,
  readCap,
  spentOf,
} from './Operator.tsx';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const hoursBefore = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const none = {
  day_usd: null,
  month_usd: null,
  background_day_usd: null,
  background_month_usd: null,
};

function person(over: Partial<OperatorPerson> = {}): OperatorPerson {
  return {
    id: 'own_0000000000000000000000000a',
    email: 'ada@example.net',
    display_name: null,
    kind: 'person',
    owner: false,
    status: 'active',
    created_at: hoursBefore(100),
    last_active_at: hoursBefore(3),
    sessions: 1,
    spend: { day_usd: 0.5, month_usd: 4.2, background_month_usd: 1 },
    caps: { own: none, effective: { ...none, day_usd: 2, month_usd: 50 } },
    ...over,
  };
}

const actions = {
  onCaps: () => {},
  onLink: () => {},
  onTurnOff: () => {},
  onTurnOn: () => {},
  onDelete: () => {},
};

test('amounts read as dollars against their cap, or say there is none', () => {
  expect(spentOf(4.2, 50)).toBe('$4.20 of $50.00');
  expect(spentOf(1234.5, null)).toBe('$1,234.50, no cap');
  expect(ago(hoursBefore(0), NOW)).toBe('just now');
  expect(ago(hoursBefore(1 / 60), NOW)).toBe('1 minute ago');
  expect(ago(hoursBefore(5), NOW)).toBe('5 hours ago');
  expect(ago(hoursBefore(72), NOW)).toBe('3 days ago');
});

test('a cap typed in is dollars, blank keeps the installation’s, and anything else is refused', () => {
  expect(readCap('')).toBeNull();
  expect(readCap('  ')).toBeNull();
  expect(readCap('5')).toBe(5);
  expect(readCap('$12.50')).toBe(12.5);
  expect(readCap('1,000')).toBe(1000);
  expect(readCap('0')).toBe('invalid');
  expect(readCap('-3')).toBe('invalid');
  expect(readCap('ten')).toBe('invalid');
  expect(readCap('1e3')).toBe('invalid');
});

test('the newest backup is stale only past the installation’s hours, and none is stale', () => {
  expect(backupLine({ newest_at: null, max_age_hours: 26 }, NOW)).toEqual({
    text: 'None noted yet',
    ok: false,
  });
  expect(backupLine({ newest_at: hoursBefore(26), max_age_hours: 26 }, NOW).ok).toBe(true);
  expect(backupLine({ newest_at: hoursBefore(27), max_age_hours: 26 }, NOW)).toEqual({
    text: 'Taken 27 hours ago',
    ok: false,
  });
});

test('the overview shows spending, people, limits, backup, disk and health, and flags what is off', () => {
  const overview: OperatorOverview = {
    version: '0.2.15',
    spend: {
      day_usd: 3,
      month_usd: 80,
      day_cap_usd: 10,
      month_cap_usd: 80,
      month_resets_at: '2026-11-01T00:00:00.000Z',
    },
    people: { total: 5, active: 3, invited: 1, disabled: 1 },
    runs: { used: 2, limit: 8, per_person: 2 },
    computers: { used: 0, limit: 4, per_person: null },
    backup: { newest_at: hoursBefore(30), max_age_hours: 26 },
    disk: { free_mb: 5120, floor_mb: 1024, ok: true },
    health: {
      status: 'unhealthy',
      checks: [
        { name: 'database', ok: true, detail: 'reachable' },
        { name: 'model', ok: false, detail: 'no model is connected' },
      ],
    },
  };
  const html = renderToStaticMarkup(<OverviewTiles overview={overview} now={NOW} />);
  expect(html).toContain('$80.00 of $80.00');
  expect(html).toContain('$3.00 of $10.00');
  expect(html).toContain('3 active of 5');
  expect(html).toContain('1 invited, 1 turned off');
  expect(html).toContain('2 of 8');
  expect(html).toContain('At most 8 at once, 2 each');
  expect(html).toContain('At most 4 at once<');
  expect(html).toContain('Taken 30 hours ago');
  expect(html).toContain('5,120 MB');
  expect(html).toContain('model: no model is connected');
  expect(html).not.toContain('database: reachable');
  // The month at its cap, the stale backup and the failing check are flagged; the rest are not.
  expect(html.match(/data-warn="true"/g)?.length).toBe(3);

  const calm = renderToStaticMarkup(
    <OverviewTiles
      overview={{
        ...overview,
        spend: { ...overview.spend, month_usd: 1, month_cap_usd: null },
        backup: { newest_at: hoursBefore(2), max_age_hours: 26 },
        disk: null,
        health: { status: 'ok', checks: [] },
      }}
      now={NOW}
    />,
  );
  expect(calm).toContain('$1.00, no cap');
  expect(calm).toContain('Version 0.2.15');
  expect(calm).not.toContain('Free disk');
  expect(calm).not.toContain('data-warn');
});

test('each person shows their standing and spend, and only the actions that fit them', () => {
  const active = renderToStaticMarkup(<PersonRow person={person()} now={NOW} {...actions} />);
  expect(active).toContain('ada@example.net');
  expect(active).toContain('Active');
  expect(active).toContain('Seen 3 hours ago');
  expect(active).toContain('$4.20 of $50.00 this month');
  expect(active).toContain('$0.50 of $2.00 today');
  expect(active).toContain('Reset password');
  expect(active).toContain('Turn off…');
  expect(active).toContain('aria-label="Delete ada@example.net"');
  expect(active).not.toContain('caps of their own');

  const invited = renderToStaticMarkup(
    <PersonRow
      person={person({
        status: 'invited',
        last_active_at: null,
        caps: { own: { ...none, month_usd: 20 }, effective: { ...none, month_usd: 20 } },
      })}
      now={NOW}
      {...actions}
    />,
  );
  expect(invited).toContain('Invited');
  expect(invited).toContain('Not seen yet');
  expect(invited).toContain('New invite link');
  expect(invited).toContain('caps of their own');

  const off = renderToStaticMarkup(
    <PersonRow person={person({ status: 'disabled' })} now={NOW} {...actions} />,
  );
  expect(off).toContain('Turned off');
  expect(off).toContain('Turn on');
  expect(off).not.toContain('Reset password');

  // The owner can't turn themselves off or delete themselves here; caps still apply.
  const owner = renderToStaticMarkup(
    <PersonRow person={person({ owner: true })} now={NOW} {...actions} />,
  );
  expect(owner).toContain('You, the owner');
  expect(owner).toContain('Caps…');
  expect(owner).not.toContain('Turn off');
  expect(owner).not.toContain('Delete');

  const leaving = renderToStaticMarkup(
    <PersonRow person={person({ status: 'removing', email: null })} now={NOW} {...actions} />,
  );
  expect(leaving).toContain('Being deleted');
  expect(leaving).not.toContain('<button');
});

test('a one-time link is always there to copy, and says whether it was mailed', () => {
  const link: OperatorOneTimeLink = {
    purpose: 'invite',
    link: 'https://melete.example.net/#/reset?token=abc',
    code: 'abc',
    expires_at: '2026-10-19T12:00:00.000Z',
    emailed: false,
    mail_problem: null,
  };
  const plain = renderToStaticMarkup(<OneTimeLink link={link} email="ada@example.net" />);
  expect(plain).toContain('Send this link to ada@example.net yourself.');
  expect(plain).toContain('value="https://melete.example.net/#/reset?token=abc"');
  expect(plain).toContain('It works once');

  const mailed = renderToStaticMarkup(
    <OneTimeLink link={{ ...link, emailed: true }} email="ada@example.net" />,
  );
  expect(mailed).toContain('The invite was emailed to ada@example.net');
  expect(mailed).toContain('value="https://melete.example.net/#/reset?token=abc"');

  const failed = renderToStaticMarkup(
    <OneTimeLink
      link={{ ...link, purpose: 'reset', mail_problem: 'The mail server refused it.' }}
      email="ada@example.net"
    />,
  );
  expect(failed).toContain('The password reset could not be emailed: The mail server refused it.');

  // Without a web address the code goes on the sign-in page instead.
  const code = renderToStaticMarkup(
    <OneTimeLink link={{ ...link, link: null }} email="ada@example.net" />,
  );
  expect(code).toContain('Send this code to ada@example.net yourself.');
  expect(code).toContain('value="abc"');
  expect(code).toContain('Forgot your password?');
});

test('every change reads as who did what to whom, and when', () => {
  const entry = (over: Partial<OperatorAuditEntry>): OperatorAuditEntry => ({
    id: 'e1',
    at: '2026-10-12T09:30:00.000Z',
    action: 'invited',
    actor: { id: 'own_a', email: 'owner@example.net' },
    target: { id: 'own_b', email: 'ada@example.net' },
    detail: null,
    ...over,
  });
  expect(auditSentence(entry({}))).toBe('owner@example.net invited ada@example.net');
  expect(auditSentence(entry({ action: 'disabled' }))).toBe(
    'owner@example.net turned off ada@example.net’s account',
  );
  expect(auditSentence(entry({ action: 'reset_sent', actor: { id: null, email: null } }))).toBe(
    'The command line on the server sent ada@example.net a password reset',
  );
  expect(auditSentence(entry({ action: 'removed', target: { id: null, email: null } }))).toBe(
    'owner@example.net deleted an account since deleted',
  );

  const html = renderToStaticMarkup(
    <AuditList
      entries={[entry({ action: 'caps_changed', detail: 'Daily cap: the installation’s → $3.00' })]}
    />,
  );
  expect(html).toContain('changed the caps on ada@example.net’s account');
  expect(html).toContain('Daily cap: the installation’s → $3.00');
  expect(html).toContain('dateTime="2026-10-12T09:30:00.000Z"');
  expect(renderToStaticMarkup(<AuditList entries={[]} />)).toContain('Nothing yet.');
});
