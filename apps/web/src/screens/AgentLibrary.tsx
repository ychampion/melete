/**
 * The agent library on the Agents screen: shelves, search and cards; a sheet
 * that says what an agent does and never does before it is added; and, once
 * it is made, a sheet that offers its starter routine and asks its
 * getting-to-know-you questions. Nothing here is made without the person
 * pressing for it: the routine is offered, the answers are optional.
 */
import {
  libraryAnswers,
  libraryRoutine,
  libraryScheduleWords,
} from '@melete/contracts/agent-library';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { Button, Chip, Field, IconButton, Input } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf } from '../experience/hooks.ts';
import type { Agent, AgentTemplate } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';
import { searchLibrary, shelvesOf, WORKS_WITH, type WorksWith } from './agent-library.ts';
import './agent-library.css';

export function WorksWithChips({ kinds }: { kinds: readonly WorksWith[] }) {
  return (
    <span className="works-with">
      {kinds.map((kind) => (
        <span key={kind} className="works-chip">
          <Icon name={WORKS_WITH[kind].icon} size={12} />
          {WORKS_WITH[kind].label}
        </span>
      ))}
    </span>
  );
}

export function LibraryShelf({
  templates,
  open,
  onOpen,
}: {
  templates: AgentTemplate[];
  /** The template whose sheet is open, if any. */
  open: string | null;
  onOpen: (template: AgentTemplate) => void;
}) {
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<string | null>(null);
  const shelves = useMemo(() => shelvesOf(templates), [templates]);
  const shown = useMemo(() => searchLibrary(templates, query, shelf), [templates, query, shelf]);
  return (
    <section className="library" aria-labelledby="library-title">
      <div className="library-head">
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <div className="section-head">
            <h2 id="library-title">Agent library</h2>
          </div>
          <p>
            Ready-made agents for everyday jobs. Each one arrives with a brief, a clear line on what
            it won’t do, and a few questions so it starts out knowing you.
          </p>
        </div>
        <Input
          icon="search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the library"
          aria-label="Search the library"
          width={260}
          style={{ minWidth: 0 }}
        />
      </div>
      <fieldset className="library-shelves">
        <legend className="sr-only">Shelves</legend>
        <Chip on={shelf === null} onClick={() => setShelf(null)}>
          All
        </Chip>
        {shelves.map((name) => (
          <Chip
            key={name}
            on={shelf === name}
            onClick={() => setShelf(shelf === name ? null : name)}
          >
            {name}
          </Chip>
        ))}
      </fieldset>
      {shown.length ? (
        <div className="library-grid">
          {shown.map((template) => (
            <button
              key={template.id}
              type="button"
              className="library-card"
              data-library-card={template.id}
              data-on={open === template.id ? 'true' : undefined}
              aria-label={`${template.agent.name}, ${template.title}: ${template.benefit}`}
              onClick={() => onOpen(template)}
            >
              <span className="row" style={{ gap: 12, alignItems: 'center' }}>
                <AgentFace look={lookOf(template.agent)} size={40} state="idle" />
                <span className="col grow" style={{ minWidth: 0, gap: 1 }}>
                  <span className="library-name clamp1">
                    {template.agent.name} <span>· {template.title}</span>
                  </span>
                  <span className="library-shelf-word">{template.category}</span>
                </span>
              </span>
              <span className="library-benefit">{template.benefit}</span>
              <WorksWithChips kinds={template.works_best_with} />
            </button>
          ))}
        </div>
      ) : (
        <p className="library-empty" role="status">
          No agent in the library matches “{query.trim()}”. Try another word, or make your own with
          New agent.
        </p>
      )}
    </section>
  );
}

/** Escape closes a sheet, unless something inside it took the key first. */
function useSheet(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return { ref, onKeyDown };
}

