/**
 * Home: the morning brief, the decisions waiting on the person as a queue
 * they clear one card at a time, what is in motion, and today beside it.
 * Every line is composed from what the service returns; a section with
 * nothing behind it is not drawn.
 */
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { Composer } from '../chat/Composer.tsx';
import { companiesApi, currentSpaceId } from '../companies/api.ts';
import { amountWords, matches, money } from '../companies/format.ts';
import { statusOf } from '../companies/Ledger.tsx';
import { AgentFace } from '../design/face.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { Button, Checkbox, Input, Status } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import {
  agentById,
  faceOf,
  lookOf,
  messageKey,
  useApp,
  useDecisions,
  useLoad,
  useNow,
} from '../experience/hooks.ts';
import { progressOf } from '../experience/trace.ts';
import type {
  Agent,
  CalendarEvent,
  CompanyMap,
  Conversation,
  LedgerItem,
  Permission,
  Question,
} from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import './home.css';

const PROMPTS: { label: string; icon: IconName; text: string }[] = [
  {
    label: 'Plan my day',
    icon: 'calendar',
    text: 'Plan my day around what is already on the calendar.',
  },
  { label: 'Explore an idea', icon: 'sparkles', text: 'Help me think through an idea.' },
  { label: 'Plan a trip', icon: 'compass', text: 'Plan a trip: two weeks in Japan, slow pace.' },
];

const FIRST_MESSAGE = 'This is the first message to this company. You are asked once.';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spell = (n: number) => NUMBER_WORDS[n] ?? String(n);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The line under the greeting, from counts alone: the decisions waiting, and
 * the companies that owe the person money. A clause whose count is zero is
 * dropped, and so is the line when both are.
 */
export function briefLine(
  decisions: number,
  owing: number,
  owedMinor: number,
  currency: string,
): string | null {
  const waiting =
    decisions > 0
      ? decisions === 1
        ? 'one decision is waiting'
        : `${spell(decisions)} decisions are waiting`
      : null;
  const owed =
    owing > 0 && owedMinor > 0
      ? `${spell(owing)} ${owing === 1 ? 'company owes' : 'companies owe'} you ${money(owedMinor, currency)}`
      : null;
  if (waiting && owed) return `${capital(waiting)}, and ${owed}.`;
  if (waiting) return `${capital(waiting)}.`;
  if (owed) return `${capital(owed)}.`;
  return null;
}

/** How a company suggestion reads, by what the item is. Kinds with no phrase are not offered. */
const SUGGESTION: Partial<Record<LedgerItem['kind'], (company: string) => string>> = {
  trial_ending: (company) => `Cancel ${company} before the trial ends`,
  price_rise: (company) => `Question ${company}’s rise`,
  invoice_unpaid: (company) => `Chase ${company} for the invoice`,
  refund_owed: (company) => `Chase ${company} for the refund`,
  wrong_charge: (company) => `Dispute ${company}’s charge`,
  subscription: (company) => `Cancel ${company}`,
  renewal: (company) => `Cancel ${company} before it renews`,
};

const SUGGESTION_ICON: Partial<Record<LedgerItem['kind'], IconName>> = {
  trial_ending: 'clock',
  price_rise: 'trendUp',
  invoice_unpaid: 'fileText',
  refund_owed: 'piggy',
  wrong_charge: 'alert',
  subscription: 'x',
  renewal: 'refresh',
};

type Suggestion = { id: string; label: string; icon: IconName };

function suggestionsOf(map: CompanyMap | null, now: number): Suggestion[] {
  if (!map) return [];
  const name = (id: string) => map.companies.find((company) => company.id === id)?.name;
  return map.items
    .filter(
      (item) =>
        item.suggested_playbook !== null &&
        item.job_id === null &&
        item.status === 'found' &&
        SUGGESTION[item.kind] !== undefined &&
        name(item.company_id) !== undefined,
    )
    .sort((a, b) => {
      if (a.due_at === b.due_at) return 0;
      if (a.due_at === null) return 1;
      if (b.due_at === null) return -1;
      return Math.abs(Date.parse(a.due_at) - now) - Math.abs(Date.parse(b.due_at) - now);
    })
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      label: SUGGESTION[item.kind]?.(name(item.company_id) ?? '') ?? '',
      icon: SUGGESTION_ICON[item.kind] ?? 'sparkles',
    }));
}

