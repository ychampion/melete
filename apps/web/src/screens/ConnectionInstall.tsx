/**
 * Adding a connection. Nothing here knows what mail, a calendar or an MCP
 * server needs: the service says which kinds exist and which fields each one
 * takes, and this draws exactly that. A new kind on the service is a new form
 * here without a change to this file.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { Badge, Button, Checkbox, Field, Input, Select } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import {
  emptyForm,
  emptyRow,
  type FieldValue,
  type FormValues,
  missing,
  requestBody,
} from '../experience/connection-form.ts';
import { useLoad } from '../experience/hooks.ts';
import type {
  AccountSignInStart,
  CatalogEntry,
  ConnectionItemField,
  ConnectionKind,
  McpSignInStart,
} from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';
import { APP_PASSWORD } from './app-passwords.ts';
import './connections.css';

/** Where an installation's owner reads how to turn on each sign-in. */
const SETUP_DOC = 'https://github.com/ychampion/melete/blob/main/docs/mail-calendar.md';
export const SETUP_DOCS: Record<string, string> = {
  google: `${SETUP_DOC}#signing-in-with-google`,
  microsoft: `${SETUP_DOC}#signing-in-with-microsoft`,
};
/** Said wherever an option needs the server set up first. */
export const NOT_SET_UP = 'Available when your server is set up for it.';

/** Kinds of connection a person uses day to day; the rest are for developers. */
const EVERYDAY = new Set<ConnectionKind['kind']>(['mail', 'caldav', 'ics']);

/** Which sign-in is the easier way to connect each kind, when it is offered. */
const SIGN_IN_FOR: Record<string, string> = {
  gmail: 'google',
  'google-calendar-feed': 'google',
};

