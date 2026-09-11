/**
 * Settings: the only place the technology shows. Memory in plain language
 * with edit, delete and why; Connections with their state machine and what
 * each may do; Rules, the standing grants a person created, with revoke.
 */
import { useEffect, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { isLogo, Logo } from '../design/logos.tsx';
import { Badge, Button, IconButton, Input, TabsUnderline } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { agentById, useApp, useLoad } from '../experience/hooks.ts';
import type { ConnectionData, MemoryItem } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';

const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  onboarding: 'You told Melete during setup',
  conversation: 'Learned in a conversation',
  inferred: 'Melete worked this out',
};

function MemoryRow({
  item,
  onChange,
  onDelete,
}: {
  item: MemoryItem;
  onChange: (next: MemoryItem) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.value);
  const [why, setWhy] = useState(false);
  return (
    <div
      className="col"
      style={{ gap: 8, padding: '12px 14px', borderTop: '1px solid var(--line)' }}
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--blue-soft)',
            color: 'var(--blue-ink)',
            flexShrink: 0,
          }}
        >
          <Icon name="bookmark" size={14} />
        </span>
        <div className="col grow" style={{ gap: 4, minWidth: 200 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--heading)' }}>{item.key}</span>
          {editing ? (
            <form
              className="row"
              style={{ gap: 8 }}
              onSubmit={(event) => {
                event.preventDefault();
                const next = value.trim();
                if (!next) return;
                void adapter.updateMemory(item.id, next).then((r) => {
                  if (r.data) onChange(r.data);
                  setEditing(false);
                });
              }}
            >
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                width="100%"
                height={32}
                aria-label={item.key}
                autoFocus
              />
              <Button size="sm" type="submit">
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <span style={{ fontSize: 14, color: 'var(--text)' }}>{item.value}</span>
          )}
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {SOURCE_LABEL[item.source]} · {item.created}
            {item.last_used ? ` · used ${item.last_used}` : ''}
          </span>
          {why ? (
            <span
              style={{
                fontSize: 13,
                color: 'var(--secondary)',
                padding: '8px 12px',
                borderRadius: 10,
                background: 'var(--soft)',
              }}
            >
              {item.why}
            </span>
          ) : null}
        </div>
        <div className="row" style={{ gap: 2 }}>
          <Button size="sm" variant="ghost" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
            Why
          </Button>
          <IconButton
            name="pencil"
            label={`Edit ${item.key}`}
            size={28}
            iconSize={14}
            onClick={() => setEditing(true)}
          />
          <IconButton
            name="trash"
            label={`Forget ${item.key}`}
            size={28}
            iconSize={14}
            onClick={onDelete}
          />
        </div>
      </div>
    </div>
  );
}

const ACCESS_LABEL: Record<ConnectionData['access'], string> = {
  read: 'Read only',
  write: 'Read and write',
  draft: 'Draft only · you always send',
};

export function ConnectionCard({
  connection,
  onChange,
  compact = false,
}: {
  connection: ConnectionData;
  onChange: (next: ConnectionData) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // "connecting" resolves on the service; poll until it does.
  useEffect(() => {
    if (connection.state !== 'connecting') return;
    const timer = setInterval(() => {
      void adapter.connections().then((r) => {
        const next = r.data?.connections.find((c) => c.id === connection.id);
        if (next && next.state !== 'connecting') onChange(next);
      });
    }, 600);
    return () => clearInterval(timer);
  }, [connection.state, connection.id, onChange]);

  const connect = () => {
    setBusy(true);
    void adapter.connect(connection.id).then((r) => {
      setBusy(false);
      if (r.data) onChange(r.data);
      else toast({ kind: 'err', title: r.error ?? 'Couldn’t connect' });
    });
  };
  const tail =
    connection.state === 'connected' ? (
      <div className="row" style={{ gap: 8 }}>
        <Badge tone="success" dot>
          Connected
        </Badge>
        {compact ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void adapter.disconnect(connection.id).then((r) => r.data && onChange(r.data))
            }
          >
            Disconnect
          </Button>
        )}
      </div>
    ) : connection.state === 'connecting' ? (
      <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <Icon name="loader" size={14} stroke={2} className="spin" />
        Opening the sign-in…
      </span>
    ) : connection.state === 'error' ? (
      <div className="row" style={{ gap: 8 }}>
        <Badge tone="danger" dot>
          Needs attention
        </Badge>
        <Button size="sm" variant="outline" loading={busy} onClick={connect}>
          Reconnect
        </Button>
      </div>
    ) : (
      <Button
        size="sm"
        variant={compact ? 'outline' : 'primary'}
        icon={compact ? undefined : 'connectors'}
        loading={busy}
        onClick={connect}
        block={compact}
      >
        Connect
      </Button>
    );
  return (
    <div
      className={compact ? 'col card-12' : 'row card'}
      style={{
        gap: compact ? 10 : 12,
        padding: compact ? 12 : '12px 12px 12px 14px',
        borderRadius: 14,
        flexWrap: compact ? undefined : 'wrap',
      }}
    >
      <div className="row" style={{ gap: 10, flex: 1, minWidth: 200 }}>
        {isLogo(connection.app) ? (
          <Logo name={connection.app} size={40} />
        ) : (
          <span
            className="row"
            style={{
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'var(--blue-soft)',
              color: 'var(--blue-ink)',
            }}
          >
            <Icon name="globe" size={20} />
          </span>
        )}
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
            {connection.name}
          </span>
          <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {connection.state === 'error' && connection.error
              ? connection.error
              : connection.state === 'connected'
                ? ACCESS_LABEL[connection.access]
                : connection.what}
          </span>
        </div>
      </div>
      {tail}
    </div>
  );
}

