/**
 * The activity log names whose work each effect was, who let it go ahead and
 * where it went, and never what it said. Owners find it from the room's
 * settings; members are not offered it.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuditEntries, approvalLine, dayRange, whoLine } from './ActivityLog.tsx';
import type { AuditEntry, RoomDetail } from './api.ts';
import { RoomSettings } from './RoomSettings.tsx';

const entry = (change: Partial<AuditEntry> = {}): AuditEntry => ({
  action_id: 'act_1',
  job_id: 'job_1',
  attempt_id: 'att_1',
  job_title: 'Post the notes',
  audience: 'room',
  kind: 'notes.post',
  effect_class: 'write_external',
  status: 'succeeded',
  payload_hash: 'ab'.repeat(32),
  connection: { id: 'conn_1', label: 'Team notes', provider: 'test' },
  principal: { id: 'own_room', name: 'Launch' },
  requested_by: { id: 'own_carol', name: 'Carol' },
  approval: {
    decision: 'approved',
    decided_by: 'own_bob',
    decided_by_name: 'Bob',
    requested_at: '2026-10-15T09:00:00.000Z',
    decided_at: '2026-10-15T09:01:00.000Z',
  },
  created_at: '2026-10-15T09:00:00.000Z',
  dispatched_at: null,
  resolved_at: null,
  ...change,
});

describe('each entry in words', () => {
  test('a room request names who asked; a person’s own work names them', () => {
    expect(whoLine(entry())).toBe('Asked by Carol');
    expect(
      whoLine(
        entry({ audience: 'principal', requested_by: null, principal: { id: 'b', name: 'Bob' } }),
      ),
    ).toBe('Bob’s own work');
  });

  test('who let it go ahead: a person, a rule, the reviewer, or nobody had to', () => {
    expect(approvalLine(entry())).toBe('Approved by Bob');
    const decided = (decision: string | null, decided_by: string | null) =>
      approvalLine(
        entry({
          approval: {
            decision,
            decided_by,
            decided_by_name: null,
            requested_at: '2026-10-15T09:00:00.000Z',
            decided_at: null,
          },
        }),
      );
    expect(decided('denied', 'policy')).toBe('Declined by a standing rule');
    expect(decided('approved', 'reviewer')).toBe('Allowed by the reviewer');
    expect(decided(null, null)).toBe('Waiting for permission');
    expect(approvalLine(entry({ approval: null }))).toBe('No permission needed');
  });

  test('the list shows where it went and a fingerprint, never a body', () => {
    const html = renderToStaticMarkup(<AuditEntries entries={[entry()]} />);
    expect(html).toContain('Sent or posted · Team notes');
    expect(html).toContain('Asked by Carol · Approved by Bob');
    expect(html).toContain('abababababab');
    expect(html).toContain('Done');
    expect(html).toContain('from “Post the notes”');
  });

  test('an entry whose title the reader may not see leaves the title out', () => {
    const html = renderToStaticMarkup(<AuditEntries entries={[entry({ job_title: null })]} />);
    expect(html).toContain('Asked by Carol · Approved by Bob');
    expect(html).not.toContain('from “');
  });
});

test('picked days cover the whole of each day, in the person’s own time', () => {
  const range = dayRange('2026-10-01', '2026-10-03');
  expect(new Date(range.since ?? '').getTime()).toBe(new Date(2026, 9, 1).getTime());
  expect(new Date(range.until ?? '').getTime()).toBe(new Date(2026, 9, 4).getTime());
  expect(dayRange('', '')).toEqual({});
  // The days are the profile's, not this browser's.
  expect(dayRange('2026-10-01', '2026-10-03', 'Asia/Kolkata')).toEqual({
    since: '2026-09-30T18:30:00.000Z',
    until: '2026-10-03T18:30:00.000Z',
  });
});

test('owners find the activity log in the room’s settings; members do not', () => {
  const detail = (role: 'owner' | 'member') =>
    ({
      room: { id: 'sp_1', name: 'Launch', my_role: role, agent_name: 'Melete' },
      members: [],
      policy: { approvers: 'requester', agent_turns: 'asked', guests_may_ask: true },
    }) as unknown as RoomDetail;
  const owner = renderToStaticMarkup(
    <RoomSettings onClose={() => {}} onChanged={() => {}} detail={detail('owner')} />,
  );
  expect(owner).toContain('href="#/rooms/sp_1/activity"');
  const member = renderToStaticMarkup(
    <RoomSettings onClose={() => {}} onChanged={() => {}} detail={detail('member')} />,
  );
  expect(member).not.toContain('/activity');
});
