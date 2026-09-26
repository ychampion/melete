/**
 * Telegram in Settings: link this person's own chat with a one-time code, or
 * unlink it. Shown only when the installation has a bot.
 */
import { useState } from 'react';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { TelegramLinkCode } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

export function TelegramCard() {
  const status = useLoad(() => adapter.telegram(), []);
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  if (!status.data?.available) return null;
  const bot = status.data.bot_username ? `@${status.data.bot_username}` : 'your Melete bot';

  const getCode = () => {
    setBusy(true);
    void adapter
      .telegramLinkCode()
      .then((r) => {
        if (r.data === null) {
          toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t get a code' });
          return;
        }
        setCode(r.data);
      })
      .finally(() => setBusy(false));
  };
  const unlink = () => {
    setBusy(true);
    void adapter
      .telegramUnlink()
      .then((r) => {
        if (r.data === null) {
          toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t unlink' });
          return;
        }
        setCode(null);
        status.reload();
        toast({ kind: 'ok', title: 'Telegram unlinked' });
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="card-12 row" style={{ gap: 12, padding: '12px 16px', flexWrap: 'wrap' }}>
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>Telegram</span>
        {status.data.linked ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Linked. Decisions Melete needs from you arrive in your chat with {bot}.
          </span>
        ) : code ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Open {bot} in Telegram and send{' '}
            <strong style={{ color: 'var(--heading)', userSelect: 'all' }}>
              /start {code.code}
            </strong>
            . The code works once, for ten minutes.
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Get the decisions Melete needs from you in a private Telegram chat, and answer there.
          </span>
        )}
      </div>
      {status.data.linked ? (
        <Button variant="outline" loading={busy} disabled={busy} onClick={unlink}>
          Unlink
        </Button>
      ) : code ? (
        <Button variant="outline" loading={busy} disabled={busy} onClick={status.reload}>
          I sent it
        </Button>
      ) : (
        <Button variant="outline" loading={busy} disabled={busy} onClick={getCode}>
          Get a code
        </Button>
      )}
    </div>
  );
}
