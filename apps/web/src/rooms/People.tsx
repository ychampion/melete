/**
 * Room → People: who is in the room and who is looking at it now, the name
 * the person goes by here, adding people (owners), removing them (owners) and
 * leaving. Everyone is shown as `Name <email>`.
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Input } from '../design/primitives.tsx';
import { toast } from '../shell/Shell.tsx';
import { type Me, type Person, type RoomDetail, roomsApi } from './api.ts';
import { PersonAvatar, Who } from './parts.tsx';
import { splitLabel } from './reduce.ts';

const ROLE_WORDS = { owner: 'Owner', member: 'Member', guest: 'Guest' } as const;

export function People({
  open,
  onClose,
  detail,
  me,
  present,
  onChanged,
  onLeft,
}: {
  open: boolean;
  onClose: () => void;
  detail: RoomDetail;
  me: Me | null;
  present: ReadonlySet<string>;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const owner = detail.room.my_role === 'owner';
  const mine = detail.members.find((member) => member.principal_id === me?.id) ?? null;
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const close = () => {
    setLeaving(false);
    onClose();
  };

  const remove = async (principalId: string, label: string) => {
    setBusy(principalId);
    const result = await roomsApi.removeMember(detail.room.id, principalId);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t remove them' });
      return;
    }
    toast({ kind: 'ok', title: `${splitLabel(label).name} is no longer in ${detail.room.name}` });
    onChanged();
  };

  const leave = async () => {
    if (!me) return;
    setBusy(me.id);
    const result = await roomsApi.removeMember(detail.room.id, me.id);
    setBusy(null);
    if (!result.data) {
      toast({
        kind: 'err',
        title: result.error ?? result.unavailable ?? 'Couldn’t leave the room',
      });
      return;
    }
    toast({ kind: 'ok', title: `You left ${detail.room.name}` });
    setLeaving(false);
    onLeft();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`People in ${detail.room.name}`}
      sub={`${detail.members.length} ${detail.members.length === 1 ? 'person' : 'people'} and ${detail.room.agent_name}, the room’s agent.`}
      width={520}
      footer={
        leaving ? (
          <>
            <span className="people-leave-note">
              You stop seeing this room at once. What you said stays in it.
            </span>
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={busy === me?.id} onClick={() => void leave()}>
              Leave room
            </Button>
          </>
        ) : (
          <>
            {mine && mine.role !== 'owner' ? (
              <Button variant="ghost" onClick={() => setLeaving(true)}>
                Leave room
              </Button>
            ) : null}
            <Button onClick={close}>Done</Button>
          </>
        )
      }
    >
      <div className="col" style={{ gap: 18 }}>
        {mine ? <YourName label={mine.display_name} onSaved={onChanged} /> : null}
        <ul className="people-list" aria-label="People in this room">
          {detail.members.map((member) => {
            const self = member.principal_id === me?.id;
            return (
              <li key={member.principal_id} className="people-row">
                <PersonAvatar id={member.principal_id} label={member.display_name} size={32} />
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="people-label">
                    <Who label={member.display_name} />
                    {self ? <span className="people-you"> (you)</span> : null}
                  </span>
                  <span className="people-meta">
                    {ROLE_WORDS[member.role]}
                    {present.has(member.principal_id) ? ' · Here now' : ''}
                  </span>
                </span>
                {owner && !self && member.role !== 'owner' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === member.principal_id}
                    aria-label={`Remove ${member.display_name}`}
                    onClick={() => void remove(member.principal_id, member.display_name)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {owner ? <AddPeople detail={detail} onAdded={onChanged} /> : null}
      </div>
    </Dialog>
  );
}

/** The name the person goes by in rooms; their email always follows it. */
function YourName({ label, onSaved }: { label: string; onSaved: () => void }) {
  const { name, email } = splitLabel(label);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const result = await roomsApi.rename(value.trim() || null);
    setBusy(false);
    if (!result.data) {
      setError(result.error ?? result.unavailable);
      return;
    }
    setError(null);
    setEditing(false);
    onSaved();
  };

  if (!editing)
    return (
      <div className="people-you-row">
        <span>
          You appear as <Who label={label} />
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          Change name
        </Button>
      </div>
    );
  return (
    <form
      className="col people-you-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor="room-name-field" className="people-field-label">
        Your name in rooms
      </label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Input
          id="room-name-field"
          value={value}
          maxLength={80}
          autoFocus
          width="min(100%, 260px)"
          error={error !== null}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" loading={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <span className="people-hint">
        {error ?? `People see it with your email: ${value.trim() || name} <${email ?? ''}>`}
      </span>
    </form>
  );
}

/** Owners add people who have an account on this installation. */
function AddPeople({ detail, onAdded }: { detail: RoomDetail; onAdded: () => void }) {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void roomsApi.people(query).then((result) => {
        if (live && result.data) setPeople(result.data.people);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const inRoom = new Set(detail.members.map((member) => member.principal_id));
  const choices = (people ?? []).filter((person) => !inRoom.has(person.id));

  const add = async (person: Person) => {
    setBusy(person.id);
    const result = await roomsApi.addMember(detail.room.id, person.id);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t add them' });
      return;
    }
    toast({ kind: 'ok', title: `${person.display_name} joined ${detail.room.name}` });
    onAdded();
  };

  return (
    <section className="col" style={{ gap: 8 }} aria-labelledby="room-add-people">
      <h4 id="room-add-people" className="people-field-label">
        Add people
      </h4>
      <Input
        icon="search"
        value={query}
        placeholder="Name or email"
        aria-label="Find people by name or email"
        onChange={(event) => setQuery(event.target.value)}
      />
      {choices.length > 0 ? (
        <ul className="people-list" aria-label="People you can add">
          {choices.slice(0, 8).map((person) => {
            const label = `${person.display_name} <${person.email}>`;
            return (
              <li key={person.id} className="people-row">
                <PersonAvatar id={person.id} label={label} size={28} />
                <span className="grow people-label" style={{ minWidth: 0 }}>
                  <Who label={label} />
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  icon="plus"
                  loading={busy === person.id}
                  aria-label={`Add ${label}`}
                  onClick={() => void add(person)}
                >
                  Add
                </Button>
              </li>
            );
          })}
        </ul>
      ) : people ? (
        <p className="people-hint">
          {query.trim()
            ? 'Nobody else here matches that.'
            : 'Everyone with an account here is already in the room.'}
        </p>
      ) : null}
    </section>
  );
}
