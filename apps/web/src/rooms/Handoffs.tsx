/**
 * Work a room handed the person, on their own Home: a task to run with their
 * own setup or decline, and, once it ran, its exact result to share with the
 * room or keep. Nothing from the person's own space reaches the room without
 * the second choice. Accepting and sharing each name the exact text the person
 * read, so what runs and what is posted is what they saw.
 */
import { useState } from 'react';
import { Button, Status } from '../design/primitives.tsx';
import type { RoomHandoff } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { roomsApi } from './api.ts';
import { Who } from './parts.tsx';
import { dayOf } from './reduce.ts';
import './rooms.css';

export function RoomHandoffs({
  handoffs,
  onChanged,
}: {
  handoffs: RoomHandoff[];
  /** Read what waits on the person again, once a choice landed. */
  onChanged: () => void;
}) {
  // Decided here and answered by the service: gone before the next read.
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const shown = handoffs.filter((handoff) => !done.has(`${handoff.id}:${handoff.state}`));
  if (shown.length === 0) return null;
  // Work already running waits on nothing from the person, so it is not counted.
  const waiting = shown.filter(
    (handoff) => handoff.state === 'pending' || handoff.state === 'settled',
  ).length;

  const settle = (handoff: RoomHandoff) => {
    setDone((previous) => new Set(previous).add(`${handoff.id}:${handoff.state}`));
    onChanged();
  };
  const decide = async (handoff: RoomHandoff, decision: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(`${handoff.id}:${decision}`);
    const result = await roomsApi.decideHandoff(handoff, decision);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer it' });
      onChanged();
      return;
    }
    toast(
      decision === 'accept'
        ? {
            kind: 'ok',
            title: 'Running it with your setup',
            sub: 'When it finishes, you choose whether the room sees the result.',
          }
        : { kind: 'ok', title: 'Declined', sub: `${handoff.room.name} hears that you declined.` },
    );
    settle(handoff);
  };
  const result = async (handoff: RoomHandoff, decision: 'share' | 'keep') => {
    if (busy) return;
    setBusy(`${handoff.id}:${decision}`);
    const answer = await roomsApi.handoffResult(handoff, decision);
    setBusy(null);
    if (!answer.data) {
      toast({ kind: 'err', title: answer.error ?? answer.unavailable ?? 'Couldn’t do that' });
      onChanged();
      return;
    }
    toast(
      decision === 'share'
        ? { kind: 'ok', title: `Shared with ${handoff.room.name}` }
        : { kind: 'ok', title: 'Kept private', sub: 'The room hears only that you kept it.' },
    );
    settle(handoff);
  };

  return (
    <section className="home-section" aria-labelledby="home-rooms-asked">
      <div className="home-section-head">
        <h2 id="home-rooms-asked">
          From your rooms
          {waiting > 0 ? <span className="nav-count">{waiting}</span> : null}
        </h2>
      </div>
      {shown.map((handoff) => {
        if (handoff.state === 'running' || handoff.state === 'accepted')
          return <Running key={handoff.id} handoff={handoff} />;
        const resultReady = handoff.state === 'settled' && handoff.result !== null;
        const title = resultReady
          ? `Share the result with ${handoff.room.name}?`
          : `${handoff.room.name} asks your agent to do this with your own setup`;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card and carries no more meaning than a named group
          <div key={handoff.id} className="decision handoff" role="group" aria-label={title}>
            <div className="decision-who">
              <span className="room-tile handoff-tile" aria-hidden="true">
                {Array.from(handoff.room.name.trim())[0]?.toUpperCase() ?? '#'}
              </span>
              <span className="decision-agent clamp1">{handoff.room.name}</span>
              {handoff.asked_by ? (
                <span className="decision-for clamp1">
                  asked by <Who label={handoff.asked_by.display_name} strong={false} />
                </span>
              ) : null}
            </div>
            <p className="decision-title voice">{title}</p>
            <div className="decision-preview">
              <span className="handoff-label">
                {resultReady ? 'The result, word for word' : 'The task, word for word'}
              </span>
              <div className="decision-draft handoff-text">
                {resultReady ? handoff.result : handoff.task}
              </div>
            </div>
            <span className="decision-meta">
              {resultReady
                ? 'Sharing posts exactly this text in the room, as yours, via Melete. Keeping it tells the room only that you kept it.'
                : `It runs in your own space with your own connections, and anything it sends asks you first. Answer by ${dayOf(handoff.expires_at)}.`}
            </span>
            <div className="decision-actions">
              {resultReady ? (
                <Button
                  className="btn-card"
                  loading={busy === `${handoff.id}:share`}
                  disabled={busy !== null}
                  onClick={() => void result(handoff, 'share')}
                >
                  Share with {handoff.room.name}
                </Button>
              ) : (
                <Button
                  className="btn-card"
                  loading={busy === `${handoff.id}:accept`}
                  disabled={busy !== null}
                  onClick={() => void decide(handoff, 'accept')}
                >
                  Run with my setup
                </Button>
              )}
              <Button
                className="btn-card"
                variant="outline"
                onClick={() => navigate(`/rooms/${handoff.room.id}/${handoff.thread_id}`)}
              >
                Open the room
              </Button>
              <div className="grow" />
              {resultReady ? (
                <Button
                  className="btn-card"
                  variant="ghost"
                  loading={busy === `${handoff.id}:keep`}
                  disabled={busy !== null}
                  onClick={() => void result(handoff, 'keep')}
                >
                  Keep it private
                </Button>
              ) : (
                <Button
                  className="btn-card"
                  variant="ghost"
                  loading={busy === `${handoff.id}:decline`}
                  disabled={busy !== null}
                  onClick={() => void decide(handoff, 'decline')}
                >
                  Decline
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * A room's task running with the person's own setup. Nothing waits on them
 * here: anything it sends asks them first, and its result comes back to this
 * place for them to share or keep.
 */
function Running({ handoff }: { handoff: RoomHandoff }) {
  const title = `Running with your setup for ${handoff.room.name}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card and carries no more meaning than a named group
    <div className="decision handoff" role="group" aria-label={title} data-running="true">
      <div className="decision-who">
        <span className="room-tile handoff-tile" aria-hidden="true">
          {Array.from(handoff.room.name.trim())[0]?.toUpperCase() ?? '#'}
        </span>
        <span className="decision-agent clamp1">{handoff.room.name}</span>
        <div className="grow" />
        <Status tone="working" quiet>
          Running
        </Status>
      </div>
      <p className="decision-title voice">{title}</p>
      <div className="decision-preview">
        <span className="handoff-label">The task, word for word</span>
        <div className="decision-draft handoff-text">{handoff.task}</div>
      </div>
      <span className="decision-meta">
        Anything it sends asks you first. When it finishes, you see the result here and choose
        whether {handoff.room.name} sees it.
      </span>
      <div className="decision-actions">
        <Button
          className="btn-card"
          variant="outline"
          onClick={() => navigate(`/rooms/${handoff.room.id}/${handoff.thread_id}`)}
        >
          Open the room
        </Button>
      </div>
    </div>
  );
}
