/**
 * Settings › Account, the part about your data: download all of it, erase
 * everything in your space, and delete your account. The person who set
 * Melete up can't delete their own account (it runs this Melete), so they
 * see the accounts they made instead, and can delete those.
 *
 * Every deletion shows what it takes before it happens, and asks for a name
 * or an email typed out, so nothing goes by a stray click.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { ownSpaceId } from '../companies/api.ts';
import { LoadError } from '../design/LoadError.tsx';
import { Button, Dialog, Field, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type {
  AccountRemovalPreview,
  AccountSummary,
  SpaceRemovalPreview,
  SpaceRemovalReport,
} from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 8, maxWidth: 560 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>{title}</span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{sub}</span>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** What a deletion takes, one line per space. */
function SpacesList({ preview }: { preview: AccountRemovalPreview }) {
  return (
    <ul className="col" style={{ gap: 6, margin: 0, padding: 0 }}>
      {preview.spaces.map((space) => (
        <li key={space.id} style={{ listStyle: 'none', fontSize: 13, color: 'var(--text)' }}>
          <strong>{space.kind === 'personal' ? 'Your space' : `The room ${space.name}`}</strong>:{' '}
          {plural(space.chats, 'chat')}, {plural(space.files, 'file')},{' '}
          {plural(space.connections, 'connection')}
          {space.kind === 'room' ? ', gone for everyone in it' : ''}
        </li>
      ))}
      {preview.rooms_left.map((room) => (
        <li key={room.id} style={{ listStyle: 'none', fontSize: 13, color: 'var(--text)' }}>
          Leaves <strong>{room.name}</strong>; what was written there stays with that room.
        </li>
      ))}
    </ul>
  );
}

