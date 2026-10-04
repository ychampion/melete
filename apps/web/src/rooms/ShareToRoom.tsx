/**
 * Share a detail from the person's own memory into a room they are in. The
 * room reads it by reference: forgetting it in their own memory takes it out
 * of every room at once, and they can withdraw it from the room's Memory.
 */
import { useState } from 'react';
import { Button, Dialog } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import { toast } from '../shell/Shell.tsx';
import { roomsApi } from './api.ts';
import './rooms.css';

export function ShareToRoom({
  claimId,
  label,
  onClose,
}: {
  /** The detail in the person's own memory. */
  claimId: string;
  label: string;
  onClose: () => void;
}) {
  const rooms = useLoad(() => roomsApi.list(), []);
  const list = (rooms.data?.rooms ?? []).filter((room) => room.my_role !== 'guest');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [membersOnly, setMembersOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const chosen = roomId ?? list[0]?.id ?? null;

  const share = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    const result = await roomsApi.share(chosen, claimId, membersOnly);
    setBusy(false);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t share it' });
      return;
    }
    const name = list.find((room) => room.id === chosen)?.name ?? 'the room';
    toast({
      kind: 'ok',
      title: `Shared with ${name}`,
      sub: 'Forget it in your memory and it leaves the room too.',
    });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Share to a room"
      sub={`“${label}” goes to the room as shared by you. The room reads it from your memory, so forgetting it here takes it out of every room at once.`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void share()} loading={busy} disabled={!chosen || busy}>
            Share
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {rooms.error ? <p className="rooms-error">{rooms.error}</p> : null}
        {list.length > 0 ? (
          <fieldset className="settings-group">
            <legend className="people-field-label">Room</legend>
            {list.map((room) => (
              <label key={room.id} className="settings-choice">
                <input
                  type="radio"
                  className="radio"
                  name="share-room"
                  value={room.id}
                  checked={chosen === room.id}
                  onChange={() => setRoomId(room.id)}
                />
                <span className="col" style={{ gap: 2, minWidth: 0 }}>
                  <span className="settings-choice-title">{room.name}</span>
                  {room.purpose ? <span className="people-hint">{room.purpose}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : rooms.data ? (
          <p className="people-hint">You are not in any room yet. Make one from Rooms.</p>
        ) : null}
        <label className="settings-choice">
          <input
            type="checkbox"
            className="checkbox"
            checked={membersOnly}
            onChange={(event) => setMembersOnly(event.target.checked)}
          />
          <span className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="settings-choice-title">Members only</span>
            <span className="people-hint">
              The room’s agent leaves it out while a guest is in the room.
            </span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
