/**
 * Settings: the only place the technology shows. Memory is what Melete
 * believes about the person, grouped, sourced and correctable, with its
 * timeline and the lessons and skills it learned; then connections with their state and what each may do, and standing rules
 * with their limits and revoke.
 */
import { type ReactNode, useState } from 'react';
import { logoFor } from '../chat/parts.tsx';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Logo } from '../design/logos.tsx';
import { Badge, Button, TabsUnderline } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import { givenName } from '../experience/profile.ts';
import type { Connection, Rule } from '../experience/types.ts';
import { FeedbackTab } from '../feedback/FeedbackTab.tsx';
import { models } from '../models/api.ts';
import { ModelLine, ModelsTab } from '../models/ModelConnect.tsx';
import { navigate } from '../router.ts';
import { RailToggle, Shell, toast } from '../shell/Shell.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { ApprovalsTab } from './Approvals.tsx';
import { MemoryPanel } from './Beliefs.tsx';
import { AddConnection, ConnectionActions } from './ConnectionInstall.tsx';
import { NotificationsTab } from './Notifications.tsx';
import { PrivacyTab } from './Privacy.tsx';

const dateOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

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

/**
 * Other assistants the person let use Melete, each with a way to disconnect it.
 * An installation that does not offer the MCP endpoint answers with an error,
 * and then there is nothing here to list or disconnect.
 */
function ConnectedAssistants() {
  const assistants = useLoad(() => adapter.assistants(), []);
  const [ending, setEnding] = useState<string | null>(null);
  if (!assistants.data) return null;
  const clients = assistants.data.clients;
  return (
    <section className="col" style={{ gap: 8, marginTop: 12 }} aria-labelledby="assistants-head">
      <h2
        id="assistants-head"
        style={{ fontSize: 15, fontWeight: 600, color: 'var(--heading)', margin: 0 }}
      >
        Connected assistants
      </h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560, margin: 0 }}>
        Other assistants you let use Melete as you. Disconnecting one ends its access at once.
      </p>
      {clients.length === 0 ? (
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>No assistant is connected.</span>
      ) : (
        <div className="card-12" style={{ overflow: 'hidden' }}>
          <div style={{ height: 1 }} />
          {clients.map((client) => (
            <div key={client.client_id} className="list-row" style={{ minHeight: 60 }}>
              <Icon name="connectors" size={18} />
              <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span
                  className="clamp1"
                  style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                >
                  {client.name}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Connected since {dateOf(client.since)}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                loading={ending === client.client_id}
                disabled={ending !== null}
                aria-label={`Disconnect ${client.name}`}
                onClick={() => {
                  setEnding(client.client_id);
                  void adapter.disconnectAssistant(client.client_id).then((r) => {
                    setEnding(null);
                    if (r.data === null) {
                      toast({ kind: 'err', title: r.error ?? 'Couldn’t disconnect' });
                      return;
                    }
                    assistants.set({
                      clients: clients.filter((c) => c.client_id !== client.client_id),
                    });
                    toast({ kind: 'ok', title: `Disconnected ${client.name}` });
                  });
                }}
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const ruleWhen = (rule: Rule) => {
  const expires = new Date(rule.bounds.expires_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `${rule.used} of ${rule.bounds.count_cap} used · until ${expires} · asks again after ${rule.bounds.reconsent_after_days} day${rule.bounds.reconsent_after_days === 1 ? '' : 's'}`;
};

export function SettingsScreen({ tab, detail = null }: { tab: string; detail?: string | null }) {
  const { profile, signOut } = useApp();
  const [leaving, setLeaving] = useState(false);
  const connections = useLoad(() => adapter.connections(), []);
  const rules = useLoad(() => adapter.rules(), []);
  const model = useLoad(() => models.settings(), []);
  const current =
    tab === 'connections' ||
    tab === 'rules' ||
    tab === 'notifications' ||
    tab === 'feedback' ||
    tab === 'models' ||
    tab === 'approvals' ||
    tab === 'privacy' ||
    tab === 'account'
      ? tab
      : 'memory';
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
          <RailToggle />
        </div>
        <div className="card-12 row" style={{ gap: 12, padding: '12px 16px', flexWrap: 'wrap' }}>
          <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)' }}>
              Signed in as {givenName(profile) || 'you'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Signing out ends this session on every open tab; nothing saved here is lost.
            </span>
            {model.data ? <ModelLine settings={model.data} /> : null}
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
            { value: 'memory', label: 'Memory' },
            { value: 'notifications', label: 'Notifications' },
            {
              value: 'connections',
              label: 'Connections',
              count: connections.error
                ? undefined
                : list.filter((c) => c.status === 'connected').length,
            },
            { value: 'approvals', label: 'Approvals' },
            {
              value: 'rules',
              label: 'Rules',
              count: rules.error ? undefined : rules.data?.rules.length,
            },
            { value: 'feedback', label: 'Feedback' },
            { value: 'models', label: 'Models' },
            { value: 'privacy', label: 'Privacy' },
            { value: 'account', label: 'Account' },
          ]}
        />
        {current === 'privacy' ? <PrivacyTab /> : null}
        {current === 'memory' ? (
          <MemoryPanel />
        ) : current === 'approvals' ? (
          <ApprovalsTab />
        ) : current === 'notifications' ? (
          <NotificationsTab />
        ) : current === 'feedback' ? (
          <FeedbackTab selected={detail} />
        ) : current === 'models' ? (
          <ModelsTab loaded={model} />
        ) : current === 'account' ? (
          <AccountSettings />
        ) : current === 'connections' ? (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Melete reads what you connect and asks before it writes anywhere. Access is per agent;
              set it on each agent’s Access tab.
            </p>
            {connections.error ? (
              <LoadError
                what="your connections"
                error={connections.error}
                onRetry={connections.reload}
              />
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
                      removable={connection.builtin !== true}
                      onChanged={connections.reload}
                    />
                  }
                />
              ))}
            </div>
            {connections.data && !connections.error && list.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is connected yet.</span>
            ) : null}
            <AddConnection onInstalled={connections.reload} />
            <ConnectedAssistants />
          </div>
        ) : current === 'privacy' ? null : (
          <div className="col" style={{ gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
              Each rule came from an “Always allow” you chose. It has a limit and an expiry; revoke
              it and the agent asks again next time.
            </p>
            {rules.error ? (
              <LoadError what="your rules" error={rules.error} onRetry={rules.reload} />
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
              {rules.data && !rules.error && rules.data.rules.length === 0 ? (
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
