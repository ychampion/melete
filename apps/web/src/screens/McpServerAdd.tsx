/**
 * Adding an MCP server by its address. The person gives it a name and the
 * address; Melete asks the server for its tools (signing in first when the
 * server wants that) and shows each one with where it starts: looking only, a
 * change that can be undone, a change that asks first, or spending money.
 * The person keeps or drops each tool and changes how far it may act, then
 * connects. Nobody types a tool name.
 */
import {
  MAX_DISCOVERED_TOOLS,
  mcpDiscoveredConfig,
  mcpServerId,
} from '@melete/contracts/mcp-catalog';
import { useEffect, useState } from 'react';
import { Button, Checkbox, Field, Input, Select } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { DiscoveredMcpTool, McpSignInStart } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

type Effect = DiscoveredMcpTool['effect_class'];

/** How far a tool may act, in the person's words. */
export const EFFECT_CHOICES: { value: Effect; label: string }[] = [
  { value: 'read', label: 'Looks only' },
  { value: 'write_reversible', label: 'Changes that can be undone' },
  { value: 'write_external', label: 'Asks you first' },
  { value: 'spend', label: 'Spends money (asks you first)' },
];

type Choice = DiscoveredMcpTool & { keep: boolean };

/** Why a sign-in ended without the tools, by its code. */
const SIGN_IN_ENDED: Record<string, string> = {
  discover_unreachable:
    'You signed in, but the server could not be reached to read its tools. Try again.',
  discover_not_mcp:
    'You signed in, but the server did not answer as an MCP server when asked for its tools.',
  sign_in_declined: 'The sign-in was not approved.',
};

