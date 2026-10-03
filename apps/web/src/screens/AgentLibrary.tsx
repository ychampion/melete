/**
 * The agent library on the Agents screen: agents recommended for what the
 * person has connected, a featured row, shelves, and search; a sheet that
 * shows an agent at work in an example chat and says what it does and never
 * does; and a short draft to name it and choose what it may use before it is
 * made. Nothing is made, granted or set up without the person pressing for it.
 */
import { libraryScheduleWords } from '@melete/contracts/agent-library';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Markdown } from '../chat/Markdown.tsx';
import { logoFor, Questionnaire } from '../chat/parts.tsx';
import { LogEntries } from '../chat/WorkLog.tsx';
import '../chat/chat.css';
import { AgentFace, FACE_PALETTE } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { Logo } from '../design/logos.tsx';
import { Button, Checkbox, Chip, Field, IconButton, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf } from '../experience/hooks.ts';
import type { Agent, AgentInput, AgentTemplate, Connection } from '../experience/types.ts';
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import {
  dayWork,
  kindsOfApp,
  listWords,
  missingNeeds,
  recommend,
  SHELF_ICON,
  searchLibrary,
  shelvesOf,
  suggests,
  WORKS_WITH,
  type WorksWith,
} from './agent-library.ts';
import './agent-library.css';

const labelsOf = (kinds: readonly WorksWith[]) => kinds.map((kind) => WORKS_WITH[kind].label);

/** What an agent works best with, as small icons, named once for assistive tech. */
export function ReachIcons({ kinds }: { kinds: readonly WorksWith[] }) {
  if (!kinds.length) return null;
  return (
    <span
      className="reach-icons"
      role="img"
      aria-label={`Works best with ${listWords(labelsOf(kinds))}`}
    >
      {kinds.map((kind) => (
        <span key={kind} className="reach-icon" title={WORKS_WITH[kind].label} aria-hidden="true">
          <Icon name={WORKS_WITH[kind].icon} size={13} />
        </span>
      ))}
    </span>
  );
}

/** The agent's own colour, washed into the surface behind its face. */
const tintOf = (colour: string): CSSProperties => ({ '--agent-tint': colour }) as CSSProperties;

function LibraryCard({
  template,
  feature = false,
  open,
  onOpen,
}: {
  template: AgentTemplate;
  feature?: boolean;
  open: boolean;
  onOpen: (template: AgentTemplate) => void;
}) {
  const { agent } = template;
  const reach = labelsOf(template.works_best_with);
  return (
    <button
      type="button"
      className="lib-card"
      data-feature={feature ? 'true' : undefined}
      data-library-card={template.id}
      data-on={open ? 'true' : undefined}
      aria-label={`${agent.name}, ${template.title}. ${template.benefit}${reach.length ? ` Works best with ${listWords(reach)}.` : ''}`}
      style={tintOf(agent.colour)}
      onClick={() => onOpen(template)}
    >
      <span className="lib-card-face">
        <AgentFace look={lookOf(agent)} size={feature ? 56 : 40} state="idle" />
      </span>
      <span className="lib-card-id">
        <span className="lib-card-name">{agent.name}</span>
        <span className="lib-card-role">{template.title}</span>
      </span>
      <span className="lib-card-benefit">{template.benefit}</span>
      <span className="lib-card-foot">
        <ReachIcons kinds={template.works_best_with} />
        <span className="lib-card-go" aria-hidden="true">
          <Icon name="chevronRight" size={14} />
        </span>
      </span>
    </button>
  );
}