const skillWords = (id: string) => {
  const words = id.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function TemplateSheet({
  template,
  onAdd,
  onClose,
}: {
  template: AgentTemplate;
  onAdd: () => void;
  onClose: () => void;
}) {
  const sheet = useSheet(onClose);
  const { agent, starter_routine: routine } = template;
  return (
    <aside
      ref={sheet.ref}
      className="side-panel"
      style={{ width: 420, maxWidth: '100%' }}
      aria-label={`${agent.name}, ${template.title}`}
      tabIndex={-1}
      onKeyDown={sheet.onKeyDown}
    >
      <div className="library-sheet-head">
        <span className="library-sheet-title">{template.title}</span>
        <IconButton name="x" label="Close" onClick={onClose} />
      </div>
      <div className="panel-body library-sheet-body">
        <div className="library-hero">
          <AgentFace look={lookOf(agent)} size={64} state="idle" />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="library-name">
              {agent.name} <span>· {template.category}</span>
            </span>
            <span className="library-meta">{agent.tone}</span>
          </div>
        </div>
        <p className="library-voice">{template.benefit}</p>
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
        <div className="library-section">
          <h3>Works best with</h3>
          <WorksWithChips kinds={template.works_best_with} />
          <span className="library-meta">
            Nothing is switched on for it. You choose what it can use before you create it.
          </span>
        </div>
        {routine ? (
          <div className="library-section">
            <h3>A routine it can run</h3>
            <div className="library-block">
              <strong>{routine.title}</strong>
              <span className="library-meta">{libraryScheduleWords(routine)}</span>
              <span className="library-text">{routine.instruction}</span>
            </div>
            <span className="library-meta">
              Offered after you add it. Nothing runs until you say yes.
            </span>
          </div>
        ) : null}
        {template.questions.length ? (
          <div className="library-section">
            <h3>Getting to know you</h3>
            <span className="library-meta">
              It asks these once. Your answers are saved to memory for this job, and you can skip
              any of them.
            </span>
            <ul className="library-list">
              {template.questions.map((question) => (
                <li key={question.id}>
                  <span style={{ color: 'var(--muted)' }}>
                    <Icon name="chat" size={14} />
                  </span>
                  <span>{question.question}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {template.skills.length ? (
          <div className="library-section">
            <h3>Knows how to</h3>
            <span className="library-text">{template.skills.map(skillWords).join(' · ')}</span>
          </div>
        ) : null}
      </div>
      <div className="library-sheet-foot">
        <span className="library-meta grow">You can change its name and look next.</span>
        <Button icon="plus" onClick={onAdd}>
          Add {agent.name}
        </Button>
      </div>
    </aside>
  );
}

/**
 * After an agent from the library is made: offer its routine, then ask its
 * questions. Each step is the person's choice, and closing skips the rest.
 */
export function WelcomeSheet({
  agent,
  template,
  onOpenAgent,
  onClose,
}: {
  agent: Agent;
  template: AgentTemplate;
  onOpenAgent: () => void;
  onClose: () => void;
}) {
  const sheet = useSheet(onClose);
  const routine = template.starter_routine;
  const [routineState, setRoutineState] = useState<'offered' | 'busy' | 'made' | 'declined'>(
    routine ? 'offered' : 'declined',
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answersState, setAnswersState] = useState<'asking' | 'busy' | 'saved' | 'skipped'>(
    template.questions.length ? 'asking' : 'skipped',
  );

  const makeRoutine = () => {
    if (!routine) return;
    setRoutineState('busy');
    void adapter.createAutomation(libraryRoutine(routine, agent.id)).then((result) => {
      if (result.data === null) {
        setRoutineState('offered');
        toast({
          kind: 'err',
          title: 'Couldn’t set up the routine',
          sub: result.error ?? result.unavailable,
        });
        return;
      }
      setRoutineState('made');
    });
  };

  const saveAnswers = async () => {
    const details = libraryAnswers(template.questions, answers);
    if (!details.length) {
      setAnswersState('skipped');
      return;
    }
    setAnswersState('busy');
    for (const detail of details) {
      const result = await adapter.createMemoryItem(detail);
      if (result.data === null) {
        setAnswersState('asking');
        toast({
          kind: 'err',
          title: 'Couldn’t save your answers',
          sub: result.error ?? result.unavailable,
        });
        return;
      }
    }
    setAnswersState('saved');
  };

  const finished =
    routineState !== 'offered' &&
    routineState !== 'busy' &&
    answersState !== 'asking' &&
    answersState !== 'busy';
  const noReach =
    agent.allowed_connection_ids !== null && agent.allowed_connection_ids.length === 0;

  return (
    <aside
      ref={sheet.ref}
      className="side-panel"
      style={{ width: 420, maxWidth: '100%' }}
      aria-label={`${agent.name} is ready`}
      tabIndex={-1}
      onKeyDown={sheet.onKeyDown}
    >
      <div className="library-sheet-head">
        <span className="library-sheet-title">{agent.name} is ready</span>
        <IconButton name="x" label="Close" onClick={onClose} />
      </div>
      <div className="panel-body library-sheet-body">
        <div className="library-hero">
          <AgentFace look={lookOf(agent)} size={56} state={finished ? 'done' : 'idle'} />
          <p className="library-voice" style={{ minWidth: 0 }}>
            {finished
              ? `${agent.name} is all set. Type @${agent.name} in any chat to ask for help.`
              : `Two quick things, and ${agent.name} can start well. Both are optional.`}
          </p>
        </div>
        {routine ? (
          <div className="library-section">
            <h3>Set up its routine?</h3>
            <div className="library-block">
              <strong>{routine.title}</strong>
              <span className="library-meta">{libraryScheduleWords(routine)}</span>
              <span className="library-text">{routine.instruction}</span>
            </div>
            {routineState === 'made' ? (
              <span className="library-meta" role="status">
                Set up. You’ll find it in Automations, where you can pause or change it.
              </span>
            ) : routineState === 'declined' ? (
              <span className="library-meta" role="status">
                Not set up. You can make a routine for {agent.name} any time in Automations.
              </span>
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  loading={routineState === 'busy'}
                  disabled={routineState === 'busy'}
                  onClick={makeRoutine}
                >
                  Set it up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={routineState === 'busy'}
                  onClick={() => setRoutineState('declined')}
                >
                  Not now
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {template.questions.length ? (
          <div className="library-section">
            <h3>Getting to know you</h3>
            {answersState === 'saved' ? (
              <span className="library-meta" role="status">
                Saved to memory. You can read or change your answers in Memory.
              </span>
            ) : answersState === 'skipped' ? (
              <span className="library-meta" role="status">
                Skipped. {agent.name} will ask in a chat if it needs to know.
              </span>
            ) : (
              <form
                className="col"
                style={{ gap: 12 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAnswers();
                }}
              >
                {template.questions.map((question) => (
                  <Field key={question.id} label={question.question}>
                    <Input
                      value={answers[question.id] ?? ''}
                      placeholder={question.placeholder}
                      maxLength={4000}
                      width="100%"
                      onChange={(event) =>
                        setAnswers({ ...answers, [question.id]: event.target.value })
                      }
                    />
                  </Field>
                ))}
                <div className="row" style={{ gap: 8 }}>
                  <Button
                    size="sm"
                    type="submit"
                    loading={answersState === 'busy'}
                    disabled={answersState === 'busy'}
                  >
                    Save answers
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={answersState === 'busy'}
                    onClick={() => setAnswersState('skipped')}
                  >
                    Skip
                  </Button>
                </div>
              </form>
            )}
          </div>
        ) : null}
        {noReach ? (
          <div className="library-block">
            <strong>It can’t use any connections yet</strong>
            <span className="library-text">
              It works best with{' '}
              {template.works_best_with
                .map((kind) => WORKS_WITH[kind].label.toLowerCase())
                .join(', ')}
              . Open {agent.name} and tick what it may use under Access.
            </span>
          </div>
        ) : null}
      </div>
      <div className="library-sheet-foot">
        <Button variant="outline" onClick={onOpenAgent}>
          Open {agent.name}
        </Button>
        <div className="grow" />
        <Button variant={finished ? 'primary' : 'ghost'} onClick={onClose}>
          Done
        </Button>
      </div>
    </aside>
  );
}
