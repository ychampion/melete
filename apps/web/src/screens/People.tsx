/**
 * Settings → People, shown in a shared space. Everyone in the space is listed;
 * its owner can remove someone. Removing a person ends their sessions in the
 * space and stops their work there; what they made stays with the space.
 */
import { useState } from 'react';
import { LoadError } from '../design/LoadError.tsx';
import { Avatar, Badge, Button, Dialog } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { SpaceMember, SpaceMembers } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const initials = (email: string) => email.slice(0, 2).toUpperCase();

export function PeopleTab({
  people,
  error,
  onRetry,
  onChanged,
}: {
  people: SpaceMembers | null;
  error: string | null;
  onRetry: () => void;
  onChanged: (next: SpaceMembers) => void;
}) {
  const [removing, setRemoving] = useState<SpaceMember | null>(null);
  const [working, setWorking] = useState(false);
  const owner = people?.space.role === 'owner';
  const remove = async (member: SpaceMember) => {
    if (!people) return;
    setWorking(true);
    const result = await adapter.removeMember(member.principal_id);
    setWorking(false);
    if (result.data === null) {
      toast({ kind: 'err', title: 'Couldn’t remove', sub: result.error ?? result.unavailable });
      return;
    }
    setRemoving(null);
    onChanged({
      ...people,
      members: people.members.filter((entry) => entry.principal_id !== member.principal_id),
    });
    toast({ kind: 'ok', title: `${member.email} was removed`, sub: people.space.name });
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
        Everyone in {people?.space.name ?? 'this space'}.{' '}
        {owner
          ? 'Removing someone signs them out of this space and stops their work here. What they made stays.'
          : 'Its owner looks after who is here.'}
      </p>
      {error ? <LoadError what="the people in this space" error={error} onRetry={onRetry} /> : null}
      <div className="card-12" style={{ overflow: 'hidden' }}>
        {(people?.members ?? []).map((member, index) => (
          <div
            key={member.principal_id}
            className="list-row"
            style={{ minHeight: 60, ...(index === 0 ? { borderTop: 0 } : {}) }}
          >
            <Avatar initials={initials(member.email)} size={32} />
            <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span
                className="clamp1"
                style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
              >
                {member.email}
                {member.you ? ' (you)' : ''}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {member.role === 'owner' ? 'Owner' : 'Member'}
              </span>
            </div>
            {member.role === 'owner' ? (
              <Badge tone="outline">Owner</Badge>
            ) : owner ? (
              <Button size="sm" variant="outline" onClick={() => setRemoving(member)}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {removing ? (
        <Dialog
          open
          onClose={working ? () => {} : () => setRemoving(null)}
          icon="user"
          tone="danger"
          title={`Remove ${removing.email}?`}
          sub={`They are signed out of ${people?.space.name ?? 'this space'} and their work here stops. The chats, plans and files they made stay with the space.`}
          footer={
            <>
              <Button variant="outline" disabled={working} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={working}
                disabled={working}
                onClick={() => void remove(removing)}
              >
                Remove
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
