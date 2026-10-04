/**
 * Room → Settings: who answers the permissions the room's requests ask for,
 * whether guests may ask the room's agent, and the accounts the room uses as
 * its own. Everyone in the room reads them; owners change them. A change
 * applies to permissions already waiting.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Toggle } from '../design/primitives.tsx';
import { AddConnection } from '../screens/ConnectionInstall.tsx';
import { toast } from '../shell/Shell.tsx';
import { type RoomConnection, type RoomDetail, type RoomPolicy, roomsApi } from './api.ts';

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
    sub: 'Owners see and answer everything the agent wants to do through the room’s connections.',
  },
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
          ? 'Everyone in the room can read these. Only owners change them.'
          : 'The room’s owners choose these.'
      }
      width={520}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="col" style={{ gap: 18 }}>
        <fieldset className="settings-group" disabled={!owner}>
          <legend className="people-field-label">Who answers permissions</legend>
          <span className="people-hint">
            When {detail.room.agent_name} wants to send, change or spend something through the
            room’s connections, it waits for one of these people.
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
        <div className="col" style={{ gap: 8 }}>
          <span className="people-field-label">Accounts the room uses</span>
          <span className="people-hint">
            The team’s own accounts, such as a shared mailbox or a team GitHub.{' '}
            {detail.room.agent_name} uses them for the room’s requests, and the rule above answers
            what it sends. A person’s own accounts stay theirs: the room hands them the task
            instead.
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
      </div>
    </Dialog>
  );
}
