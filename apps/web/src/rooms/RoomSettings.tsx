/**
 * Room → Settings: who answers the permissions the room's requests ask for,
 * whether guests may ask the room's agent, and the accounts the room uses as
 * its own, with who approves what they send. Owners change the room's policy;
 * each member chooses whether to share their own calendar as free/busy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Select, Toggle } from '../design/primitives.tsx';
import { href } from '../router.ts';
import { AddConnection } from '../screens/ConnectionInstall.tsx';
import { SummariesOnlySetting } from '../screens/SummariesOnly.tsx';
import { toast } from '../shell/Shell.tsx';
import {
  type RoomCalendarMode,
  type RoomCalendarSettings,
  type RoomConnection,
  type RoomDetail,
  type RoomPolicy,
  roomsApi,
} from './api.ts';

export const APPROVER_CHOICES: readonly {
  value: RoomPolicy['approvers'];
  title: string;
  sub: string;
}[] = [
  {
    value: 'requester',
    title: 'The person who asked',
    sub: 'Each person answers for their own requests. A guest’s requests are answered by the room’s owners.',
  },
  {
    value: 'any_member',
    title: 'Anyone in the room',
    sub: 'Any member can answer any request’s permissions. Guests never answer.',
  },
  {
    value: 'owners',
    title: 'The room’s owners',
    sub: 'Only owners answer what the agent wants to do for the room.',
  },
];

/** Who approves what the room's own accounts send. Guests never approve. */
export const TEAM_ACCOUNT_APPROVER_CHOICES: readonly {
  value: NonNullable<RoomPolicy['team_account_approvers']>;
  title: string;
}[] = [
  { value: 'any_member', title: 'Anyone in the room' },
  { value: 'owners', title: 'The room’s owners' },
];

/** The rule in one line, as the room's people read it on the room's page. */
export function approversLine(approvers: RoomPolicy['approvers']): string {
  return approvers === 'requester'
    ? 'Permissions are answered by the person who asked.'
    : approvers === 'any_member'
      ? 'Permissions are answered by anyone in the room who is not a guest.'
      : 'Permissions are answered by the room’s owners.';
}

