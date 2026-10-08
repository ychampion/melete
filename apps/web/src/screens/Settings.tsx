/**
 * Settings: the only place the technology shows. Memory is what Melete
 * believes about the person, grouped, sourced and correctable, with its
 * timeline and the lessons and skills it learned; then connections with their
 * state and what each may do, the person's own computers, and standing rules
 * with their limits and revoke.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { appIcon, logoFor } from '../chat/parts.tsx';
import { Icon } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Logo } from '../design/logos.tsx';
import { Badge, Button, TabsUnderline, Toggle } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useLoad } from '../experience/hooks.ts';
import type { Connection, Rule } from '../experience/types.ts';
import { FeedbackTab } from '../feedback/FeedbackTab.tsx';
import { models } from '../models/api.ts';
import { ModelsTab } from '../models/ModelConnect.tsx';
import { navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { ActivityTab } from './Activity.tsx';
import { ApprovalsTab } from './Approvals.tsx';
import { MemoryPanel } from './Beliefs.tsx';
import { AddConnection, ConnectionActions } from './ConnectionInstall.tsx';
import { DevicesTab } from './Devices.tsx';
import { NotificationsTab } from './Notifications.tsx';
import { PeopleTab } from './People.tsx';
import { PrivacyTab } from './Privacy.tsx';
import './settings.css';

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
  footer,
}: {
  connection: Connection;
  compact?: boolean;
  /** What may be done to this connection here; absent where a card only reports. */
  actions?: ReactNode;
  /** A setting for this connection, on its own line under the rest. */
  footer?: ReactNode;
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
        {connection.problem?.kind === 'not_running'
          ? 'Not running'
          : connection.problem?.kind === 'failing'
            ? 'Failing'
            : 'Needs attention'}
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
            <Icon name={appIcon(connection.app, connection.label)} size={20} />
          </span>
        )}
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
            {connection.label}
          </span>
          <span className="clamp1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {connection.app} · {ACCESS_LABEL[connection.access]}
          </span>
          {connection.status === 'error' && connection.problem ? (
            <span className="connection-problem">{connection.problem.detail}</span>
          ) : connection.reading_note ? (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{connection.reading_note}</span>
          ) : null}
        </div>
      </div>
      {tail}
      {actions}
      {footer ? <div style={{ flexBasis: '100%', minWidth: 0 }}>{footer}</div> : null}
    </div>
  );
}

/** What the watch switch says it does, for a mailbox or a calendar, on or off. */
export function watchWords(app: string, on: boolean): string {
  if (!on) return 'Off. Melete still reads this account for things you asked it to watch.';
  return /calendar/i.test(app)
    ? 'Melete reads each event’s title, time and place to notice changes and clashes.'
    : 'Melete reads new mail’s sender and subject to notice what needs you.';
}

/**
 * The switch on a mailbox or calendar: whether Melete watches it for changes
 * without being asked. It reads only what changed (who wrote and the subject
 * line, or when and where a meeting is), so work that is waiting hears of it.
 */
