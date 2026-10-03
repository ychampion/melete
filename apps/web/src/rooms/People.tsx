/**
 * Room → People: who is in the room and who is looking at it now, the name
 * the person goes by here, adding people (owners), inviting guests for a while
 * (owners), removing people (owners) and leaving. Everyone is shown as
 * `Name <handle>`: the handle is the room's own code for a person.
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Input, Select } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { toast } from '../shell/Shell.tsx';
import {
  type InviteCreated,
  inviteLink,
  type Me,
  type Person,
  type RoomDetail,
  type RoomInvite,
  roomsApi,
} from './api.ts';
import { PersonAvatar, Who } from './parts.tsx';
import { dayOf, splitLabel } from './reduce.ts';

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
  const [leaving, setLeaving] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The footer's buttons change in place, so focus moves to what replaced the one pressed.
  useEffect(() => {
    if (leaving === null) return;
    document.getElementById(leaving ? 'room-leave-cancel' : 'room-leave')?.focus();
  }, [leaving]);

  const close = () => {
    setLeaving(null);
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
    setLeaving(null);
    onLeft();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`People in ${detail.room.name}`}
      sub={`${detail.members.length} ${detail.members.length === 1 ? 'person' : 'people'} and ${detail.room.agent_name}, the room’s agent.`}
      width={560}
      footer={
        leaving ? (
          <>
            <span className="people-leave-note">
              You stop seeing this room at once. What you said stays in it.
            </span>
            <Button id="room-leave-cancel" variant="ghost" onClick={() => setLeaving(false)}>
              Cancel
            </Button>
            <Button variant="destructive" loading={busy === me?.id} onClick={() => void leave()}>
              Leave room
            </Button>
          </>
        ) : (
          <>
            {mine && mine.role !== 'owner' ? (
              <Button id="room-leave" variant="ghost" onClick={() => setLeaving(true)}>
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
            const meta = [
              ROLE_WORDS[member.role],
              member.role === 'guest' && member.expires_at
                ? `until ${dayOf(member.expires_at)}`
                : null,
              member.email ?? null,
              present.has(member.principal_id) ? 'Here now' : null,
            ].filter(Boolean);
            return (
              <li key={member.principal_id} className="people-row">
                <PersonAvatar id={member.principal_id} label={member.display_name} size={32} />
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="people-label">
                    <Who label={member.display_name} />
                    {self ? <span className="people-you"> (you)</span> : null}
                  </span>
                  <span className="people-meta">{meta.join(' · ')}</span>
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
        {owner ? <Guests roomId={detail.room.id} /> : null}
      </div>
    </Dialog>
  );
}

/** The name the person goes by in rooms; the room's handle for them always follows it. */
function YourName({ label, onSaved }: { label: string; onSaved: () => void }) {
  const { name, handle } = splitLabel(label);
  // "Someone" is what a room says for a person who chose no name.
  const chosen = name === 'Someone' ? '' : name;
  const [editing, setEditing] = useState<boolean | null>(null);
  useEffect(() => {
    if (editing === false) document.getElementById('room-rename')?.focus();
  }, [editing]);
  const [value, setValue] = useState(chosen);
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
          id="room-rename"
          size="sm"
          variant="outline"
          onClick={() => {
            setValue(chosen);
            setEditing(true);
          }}
        >
          {chosen ? 'Change name' : 'Choose a name'}
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
        {error ??
          `People here see you as ${value.trim() || 'Someone'} <${handle ?? '…'}>. The code after your name is this room’s, so nobody else can pass as you.`}
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
          {choices.slice(0, 8).map((person) => (
            <li key={person.id} className="people-row">
              <PersonAvatar id={person.id} label={person.display_name} size={28} />
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="people-label who-name">{person.display_name}</span>
                <span className="people-meta">{person.email}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                icon="plus"
                loading={busy === person.id}
                aria-label={`Add ${person.display_name}, ${person.email}`}
                onClick={() => void add(person)}
              >
                Add
              </Button>
            </li>
          ))}
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

const DAYS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

const INVITE_WORDS: Record<RoomInvite['state'], string> = {
  open: 'Not used yet',
  accepted: 'Joined',
  expired: 'Ran out',
  withdrawn: 'Withdrawn',
};

/**
 * Owners invite someone from outside the installation as a guest, for a
 * number of days. Melete makes a link that works once and shows it once; the
 * owner sends it themselves.
 */
function Guests({ roomId }: { roomId: string }) {
  const invites = useLoad(() => roomsApi.invites(roomId), [roomId]);
  const [email, setEmail] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<InviteCreated | null>(null);

  const invite = async () => {
    if (!email.trim() || busy) return;
    setBusy('new');
    const result = await roomsApi.invite(roomId, email.trim(), Number(days));
    setBusy(null);
    if (!result.data) {
      setError(result.error ?? result.unavailable);
      return;
    }
    setError(null);
    setEmail('');
    setMade(result.data);
    invites.reload();
  };
  const withdraw = async (item: RoomInvite) => {
    setBusy(item.id);
    const result = await roomsApi.withdrawInvite(roomId, item.id);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t withdraw it' });
      return;
    }
    if (made?.invite.id === item.id) setMade(null);
    toast({ kind: 'ok', title: `The invite for ${item.email} no longer works` });
    invites.reload();
  };

  const list = invites.data?.invites ?? [];
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="room-guests">
      <div className="col" style={{ gap: 2 }}>
        <h4 id="room-guests" className="people-field-label">
          Invite a guest
        </h4>
        <span className="people-hint">
          For someone without an account here. A guest reads and posts in this room only, never
          answers a permission, and leaves when their days are up.
        </span>
      </div>
      <form
        className="people-invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            value={email}
            maxLength={254}
            placeholder="name@example.com"
            error={error !== null}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="For">
          <Select label="How long they stay" value={days} onChange={setDays} options={DAYS} />
        </Field>
        <Button type="submit" variant="outline" loading={busy === 'new'} disabled={!email.trim()}>
          Make invite link
        </Button>
      </form>
      {error ? (
        <p className="rooms-error" role="alert">
          {error}
        </p>
      ) : null}
      {made ? <InviteLink created={made} /> : null}
      {list.length > 0 ? (
        <ul className="people-list" aria-label="Guest invites">
          {list.map((item) => (
            <li key={item.id} className="people-row">
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="people-label who-name">{item.email}</span>
                <span className="people-meta">
                  {INVITE_WORDS[item.state]}
                  {item.state === 'open' || item.state === 'accepted'
                    ? ` · until ${dayOf(item.expires_at)}`
                    : ''}
                </span>
              </span>
              {item.state === 'open' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === item.id}
                  aria-label={`Withdraw the invite for ${item.email}`}
                  onClick={() => void withdraw(item)}
                >
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The link, shown once: copy it and send it yourself. */
function InviteLink({ created }: { created: InviteCreated }) {
  const link = inviteLink(created, window.location.origin);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      toast({ kind: 'err', title: 'Couldn’t copy it. Select the link and copy it instead.' });
    }
  };
  return (
    <div className="people-link" role="status">
      <span className="people-field-label">Send this link to {created.invite.email}</span>
      <div className="row" style={{ gap: 8, minWidth: 0 }}>
        <Input
          readOnly
          value={link}
          aria-label="Invite link"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button size="sm" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <span className="people-hint">
        It works once, until {dayOf(created.invite.expires_at)}, and this is the only time it is
        shown. Their place in the room ends then too.
      </span>
    </div>
  );
}
