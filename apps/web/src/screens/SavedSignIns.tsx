/**
 * Settings → Privacy → Saved sign-ins: the usernames, passwords and code
 * secrets a person keeps so Melete's browser can sign in to a site for them.
 * What was saved never comes back to this page: a sign-in shows its username
 * and a mask, and the most it shows on request is the current one-time code.
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Badge, Button, Dialog, Field, Input, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import type {
  SavedSignIn,
  SavedSignInCheck,
  SavedSignInCreate,
  SavedSignInUpdate,
} from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';
import { lastUsed, Section } from './Privacy.tsx';

/** How the last use went, in a few words. */
export const OUTCOME_WORDS: Record<NonNullable<SavedSignIn['last_outcome']>, string> = {
  signed_in: 'signed in',
  needs_code: 'the site asked for a code',
  needs_person: 'the site needed you',
  form_not_found: 'no sign-in form found',
  not_accepted: 'the site didn’t accept it',
  wrong_site: 'stopped on a different site',
  failed: 'didn’t finish',
};

/** "Last used today, signed in" or "Not used yet". */
export function usedLine(signIn: SavedSignIn, now = Date.now()): string {
  if (!signIn.last_used_at) return 'Not used yet';
  const used = lastUsed(signIn.last_used_at, now);
  return signIn.last_outcome ? `${used}, ${OUTCOME_WORDS[signIn.last_outcome]}` : used;
}

type Draft = {
  site: string;
  username: string;
  password: string;
  code_secret: string;
  label: string;
  ask_first: boolean;
  remove_code: boolean;
};

const EMPTY: Draft = {
  site: '',
  username: '',
  password: '',
  code_secret: '',
  label: '',
  ask_first: false,
  remove_code: false,
};

/** The body for a new sign-in: optional fields left out when blank. */
export function createBody(draft: Draft): SavedSignInCreate {
  return {
    site: draft.site.trim(),
    username: draft.username,
    password: draft.password,
    ...(draft.code_secret.trim() ? { code_secret: draft.code_secret.trim() } : {}),
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    policy: draft.ask_first ? 'ask_first' : 'whenever_needed',
  };
}

/** Only what changed. A blank password or code secret keeps the saved one. */
export function updateBody(signIn: SavedSignIn, draft: Draft): SavedSignInUpdate | null {
  const change: SavedSignInUpdate = {};
  if (draft.username && draft.username !== signIn.username) change.username = draft.username;
  if (draft.password) change.password = draft.password;
  if (draft.remove_code) change.code_secret = null;
  else if (draft.code_secret.trim()) change.code_secret = draft.code_secret.trim();
  const label = draft.label.trim();
  if (label && label !== signIn.label) change.label = label;
  const policy = draft.ask_first ? 'ask_first' : 'whenever_needed';
  if (policy !== signIn.policy) change.policy = policy;
  return Object.keys(change).length ? change : null;
}