/** The tools a server listed, each kept or dropped, with how far it may act. */
export function ToolChoices({
  choices,
  onChange,
}: {
  choices: Choice[];
  onChange: (next: Choice[]) => void;
}) {
  const set = (name: string, change: Partial<Choice>) =>
    onChange(choices.map((item) => (item.name === name ? { ...item, ...change } : item)));
  const kept = choices.filter((item) => item.keep).length;
  return (
    <fieldset className="col field-group mcp-tools" style={{ gap: 8 }}>
      <legend style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
        Its tools ({kept} of {choices.length} kept)
      </legend>
      <span className="app-connect-note">
        Melete suggests how far each may act. Looking only runs without asking; changes that can be
        undone are checked first; the rest ask you every time.
      </span>
      <ul className="col mcp-tool-list" style={{ gap: 8 }}>
        {choices.map((item) => (
          <li key={item.name} className="mcp-tool" data-dropped={item.keep ? undefined : 'true'}>
            <span className="row" style={{ gap: 8, minWidth: 0, alignItems: 'flex-start' }}>
              <Checkbox
                checked={item.keep}
                label={`Use ${item.name}`}
                onChange={(keep) => set(item.name, { keep })}
              />
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <code className="mcp-tool-name">{item.name}</code>
                {item.description ? (
                  <span className="app-connect-note">{item.description}</span>
                ) : null}
              </span>
            </span>
            <Select
              label={`How far ${item.name} may act`}
              value={item.effect_class}
              onChange={(value) => set(item.name, { effect_class: value as Effect })}
              options={EFFECT_CHOICES}
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

const fromTools = (tools: DiscoveredMcpTool[]): Choice[] =>
  tools.map((tool, index) => ({ ...tool, keep: index < MAX_DISCOVERED_TOOLS }));

export function McpServerAdd({
  onDone,
  onInstalled,
  spaceId,
}: {
  onDone: () => void;
  onInstalled?: () => void;
  spaceId?: string;
}) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  // The server wants a sign-in before it lists its tools.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signIn, setSignIn] = useState<McpSignInStart | null>(null);
  const [opened, setOpened] = useState(false);
  const id = mcpServerId(label);
  const host = URL.canParse(url) ? new URL(url).host : '';
  const kept = (choices ?? []).filter((item) => item.keep);

  // Once the server's sign-in page is open, wait for its tools.
  useEffect(() => {
    if (!opened || !signIn) return;
    const until = new Date(signIn.expires_at).getTime();
    const timer = window.setInterval(() => {
      if (Date.now() > until) {
        window.clearInterval(timer);
        setError('The sign-in expired. Start again.');
        return;
      }
      void adapter.mcpSignInStatus(signIn.sign_in_id).then((r) => {
        if (!r.data || r.data.state === 'pending') return;
        window.clearInterval(timer);
        if (r.data.state === 'ready') setChoices(fromTools(r.data.tools));
        else if (r.data.state === 'failed')
          setError(SIGN_IN_ENDED[r.data.error] ?? 'The sign-in didn’t finish. Try again.');
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [opened, signIn]);

  const find = () => {
    setBusy(true);
    setError(null);
    void adapter
      .discoverMcpTools(url.trim(), token.trim() || undefined, spaceId)
      .then((r) => {
        if (!r.data) setError(r.error ?? r.unavailable ?? 'Couldn’t read its tools');
        else if (r.data.state === 'needs_sign_in') setNeedsSignIn(true);
        else if (!r.data.tools.length) setError('The server lists no tools Melete can use.');
        else setChoices(fromTools(r.data.tools));
      })
      .finally(() => setBusy(false));
  };

  const startSignIn = () => {
    setBusy(true);
    setError(null);
    void adapter
      .startDiscoverySignIn(label.trim(), id, url.trim(), spaceId)
      .then((r) => {
        if (r.data) setSignIn(r.data);
        else setError(r.error ?? r.unavailable ?? 'Couldn’t start signing in');
      })
      .finally(() => setBusy(false));
  };

  const connect = () => {
    const tools = kept.map(({ name, effect_class }) => ({ name, effect_class }));
    setBusy(true);
    setError(null);
    const request = signIn
      ? adapter.installSignedIn(signIn.sign_in_id, tools)
      : adapter.installConnection({
          provider: 'mcp',
          label: label.trim(),
          scopes: [],
          mcp: mcpDiscoveredConfig(id, url.trim(), tools),
          ...(token.trim() ? { credentials: { access_token: token.trim() } } : {}),
          ...(spaceId ? { space_id: spaceId } : {}),
        });
    void request
      .then((r) => {
        if (!r.data) {
          setError(r.error ?? r.unavailable ?? 'Couldn’t connect it');
          return;
        }
        const check = r.data.check;
        if (check && check.status === 'failing')
          toast({ kind: 'err', title: `${label} was saved but is not working`, sub: check.detail });
        else toast({ kind: 'ok', title: `${label} is connected` });
        onInstalled?.();
        onDone();
      })
      .finally(() => setBusy(false));
  };

  const ready = id.length > 0 && URL.canParse(url.trim());
  return (
    <form
      className="col card-12"
      style={{ gap: 14, padding: 16 }}
      aria-label="Add an MCP server"
      onSubmit={(event) => {
        event.preventDefault();
        if (choices) connect();
        else if (!needsSignIn && ready) find();
      }}
    >
      <div className="col" style={{ gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)' }}>
          Add an MCP server
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          Give its address and Melete reads what it can do. You choose which of its tools to use and
          how far each may act.
        </span>
      </div>
      <Field label="Name">
        <Input
          value={label}
          maxLength={120}
          placeholder="DeepWiki"
          disabled={choices !== null || signIn !== null}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      <Field label="Server address">
        <Input
          type="url"
          value={url}
          placeholder="https://mcp.example.com/mcp"
          spellCheck={false}
          autoComplete="off"
          disabled={choices !== null || signIn !== null}
          onChange={(event) => {
            setUrl(event.target.value);
            setNeedsSignIn(false);
          }}
        />
      </Field>
      {choices === null && !needsSignIn ? (
        <Field
          label="Access token (optional)"
          hint="Only if the server’s owner gave you one. Most servers ask you to sign in instead."
        >
          <Input
            type="password"
            value={token}
            autoComplete="new-password"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      ) : null}
      {needsSignIn && !choices ? (
        <div className="col connect-easier" role="note">
          <span>
            {host || 'This server'} asks you to sign in before it shows what it can do. You choose
            its tools after signing in.
          </span>
          {opened ? (
            <span role="status">Finish signing in there. This updates when you are done.</span>
          ) : null}
        </div>
      ) : null}
      {choices ? <ToolChoices choices={choices} onChange={setChoices} /> : null}
      {choices && kept.length > MAX_DISCOVERED_TOOLS ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          Keep at most {MAX_DISCOVERED_TOOLS} tools.
        </span>
      ) : null}
      {error ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>
          {error}
        </span>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {choices ? (
          <Button
            type="submit"
            loading={busy}
            disabled={busy || !kept.length || kept.length > MAX_DISCOVERED_TOOLS}
          >
            Connect {label.trim() || 'server'}
          </Button>
        ) : needsSignIn ? (
          signIn ? (
            <Button
              icon="arrowUpRight"
              disabled={opened}
              onClick={() => {
                window.open(signIn.authorize_url, '_blank', 'noopener,noreferrer');
                setOpened(true);
              }}
            >
              Continue to {URL.canParse(signIn.issuer) ? new URL(signIn.issuer).host : host}
            </Button>
          ) : (
            <Button loading={busy} disabled={busy || !ready} onClick={startSignIn}>
              Sign in to {host || 'the server'}
            </Button>
          )
        ) : (
          <Button type="submit" loading={busy} disabled={busy || !ready}>
            Find its tools
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