export function WatchSwitch({
  connection,
  onChanged,
}: {
  connection: Connection;
  onChanged: (connections: Connection[]) => void;
}) {
  const [saving, setSaving] = useState(false);
  const on = connection.watching === true;
  const title = 'Watch this account for changes';
  const reads = watchWords(connection.app, on);
  return (
    <div
      className="row"
      style={{
        gap: 12,
        paddingTop: 10,
        borderTop: '1px solid var(--line)',
        alignItems: 'center',
      }}
    >
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{reads}</span>
      </span>
      {/* Kept enabled while saving, so the switch keeps its focus for the keyboard. */}
      <Toggle
        on={on}
        label={`${title}: ${connection.label}`}
        onChange={(next) => {
          if (saving) return;
          setSaving(true);
          void adapter.watchConnection(connection.id, next).then((r) => {
            setSaving(false);
            if (r.data === null) {
              toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save' });
              return;
            }
            onChanged(r.data.connections);
            toast({
              kind: 'ok',
              title: next ? `Watching ${connection.label}` : `Stopped watching ${connection.label}`,
            });
          });
        }}
      />
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

/**
 * Reading public web pages in conversations, for this space. On by default;
 * an installation without the setting draws nothing here.
 */
function WebReads() {
  const setting = useLoad(() => adapter.webReads(), []);
  const [saving, setSaving] = useState(false);
  if (!setting.data?.available) return null;
  const enabled = setting.data.enabled;
  return (
    <div className="card-12 row" style={{ gap: 12, padding: '12px 16px', flexWrap: 'wrap' }}>
      <span
        className="row"
        style={{
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'var(--blue-soft)',
          color: 'var(--blue-ink)',
          flexShrink: 0,
        }}
      >
        <Icon name="globe" size={20} />
      </span>
      <div className="col grow" style={{ gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
          Read public web pages
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 520 }}>
          {enabled ? 'On' : 'Off'} · on by default. Conversations can open public pages to answer
          you. They never sign in, fill in forms or post, and private spaces and agents stay
          offline.
        </span>
      </div>
      <Toggle
        on={enabled}
        disabled={saving}
        label="Read public web pages"
        onChange={(next) => {
          setSaving(true);
          void adapter.saveWebReads(next).then((r) => {
            setSaving(false);
            if (r.data === null) {
              toast({ kind: 'err', title: r.error ?? r.unavailable ?? 'Couldn’t save' });
              return;
            }
            setting.set(r.data);
            toast({
              kind: 'ok',
              title: r.data.enabled ? 'Public web pages on' : 'Public web pages off',
            });
          });
        }}
      />
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

/** The Settings pages in the order the tabs show them. Memory has its own page in the nav. */
const TABS = [
  'account',
  'notifications',
  'people',
  'connections',
  'devices',
  'approvals',
  'rules',
  'activity',
  'models',
  'privacy',
  'feedback',
] as const;
type Tab = (typeof TABS)[number] | 'memory';

export function SettingsScreen({ tab, detail = null }: { tab: string; detail?: string | null }) {
  const connections = useLoad(() => adapter.connections(), []);
  const rules = useLoad(() => adapter.rules(), []);
  const model = useLoad(() => models.settings(), []);
  const people = useLoad(() => adapter.spaceMembers(), []);
  // People is a shared space's page; a personal space has only its owner.
  const shared = people.data?.space.kind === 'shared';
  const current: Tab =
    tab === 'memory'
      ? 'memory'
      : (((TABS as readonly string[]).includes(tab) ? tab : 'account') as Tab);
  const [deviceCount, setDeviceCount] = useState<number | undefined>(undefined);
  const list = connections.data?.connections ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const memory = current === 'memory';
  // The chosen tab stays in view when the strip is wider than the page.
  const tabsRef = useRef<HTMLDivElement>(null);
  // The strip itself is scrolled, not the page, and again whenever its tabs
  // change width: the counts beside earlier tabs arrive after the first paint
  // and push a tab near the end, such as Activity, back out of view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of tab is what moves it
  useEffect(() => {
    const strip = tabsRef.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!strip) return;
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      const start = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left;
      const end = start + tab.offsetWidth;
      if (start < 0) strip.scrollLeft += start - 16;
      else if (end > strip.clientWidth) strip.scrollLeft += end - strip.clientWidth + 16;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(reveal);
    for (const child of strip.children) watch.observe(child);
    return () => watch.disconnect();
  }, [current]);

  return (
    <Shell title={memory ? 'Memory' : 'Settings'} rail={false}>
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>{memory ? 'Memory' : 'Settings'}</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              {memory
                ? 'What Melete has learned about you, where it learned it, and how to change it.'
                : 'What Melete may reach, what it may do without asking, and your account.'}
            </p>
          </div>
        </div>
        {memory ? null : (
          <div ref={tabsRef} className="settings-tabs">
            <TabsUnderline
              label="Settings"
              value={current}
              onChange={(next) => navigate(`/settings/${next}`)}
              tabs={[
                { value: 'account', label: 'Account' },
                { value: 'notifications', label: 'Notifications' },
                ...(shared
                  ? [
                      {
                        value: 'people' as const,
                        label: 'People',
                        count: people.data?.members.length,
                      },
                    ]
                  : []),
                {
                  value: 'connections',
                  label: 'Connections',
                  count: connections.error
                    ? undefined
                    : list.filter((c) => c.status === 'connected').length,
                },
                { value: 'devices', label: 'Devices', count: deviceCount },
                { value: 'approvals', label: 'Approvals' },
                {
                  value: 'rules',
                  label: 'Rules',
                  count: rules.error ? undefined : rules.data?.rules.length,
                },
                { value: 'activity', label: 'Activity' },
                { value: 'models', label: 'Models' },
                { value: 'privacy', label: 'Privacy' },
                { value: 'feedback', label: 'Feedback' },
              ]}
            />
          </div>
        )}
        {current === 'privacy' ? <PrivacyTab /> : null}
        {current === 'activity' ? <ActivityTab /> : null}
        {current === 'people' ? (
          <PeopleTab
            people={people.data}
            error={people.error}
            onRetry={people.reload}
            onChanged={people.set}
          />
        ) : null}
        {current === 'memory' ? (
          <MemoryPanel />
        ) : current === 'approvals' ? (
          <ApprovalsTab />
        ) : current === 'notifications' ? (
          <NotificationsTab />
        ) : current === 'devices' ? (
          <DevicesTab onCount={setDeviceCount} />
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
            <WebReads />
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
                  footer={
                    connection.watching === undefined ? undefined : (
                      <WatchSwitch
                        connection={connection}
                        onChanged={(next) => connections.set({ connections: next })}
                      />
                    )
                  }
                />
              ))}
            </div>
            {connections.data && !connections.error && list.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing is connected yet.</span>
            ) : null}
            <AddConnection
              onInstalled={connections.reload}
              connected={
                new Set(list.flatMap((item) => (item.catalog_id ? [item.catalog_id] : [])))
              }
            />
            <ConnectedAssistants />
          </div>
        ) : current === 'privacy' || current === 'people' || current === 'activity' ? null : (
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
