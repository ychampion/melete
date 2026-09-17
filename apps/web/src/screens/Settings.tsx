/**
 * Settings: the only place the technology shows. Saved details in plain
 * language with edit, forget and why; connections with their state and what
 * each may do; standing rules with their limits and revoke.
 */
import { type ReactNode, useState } from 'react';
import { logoFor } from '../chat/parts.tsx';
import { Icon } from '../design/icons.tsx';
import { Logo } from '../design/logos.tsx';
import { Badge, Button, IconButton, Input, TabsUnderline } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import type { Connection, MemoryItem, Rule } from '../experience/types.ts';
import { navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { AddConnection, ConnectionActions } from './ConnectionInstall.tsx';

const SOURCE_LABEL: Record<MemoryItem['source'], string> = {
  onboarding: 'You told Melete during setup',
  conversation: 'Learned in a conversation',
  inferred: 'Melete worked this out',
};

const dateOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

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
  const [why, setWhy] = useState<string[] | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const explain = () => {
    if (whyOpen) {
      setWhyOpen(false);
      return;
    }
    void adapter.memoryWhy(item.id).then((r) => {
      setWhy(
        r.data
          ? r.data.reasons.length
            ? r.data.reasons
            : ['No recent use of this detail is recorded.']
          : [r.error ?? r.unavailable ?? 'No explanation is available.'],
      );
      setWhyOpen(true);
    });
  };
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
                void adapter.editMemory(item.id, next, item.version).then(async (r) => {
                  if (r.data === null) {
                    toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save' });
                    return;
                  }
                  const fresh = await adapter.memory();
                  const updated = fresh.data?.items.find((i) => i.id === item.id);
                  if (updated) onChange(updated);
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
            {SOURCE_LABEL[item.source]} · {dateOf(item.created)}
            {item.last_used ? ` · used ${dateOf(item.last_used)}` : ''}
          </span>
          {whyOpen && why ? (
            <div
              className="col"
              style={{
                gap: 4,
                fontSize: 13,
                color: 'var(--secondary)',
                padding: '8px 12px',
                borderRadius: 10,
                background: 'var(--soft)',
              }}
            >
              {why.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="row" style={{ gap: 2 }}>
          <Button size="sm" variant="ghost" onClick={explain} aria-expanded={whyOpen}>
            Why
          </Button>
          {item.editable ? (
            <IconButton
              name="pencil"
              label={`Edit ${item.key}`}
              size={28}
              iconSize={14}
              onClick={() => setEditing(true)}
            />
          ) : null}
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

const ACCESS_LABEL: Record<Connection['access'], string> = {
  read_only: 'Read only',
  asks_before_acting: 'Asks before acting',
  draft_only: 'Draft only · you always send',
};

export function ConnectionCard({
  connection,
  compact = false,
  actions,
}: {
  connection: Connection;
  compact?: boolean;
  /** What may be done to this connection here; absent where a card only reports. */
  actions?: ReactNode;
}) {
  const logo = logoFor(connection.app);
  const tail =
    connection.status === 'connected' ? (
      <Badge tone="success" dot>
        Connected
      </Badge>
    ) : connection.status === 'connecting' ? (
      <span className="row" style={{ gap: 8, fontSize: 12, color: 'var(--muted)' }}>
        <Icon name="loader" size={14} stroke={2} className="spin" />
        Connecting…
      </span>
    ) : connection.status === 'error' ? (
      <Badge tone="danger" dot>
        Needs attention
      </Badge>
    ) : (
      <Badge tone="outline">Available</Badge>
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
        {logo ? (
          <Logo name={logo} size={40} />
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
            <Icon name="connectors" size={20} />
          </span>
        )}
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
            {connection.label}
          </span>
          <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {connection.app} · {ACCESS_LABEL[connection.access]}
          </span>
        </div>
      </div>
      {tail}
      {actions}
    </div>
  );
}

const ruleWhen = (rule: Rule) => {
  const expires = new Date(rule.bounds.expires_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `${rule.used} of ${rule.bounds.count_cap} used · until ${expires} · asks again after ${rule.bounds.reconsent_after_days} day${rule.bounds.reconsent_after_days === 1 ? '' : 's'}`;
};

export function SettingsScreen({ tab }: { tab: string }) {
  const { profile, signOut } = useApp();
  const [leaving, setLeaving] = useState(false);
  const memory = useLoad(() => adapter.memory(), []);
  const connections = useLoad(() => adapter.connections(), []);
  const rules = useLoad(() => adapter.rules(), []);
  const current = tab === 'connections' || tab === 'rules' ? tab : 'memory';
  const items = memory.data?.items ?? [];
  const list = connections.data?.connections ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));

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
        <div className="card-12 row" style={{ gap: 12, padding: '12px 16px', flexWrap: 'wrap' }}>
          <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
              Signed in as {profile?.name ?? 'you'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Signing out ends this session on every open tab; nothing saved here is lost.
            </span>
          </div>
          <Button
            variant="outline"
            icon="logout"
            loading={leaving}
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut().finally(() => setLeaving(false));
            }}
          >
            Sign out
          </Button>
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
              count: list.filter((c) => c.status === 'connected').length,
            },
            { value: 'rules', label: 'Rules', count: rules.data?.rules.length ?? 0 },
          ]}
        />
        {current === 'memory' ? (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Agents use these quietly. Anything here can be changed or forgotten, and Melete can
              say why it used one.
            </p>
            {memory.error ? (
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>{memory.error}</p>
            ) : null}
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
                    void adapter.deleteMemory(item.id).then((r) => {
                      if (r.data === null) {
                        toast({
                          kind: 'err',
                          title: r.error ?? r.unavailable ?? 'Couldn’t forget that',
                        });
                        return;
                      }
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
                  actions={
                    <ConnectionActions
                      id={connection.id}
                      label={connection.label}
                      onChanged={connections.reload}
                    />
                  }
                />
              ))}
            </div>
            {connections.data && list.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is connected yet.</span>
            ) : null}
            <AddConnection onInstalled={connections.reload} />
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Each rule came from an “Always allow” you chose. It has a limit and an expiry; revoke
              it and the agent asks again next time.
            </p>
            {rules.error ? (
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>{rules.error}</p>
            ) : null}
            <div className="card-12" style={{ overflow: 'hidden' }}>
              <div style={{ height: 1 }} />
              {(rules.data?.rules ?? []).map((rule) => {
                const connection = byId.get(rule.connection_id);
                const logo = connection ? logoFor(connection.app) : null;
                return (
                  <div key={rule.id} className="list-row" style={{ minHeight: 60 }}>
                    {logo ? <Logo name={logo} size={32} /> : <Icon name="lock" size={18} />}
                    <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                        {rule.text}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {connection?.label ?? 'A connection'} · {ruleWhen(rule)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void adapter.revokeRule(rule.id).then((r) => {
                          if (r.data === null) {
                            toast({
                              kind: 'err',
                              title: r.error ?? r.unavailable ?? 'Couldn’t revoke',
                            });
                            return;
                          }
                          rules.set({
                            rules: (rules.data?.rules ?? []).filter((x) => x.id !== rule.id),
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