export function RoomSettings({
  onClose,
  detail,
  onChanged,
}: {
  onClose: () => void;
  detail: RoomDetail;
  onChanged: () => void;
}) {
  const owner = detail.room.my_role === 'owner';
  const [policy, setPolicy] = useState(detail.policy);
  // Controls stay enabled while a save is out, so focus stays where the keyboard
  // left it; only the answer to the latest save is applied.
  const latest = useRef(0);

  const [accounts, setAccounts] = useState<RoomConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const loadAccounts = useCallback(() => {
    void roomsApi.connections(detail.room.id).then((result) => {
      if (result.data)
        setAccounts(
          result.data.connections.filter(
            // The tools every room has are not accounts anyone added.
            (entry) => entry.shared_use === 'room' && !entry.builtin,
          ),
        );
    });
  }, [detail.room.id]);
  useEffect(loadAccounts, [loadAccounts]);

  const save = async (change: Partial<RoomPolicy>) => {
    const before = policy;
    setPolicy({ ...policy, ...change });
    const turn = ++latest.current;
    const result = await roomsApi.setPolicy(detail.room.id, change);
    if (turn !== latest.current) return;
    if (!result.data) {
      setPolicy(before);
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save that' });
      return;
    }
    setPolicy(result.data.policy);
    toast({ kind: 'ok', title: 'Saved', sub: 'It applies to what is waiting now, too.' });
    onChanged();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`How ${detail.room.name} works`}
      sub={
        owner
          ? 'Owners choose the room’s policy. Each member chooses their own calendar share.'
          : 'Owners choose the room’s policy. You choose your own calendar share.'
      }
      width={520}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="col" style={{ gap: 18 }}>
        {owner ? (
          <div className="settings-switch">
            <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="settings-choice-title">Activity log</span>
              <span className="people-hint">
                Everything {detail.room.agent_name} did through a connected account in this room:
                who asked, who approved, and when. Only owners see it.
              </span>
            </span>
            <a
              className="btn btn-sm btn-outline"
              href={href(`/rooms/${detail.room.id}/activity`)}
              aria-label="Open the activity log"
            >
              <span>Open</span>
            </a>
          </div>
        ) : null}
        <fieldset className="settings-group" disabled={!owner}>
          <legend className="people-field-label">Who answers permissions</legend>
          <span className="people-hint">
            When {detail.room.agent_name} wants to send, change or spend something for the room, it
            waits for one of these people. What the team accounts send has its own choice below.
          </span>
          {APPROVER_CHOICES.map((choice) => (
            <label key={choice.value} className="settings-choice">
              <input
                type="radio"
                className="radio"
                name="room-approvers"
                value={choice.value}
                checked={policy.approvers === choice.value}
                onChange={() => void save({ approvers: choice.value })}
              />
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="settings-choice-title">{choice.title}</span>
                <span className="people-hint">{choice.sub}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="settings-switch">
          <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="settings-choice-title">Guests may ask {detail.room.agent_name}</span>
            <span className="people-hint">
              Off: guests talk with the room, and only members ask the agent.
            </span>
          </span>
          <Toggle
            on={policy.guests_may_ask}
            disabled={!owner}
            label={`Guests may ask ${detail.room.agent_name}`}
            onChange={(next) => void save({ guests_may_ask: next })}
          />
        </div>
        <SummariesOnlySetting spaceId={detail.room.id} room />
        <div className="col" style={{ gap: 8 }}>
          <span className="people-field-label">Accounts the room uses</span>
          <span className="people-hint">
            The team’s own accounts, such as a shared mailbox or a team GitHub.{' '}
            {detail.room.agent_name} uses them for the room’s requests. Members can also choose to
            share their own calendar as free/busy below.
          </span>
          {accounts === null ? null : accounts.length ? (
            <ul className="col" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
              {accounts.map((entry) => (
                <li key={entry.id} className="settings-choice-title">
                  {entry.label}
                </li>
              ))}
            </ul>
          ) : (
            <span className="people-hint">None yet.</span>
          )}
          <fieldset className="settings-group" disabled={!owner}>
            <legend className="people-field-label">Who approves what the team accounts send</legend>
            <span className="people-hint">
              {(policy.team_account_approvers ?? 'any_member') === 'any_member'
                ? 'The person who asked can approve too. Guests never approve.'
                : 'Guests never approve.'}
            </span>
            {TEAM_ACCOUNT_APPROVER_CHOICES.map((choice) => (
              <label key={choice.value} className="settings-choice">
                <input
                  type="radio"
                  className="radio"
                  name="room-team-account-approvers"
                  value={choice.value}
                  checked={(policy.team_account_approvers ?? 'any_member') === choice.value}
                  onChange={() => void save({ team_account_approvers: choice.value })}
                />
                <span className="settings-choice-title">{choice.title}</span>
              </label>
            ))}
          </fieldset>
          {owner ? (
            adding ? (
              <AddConnection
                spaceId={detail.room.id}
                title="Add an account to this room"
                onInstalled={() => {
                  setAdding(false);
                  loadAccounts();
                }}
              />
            ) : (
              <Button variant="outline" onClick={() => setAdding(true)}>
                Add an account
              </Button>
            )
          ) : null}
        </div>
        {detail.room.my_role !== 'guest' ? (
          <MyCalendarShare roomId={detail.room.id} agentName={detail.room.agent_name} />
        ) : null}
      </div>
    </Dialog>
  );
}

/** These settings belong to the signed-in member, including when they are not an owner. */
function MyCalendarShare({ roomId, agentName }: { roomId: string; agentName: string }) {
  const [settings, setSettings] = useState<RoomCalendarSettings | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [mode, setMode] = useState<RoomCalendarMode>('freebusy');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void roomsApi.calendarShares(roomId).then((result) => {
      if (!live) return;
      if (!result.data) {
        setError(result.error ?? result.unavailable ?? 'Couldn’t read your calendar sharing');
        return;
      }
      setSettings(result.data);
      setConnectionId(result.data.share?.connection_id ?? result.data.connections[0]?.id ?? '');
      setMode(result.data.share?.mode ?? 'freebusy');
    });
    return () => {
      live = false;
    };
  }, [roomId]);

  const share = async (enabled: boolean, nextId = connectionId, nextMode = mode) => {
    if (!settings || saving) return;
    setSaving(true);
    const result = enabled
      ? await roomsApi.shareCalendar(roomId, nextId, nextMode)
      : await roomsApi.revokeCalendarShare(roomId);
    setSaving(false);
    if (!result.data) {
      toast({
        kind: 'err',
        title: result.error ?? result.unavailable ?? 'Couldn’t save your share',
      });
      return;
    }
    setSettings({
      ...settings,
      share: 'share' in result.data ? result.data.share : null,
    });
    setConnectionId(nextId);
    setMode(nextMode);
    toast({ kind: 'ok', title: enabled ? 'Calendar shared' : 'Calendar share revoked' });
  };

  const selected = settings?.connections.find((entry) => entry.id === connectionId);
  return (
    <fieldset className="settings-group" disabled={saving || !settings}>
      <legend className="people-field-label">My calendar</legend>
      <span className="people-hint">
        Share when you are busy with {agentName}. Event titles, locations and attendees stay
        private. You can revoke access at any time. Leaving the room ends access too.
      </span>
      {error ? (
        <p className="rooms-error" role="alert">
          {error}
        </p>
      ) : !settings ? (
        <span className="people-hint">Loading your calendars…</span>
      ) : settings.connections.length ? (
        <>
          <Select
            label="My calendar to share"
            value={connectionId}
            options={settings.connections.map((entry) => ({ value: entry.id, label: entry.label }))}
            onChange={(id) => {
              const next = settings.connections.find((entry) => entry.id === id);
              const nextMode = next?.can_add ? mode : 'freebusy';
              if (settings.share) void share(true, id, nextMode);
              else {
                setConnectionId(id);
                setMode(nextMode);
              }
            }}
          />
          <div className="settings-switch">
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="settings-choice-title">Share my free/busy</span>
            </span>
            <Toggle
              label="Share my calendar free/busy with this room"
              on={Boolean(settings.share)}
              disabled={saving}
              onChange={(enabled) => void share(enabled)}
            />
          </div>
          <div className="settings-switch">
            <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span className="settings-choice-title">Let the room add events</span>
              <span className="people-hint">
                {selected?.can_add
                  ? 'Only you approve each event added to your calendar.'
                  : 'This calendar is read-only.'}
              </span>
            </span>
            <Toggle
              label="Let the room add events to my calendar with my approval"
              on={mode === 'freebusy_add'}
              disabled={saving || !selected?.can_add}
              onChange={(enabled) => {
                const nextMode = enabled ? 'freebusy_add' : 'freebusy';
                if (settings.share) void share(true, connectionId, nextMode);
                else setMode(nextMode);
              }}
            />
          </div>
        </>
      ) : (
        <span className="people-hint">Connect a calendar in your own space to share it here.</span>
      )}
    </fieldset>
  );
}
