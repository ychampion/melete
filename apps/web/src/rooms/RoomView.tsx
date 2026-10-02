/**
 * One room: its threads on the left, the open thread (or a new one) on the
 * right, who is looking at it now, and its people. On the phone the list and
 * the thread take turns.
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Button } from '../design/primitives.tsx';
import { href, navigate } from '../router.ts';
import { Shell } from '../shell/Shell.tsx';
import { type Me, type RoomDetail, type RoomThread, roomsApi } from './api.ts';
import { People } from './People.tsx';
import { PersonAvatar } from './parts.tsx';
import { RoomMemory } from './RoomMemory.tsx';
import { approversLine, RoomSettings } from './RoomSettings.tsx';
import { dayOf } from './reduce.ts';
import { NewThread, Thread } from './Thread.tsx';

/** How often an open room says the person is still looking at it. */
const HEARTBEAT_MS = 20_000;

let knownMe: Me | null = null;

const peopleCount = (n: number) => (n === 1 ? '1 person' : `${n} people`);

function when(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function RoomView({ roomId, threadId }: { roomId: string; threadId: string | null }) {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [threads, setThreads] = useState<RoomThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [me, setMe] = useState<Me | null>(knownMe);
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped when the room's rule changes, so the open thread reads who may answer now.
  const [ruleChanged, setRuleChanged] = useState(0);

  const readRoom = useCallback(async () => {
    const result = await roomsApi.detail(roomId);
    if (result.data) {
      setDetail(result.data);
      setPresent(new Set(result.data.members.filter((m) => m.present).map((m) => m.principal_id)));
      setError(null);
    } else if (result.status === 404 || result.status === 403) setGone(true);
    else setError(result.error ?? result.unavailable);
  }, [roomId]);
  const readThreads = useCallback(async () => {
    const result = await roomsApi.threads(roomId);
    if (result.data) setThreads(result.data.threads);
  }, [roomId]);

  useEffect(() => {
    void readRoom();
    void readThreads();
    if (!knownMe)
      void roomsApi.me().then((result) => {
        if (result.data) {
          knownMe = result.data.owner;
          setMe(result.data.owner);
        }
      });
  }, [readRoom, readThreads]);

  // Presence: say we are here while the page is open and visible, and show who else is.
  useEffect(() => {
    if (gone) return;
    let live = true;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void roomsApi.presence(roomId).then((result) => {
        if (!live) return;
        if (result.data) setPresent(new Set(result.data.present));
        else if (result.status === 404 || result.status === 403) setGone(true);
      });
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [roomId, gone]);

  const room = detail?.room ?? null;
  const here = (detail?.members ?? []).filter((member) => present.has(member.principal_id));
  const opened = threadId !== null;
  const guest = room?.my_role === 'guest';
  const myPlace = detail?.members.find((member) => member.principal_id === me?.id) ?? null;

  if (gone)
    return (
      <Shell title="Rooms" rail={false} phoneBack={() => navigate('/rooms')}>
        <div className="page">
          <div className="col" style={{ gap: 12, maxWidth: 520 }}>
            <h1>This room is closed to you</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              You are no longer in this room, or it was removed.
            </p>
            <div>
              <Button variant="outline" onClick={() => navigate('/rooms')}>
                Back to rooms
              </Button>
            </div>
          </div>
        </div>
      </Shell>
    );

  return (
    <Shell
      title={room?.name ?? 'Room'}
      rail={false}
      phoneBack={() => navigate(opened ? `/rooms/${roomId}` : '/rooms')}
      phoneSub={
        room ? `${peopleCount(detail?.members.length ?? 0)} · ${room.agent_name}` : undefined
      }
    >
      <div className="room" data-thread={opened ? 'open' : undefined}>
        <header className="room-head">
          <div className="col" style={{ gap: 4, minWidth: 0 }}>
            <a className="room-crumb" href={href('/rooms')}>
              Rooms
            </a>
            <h1 className="room-title clamp1">{room?.name ?? ' '}</h1>
            {room?.purpose ? <p className="room-purpose">{room.purpose}</p> : null}
            {detail ? (
              <p className="room-rule">
                {guest && myPlace?.expires_at
                  ? `You are a guest here until ${dayOf(myPlace.expires_at)}. `
                  : ''}
                {approversLine(detail.policy.approvers)}
              </p>
            ) : null}
          </div>
          <div className="row room-head-actions">
            {here.length > 0 ? (
              <ul className="room-here" aria-label="Looking at this room now">
                {here.slice(0, 5).map((member) => (
                  <li key={member.principal_id} title={member.display_name}>
                    <PersonAvatar id={member.principal_id} label={member.display_name} size={26} />
                    <span className="sr-only">{member.display_name}</span>
                  </li>
                ))}
                {here.length > 5 ? <li className="room-here-more">+{here.length - 5}</li> : null}
              </ul>
            ) : null}
            <Button
              variant="outline"
              icon="bookmark"
              onClick={() => setMemoryOpen(true)}
              disabled={!detail}
            >
              Memory
            </Button>
            <Button
              variant="outline"
              icon="sliders"
              onClick={() => setSettingsOpen(true)}
              disabled={!detail}
            >
              Settings
            </Button>
            <Button
              variant="outline"
              icon="users"
              onClick={() => setPeopleOpen(true)}
              disabled={!detail}
            >
              People
            </Button>
          </div>
        </header>
        {error ? (
          <div className="row room-error">
            <span>Couldn’t read this room. {error}</span>
            <Button size="sm" variant="outline" onClick={() => void readRoom()}>
              Try again
            </Button>
          </div>
        ) : null}
        <div className="room-body">
          <nav className="room-threads" aria-label="Threads">
            <a
              className="room-thread-new"
              href={href(`/rooms/${roomId}/new`)}
              aria-current={threadId === 'new' ? 'page' : undefined}
            >
              <Icon name="plus" size={16} />
              <span>New thread</span>
            </a>
            {(threads ?? []).map((thread) => (
              <a
                key={thread.id}
                className="room-thread-row"
                href={href(`/rooms/${roomId}/${thread.id}`)}
                aria-current={thread.id === threadId ? 'page' : undefined}
              >
                <span className="clamp1 room-thread-title">{thread.title}</span>
                <span className="clamp1 room-thread-meta">
                  {when(thread.last_activity_at)} · {thread.created_by.display_name}
                </span>
              </a>
            ))}
            {threads && threads.length === 0 ? (
              <p className="room-threads-empty">
                Threads start with a message. Ask the agent, or talk it over with the room first.
              </p>
            ) : null}
          </nav>
          <section className="room-thread" aria-label="Thread">
            {!detail ? null : threadId && threadId !== 'new' ? (
              <Thread
                key={threadId}
                roomId={roomId}
                threadId={threadId}
                detail={detail}
                me={me}
                ruleChanged={ruleChanged}
                onActivity={readThreads}
                onGone={() => void readRoom()}
              />
            ) : (
              <NewThread
                roomId={roomId}
                detail={detail}
                onStarted={(thread) => {
                  void readThreads();
                  navigate(`/rooms/${roomId}/${thread}`);
                }}
              />
            )}
          </section>
        </div>
      </div>
      {detail && memoryOpen ? (
        <RoomMemory
          open
          onClose={() => setMemoryOpen(false)}
          detail={detail}
          guest={me?.kind === 'guest' || guest}
        />
      ) : null}
      {detail && settingsOpen ? (
        <RoomSettings
          onClose={() => setSettingsOpen(false)}
          detail={detail}
          onChanged={() => {
            void readRoom();
            setRuleChanged((n) => n + 1);
          }}
        />
      ) : null}
      {detail ? (
        <People
          open={peopleOpen}
          onClose={() => setPeopleOpen(false)}
          detail={detail}
          me={me}
          present={present}
          onChanged={() => void readRoom()}
          onLeft={() => {
            setPeopleOpen(false);
            navigate('/rooms');
          }}
        />
      ) : null}
    </Shell>
  );
}
