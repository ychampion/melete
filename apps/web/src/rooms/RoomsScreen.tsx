/**
 * Rooms: shared spaces where several people talk to one agent. This is the
 * list of rooms the person is in, and where a new one is made. `#/rooms/{id}`
 * opens a room, and `#/rooms/{id}/{thread}` one of its threads.
 */
import { useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button, Count, Dialog, Field, Input } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { roomsApi } from './api.ts';
import { RoomView } from './RoomView.tsx';
import './rooms.css';

const ROLE_WORDS = { owner: 'Owner', member: 'Member', guest: 'Guest' } as const;

/** The rooms route: the list, a room, or one of its threads. */
export function RoomsRoute({ parts }: { parts: string[] }) {
  const [, roomId, threadId] = parts;
  if (!roomId) return <RoomsScreen />;
  return <RoomView key={roomId} roomId={roomId} threadId={threadId ?? null} />;
}

export function RoomsScreen() {
  const rooms = useLoad(() => roomsApi.list(), []);
  const [making, setMaking] = useState(false);
  const list = rooms.data?.rooms ?? [];

  return (
    <Shell title="Rooms" rail={false}>
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Rooms</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              Talk with other people and one shared agent. Everyone in a room sees its threads and
              what the agent does there.
            </p>
          </div>
          <Button icon="plus" onClick={() => setMaking(true)}>
            New room
          </Button>
        </div>
        {rooms.error ? (
          <div className="row" style={{ gap: 12, fontSize: 13, color: 'var(--secondary)' }}>
            <span>Couldn’t read your rooms. {rooms.error}</span>
            <Button size="sm" variant="outline" onClick={rooms.reload}>
              Try again
            </Button>
          </div>
        ) : null}
        <div className="card-12" style={{ overflow: 'hidden' }}>
          {list.map((room, index) => (
            <a
              key={room.id}
              className="list-row rooms-row"
              href={href(`/rooms/${room.id}`)}
              style={index === 0 ? { borderTop: 0 } : undefined}
            >
              <span className="room-tile" aria-hidden="true">
                {Array.from(room.name.trim())[0]?.toUpperCase() ?? '#'}
              </span>
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="clamp1 rooms-name">{room.name}</span>
                <span className="clamp1 rooms-meta">
                  {room.purpose ? `${room.purpose} · ` : ''}
                  {ROLE_WORDS[room.my_role]}
                </span>
              </span>
              {room.unread > 0 ? (
                <span title={`${room.unread} new`}>
                  <Count n={room.unread} active />
                  <span className="sr-only"> new messages</span>
                </span>
              ) : null}
              <span style={{ color: 'var(--secondary)', display: 'flex' }}>
                <Icon name="chevronRight" size={16} />
              </span>
            </a>
          ))}
          {!rooms.loading && list.length === 0 && !rooms.error ? (
            <div className="rooms-empty">
              Make a room for a team or a project, add the people in it, and ask its agent together.
            </div>
          ) : null}
        </div>
      </div>
      <NewRoomDialog open={making} onClose={() => setMaking(false)} />
    </Shell>
  );
}

function NewRoomDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setName('');
    setPurpose('');
    setError(null);
    onClose();
  };
  const make = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const result = await roomsApi.create(name.trim(), purpose);
    setBusy(false);
    if (!result.data) {
      setError(result.error ?? result.unavailable);
      return;
    }
    toast({ kind: 'ok', title: `${result.data.room.name} is ready` });
    close();
    navigate(`/rooms/${result.data.room.id}`);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New room"
      sub="You own the room and choose who is in it. It has its own agent, files and tools."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={make} loading={busy} disabled={!name.trim() || busy}>
            Make room
          </Button>
        </>
      }
    >
      <form
        className="col"
        style={{ gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            maxLength={120}
            placeholder="Design"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Purpose" hint="Optional. Everyone in the room sees it.">
          <textarea
            className="textarea"
            value={purpose}
            maxLength={500}
            rows={3}
            placeholder="What the room is for"
            onChange={(event) => setPurpose(event.target.value)}
          />
        </Field>
        {error ? <p className="rooms-error">{error}</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
