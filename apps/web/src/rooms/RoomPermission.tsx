/**
 * A permission a room's request waits on, as everyone in the room sees it:
 * the same card a person's own permissions use, with the draft, the file and
 * the facts of exactly what would happen, then who may answer it. Only the
 * people the room's rule names get answers, and only the ones the card offers;
 * a room never offers a standing rule.
 */
import { PermissionCard } from '../chat/parts.tsx';
import type { Permission } from '../experience/types.ts';
import type { RoomPermission } from './api.ts';
import { Who } from './parts.tsx';
import { canAnswer } from './reduce.ts';

/** What this person may answer from the room's page: nothing unless the rule names them. */
export function answerableOptions(
  permission: RoomPermission,
  me: string | null,
): ('allow_once' | 'deny')[] {
  if (!canAnswer(permission, me)) return [];
  return permission.options.filter(
    (option): option is 'allow_once' | 'deny' => option === 'allow_once' || option === 'deny',
  );
}

export function RoomPermissionCard({
  permission,
  me,
  busy,
  onAnswer,
}: {
  permission: RoomPermission;
  me: string | null;
  busy: boolean;
  onAnswer: (permission: RoomPermission, option: 'allow_once' | 'deny') => void;
}) {
  const options = answerableOptions(permission, me);
  // The card is drawn whole for everyone; its answers only for those the rule names.
  const card = { ...permission, options } as unknown as Permission;
  return (
    <div className="col room-permission-card">
      <PermissionCard
        permission={card}
        decided={null}
        bare={options.length === 0}
        busy={busy}
        onDecide={(option) => {
          if (option === 'allow_once' || option === 'deny') onAnswer(permission, option);
        }}
      />
      {permission.eligible_approvers && permission.eligible_approvers.length > 0 ? (
        <span className="room-permission-who">
          Who can answer:{' '}
          {permission.eligible_approvers.map((person, index) => (
            <span key={person.principal_id}>
              {index > 0 ? ', ' : null}
              <Who label={person.display_name} />
              {person.principal_id === me ? ' (you)' : null}
            </span>
          ))}
        </span>
      ) : (
        <span className="room-permission-who">Nobody in the room can answer this now.</span>
      )}
    </div>
  );
}