/** Type the email to delete an account: one's own, or one the setup owner made. */
function DeleteAccountDialog({
  preview,
  open,
  onClose,
  onDelete,
  own,
}: {
  preview: AccountRemovalPreview;
  open: boolean;
  onClose: () => void;
  onDelete: (email: string) => Promise<string | null>;
  own: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = typed.trim().toLowerCase() === preview.confirm.toLowerCase();
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      icon="trash"
      tone="danger"
      title={own ? 'Delete your account?' : `Delete ${preview.confirm}?`}
      sub={
        own
          ? 'You are signed out at once and can’t sign in again. Everything below is deleted for good, and the email is free to use again. Download your data first if you want a copy.'
          : 'They are signed out at once and can’t sign in again. Everything below is deleted for good.'
      }
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!ready || busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              void onDelete(typed).then((failed) => {
                setBusy(false);
                if (failed) setProblem(failed);
              });
            }}
          >
            Delete account
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <SpacesList preview={preview} />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Messages already sent stay where they were sent. Keys and app passwords made at other
          services keep working there until you revoke them.
        </span>
        <Field label={`Type ${preview.confirm} to confirm`}>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            width="100%"
          />
        </Field>
        {problem ? (
          <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
            {problem}
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Empty one's own space: the preview, the name typed out, then where it has got to. */
function EraseSpace() {
  const [preview, setPreview] = useState<SpaceRemovalPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removalId, setRemovalId] = useState<string | null>(null);
  const [report, setReport] = useState<SpaceRemovalReport['report'] | null>(null);

  useEffect(() => {
    if (!removalId) return;
    let live = true;
    const look = async () => {
      const read = await adapter.spaceRemoval(removalId);
      if (!live) return;
      if (read.data) {
        setReport(read.data.report);
        const { state } = read.data.removal;
        if (state === 'complete' || state === 'blocked') return;
      }
      setTimeout(() => void look(), 2_000);
    };
    void look();
    return () => {
      live = false;
    };
  }, [removalId]);

  const open = async () => {
    setBusy(true);
    const space = await ownSpaceId();
    const read = space.data === null ? null : await adapter.spaceRemovalPreview(space.data);
    setBusy(false);
    if (!read?.data) {
      const failed = read ?? space;
      toast({
        kind: 'err',
        title: 'Couldn’t check your space',
        sub: failed.error ?? failed.unavailable ?? '',
      });
      return;
    }
    setTyped('');
    setProblem(null);
    setPreview(read.data.preview);
  };

  const erase = async () => {
    if (!preview) return;
    setBusy(true);
    setProblem(null);
    const started = await adapter.removeSpace(preview.space_id, typed);
    setBusy(false);
    if (started.data === null) {
      setProblem(started.error ?? started.unavailable ?? 'Couldn’t start erasing.');
      return;
    }
    setPreview(null);
    setRemovalId(started.data.removal.id);
  };

  const counts = preview?.counts;
  return (
    <Section
      title="Erase everything in your space"
      sub="Deletes every chat, file, memory, connection and automation in your space, and keeps your account and the empty space, ready to start again."
    >
      {report ? (
        <div className="col" style={{ gap: 4 }} role="status">
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
            {report.headline}
          </span>
          {report.removal.state === 'complete'
            ? report.still_yours.map((line) => (
                <span key={line} style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {line}
                </span>
              ))
            : null}
          {report.removal.state === 'complete' ? (
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Start again
            </Button>
          ) : null}
        </div>
      ) : removalId ? (
        <span role="status" style={{ fontSize: 13, color: 'var(--muted)' }}>
          Erasing…
        </span>
      ) : (
        <Button variant="outline" loading={busy && !preview} onClick={() => void open()}>
          Erase everything…
        </Button>
      )}
      {preview && counts ? (
        <Dialog
          open
          onClose={busy ? () => {} : () => setPreview(null)}
          icon="trash"
          tone="danger"
          title="Erase everything in your space?"
          sub={preview.confirmation}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                disabled={busy || typed !== preview.name}
                onClick={() => void erase()}
              >
                Erase everything
              </Button>
            </>
          }
        >
          <div className="col" style={{ gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
              {plural(counts.jobs, 'chat or piece of work', 'chats and pieces of work')},{' '}
              {plural(counts.artifacts, 'file')}, {plural(counts.memory_claims, 'saved detail')},{' '}
              {plural(counts.connections, 'connection')}.
            </span>
            <ul className="col" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
              {preview.stays.map((line) => (
                <li key={line} style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {line}
                </li>
              ))}
            </ul>
            <Field label={`Type ${preview.name} to confirm`}>
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                width="100%"
              />
            </Field>
            {problem ? (
              <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
                {problem}
              </span>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </Section>
  );
}

/** The accounts the person who set Melete up made, each of which they can delete. */
function OtherAccounts() {
  const list = useLoad(() => adapter.accounts(), []);
  const [target, setTarget] = useState<{
    account: AccountSummary;
    preview: AccountRemovalPreview;
  } | null>(null);
  const others = (list.data?.accounts ?? []).filter((account) => !account.setup_owner);
  const ask = async (account: AccountSummary) => {
    const read = await adapter.otherAccountPreview(account.id);
    if (read.data === null) {
      toast({
        kind: 'err',
        title: 'Couldn’t check that account',
        sub: read.error ?? read.unavailable ?? '',
      });
      return;
    }
    setTarget({ account, preview: read.data.preview });
  };
  return (
    <Section
      title="Accounts on this Melete"
      sub="The accounts you made for other people. Deleting one signs them out and deletes their space and everything in it."
    >
      {list.error ? (
        <LoadError what="the accounts" error={list.error} onRetry={list.reload} />
      ) : others.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {list.loading ? 'Loading…' : 'Nobody else has an account here.'}
        </span>
      ) : (
        <ul className="col" style={{ gap: 8, margin: 0, padding: 0, width: '100%' }}>
          {others.map((account) => (
            <li
              key={account.id}
              className="row"
              style={{
                listStyle: 'none',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' }}>
                {account.display_name ? `${account.display_name}, ` : ''}
                {account.email ?? 'Being deleted'}
                {account.kind === 'guest' ? ' (room guest)' : ''}
              </span>
              {account.state === 'active' ? (
                <Button variant="ghost" size="sm" onClick={() => void ask(account)}>
                  Delete…
                </Button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Being deleted</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {target ? (
        <DeleteAccountDialog
          open
          own={false}
          preview={target.preview}
          onClose={() => setTarget(null)}
          onDelete={async (email) => {
            const done = await adapter.removeOtherAccount(target.account.id, email);
            if (done.data === null) return done.error ?? done.unavailable ?? 'Couldn’t delete it.';
            setTarget(null);
            toast({
              kind: 'ok',
              title: `${target.preview.confirm} was deleted`,
              sub: 'Their spaces are being cleared now.',
            });
            list.reload();
            return null;
          }}
        />
      ) : null}
    </Section>
  );
}

export function AccountData() {
  const preview = useLoad(() => adapter.accountRemovalPreview(), []);
  const [deleting, setDeleting] = useState(false);
  const own = preview.data?.preview;
  return (
    <div className="col" style={{ gap: 20 }}>
      <Section
        title="Download your data"
        sub="One zip of everything Melete keeps for you: every chat, your files, memory, automations and settings, in files any program can open. Passwords and connection keys are left out."
      >
        <Button
          variant="outline"
          icon="arrowDown"
          onClick={() => window.location.assign(adapter.exportUrl())}
        >
          Download everything
        </Button>
      </Section>
      <EraseSpace />
      {own?.account.setup_owner ? (
        <>
          <OtherAccounts />
          <Section title="Delete your account" sub={own.blocked_reason ?? ''}>
            {null}
          </Section>
        </>
      ) : own ? (
        <Section
          title="Delete your account"
          sub="Deletes your account, your space and everything in it, and signs you out everywhere."
        >
          <Button
            variant="outline"
            disabled={Boolean(own.blocked_reason)}
            onClick={() => setDeleting(true)}
          >
            Delete account…
          </Button>
          {own.blocked_reason ? (
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{own.blocked_reason}</span>
          ) : null}
          {deleting ? (
            <DeleteAccountDialog
              open
              own
              preview={own}
              onClose={() => setDeleting(false)}
              onDelete={async (email) => {
                const done = await adapter.deleteAccount(email);
                if (done.data === null)
                  return done.error ?? done.unavailable ?? 'Couldn’t delete it.';
                // Signed out with it: back to the start.
                window.location.assign('/');
                return null;
              }}
            />
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