function SignInForm({
  draft,
  setDraft,
  editing,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  editing: SavedSignIn | null;
}) {
  const [showPassword, setShowPassword] = useState(false);
  return (
    <div className="col" style={{ gap: 12 }}>
      {editing ? (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          For {editing.origin}. To use it on another site, save a new sign-in.
        </p>
      ) : (
        <Field label="Site" hint="The address you sign in at, like example.com">
          <Input
            value={draft.site}
            onChange={(event) => setDraft({ ...draft, site: event.target.value })}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            required
            autoFocus
            width="100%"
          />
        </Field>
      )}
      <Field label="Username or email">
        <Input
          value={draft.username}
          onChange={(event) => setDraft({ ...draft, username: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          required={!editing}
          autoFocus={Boolean(editing)}
          width="100%"
        />
      </Field>
      <Field
        label="Password"
        hint={editing ? 'Leave it blank to keep the saved password.' : undefined}
      >
        <Input
          type={showPassword ? 'text' : 'password'}
          value={draft.password}
          onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          autoComplete="new-password"
          spellCheck={false}
          required={!editing}
          width="100%"
          trailing={
            <button
              type="button"
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword(!showPassword)}
              style={{
                fontSize: 12,
                color: 'var(--secondary)',
                padding: '0 4px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          }
        />
      </Field>
      {editing?.has_code && draft.remove_code ? null : (
        <Field
          label="Code secret (optional)"
          hint={
            editing?.has_code
              ? 'A code secret is saved. Paste a new one to replace it.'
              : 'For sites that ask for a six-digit code: the setup key or otpauth:// link the site shows when you turn on an authenticator app.'
          }
        >
          <Input
            value={draft.code_secret}
            onChange={(event) => setDraft({ ...draft, code_secret: event.target.value })}
            autoComplete="off"
            spellCheck={false}
            width="100%"
          />
        </Field>
      )}
      {editing?.has_code ? (
        <label className="row" style={{ gap: 8, fontSize: 13, color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={draft.remove_code}
            onChange={(event) =>
              setDraft({ ...draft, remove_code: event.target.checked, code_secret: '' })
            }
          />
          Remove the saved code secret
        </label>
      ) : null}
      <Field label="Name (optional)" hint="What to call it. The site’s name if left blank.">
        <Input
          value={draft.label}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          autoComplete="off"
          width="100%"
        />
      </Field>
      <div className="row" style={{ gap: 12, justifyContent: 'space-between' }}>
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
            Ask me first
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Melete asks before each use instead of signing in whenever it needs to.
          </span>
        </span>
        <Toggle
          label="Ask me before using this sign-in"
          on={draft.ask_first}
          onChange={(next) => setDraft({ ...draft, ask_first: next })}
        />
      </div>
    </div>
  );
}

/** The current one-time code, shown until it runs out. */
function CodeReveal({ signIn }: { signIn: SavedSignIn }) {
  const [shown, setShown] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!shown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shown]);

  const left = shown ? Math.ceil((shown.until - now) / 1000) : 0;
  useEffect(() => {
    if (shown && left <= 0) setShown(null);
  }, [shown, left]);

  const reveal = async () => {
    setBusy(true);
    const result = await adapter.signInCode(signIn.id);
    setBusy(false);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t show the code' });
      return;
    }
    setNow(Date.now());
    setShown({ code: result.data.code, until: Date.now() + result.data.expires_in * 1000 });
  };

  if (shown)
    return (
      <span className="row" style={{ gap: 8 }}>
        <span aria-live="polite">
          <span className="sr-only">Current code {shown.code.split('').join(' ')}</span>
          <span
            aria-hidden="true"
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 15,
              letterSpacing: '0.08em',
              color: 'var(--heading)',
            }}
          >
            {shown.code}
          </span>
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{left}s left</span>
        <Button size="sm" variant="ghost" onClick={() => setShown(null)}>
          Hide
        </Button>
      </span>
    );
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      disabled={busy}
      aria-label={`Show the current code for ${signIn.label}`}
      onClick={() => void reveal()}
    >
      Show code
    </Button>
  );
}

function CheckResult({ check }: { check: SavedSignInCheck }) {
  return (
    <ul
      className="col"
      style={{ gap: 4, margin: 0, padding: '0 0 10px 44px', listStyle: 'none' }}
      aria-label="Check results"
    >
      {check.checks.map((item) => (
        <li key={item.name} className="row" style={{ gap: 6, fontSize: 12, color: 'var(--text)' }}>
          <span aria-hidden="true" style={{ color: item.ok ? 'var(--success)' : 'var(--danger)' }}>
            <Icon name={item.ok ? 'circleCheck' : 'circleX'} size={14} />
          </span>
          <span>
            <span className="sr-only">{item.ok ? 'Passed: ' : 'Problem: '}</span>
            {item.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The sign-ins a person saved for Melete's browser here, and their add, edit,
 * check and delete. Shown only where the service has a browser.
 */
export function SavedSignIns() {
  const { capabilities } = useApp();
  const signIns = useLoad(
    () =>
      capabilities.browser
        ? adapter.savedSignIns()
        : Promise.resolve({ data: { sign_ins: [] }, error: null, unavailable: null }),
    [capabilities.browser],
  );
  const [dialog, setDialog] = useState<{ editing: SavedSignIn | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedSignIn | null>(null);
  const [checks, setChecks] = useState<Record<string, SavedSignInCheck>>({});
  const [checking, setChecking] = useState<string | null>(null);
  if (!capabilities.browser) return null;

  const list = signIns.data?.sign_ins ?? [];
  const replace = (next: SavedSignIn) =>
    signIns.set({
      sign_ins: list.some((item) => item.id === next.id)
        ? list.map((item) => (item.id === next.id ? next : item))
        : [...list, next],
    });

  const openAdd = () => {
    setDraft(EMPTY);
    setProblem(null);
    setDialog({ editing: null });
  };
  const openEdit = (signIn: SavedSignIn) => {
    setDraft({
      ...EMPTY,
      username: signIn.username,
      label: signIn.label,
      ask_first: signIn.policy === 'ask_first',
    });
    setProblem(null);
    setDialog({ editing: signIn });
  };
  const close = () => {
    // What was typed goes with the dialog.
    setDraft(EMPTY);
    setDialog(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || saving) return;
    const editing = dialog.editing;
    const change = editing ? updateBody(editing, draft) : null;
    if (editing && !change) {
      close();
      return;
    }
    setSaving(true);
    setProblem(null);
    const result = editing
      ? await adapter.updateSignIn(editing.id, change as SavedSignInUpdate)
      : await adapter.saveSignIn(createBody(draft));
    setSaving(false);
    if (result.data === null) {
      setProblem(result.error ?? result.unavailable ?? 'Couldn’t save the sign-in');
      return;
    }
    replace(result.data);
    setChecks(({ [result.data.id]: _, ...rest }) => rest);
    close();
    toast({
      kind: 'ok',
      title: editing ? 'Sign-in updated' : `Saved a sign-in for ${result.data.site}`,
    });
  };

  const remove = async (signIn: SavedSignIn) => {
    setSaving(true);
    const result = await adapter.deleteSignIn(signIn.id);
    setSaving(false);
    setDeleting(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t delete it' });
      return;
    }
    signIns.set({ sign_ins: list.filter((item) => item.id !== signIn.id) });
    toast({ kind: 'ok', title: `Deleted the sign-in for ${signIn.site}` });
  };

  const check = async (signIn: SavedSignIn) => {
    setChecking(signIn.id);
    const result = await adapter.checkSignIn(signIn.id);
    setChecking(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t check it' });
      return;
    }
    const checked = result.data;
    setChecks((current) => ({ ...current, [signIn.id]: checked }));
  };

  return (
    <Section
      title="Saved sign-ins"
      sub="Save a username and password so Melete’s browser can sign in for you. Melete types them into the site itself; the AI model never sees them, and they’re only used on the exact site you saved."
    >
      {signIns.error ? (
        <LoadError what="your saved sign-ins" error={signIns.error} onRetry={signIns.reload} />
      ) : signIns.loading && !signIns.data ? (
        <div className="shimmer" style={{ height: 52, borderRadius: 10 }} aria-hidden="true" />
      ) : list.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No saved sign-ins yet.</p>
      ) : (
        <ul className="col" style={{ gap: 0, margin: 0, padding: 0, listStyle: 'none' }}>
          {list.map((signIn, index) => (
            <li
              key={signIn.id}
              className="col"
              style={{ borderTop: index ? '1px solid var(--line)' : undefined }}
            >
              <div
                className="row"
                style={{ gap: 12, minHeight: 56, flexWrap: 'wrap', padding: '8px 0' }}
              >
                <span
                  aria-hidden="true"
                  className="row"
                  style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    justifyContent: 'center',
                    borderRadius: 8,
                    background: 'var(--soft)',
                    color: 'var(--secondary)',
                  }}
                >
                  <Icon name="lock" size={16} />
                </span>
                <span className="col grow" style={{ gap: 2, minWidth: 160, flexBasis: 180 }}>
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <span
                      className="clamp1"
                      style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                    >
                      {signIn.label}
                    </span>
                    {signIn.policy === 'ask_first' ? <Badge>Asks first</Badge> : null}
                  </span>
                  <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {signIn.site} · {signIn.username} ·{' '}
                    <span aria-hidden="true">{signIn.password}</span>
                    <span className="sr-only">password saved</span>
                  </span>
                  <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {usedLine(signIn)}
                  </span>
                </span>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                  {signIn.has_code ? <CodeReveal signIn={signIn} /> : null}
                  <Button
                    size="sm"
                    variant="outline"
                    loading={checking === signIn.id}
                    disabled={checking === signIn.id}
                    aria-label={`Check the sign-in for ${signIn.label}`}
                    onClick={() => void check(signIn)}
                  >
                    Check
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Edit the sign-in for ${signIn.label}`}
                    onClick={() => openEdit(signIn)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Delete the sign-in for ${signIn.label}`}
                    onClick={() => setDeleting(signIn)}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              {checks[signIn.id] ? (
                <CheckResult check={checks[signIn.id] as SavedSignInCheck} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button icon="plus" variant="outline" onClick={openAdd} disabled={Boolean(signIns.error)}>
          Add a sign-in
        </Button>
      </div>
      <Dialog
        open={dialog !== null}
        onClose={close}
        icon="lock"
        title={dialog?.editing ? `Edit ${dialog.editing.label}` : 'Add a sign-in'}
        width={480}
      >
        <form onSubmit={(event) => void save(event)} className="col" style={{ gap: 14 }}>
          <SignInForm draft={draft} setDraft={setDraft} editing={dialog?.editing ?? null} />
          {problem ? (
            <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', margin: 0 }}>
              {problem}
            </p>
          ) : null}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="outline" disabled={saving} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={saving}>
              {dialog?.editing ? 'Save changes' : 'Save sign-in'}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        icon="trash"
        tone="danger"
        title={deleting ? `Delete the sign-in for ${deleting.site}?` : 'Delete this sign-in?'}
        sub="Its username, password and code secret are erased. If Melete’s browser is already signed in to the site, it stays signed in until you sign it out under signed-in sites."
        footer={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={saving}
              disabled={saving}
              onClick={() => deleting && void remove(deleting)}
            >
              Delete
            </Button>
          </>
        }
      />
    </Section>
  );
}
