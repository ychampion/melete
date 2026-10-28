/**
 * Room settings offer who approves what the room's own accounts send, under
 * the list of those accounts, with "Anyone in the room" chosen by default.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomDetail } from './api.ts';
import { RoomSettings } from './RoomSettings.tsx';

const detail = (
  policy: Partial<RoomDetail['policy']>,
  role: RoomDetail['room']['my_role'] = 'owner',
) =>
  ({
    room: { id: 'sp_1', name: 'Launch', my_role: role, agent_name: 'Melete' },
    members: [],
    policy: { approvers: 'requester', agent_turns: 'asked', guests_may_ask: true, ...policy },
  }) as unknown as RoomDetail;

const checkedTeamChoice = (html: string) =>
  /name="room-team-account-approvers" checked="" value="([a-z_]+)"/.exec(html)?.[1] ?? null;

test('who approves what the team accounts send is a choice, anyone in the room by default', () => {
  const html = renderToStaticMarkup(
    <RoomSettings onClose={() => {}} onChanged={() => {}} detail={detail({})} />,
  );
  expect(html).toContain('Who approves what the team accounts send');
  expect(html).toContain('Anyone in the room');
  expect(html).toContain('The room’s owners');
  expect(checkedTeamChoice(html)).toBe('any_member');
  expect(html).toContain('The person who asked can approve too.');
  const owners = renderToStaticMarkup(
    <RoomSettings
      onClose={() => {}}
      onChanged={() => {}}
      detail={detail({ team_account_approvers: 'owners' })}
    />,
  );
  expect(checkedTeamChoice(owners)).toBe('owners');
  // Under the owners' rule, the person who asked approves only if they are an owner.
  expect(owners).not.toContain('The person who asked can approve too.');
  expect(owners).toContain('Guests never approve.');
});

test('members choose their own calendar sharing even when they do not own the room', () => {
  const html = renderToStaticMarkup(
    <RoomSettings onClose={() => {}} onChanged={() => {}} detail={detail({}, 'member')} />,
  );
  expect(html).toContain('<legend class="people-field-label">My calendar</legend>');
  expect(html).toContain('Event titles, locations and attendees stay private.');
  expect(html).toContain('Leaving the room ends access too.');
});

test('guests are not offered a personal calendar share', () => {
  const html = renderToStaticMarkup(
    <RoomSettings onClose={() => {}} onChanged={() => {}} detail={detail({}, 'guest')} />,
  );
  expect(html).not.toContain('<legend class="people-field-label">My calendar</legend>');
  expect(html).not.toContain('Loading your calendars');
});