/** Addresses in help text become links: "myaccount.google.com/apppasswords" opens it. */
export function Linked({ text }: { text: string }) {
  const parts = text.split(
    /((?:[a-z0-9-]+\.)+(?:com|net|org)(?:\/[A-Za-z0-9/_-]*[A-Za-z0-9_-])?)/g,
  );
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence
          <a key={index} href={`https://${part}`} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

const INPUT_TYPE: Partial<Record<ConnectionItemField['input'], string>> = {
  email: 'email',
  url: 'url',
  number: 'number',
  password: 'password',
};

function Control({
  field,
  value,
  onChange,
}: {
  field: ConnectionItemField;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
}) {
  const label = field.required ? field.label : `${field.label} (optional)`;
  if (field.input === 'checkbox')
    return (
      <div className="col" style={{ gap: 4 }}>
        <span className="row" style={{ gap: 8, fontSize: 13, color: 'var(--heading)' }}>
          <Checkbox checked={value === true} onChange={onChange} label={field.label} />
          {field.label}
        </span>
        {field.help ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{field.help}</span>
        ) : null}
      </div>
    );
  if (field.input === 'select')
    return (
      <Field label={label} hint={field.help}>
        <Select
          label={field.label}
          value={String(value)}
          onChange={onChange}
          options={field.options ?? []}
        />
      </Field>
    );
  return (
    <Field
      label={label}
      hint={
        field.input === 'string_list' ? (field.help ?? 'Separate entries with commas.') : field.help
      }
    >
      <Input
        // What the service seals is masked whatever kind of value it holds, so
        // a feed address kept like a password is typed like one.
        type={field.secret ? 'password' : (INPUT_TYPE[field.input] ?? 'text')}
        value={String(value)}
        placeholder={field.placeholder}
        // A secret is never offered back by the browser's own form memory.
        autoComplete={field.secret ? 'new-password' : 'off'}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Why a mail kind asks for an app password, and where to make one. Stated as fact, once. */
export function AppPasswordExplainer({ kindId }: { kindId: string }) {
  const note = APP_PASSWORD[kindId];
  if (!note) return null;
  return (
    <div
      className="col"
      style={{
        gap: 6,
        padding: '12px 14px',
        borderRadius: 12,
        background: 'var(--soft)',
        border: '1px solid var(--line)',
      }}
    >
      <span
        className="row"
        style={{ gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}
      >
        <Icon name="lock" size={14} />
        {note.title}
      </span>
      {note.lines.map((line) => (
        <p key={line} style={{ fontSize: 13, lineHeight: '19px', color: 'var(--secondary)' }}>
          <Linked text={line} />
        </p>
      ))}
    </div>
  );
}

export function KindForm({
  kind,
  onDone,
  onInstalled,
  signIn: easier,
  onSignIn,
}: {
  kind: ConnectionKind;
  onDone: () => void;
  /** Called only when the connection was saved, before `onDone`. */
  onInstalled?: () => void;
  /** The account sign-in that connects this kind without a password, when there is one. */
  signIn?: SignInEntry;
  onSignIn?: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => emptyForm(kind));
  const [sending, setSending] = useState(false);
  // Installed, but the server asks the person to sign in before it answers.
  const [signIn, setSignIn] = useState<{ id: string; detail: string } | null>(null);
  const gap = missing(kind, values);
  const setField = (path: string, next: FieldValue) =>
    setValues((current) => ({ ...current, fields: { ...current.fields, [path]: next } }));
  const setRows = (path: string, change: (rows: FormValues['lists'][string]) => typeof rows) =>
    setValues((current) => ({
      ...current,
      lists: { ...current.lists, [path]: change(current.lists[path] ?? []) },
    }));

  const submit = () => {
    if (gap) return;
    setSending(true);
    void adapter
      .installConnection(requestBody(kind, values))
      .then((result) => {
        if (result.data === null) {
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t add that' });
          return;
        }
        const check = result.data.check;
        if (check?.code === 'needs_sign_in') {
          setSignIn({ id: result.data.connection.id, detail: check.detail });
          onInstalled?.();
          return;
        }
        if (check && check.status === 'failing')
          toast({
            kind: 'err',
            title: `${values.label} was saved but is not working`,
            sub: check.detail,
          });
        else toast({ kind: 'ok', title: `${values.label} is connected` });
        onInstalled?.();
        onDone();
      })
      .finally(() => setSending(false));
  };

  if (signIn)
    return (
      <div className="col card-12" style={{ gap: 12, padding: 16 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          {values.label} needs you to sign in
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>{signIn.detail}</span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <McpSignIn connectionId={signIn.id} label={values.label} />
          <Button variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );

  return (
    <form
      className="col card-12"
      style={{ gap: 14, padding: 16 }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="col" style={{ gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>{kind.title}</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          {kind.description}
        </span>
      </div>
      {easier?.available ? (
        <div className="col connect-easier" role="note">
          <span>
            Signing in with {easier.title} is the simpler way: no app password, and you can stop it
            from your {easier.title} account at any time.
          </span>
          <div>
            <Button size="sm" icon="arrowUpRight" onClick={onSignIn}>
              Sign in with {easier.title} instead
            </Button>
          </div>
        </div>
      ) : easier ? (
        <div className="col connect-easier" role="note">
          <span>
            Signing in with {easier.title} needs your server set up for it, so {kind.title} connects
            here with an app password instead.{' '}
            {SETUP_DOCS[easier.connect.provider] ? (
              <a href={SETUP_DOCS[easier.connect.provider]} target="_blank" rel="noreferrer">
                How to set up {easier.title} sign-in
              </a>
            ) : null}
          </span>
        </div>
      ) : null}
      <AppPasswordExplainer kindId={kind.id} />
      <Field label="Name">
        <Input
          value={values.label}
          maxLength={120}
          onChange={(event) => setValues((current) => ({ ...current, label: event.target.value }))}
        />
      </Field>
      {kind.fields.map((field) =>
        field.input === 'list' ? (
          <fieldset key={field.path} className="col field-group" style={{ gap: 10 }}>
            <legend style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
              {field.label}
            </legend>
            {(values.lists[field.path] ?? []).map((row, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
                key={index}
                className="col"
                style={{ gap: 10, padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}
              >
                {(field.item_fields ?? []).map((item) => (
                  <Control
                    key={item.path}
                    field={item}
                    value={row[item.path] ?? ''}
                    onChange={(next) =>
                      setRows(field.path, (rows) =>
                        rows.map((entry, at) =>
                          at === index ? { ...entry, [item.path]: next } : entry,
                        ),
                      )
                    }
                  />
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    disabled={(values.lists[field.path] ?? []).length <= 1}
                    onClick={() =>
                      setRows(field.path, (rows) => rows.filter((_, at) => at !== index))
                    }
                  >
                    Remove this row
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                size="sm"
                variant="outline"
                icon="plus"
                onClick={() =>
                  setRows(field.path, (rows) => [...rows, emptyRow(field.item_fields ?? [])])
                }
              >
                Add a row
              </Button>
            </div>
          </fieldset>
        ) : (
          <Control
            key={field.path}
            field={{ ...field, input: field.input }}
            value={values.fields[field.path] ?? ''}
            onChange={(next) => setField(field.path, next)}
          />
        ),
      )}
      {kind.scopes.length ? (
        <fieldset className="col field-group" style={{ gap: 8 }}>
          <legend style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
            What it may do
          </legend>
          {kind.scopes.map((scope) => (
            <span
              key={scope.scope}
              className="row"
              style={{ gap: 8, fontSize: 13, color: 'var(--heading)' }}
            >
              <Checkbox
                label={scope.label}
                checked={values.scopes[scope.scope] === true}
                onChange={(next) =>
                  setValues((current) => ({
                    ...current,
                    scopes: { ...current.scopes, [scope.scope]: next },
                  }))
                }
              />
              {scope.label}
              {scope.asks_first ? <Badge tone="outline">Asks you first</Badge> : null}
            </span>
          ))}
        </fieldset>
      ) : null}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Button type="submit" loading={sending} disabled={sending || gap !== null}>
          Connect and test
        </Button>
        <Button variant="ghost" disabled={sending} onClick={onDone}>
          Cancel
        </Button>
        {gap ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{gap}</span> : null}
      </div>
    </form>
  );
}

export type SignInEntry = CatalogEntry & { connect: { method: 'sign_in' } };
const isSignIn = (entry: CatalogEntry): entry is SignInEntry => entry.connect.method === 'sign_in';

/**
 * Signing in to an account. Before the browser leaves for the provider, the
 * person sees where they will sign in and everything Melete asks for there.
 */
export function AccountSignIn({
  entry,
  onDone,
  onInstalled,
}: {
  entry: SignInEntry;
  onDone: () => void;
  onInstalled: () => void;
}) {
  const provider = entry.connect.provider;
  const [started, setStarted] = useState<AccountSignInStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(entry.available);

  useEffect(() => {
    if (!entry.available) return;
    let live = true;
    void adapter.startAccountSignIn(provider).then((r) => {
      if (!live) return;
      setLoading(false);
      if (r.data) setStarted(r.data);
      else setError(r.error ?? r.unavailable ?? 'Couldn’t start signing in');
    });
    return () => {
      live = false;
    };
  }, [entry.available, provider]);

  // Once the provider's page is open, wait for the sign-in to finish there.
  useEffect(() => {
    if (!opened || !started) return;
    const until = new Date(started.expires_at).getTime();
    const timer = window.setInterval(() => {
      if (Date.now() > until) {
        window.clearInterval(timer);
        setError('The sign-in expired. Start again.');
        return;
      }
      void adapter.accountSignInStatus(provider, started.sign_in_id).then((r) => {
        if (!r.data || r.data.state === 'pending') return;
        window.clearInterval(timer);
        if (r.data.state === 'connected') {
          toast({ kind: 'ok', title: `${entry.title} connected` });
          onInstalled();
          onDone();
        } else setError(r.data.error);
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [opened, started, provider, entry.title, onInstalled, onDone]);

  const issuer = new URL(started?.issuer ?? entry.connect.issuer).host;
  const scopes = started?.scopes ?? entry.connect.scopes;
  return (
    <div className="col card-12" style={{ gap: 10, padding: 16, maxWidth: 560 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
        Sign in with {entry.title}
      </span>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>
        You sign in at <strong>{issuer}</strong>. Melete asks {entry.title} for:
      </span>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)' }}>
        {scopes.map((item) => (
          <li key={item.scope}>{item.label ?? item.scope}</li>
        ))}
      </ul>
      {!entry.available ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {NOT_SET_UP}{' '}
          {SETUP_DOCS[provider] ? (
            <a href={SETUP_DOCS[provider]} target="_blank" rel="noreferrer">
              How to set this up
            </a>
          ) : null}
        </span>
      ) : null}
      {error ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
      {opened && !error ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          Finish signing in on the {entry.title} page. This updates when you are done.
        </span>
      ) : null}
      <div className="row" style={{ gap: 8 }}>
        {entry.available ? (
          <Button
            icon="arrowUpRight"
            loading={loading}
            disabled={!started || opened}
            onClick={() => {
              if (!started) return;
              window.open(started.authorize_url, '_blank', 'noopener,noreferrer');
              setOpened(true);
            }}
          >
            Continue to {entry.title}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AddConnection({ onInstalled }: { onInstalled: () => void }) {
  const kinds = useLoad(() => adapter.connectionKinds(), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const list = kinds.data?.kinds ?? [];
  const kind = list.find((item) => item.id === chosen);
  const accounts = (kinds.data?.catalog ?? []).filter(isSignIn);
  const account = accounts.find((item) => item.id === signingIn);
  // Sign-ins this server offers come first; the ones it is not set up for say so, with no button.
  const ready = accounts.filter((item) => item.available);
  const later = accounts.filter((item) => !item.available);
  const everyday = list.filter((item) => EVERYDAY.has(item.kind));
  const builders = list.filter((item) => !EVERYDAY.has(item.kind));
  const easier = (kindId: string) => accounts.find((item) => item.id === SIGN_IN_FOR[kindId]);
  // An instance that does not serve kinds cannot install anything, so nothing is drawn.
  if (kinds.unavailable || (!kinds.loading && !kinds.error && list.length === 0)) return null;

  return (
    <div className="col" style={{ gap: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
        Add a connection
      </span>
      {kinds.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{kinds.error}</p> : null}
      {account ? (
        <AccountSignIn
          key={account.id}
          entry={account}
          onDone={() => setSigningIn(null)}
          onInstalled={onInstalled}
        />
      ) : kind ? (
        <KindForm
          key={kind.id}
          kind={kind}
          signIn={easier(kind.id)}
          onSignIn={() => {
            const entry = easier(kind.id);
            if (!entry) return;
            setChosen(null);
            setSigningIn(entry.id);
          }}
          onDone={() => {
            setChosen(null);
            onInstalled();
          }}
        />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {ready.length || everyday.length ? (
            <div className="col" style={{ gap: 8 }}>
              <span className="connect-group">Mail and calendars</span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {ready.map((item) => (
                  <Button
                    key={item.id}
                    variant="outline"
                    icon="plus"
                    title={item.description}
                    onClick={() => setSigningIn(item.id)}
                  >
                    Sign in with {item.title}
                  </Button>
                ))}
                {everyday.map((item) => (
                  <Button
                    key={item.id}
                    variant="outline"
                    icon="plus"
                    title={item.description}
                    onClick={() => setChosen(item.id)}
                  >
                    {item.title}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {later.length ? (
            <div className="col" style={{ gap: 6 }}>
              {later.map((item) => (
                <div key={item.id} className="row connect-later">
                  <span className="connect-later-name">Sign in with {item.title}</span>
                  <span className="grow">{NOT_SET_UP}</span>
                  {SETUP_DOCS[item.connect.provider] ? (
                    <a href={SETUP_DOCS[item.connect.provider]} target="_blank" rel="noreferrer">
                      How to set this up
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {builders.length ? (
            <div className="col" style={{ gap: 8 }}>
              <span className="connect-group">For developers</span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {builders.map((item) => (
                  <Button
                    key={item.id}
                    variant="outline"
                    icon="plus"
                    title={item.description}
                    onClick={() => setChosen(item.id)}
                  >
                    {item.title}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Signing in to a remote MCP server that asked for it. The sign-in is started
 * first, so the person sees where they will sign in before the browser leaves;
 * the page is then opened from the click itself, which pop-up blockers allow.
 * A service that cannot take sign-ins says why (it needs its public address).
 */
export function McpSignIn({ connectionId, label }: { connectionId: string; label: string }) {
  const [started, setStarted] = useState<McpSignInStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [opened, setOpened] = useState(false);
  if (!started)
    return (
      <Button
        size="sm"
        loading={starting}
        disabled={starting}
        onClick={() => {
          setStarting(true);
          void adapter
            .startMcpSignIn(connectionId)
            .then((result) => {
              if (result.data) setStarted(result.data);
              else
                toast({
                  kind: 'err',
                  title: `Couldn’t start signing in to ${label}`,
                  sub: result.error ?? result.unavailable ?? undefined,
                });
            })
            .finally(() => setStarting(false));
        }}
      >
        Sign in
      </Button>
    );
  const host = URL.canParse(started.issuer) ? new URL(started.issuer).host : started.issuer;
  return (
    <span className="row" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
      <Button
        size="sm"
        disabled={opened}
        onClick={() => {
          window.open(started.authorize_url, '_blank', 'noopener,noreferrer');
          setOpened(true);
        }}
      >
        Continue to {host}
      </Button>
      {opened
        ? 'Finish signing in there, then test the connection.'
        : started.scopes.length
          ? `Asks for: ${started.scopes.map((scope) => scope.label ?? scope.scope).join(', ')}`
          : null}
    </span>
  );
}

/**
 * Test and remove, for one connection. A connection the service keeps in every
 * space is tested here and not removed: the service does not make it again.
 */
export function ConnectionActions({
  id,
  label,
  removable,
  onChanged,
}: {
  id: string;
  label: string;
  removable: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'test' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const test = () => {
    setBusy('test');
    void adapter
      .testConnection(id)
      .then((result) => {
        setNeedsSignIn(result.data?.check.code === 'needs_sign_in');
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t test that' });
        else if (result.data.check.status === 'failing')
          toast({ kind: 'err', title: `${label} is not working`, sub: result.data.check.detail });
        else toast({ kind: 'ok', title: `${label} is working`, sub: result.data.check.detail });
        onChanged();
      })
      .finally(() => setBusy(null));
  };
  const remove = () => {
    setBusy('remove');
    void adapter
      .removeConnection(id)
      .then((result) => {
        if (result.data === null) {
          toast({
            kind: 'err',
            title: result.error ?? result.unavailable ?? 'Couldn’t remove that',
          });
          return;
        }
        toast({ kind: 'ok', title: `${label} was removed` });
        onChanged();
      })
      .finally(() => {
        setBusy(null);
        setConfirming(false);
      });
  };
  return (
    <div className="row" style={{ gap: 6 }}>
      <Button
        size="sm"
        variant="outline"
        loading={busy === 'test'}
        disabled={busy !== null}
        onClick={test}
      >
        Test
      </Button>
      {needsSignIn ? <McpSignIn connectionId={id} label={label} /> : null}
      {!removable ? null : confirming ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            loading={busy === 'remove'}
            disabled={busy !== null}
            onClick={remove}
          >
            Remove {label}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}
