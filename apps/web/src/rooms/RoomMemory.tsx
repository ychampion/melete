/**
 * Room → Memory: what the room's agent remembers from what people said here,
 * each detail with whose words it rests on, and the details people shared
 * into the room from their own memory. An owner forgets any detail; anyone
 * else forgets what rests on their own words alone, and withdraws what they
 * shared.
 */
import { useState } from 'react';
import { Button, Dialog } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { type RoomDetail, type RoomMemoryItem, type RoomShare, roomsApi } from './api.ts';
import { Who } from './parts.tsx';
import { dayOf } from './reduce.ts';

export function RoomMemory({
  open,
  onClose,
  detail,
  guest,
}: {
  open: boolean;
  onClose: () => void;
  detail: RoomDetail;
  /** A guest has no memory of their own to share from. */
  guest: boolean;
}) {
  const roomId = detail.room.id;
  const memory = useLoad(() => roomsApi.memory(roomId), [roomId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const items = memory.data?.items ?? [];
  const shares = memory.data?.shares ?? [];
  const hasGuest = detail.members.some((member) => member.role === 'guest');

  const forget = async (item: RoomMemoryItem) => {
    setBusy(item.claim_id);
    const result = await roomsApi.forget(roomId, item.claim_id);
    setBusy(null);
    setConfirming(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t forget that' });
      return;
    }
    toast({
      kind: 'ok',
      title: `Forgot “${item.label}”`,
      sub: 'The room’s agent no longer uses it.',
    });
    memory.reload();
  };
  const withdraw = async (share: RoomShare) => {
    setBusy(share.id);
    const result = await roomsApi.withdrawShare(roomId, share.id);
    setBusy(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t withdraw it' });
      return;
    }
    toast({ kind: 'ok', title: 'Withdrawn', sub: 'It stays in the memory it came from.' });
    memory.reload();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setConfirming(null);
        onClose();
      }}
      title={`What ${detail.room.name} remembers`}
      sub={`${detail.room.agent_name} remembers what people say here, with who said it. It never reads anyone’s own memory, only what they share into the room.`}
      width={560}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="col" style={{ gap: 18 }}>
        {memory.error ? (
          <div className="row room-error" style={{ padding: 0 }}>
            <span>Couldn’t read what the room remembers. {memory.error}</span>
            <Button size="sm" variant="outline" onClick={memory.reload}>
              Try again
            </Button>
          </div>
        ) : null}
        <section className="col" style={{ gap: 8 }} aria-labelledby="room-memory-said">
          <h4 id="room-memory-said" className="people-field-label">
            From what people said
          </h4>
          {items.length > 0 ? (
            <ul className="people-list" aria-label="What the room remembers">
              {items.map((item) => (
                <li key={item.claim_id} className="memory-row">
                  <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                    <span className="memory-label">{item.label}</span>
                    <span className="memory-content">{item.content}</span>
                    <span className="people-meta">
                      From what{' '}
                      {item.said_by.map((person, index) => (
                        <span key={person.principal_id}>
                          {index > 0 ? (index === item.said_by.length - 1 ? ' and ' : ', ') : null}
                          <Who label={person.display_name} strong={false} />
                        </span>
                      ))}{' '}
                      said · {dayOf(item.recorded_at)}
                    </span>
                    {confirming === item.claim_id ? (
                      <fieldset className="room-msg-confirm">
                        <legend>
                          Forget this for everyone in the room? It is erased, not hidden.
                        </legend>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          <Button
                            size="sm"
                            variant="destructive"
                            autoFocus
                            loading={busy === item.claim_id}
                            onClick={() => void forget(item)}
                          >
                            Forget
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                            Keep it
                          </Button>
                        </div>
                      </fieldset>
                    ) : null}
                  </div>
                  {item.can_forget && confirming !== item.claim_id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Forget ${item.label}`}
                      onClick={() => setConfirming(item.claim_id)}
                    >
                      Forget
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : memory.data ? (
            <p className="people-hint">Nothing yet. What people say in the threads lands here.</p>
          ) : null}
        </section>
        <section className="col" style={{ gap: 8 }} aria-labelledby="room-memory-shared">
          <h4 id="room-memory-shared" className="people-field-label">
            Shared into the room
          </h4>
          {shares.length > 0 ? (
            <ul className="people-list" aria-label="Shared into the room">
              {shares.map((share) => (
                <li key={share.id} className="memory-row">
                  <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                    <span className="memory-label">{share.label ?? 'A detail'}</span>
                    <span
                      className="memory-content"
                      data-gone={share.content === null || undefined}
                    >
                      {share.content ?? 'No longer shared: it was forgotten where it came from.'}
                    </span>
                    <span className="people-meta">
                      Shared by <Who label={share.shared_by.display_name} strong={false} /> ·{' '}
                      {dayOf(share.created_at)}
                      {share.members_only
                        ? hasGuest
                          ? ' · Members only, so the agent leaves it out while a guest is here'
                          : ' · Members only'
                        : ''}
                    </span>
                  </div>
                  {share.can_withdraw ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === share.id}
                      aria-label={`Withdraw ${share.label ?? 'this detail'}`}
                      onClick={() => void withdraw(share)}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : memory.data ? (
            <p className="people-hint">Nobody has shared anything of their own here.</p>
          ) : null}
          {guest ? null : (
            <p className="people-hint">
              To share something Melete remembers about you, open{' '}
              <a className="memory-link" href={href('/settings/memory')}>
                Memory
              </a>{' '}
              and choose Share to a room. Forgetting it there takes it out of every room.
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
