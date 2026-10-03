/**
 * Room → Settings: who answers the permissions the room's requests ask for,
 * and whether guests may ask the room's agent. Everyone in the room reads
 * them; owners change them. A change applies to permissions already waiting.
 */
import { useRef, useState } from 'react';
import { Button, Dialog, Toggle } from '../design/primitives.tsx';
import { toast } from '../shell/Shell.tsx';
import { type RoomDetail, type RoomPolicy, roomsApi } from './api.ts';

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
      </div>
    </Dialog>
  );
}