function relative(iso: string, now: number): string {
  const date = new Date(iso);
  if (now - date.getTime() < 5 * 60_000) return 'now';
  if (date.toDateString() === new Date(now).toDateString())
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

/* ---------- the queue ---------- */

type Decision =
  | { kind: 'permission'; id: string; permission: Permission }
  | { kind: 'question'; id: string; question: Question };

function Face({ agent, size, state }: { agent: Agent | null; size: number; state?: 'idle' }) {
  return agent ? (
    <AgentFace look={lookOf(agent)} size={size} state={state ?? 'idle'} />
  ) : (
    <MeleteAvatar size={size} />
  );
}

function DecisionCard({
  decision,
  conversation,
  agent,
  linked,
  now,
  onDecide,
  onAnswer,
}: {
  decision: Decision;
  conversation: Conversation | undefined;
  agent: Agent | null;
  linked: { item: LedgerItem; company: string } | null;
  now: number;
  onDecide: (permission: Permission, option: 'allow_once' | 'deny') => void;
  onAnswer: (question: Question, optionId: string) => void;
}) {
  const chatId =
    decision.kind === 'permission'
      ? decision.permission.conversation_id
      : decision.question.conversation_id;
  const open = () => {
    if (chatId) navigate(`/chat/${chatId}`);
  };
  const permission = decision.kind === 'permission' ? decision.permission : null;
  const question = decision.kind === 'question' ? decision.question : null;
  const options = question?.options.slice(0, 4) ?? [];
  const can = (option: 'allow_once' | 'deny') => permission?.options.includes(option) ?? false;

  // The keys work only while this card has focus.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (permission) {
      if (key === 'enter' && target === event.currentTarget && can('allow_once')) {
        event.preventDefault();
        onDecide(permission, 'allow_once');
      } else if (key === 'd' && can('deny')) {
        event.preventDefault();
        onDecide(permission, 'deny');
      }
    }
    if (question) {
      const n = Number(event.key);
      const option = Number.isInteger(n) ? options[n - 1] : undefined;
      if (option) {
        event.preventDefault();
        onAnswer(question, option.id);
      }
    }
    if (key === 'r' && chatId) {
      event.preventDefault();
      open();
    }
  };

  const title = permission
    ? permission.why[0] === FIRST_MESSAGE && linked
      ? `Send the first message to ${linked.company}?`
      : permission.what
    : (question?.text ?? '');
  const field = (label: string) =>
    permission?.why
      .find((line) => line.startsWith(`${label}: `))
      ?.slice(label.length + 2)
      .trim();
  const from = field('From');
  const to = field('To') ?? permission?.draft?.recipient;
  const amount = linked ? amountWords(linked.item) : null;
  const state = linked ? statusOf(linked.item, now) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card and carries no more meaning than a named group
    <div
      className="decision"
      role="group"
      aria-label={title}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card takes focus so its keys apply to it alone
      tabIndex={0}
      onKeyDown={onKey}
    >
      <div className="decision-who">
        <Face agent={agent} size={22} />
        <span className="decision-agent">{agent?.name ?? 'Melete'}</span>
        {conversation ? (
          <span className="decision-for clamp1">for {conversation.title}</span>
        ) : null}
        <div className="grow" />
        {amount && state ? (
          <Status tone={state.tone} quiet>
            {amount.figure} · {state.words}
          </Status>
        ) : null}
      </div>
      <p className="decision-title voice">{title}</p>
      {permission && (permission.draft || from || to) ? (
        <div className="decision-preview">
          {permission.draft ? (
            <div className="clamp2 decision-draft">{permission.draft.body}</div>
          ) : null}
          {from || to ? (
            <span className="decision-meta">
              {from ? `From ${from}` : ''}
              {from && to ? ' to ' : ''}
              {!from && to ? 'To ' : ''}
              {to ?? ''}
            </span>
          ) : null}
        </div>
      ) : null}
      {permission && !permission.draft && permission.why.length > 0 && !from && !to ? (
        <span className="decision-meta">{permission.why[0]}</span>
      ) : null}
      {question ? (
        <div className="col" style={{ gap: 6 }}>
          {options.map((option, index) => {
            const [label, ...description] = option.label.split(' · ');
            return (
              <button
                key={option.id}
                type="button"
                className="question-option"
                onClick={() => onAnswer(question, option.id)}
              >
                <span className="kbd">{index + 1}</span>
                <span className="decision-option">{label}</span>
                <span className="clamp1 grow decision-meta">{description.join(' · ')}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="decision-actions">
        {permission && can('allow_once') ? (
          <Button className="btn-card" hint="↵" onClick={() => onDecide(permission, 'allow_once')}>
            Allow once
          </Button>
        ) : null}
        {chatId ? (
          <Button className="btn-card" variant="outline" hint="R" onClick={open}>
            Read it all
          </Button>
        ) : null}
        <div className="grow" />
        {permission && can('deny') ? (
          <Button
            className="btn-card"
            variant="ghost"
            hint="D"
            onClick={() => onDecide(permission, 'deny')}
          >
            Deny
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function WaitingOnYou({
  decisions,
  map,
  now,
}: {
  decisions: ReturnType<typeof useDecisions>;
  map: CompanyMap | null;
  now: number;
}) {
  const { agents, conversations, refreshConversations } = useApp();
  const { permissions, questions } = decisions;
  const [offset, setOffset] = useState(0);
  const queue: Decision[] = [
    ...(permissions.data?.permissions ?? []).map(
      (permission): Decision => ({ kind: 'permission', id: permission.id, permission }),
    ),
    ...(questions.data?.questions ?? []).map(
      (question): Decision => ({ kind: 'question', id: question.id, question }),
    ),
  ];
  if (queue.length === 0) return null;
  const at = offset % queue.length;
  const ordered = [...queue.slice(at), ...queue.slice(0, at)];
  const [front, next] = ordered;
  if (!front) return null;

  const chatOf = (decision: Decision) =>
    decision.kind === 'permission'
      ? decision.permission.conversation_id
      : decision.question.conversation_id;
  const conversationOf = (decision: Decision) =>
    conversations.find((conversation) => conversation.id === chatOf(decision));
  const agentOf = (decision: Decision) => agentById(agents, conversationOf(decision)?.agent_id);
  const linkedOf = (decision: Decision) => {
    const item = map?.items.find((entry) => entry.job_id && entry.job_id === chatOf(decision));
    const company = item && map?.companies.find((entry) => entry.id === item.company_id);
    return item && company ? { item, company: company.name } : null;
  };
  const settled = () => {
    permissions.reload();
    questions.reload();
    refreshConversations();
  };
  const decide = (permission: Permission, option: 'allow_once' | 'deny') =>
    void adapter.decide(permission.id, option, permission.version).then((result) => {
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t decide' });
        return;
      }
      settled();
    });
  const answer = (question: Question, optionId: string) =>
    void adapter.answer(question.id, optionId).then((result) => {
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer' });
        return;
      }
      settled();
    });

  return (
    <section className="home-section" aria-labelledby="home-waiting">
      <div className="home-section-head">
        <h2 id="home-waiting">
          Waiting on you
          <span className="nav-count">{queue.length}</span>
        </h2>
      </div>
      <div className="queue">
        <DecisionCard
          key={front.id}
          decision={front}
          conversation={conversationOf(front)}
          agent={agentOf(front)}
          linked={linkedOf(front)}
          now={now}
          onDecide={decide}
          onAnswer={answer}
        />
        {next ? (
          <button type="button" className="queue-next" onClick={() => setOffset((n) => n + 1)}>
            <Face agent={agentOf(next)} size={16} />
            <span className="queue-next-agent">{agentOf(next)?.name ?? 'Melete'}</span>
            <span className="clamp1 grow queue-next-what">
              {next.kind === 'permission' ? next.permission.what : next.question.text}
            </span>
            <span className="queue-next-hint">
              Next
              <Icon name="chevronDown" size={13} />
            </span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ---------- in motion ---------- */

const MOVING = new Set<Conversation['status']>(['queued', 'working', 'streaming', 'paused']);

const STATUS_LINE: Partial<Record<Conversation['status'], string>> = {
  queued: 'Starting',
  working: 'Working',
  streaming: 'Answering',
  paused: 'Paused',
  done: 'Done',
};

function InMotion({ now }: { now: number }) {
  const { agents, conversations } = useApp();
  const rows = conversations
    .filter(
      (conversation) =>
        MOVING.has(conversation.status) ||
        (conversation.status === 'done' && now - Date.parse(conversation.updated_at) < 86_400_000),
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 3);
  if (rows.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby="home-motion">
      <div className="home-section-head">
        <h2 id="home-motion">In motion</h2>
      </div>
      <div className="motion">
        {rows.map((conversation) => {
          const agent = agentById(agents, conversation.agent_id);
          const progress = progressOf(conversation);
          const segments = progress
            ? Math.min(8, progress.steps_done + (progress.current ? 1 : 0))
            : 0;
          return (
            <a key={conversation.id} className="motion-row" href={href(`/chat/${conversation.id}`)}>
              {agent ? (
                <AgentFace look={lookOf(agent)} size={28} state={faceOf(conversation.status)} />
              ) : (
                <MeleteAvatar size={28} />
              )}
              <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="clamp1 motion-title">{conversation.title}</span>
                <span className="clamp1 motion-line">
                  {progress?.current ??
                    STATUS_LINE[conversation.status] ??
                    `${agent?.name ?? 'Melete'} is on it`}
                </span>
              </span>
              {progress && segments > 0 ? (
                <span
                  className="motion-track"
                  role="img"
                  aria-label={`${progress.steps_done} step${progress.steps_done === 1 ? '' : 's'} done${
                    progress.current ? `, now: ${progress.current}` : ''
                  }`}
                >
                  {Array.from({ length: segments }, (_, index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions, not items
                      key={index}
                      data-state={index < progress.steps_done ? 'done' : 'now'}
                    />
                  ))}
                </span>
              ) : null}
              <span className="motion-when">{relative(conversation.updated_at, now)}</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

/* ---------- the day ---------- */

const DAY_START = 8;
const DAY_END = 22;
const HOUR_PX = 24;
const TINTS = ['travel', 'sage', 'lilac', 'sand'] as const;

const hourLabel = (hour: number) =>
  hour === 12 ? 'Noon' : `${hour > 12 ? hour - 12 : hour} ${hour >= 12 ? 'PM' : 'AM'}`;
const clockOf = (date: Date) =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function EventBody({ title, time, tall }: { title: string; time: string; tall: boolean }) {
  return tall ? (
    <>
      <span className="clamp1 day-event-title">{title}</span>
      <span className="clamp1 day-event-time">{time}</span>
    </>
  ) : (
    <span className="clamp1 day-event-title">
      {title} · {time}
    </span>
  );
}

function DayGrid({ events, now }: { events: CalendarEvent[]; now: number }) {
  const today = new Date(now);
  const hoursOf = (date: Date) => date.getHours() + date.getMinutes() / 60;
  const top = (hours: number) =>
    (Math.min(DAY_END, Math.max(DAY_START, hours)) - DAY_START) * HOUR_PX;
  const nowHours = hoursOf(today);
  const nowTop = nowHours >= DAY_START && nowHours <= DAY_END ? top(nowHours) : null;
  const todays = events.filter(
    (event) => new Date(event.starts_at).toDateString() === today.toDateString(),
  );
  const hours: number[] = [];
  for (let hour = DAY_START; hour <= DAY_END; hour += 2) hours.push(hour);
  return (
    <div className="day-grid" style={{ height: (DAY_END - DAY_START) * HOUR_PX }}>
      {hours.map((hour) => {
        const at = top(hour);
        // The now tag is 18px tall; a label that close to it would sit under it.
        const hidden = nowTop !== null && Math.abs(at - nowTop) < 16;
        return (
          <div key={hour} className="day-hour" style={{ top: at }}>
            <span style={{ visibility: hidden ? 'hidden' : undefined }}>{hourLabel(hour)}</span>
            <span className="day-line" />
          </div>
        );
      })}
      {nowTop !== null ? <div className="day-past" style={{ height: nowTop }} /> : null}
      {todays.map((event, index) => {
        const start = new Date(event.starts_at);
        const end = new Date(event.ends_at);
        const y = top(hoursOf(start));
        const height = Math.max(22, top(hoursOf(end)) - y - 2);
        if (hoursOf(start) >= DAY_END || hoursOf(end) <= DAY_START) return null;
        const tint = TINTS[index % TINTS.length] ?? 'travel';
        const style = {
          top: y,
          height,
          background: `var(--${tint})`,
          color: `var(--${tint}-ink)`,
        };
        return event.url ? (
          <a
            key={event.id}
            className="day-event"
            href={event.url}
            target="_blank"
            rel="noreferrer"
            style={style}
          >
            <EventBody title={event.title} time={clockOf(start)} tall={height >= 32} />
          </a>
        ) : (
          <div key={event.id} className="day-event" style={style}>
            <EventBody title={event.title} time={clockOf(start)} tall={height >= 32} />
          </div>
        );
      })}
      {nowTop !== null ? (
        <>
          <div className="day-now" style={{ top: nowTop - 1 }} />
          <span className="day-now-tag" style={{ top: nowTop - 9 }}>
            {clockOf(today).replace(/\s?[AP]M$/, '')}
          </span>
        </>
      ) : null}
    </div>
  );
}

function DayColumn({ now }: { now: number }) {
  const home = useLoad(() => adapter.home(), []);
  const tasks = useLoad(() => adapter.tasks(), []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const upcoming: CalendarEvent[] | null =
    home.data && Array.isArray(home.data.upcoming) ? (home.data.upcoming as CalendarEvent[]) : null;
  const today = new Date(now).toDateString();
  const later = (upcoming ?? []).find(
    (event) =>
      new Date(event.starts_at).toDateString() !== today && Date.parse(event.starts_at) > now,
  );
  const list = tasks.data?.tasks ?? [];
  const done = list.filter((task) => task.done).length;
  return (
    <aside className="home-day" aria-label="Today">
      {upcoming ? (
        <section className="home-section" aria-labelledby="home-today">
          <div className="home-section-head">
            <h2 id="home-today">Today</h2>
          </div>
          <DayGrid events={upcoming} now={now} />
          {later ? (
            <span className="day-next">
              Next: {later.title},{' '}
              {new Date(later.starts_at).toLocaleDateString('en-US', { weekday: 'long' })}{' '}
              {clockOf(new Date(later.starts_at))}
            </span>
          ) : null}
        </section>
      ) : null}
      {tasks.data ? (
        <section className="home-section" aria-labelledby="home-tasks">
          <div className="home-section-head">
            <h2 id="home-tasks">Tasks</h2>
            {list.length ? (
              <span className="home-section-meta">
                {done} of {list.length} done
              </span>
            ) : null}
          </div>
          <div className="col">
            {list.map((task) => (
              <div key={task.id} className="task-row" data-done={task.done ? 'true' : undefined}>
                <Checkbox
                  checked={task.done}
                  label={task.title}
                  onChange={(next) =>
                    void adapter.setTask(task, { done: next }).then((result) => {
                      if (result.data)
                        tasks.set({
                          tasks: list.map((t) => (t.id === task.id ? result.data.task : t)),
                        });
                    })
                  }
                />
                <span className="clamp1">{task.title}</span>
              </div>
            ))}
            {adding ? (
              <form
                className="row"
                style={{ gap: 8, paddingTop: 6 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = draft.trim();
                  if (!text) return;
                  void adapter.addTask(text).then((result) => {
                    if (result.data) tasks.set({ tasks: [...list, result.data.task] });
                  });
                  setDraft('');
                  setAdding(false);
                }}
              >
                <Input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="A task"
                  aria-label="New task"
                  width="100%"
                  height={32}
                  autoFocus
                />
                <Button size="sm" type="submit">
                  Add
                </Button>
              </form>
            ) : (
              <button type="button" className="task-add" onClick={() => setAdding(true)}>
                <Icon name="plus" size={15} />
                Add a task
              </button>
            )}
          </div>
        </section>
      ) : null}
    </aside>
  );
}

/* ---------- the screen ---------- */

export function HomeScreen() {
  const { agents, refreshConversations } = useApp();
  const home = useLoad(() => adapter.home(), []);
  const decisions = useDecisions();
  const [map, setMap] = useState<CompanyMap | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(true, 60_000);

  useEffect(() => {
    let live = true;
    void currentSpaceId().then(async (space) => {
      if (!live || space.data === null) return;
      const result = await companiesApi.map(space.data);
      if (live && result.data) setMap(result.data);
    });
    return () => {
      live = false;
    };
  }, []);

  const start = async (body: string) => {
    const clean = body.trim();
    const agent = agents[0];
    if (!clean || busy || !agent) return;
    setBusy(true);
    const title =
      clean
        .replace(/[.!?].*$/, '')
        .trim()
        .slice(0, 60) || 'New chat';
    const created = await adapter.createConversation({ title, agent_id: agent.id });
    if (created.data === null) {
      setBusy(false);
      toast({
        kind: 'err',
        title: 'Couldn’t start the chat',
        sub: created.error ?? created.unavailable ?? '',
      });
      return;
    }
    const sent = await adapter.send(created.data.conversation.id, clean, messageKey());
    setBusy(false);
    if (sent.data === null)
      toast({ kind: 'err', title: 'Couldn’t send', sub: sent.error ?? sent.unavailable ?? '' });
    refreshConversations();
    navigate(`/chat/${created.data.conversation.id}`);
  };

  const handle = async (itemId: string) => {
    if (busy) return;
    setBusy(true);
    const result = await companiesApi.handle(itemId);
    setBusy(false);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t start it' });
      return;
    }
    refreshConversations();
    navigate(`/chat/${result.data.job_id}`);
  };

  const owing = useMemo(() => {
    if (!map) return 0;
    const owed = map.items.filter((item) =>
      matches(item, { kind: 'direction', value: 'owed_to_you' }, now),
    );
    return new Set(owed.map((item) => item.company_id)).size;
  }, [map, now]);
  const line = briefLine(
    decisions.count,
    owing,
    map?.totals.owed_to_you_minor ?? 0,
    map?.currency ?? 'GBP',
  );
  const suggestions = suggestionsOf(map, now);
  const prompts = PROMPTS.slice(0, Math.max(0, 3 - suggestions.length));
  const data = home.data;

  return (
    <Shell title="Home" rail={false}>
      <div className="home">
        <div className="home-main">
          <header className="brief">
            {data ? <span className="brief-date">{data.date}</span> : null}
            <h1 className="brief-greeting voice">{data?.greeting ?? 'Hello'}</h1>
            {line ? <p className="brief-line voice">{line}</p> : null}
          </header>
          {home.error ? <p className="home-error">{home.error}</p> : null}
          <div className="home-compose">
            <Composer
              value={text}
              onChange={setText}
              onSend={() => void start(text)}
              placeholder="Ask Melete to handle something"
              disabled={busy}
            />
            <div className="suggestions">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="suggestion"
                  disabled={busy}
                  onClick={() => void handle(suggestion.id)}
                >
                  <Icon name={suggestion.icon} size={14} />
                  {suggestion.label}
                </button>
              ))}
              {prompts.map((prompt) => (
                <button
                  key={prompt.label}
                  type="button"
                  className="suggestion"
                  disabled={busy}
                  onClick={() => void start(prompt.text)}
                >
                  <Icon name={prompt.icon} size={14} />
                  {prompt.label}
                </button>
              ))}
            </div>
          </div>
          <WaitingOnYou decisions={decisions} map={map} now={now} />
          <InMotion now={now} />
        </div>
        <DayColumn now={now} />
      </div>
    </Shell>
  );
}