function CardGrid({
  templates,
  open,
  onOpen,
}: {
  templates: AgentTemplate[];
  open: string | null;
  onOpen: (template: AgentTemplate) => void;
}) {
  return (
    <div className="lib-grid">
      {templates.map((template) => (
        <LibraryCard
          key={template.id}
          template={template}
          open={open === template.id}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

export function Library({
  templates,
  connections,
  open,
  onOpen,
  onNewAgent,
}: {
  templates: AgentTemplate[];
  /** The person's connections; null until they are read. */
  connections: Connection[] | null;
  /** The template whose sheet is open, if any. */
  open: string | null;
  onOpen: (template: AgentTemplate) => void;
  onNewAgent: () => void;
}) {
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const shelves = useMemo(() => shelvesOf(templates), [templates]);
  const found = useMemo(() => searchLibrary(templates, query, null), [templates, query]);
  const featured = templates.filter((template) => template.featured);
  const picks = useMemo(
    () => (connections ? recommend(templates, connections) : null),
    [templates, connections],
  );
  const searching = query.trim().length > 0;
  return (
    <section className="library" aria-labelledby="library-title">
      <div className="library-head">
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <h2 id="library-title" className="lib-title">
            Agent library
          </h2>
          <p className="library-lede">
            Ready-made agents for everyday jobs. Each one knows what it won’t do, and asks a few
            questions so it starts out knowing you.
          </p>
        </div>
        <Input
          icon="search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              setQuery('');
            }
          }}
          placeholder="Search by job, app or name"
          aria-label="Search the library"
          aria-controls="library-results"
          className="lib-search"
        />
      </div>
      {searching ? (
        <div id="library-results" className="lib-block">
          <p className="lib-count" role="status">
            {found.length
              ? `${found.length} ${found.length === 1 ? 'agent matches' : 'agents match'} “${query.trim()}”`
              : ''}
          </p>
          {found.length ? (
            <CardGrid templates={found} open={open} onOpen={onOpen} />
          ) : (
            <div className="lib-empty" role="status">
              <span className="lib-empty-icon" aria-hidden="true">
                <Icon name="search" size={18} />
              </span>
              <div className="col" style={{ gap: 4, minWidth: 0 }}>
                <strong>No agent here does “{query.trim()}” yet</strong>
                <span>
                  Try a job like bills, travel or inbox, or make your own agent with exactly the
                  brief you want.
                </span>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  {['inbox', 'bills', 'travel'].map((word) => (
                    <Chip key={word} size={30} onClick={() => setQuery(word)}>
                      {word}
                    </Chip>
                  ))}
                  <Button size="sm" variant="outline" icon="plus" onClick={onNewAgent}>
                    New agent
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {picks === null ? null : picks.templates.length ? (
            <div className="lib-block">
              <div className="lib-block-head">
                <h3>Recommended for you</h3>
                <span>
                  Because you connected {listWords(labelsOf(picks.because))}. An agent reaches
                  nothing until you add it and tick what it may use.
                </span>
              </div>
              <CardGrid templates={picks.templates} open={open} onOpen={onOpen} />
            </div>
          ) : (
            <div className="lib-connect">
              <span className="lib-connect-icon" aria-hidden="true">
                <Icon name="connectors" size={18} />
              </span>
              <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <strong>Connect your mail, calendar or files</strong>
                <span>
                  Agents work best with what you connect, and the ones that fit will show up here.
                  Every agent can still chat and read public pages without them.
                </span>
              </div>
              <a
                className="btn btn-md btn-outline lib-connect-link"
                href={href('/settings/connections')}
              >
                Connect an app
              </a>
            </div>
          )}
          {featured.length ? (
            <div className="lib-block">
              <div className="lib-block-head">
                <h3>Featured</h3>
              </div>
              <div className="lib-featured">
                {featured.map((template) => (
                  <LibraryCard
                    key={template.id}
                    template={template}
                    feature
                    open={open === template.id}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          ) : null}
          <div className="lib-block">
            <div className="lib-block-head">
              <h3>Shelves</h3>
            </div>
            <fieldset className="library-shelves">
              <legend className="sr-only">Show one shelf</legend>
              <Chip on={shelf === null} onClick={() => setShelf(null)}>
                All
              </Chip>
              {shelves.map((name) => (
                <Chip
                  key={name}
                  icon={SHELF_ICON[name]}
                  on={shelf === name}
                  onClick={() => setShelf(shelf === name ? null : name)}
                >
                  {name}
                </Chip>
              ))}
            </fieldset>
            {shelves
              .filter((name) => shelf === null || shelf === name)
              .map((name) => {
                const onShelf = templates.filter((template) => template.category === name);
                return (
                  <div key={name} className="lib-shelf">
                    <h4 className="lib-shelf-head">
                      <span className="lib-shelf-icon" aria-hidden="true">
                        <Icon name={SHELF_ICON[name]} size={14} />
                      </span>
                      {name}
                      <span className="lib-shelf-count">{onShelf.length}</span>
                    </h4>
                    <CardGrid templates={onShelf} open={open} onOpen={onOpen} />
                  </div>
                );
              })}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A sheet beside the page; on a phone it rises from the bottom over a scrim.
 * Escape closes it, unless something inside took the key first.
 */
function Sheet({
  label,
  head,
  foot,
  onClose,
  children,
}: {
  label: string;
  head: ReactNode;
  foot: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <>
      <button
        type="button"
        className="lib-scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        ref={ref}
        className="side-panel lib-sheet"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <span className="lib-grabber" aria-hidden="true" />
        <div className="library-sheet-head">
          <span className="library-sheet-title">{head}</span>
          <IconButton name="x" label="Close" onClick={onClose} />
        </div>
        <div className="panel-body library-sheet-body">{children}</div>
        <div className="library-sheet-foot">{foot}</div>
      </aside>
    </>
  );
}

/**
 * How the agent works in a chat, drawn with the chat's own pieces: what the
 * person asks, its first message, its work as quiet rows, the one question it
 * asks (answered), and what it says at the end. An example, labelled so.
 */
export function DayPreview({ template }: { template: AgentTemplate }) {
  const { agent, day } = template;
  const work = dayWork(template);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the example and carries no more meaning than a named group
    <div className="day-preview" role="group" aria-label={`An example chat with ${agent.name}`}>
      <span className="day-tag">Example</span>
      <div className="bubble-wrap">
        <div className="bubble">
          <div className="bubble-text">{day.ask}</div>
        </div>
      </div>
      <div className="turn">
        <div className="turn-text">
          <AgentFace look={lookOf(agent)} size={28} state="done" />
          <div className="turn-main">
            <LogEntries
              items={[
                { type: 'message', key: 'opening', text: day.opening },
                ...work.map((tool) => ({
                  type: 'work' as const,
                  key: tool.id,
                  work: [{ type: 'tool' as const, tool }],
                })),
              ]}
              live={false}
              streaming={false}
              renderBlock={() => null}
            />
            <div className="log-block">
              <Questionnaire
                question={{
                  id: `${template.id}-example-question`,
                  conversation_id: null,
                  text: day.question.text,
                  why: [],
                  if_ignored: '',
                  options: day.question.options.map((label, index) => ({
                    id: `option-${index}`,
                    label,
                  })),
                  free_text: false,
                  created_at: '2026-01-01T09:00:00.000Z',
                }}
                answered="option-0"
                active={false}
                own={false}
                onAnswer={() => {}}
                onOwn={() => {}}
              />
            </div>
            <div className="final-answer">
              <Markdown text={day.answer} streaming={false} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const skillWords = (id: string) => {
  const words = id.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function TemplateSheet({
  template,
  connections,
  onAdd,
  onClose,
}: {
  template: AgentTemplate;
  connections: Connection[];
  onAdd: () => void;
  onClose: () => void;
}) {
  const { agent, starter_routine: routine } = template;
  const connected = new Set(
    connections
      .filter((connection) => connection.status === 'connected')
      .flatMap((connection) => kindsOfApp(connection.app)),
  );
  return (
    <Sheet
      label={`${agent.name}, ${template.title}`}
      onClose={onClose}
      head={template.category}
      foot={
        <>
          <span className="library-meta grow">
            Its name, face and suggested connections are filled in for you to check.
          </span>
          <Button icon="plus" onClick={onAdd}>
            Add {agent.name}
          </Button>
        </>
      }
    >
      <div className="lib-hero" style={tintOf(agent.colour)}>
        <span className="lib-hero-face">
          <AgentFace look={lookOf(agent)} size={64} state="idle" />
        </span>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <h2 className="lib-hero-name">{agent.name}</h2>
          <span className="library-meta">
            {template.title} · {agent.tone}
          </span>
        </div>
      </div>
      <p className="library-voice">{template.benefit}</p>
      <div className="library-section">
        <h3>A day with {agent.name}</h3>
        <DayPreview template={template} />
      </div>
      <div className="lib-lists">
        <div className="library-section">
          <h3>What it does</h3>
          <ul className="library-list" data-tone="does">
            {template.does.map((line) => (
              <li key={line}>
                <span>
                  <Icon name="check" size={14} stroke={2.4} />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="library-section">
          <h3>What it won’t do</h3>
          <ul className="library-list" data-tone="wont">
            {template.wont.map((line) => (
              <li key={line}>
                <span>
                  <Icon name="lock" size={14} />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {routine ? (
        <div className="library-section">
          <h3>Its routine</h3>
          <div className="lib-schedule">
            <span className="lib-schedule-icon" aria-hidden="true">
              <Icon name="clock" size={15} />
            </span>
            <span className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="lib-schedule-line">
                <strong>{routine.title}</strong> · {libraryScheduleWords(routine)}
              </span>
              <span className="library-text">{routine.instruction}</span>
            </span>
          </div>
          <span className="library-meta">
            Offered in your first chat. Nothing runs until you say yes.
          </span>
        </div>
      ) : null}
      {template.questions.length ? (
        <div className="library-section">
          <h3>Getting to know you</h3>
          <ul className="lib-questions">
            {template.questions.map((question) => (
              <li key={question.id}>{question.question}</li>
            ))}
          </ul>
          <span className="library-meta">
            Asked once in your first chat. Skip any; answers are saved to memory for this job.
          </span>
        </div>
      ) : null}
      <div className="library-section">
        <h3>What it can reach</h3>
        <ul className="lib-reach">
          {template.works_best_with.map((kind) => (
            <li key={kind}>
              <span className="reach-icon" aria-hidden="true">
                <Icon name={WORKS_WITH[kind].icon} size={13} />
              </span>
              <span className="grow">{WORKS_WITH[kind].label}</span>
              <span className="lib-reach-state" data-on={connected.has(kind) ? 'true' : undefined}>
                {connected.has(kind) ? 'Connected' : 'Not connected'}
              </span>
            </li>
          ))}
        </ul>
        {template.relies_on
          .filter((need) => !connected.has(need.kind))
          .map((need) => (
            <span key={need.kind} className="library-meta">
              {need.without}
            </span>
          ))}
        <span className="library-meta">
          It reaches only what you tick when you add it, and you can change that any time.
        </span>
      </div>
      {template.skills.length ? (
        <div className="library-section">
          <h3>Knows how to</h3>
          <span className="library-text">{template.skills.map(skillWords).join(' · ')}</span>
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * The short way to add a library agent: its name, face and suggested
 * connections are already set, so it is one press to create. Everything else
 * is a press away in the full editor.
 */
export function LibraryDraft({
  template,
  initial,
  connections,
  onCreated,
  onMore,
  onClose,
}: {
  template: AgentTemplate;
  /** The agent to make, with its free name and suggested connections already set. */
  initial: AgentInput;
  /** Connected connections only. */
  connections: Connection[];
  onCreated: (agent: Agent) => void;
  /** Opens the full editor on this draft. */
  onMore: (draft: AgentInput) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const name = draft.name.trim();
  const ids = connections.map((connection) => connection.id);
  const reaches = (id: string) =>
    draft.allowed_connection_ids === null || draft.allowed_connection_ids.includes(id);
  const toggle = (id: string, on: boolean) => {
    const current = draft.allowed_connection_ids ?? ids;
    const next = on ? [...current, id] : current.filter((item) => item !== id);
    setDraft({
      ...draft,
      allowed_connection_ids: ids.every((item) => next.includes(item)) ? null : next,
    });
  };
  const nextColour = () => {
    const at = (FACE_PALETTE as readonly string[]).indexOf(draft.colour.toLowerCase());
    setDraft({ ...draft, colour: FACE_PALETTE[(at + 1) % FACE_PALETTE.length] ?? draft.colour });
  };
  const create = () => {
    if (!name) {
      toast({ kind: 'err', title: 'Give the agent a name first.' });
      return;
    }
    setBusy(true);
    void adapter.createAgent({ ...draft, name }).then((result) => {
      setBusy(false);
      if (result.data === null)
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t save' });
      else onCreated(result.data.agent);
    });
  };
  const needs = missingNeeds(template.relies_on, connections, draft.allowed_connection_ids);
  return (
    <Sheet
      label={`Add ${name || template.agent.name}`}
      onClose={onClose}
      head={`Add ${name || 'agent'}`}
      foot={
        <>
          <Button variant="ghost" onClick={() => onMore(draft)}>
            More settings
          </Button>
          <div className="grow" />
          <Button icon="plus" loading={busy} disabled={busy} onClick={create}>
            Create {name || 'agent'}
          </Button>
        </>
      }
    >
      <form
        className="col"
        style={{ gap: 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <div className="lib-hero" style={tintOf(draft.colour)}>
          <span className="lib-hero-face">
            <AgentFace look={lookOf(draft)} size={64} state="idle" />
          </span>
          <div className="col grow" style={{ gap: 8, minWidth: 0 }}>
            <Field label="Name">
              <Input
                value={draft.name}
                maxLength={40}
                width="100%"
                aria-label="Agent name"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <button type="button" className="lib-link" onClick={nextColour}>
              <Icon name="shuffle" size={13} />
              Another colour
            </button>
          </div>
        </div>
        <div className="library-section">
          <h3>What {name || 'it'} may use</h3>
          {connections.length ? (
            <>
              <span className="library-meta">
                The ones it works best with are ticked. Untick any you would rather it left alone.
              </span>
              <ul className="lib-connections">
                {connections.map((connection) => {
                  const logo = logoFor(connection.app);
                  return (
                    <li key={connection.id} className="lib-connection">
                      {logo ? (
                        <Logo name={logo} size={28} />
                      ) : (
                        <span className="lib-connection-tile" aria-hidden="true">
                          <Icon name="connectors" size={14} />
                        </span>
                      )}
                      <span className="col grow" style={{ minWidth: 0 }}>
                        <span className="lib-connection-name">
                          {connection.label}
                          {suggests(template.works_best_with, connection.app) ? (
                            <span className="library-suggested">Suggested</span>
                          ) : null}
                        </span>
                        <span className="library-meta clamp1">{connection.app}</span>
                      </span>
                      <Checkbox
                        checked={reaches(connection.id)}
                        label={connection.label}
                        onChange={(next) => toggle(connection.id, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <span className="library-text">
              Nothing is connected yet. {name || 'It'} can still chat and read public pages, and you
              can connect apps later in{' '}
              <a className="lib-inline-link" href={href('/settings/connections')}>
                Connections
              </a>
              .
            </span>
          )}
          {needs.map((need) => (
            <p key={need.kind} role="status" className="welcome-note">
              <Icon name="info" size={14} />
              <span>
                {need.without}{' '}
                {connections.some((connection) => kindsOfApp(connection.app).includes(need.kind))
                  ? `Tick ${WORKS_WITH[need.kind].label} to let it.`
                  : `Connect ${WORKS_WITH[need.kind].label} to let it.`}
              </span>
            </p>
          ))}
        </div>
        <p className="library-meta">
          {draft.asks_before_acting
            ? `${name || 'It'} asks before it sends, books or changes anything. Next, it says hello in a new chat.`
            : `Next, ${name || 'it'} says hello in a new chat.`}
        </p>
      </form>
    </Sheet>
  );
}