export function SettingsScreen({ tab }: { tab: string }) {
  const { agents } = useApp();
  const memory = useLoad(() => adapter.memory(), []);
  const connections = useLoad(() => adapter.connections(), []);
  const rules = useLoad(() => adapter.rules(), []);
  const current = tab === 'connections' || tab === 'rules' ? tab : 'memory';
  const items = memory.data?.items ?? [];
  const list = connections.data?.connections ?? [];
  const setConnection = (next: ConnectionData) =>
    connections.set({ connections: list.map((c) => (c.id === next.id ? next : c)) });

  return (
    <Shell title="Settings">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Settings</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              What Melete remembers, what it may reach, and what it may do without asking.
            </p>
          </div>
        </div>
        <TabsUnderline
          label="Settings"
          value={current}
          onChange={(next) => navigate(`/settings/${next}`)}
          tabs={[
            { value: 'memory', label: 'Memory', count: items.length },
            {
              value: 'connections',
              label: 'Connections',
              count: list.filter((c) => c.state === 'connected').length,
            },
            { value: 'rules', label: 'Rules', count: rules.data?.rules.length ?? 0 },
          ]}
        />
        {current === 'memory' ? (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Agents use these quietly. Anything here can be changed or forgotten, and Melete can
              always say why it used one.
            </p>
            <div className="card-12" style={{ overflow: 'hidden' }}>
              <div style={{ height: 1 }} />
              {items.map((item) => (
                <MemoryRow
                  key={item.id}
                  item={item}
                  onChange={(next) =>
                    memory.set({ items: items.map((i) => (i.id === next.id ? next : i)) })
                  }
                  onDelete={() =>
                    void adapter.deleteMemory(item.id).then(() => {
                      memory.set({ items: items.filter((i) => i.id !== item.id) });
                      toast({ kind: 'ok', title: `Forgot “${item.key}”` });
                    })
                  }
                />
              ))}
              {memory.data && items.length === 0 ? (
                <div
                  className="col"
                  style={{
                    alignItems: 'center',
                    gap: 8,
                    padding: '32px 24px',
                    textAlign: 'center',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-head)',
                      fontSize: 16,
                      fontWeight: 600,
                      color: 'var(--heading)',
                    }}
                  >
                    Nothing remembered yet
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    Melete adds to this list as you talk, and tells you when it does.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : current === 'connections' ? (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Melete reads what you connect and asks before it writes anywhere. Access is per agent;
              set it on each agent’s Access tab.
            </p>
            {connections.error ? (
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>{connections.error}</p>
            ) : null}
            <div className="col" style={{ gap: 8 }}>
              {list.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onChange={setConnection}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Each rule came from an “Always allow” you chose. Revoke one and the agent asks again
              next time.
            </p>
            <div className="card-12" style={{ overflow: 'hidden' }}>
              <div style={{ height: 1 }} />
              {(rules.data?.rules ?? []).map((rule) => {
                const agent = agentById(agents, rule.agent_id);
                return (
                  <div key={rule.id} className="list-row" style={{ minHeight: 60 }}>
                    {isLogo(rule.connection.app) ? (
                      <Logo name={rule.connection.app} size={32} />
                    ) : (
                      <Icon name="lock" size={18} />
                    )}
                    <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                        {rule.text}
                      </span>
                      <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                        {agent ? <AgentFace look={agent.look} size={16} /> : null}
                        {agent?.name ?? 'Melete'} · {rule.connection.label} · since {rule.created}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void adapter.revokeRule(rule.id).then(() => {
                          rules.set({
                            rules: (rules.data?.rules ?? []).filter((r) => r.id !== rule.id),
                          });
                          toast({
                            kind: 'ok',
                            title: 'Rule revoked',
                            sub: 'The agent will ask next time.',
                          });
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                );
              })}
              {rules.data && rules.data.rules.length === 0 ? (
                <div
                  className="col"
                  style={{
                    alignItems: 'center',
                    gap: 8,
                    padding: '32px 24px',
                    textAlign: 'center',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-head)',
                      fontSize: 16,
                      fontWeight: 600,
                      color: 'var(--heading)',
                    }}
                  >
                    No standing rules
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    Every agent asks before it writes anywhere.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
