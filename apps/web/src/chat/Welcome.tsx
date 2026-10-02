/**
 * A library agent's first chat, opened right after it is made. The agent
 * speaks first: it says what it is for, offers its starter routine as a
 * choice, then asks its getting-to-know-you questions one at a time, each
 * one skippable. Nothing is set up or saved until the person picks an answer.
 */
import {
  libraryAnswers,
  libraryRoutine,
  libraryScheduleWords,
} from '@melete/contracts/agent-library';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import { lookOf, useApp, useLoad } from '../experience/hooks.ts';
import type { Agent, AgentTemplate, Question } from '../experience/types.ts';
import { href } from '../router.ts';
import { missingNeeds, WORKS_WITH } from '../screens/agent-library.ts';
import { toast } from '../shell/Shell.tsx';
import { Markdown } from './Markdown.tsx';
import { Questionnaire } from './parts.tsx';
import {
  restoreWelcome,
  saveWelcome,
  sessionWelcome,
  type WelcomeProgress,
  type WelcomeRef,
  welcomeQuery,
  welcomeStep,
} from './welcome.ts';

const asQuestion = (id: string, text: string, options: Question['options']): Question => ({
  id,
  conversation_id: null,
  text,
  why: [],
  if_ignored: '',
  options,
  free_text: true,
  created_at: '2026-01-01T00:00:00.000Z',
});

/** "Weekdays at 8:00 AM" reads "weekdays at 8:00 AM" inside a sentence; a day's name keeps its capital. */
const inSentence = (words: string) =>
  /^(Weekdays|Weekends|Every day)\b/.test(words)
    ? words.charAt(0).toLowerCase() + words.slice(1)
    : `on ${words}`;

function AgentTurn({ agent, children }: { agent: Agent; children: ReactNode }) {
  return (
    <div className="turn">
      <div className="turn-text">
        <AgentFace look={lookOf(agent)} size={28} state="idle" />
        <div className="turn-main">{children}</div>
      </div>
    </div>
  );
}

const Said = ({ text }: { text: string }) => (
  <div className="log-message">
    <Markdown text={text} streaming={false} />
  </div>
);

const Mine = ({ text }: { text: string }) => (
  <div className="bubble-wrap">
    <div className="bubble">
      <div className="bubble-text">{text}</div>
    </div>
  </div>
);

export function AgentWelcome({
  agent,
  template,
  initial,
  onProgress,
  onTry,
}: {
  agent: Agent;
  template: AgentTemplate;
  /** Where the person got to, restored from the session or the service. */
  initial: WelcomeProgress;
  onProgress: (next: WelcomeProgress) => void;
  /** Puts an example request in the composer. */
  onTry: (text: string) => void;
}) {
  const routine = template.starter_routine;
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  // Each new step comes into view above the composer as the welcome moves on.
  const moved = state.routine + state.answers.length;
  useEffect(() => {
    if (moved === `${routine ? 'offered' : 'declined'}0`) return;
    section.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [moved, routine]);
  const connections = useLoad(() => adapter.connections(), []);
  const update = (next: typeof state) => {
    onProgress(next);
    setState(next);
  };
  const questions = template.questions;
  const step = welcomeStep(state, questions.length);
  const schedule = routine ? libraryScheduleWords(routine) : '';
  const missing = connections.data
    ? missingNeeds(
        template.relies_on,
        connections.data.connections.filter((connection) => connection.status === 'connected'),
        agent.allowed_connection_ids,
      )
    : [];

  const setUp = async () => {
    if (!routine) return;
    setBusy(true);
    const result = await adapter.createAutomation(libraryRoutine(routine, agent.id));
    setBusy(false);
    if (result.data === null) {
      toast({
        kind: 'err',
        title: 'Couldn’t set up the routine',
        sub: result.error ?? result.unavailable,
      });
      return;
    }
    update({ ...state, routine: 'made' });
  };

  const answer = async (question: AgentTemplate['questions'][number], text: string | null) => {
    const [detail] = text ? libraryAnswers([question], { [question.id]: text }) : [];
    if (detail) {
      setBusy(true);
      const result = await adapter.createMemoryItem(detail);
      setBusy(false);
      if (result.data === null) {
        toast({
          kind: 'err',
          title: 'Couldn’t save your answer',
          sub: result.error ?? result.unavailable,
        });
        return;
      }
    }
    update({
      ...state,
      answers: [...state.answers, { id: question.id, text: detail ? text : null }],
    });
  };

  const steps = (routine ? 1 : 0) + (questions.length ? 1 : 0);
  const opening = [
    `Hi, I’m ${agent.name}. ${template.benefit}`,
    steps === 2
      ? 'Two quick things before we start, and both are optional.'
      : routine
        ? 'One quick thing before we start, and it’s optional.'
        : questions.length
          ? 'A few quick questions before we start. Skip any you like.'
          : 'Tell me what you need, and I’ll get going.',
  ].join('\n\n');
  const saved = state.answers.filter((item) => item.text).length;

  return (
    <section ref={section} className="welcome" aria-label={`${agent.name} says hello`}>
      <AgentTurn agent={agent}>
        <Said text={opening} />
        {missing.map((need) => (
          <p key={need.kind} className="welcome-note">
            <Icon name="info" size={14} />
            <span>
              {need.without}{' '}
              <a href={href(`/agents/${agent.id}`)}>
                Let {agent.name} use {WORKS_WITH[need.kind].label}
              </a>
            </span>
          </p>
        ))}
        {routine ? (
          <>
            <Said
              text={`I can run this for you ${inSentence(schedule)}:\n\n> ${routine.instruction}`}
            />
            <div className="log-block">
              <Questionnaire
                question={asQuestion(`routine-${template.id}`, `Set up “${routine.title}”?`, [
                  { id: 'yes', label: `Yes, set it up · ${schedule}` },
                  { id: 'no', label: 'Not now · You can add it later in Automations' },
                ])}
                answered={
                  state.routine === 'made' ? 'yes' : state.routine === 'declined' ? 'no' : null
                }
                active={step.kind === 'routine'}
                busy={busy}
                own={false}
                onAnswer={(id) => {
                  if (id === 'yes') void setUp();
                  else update({ ...state, routine: 'declined' });
                }}
                onOwn={() => {}}
              />
            </div>
          </>
        ) : null}
      </AgentTurn>
      {routine && state.routine !== 'offered' ? (
        <AgentTurn agent={agent}>
          <Said
            text={
              state.routine === 'made'
                ? `Done. “${routine.title}” runs ${inSentence(schedule)}, and you can pause or change it in Automations.`
                : 'No problem. You can set up a routine for me any time in Automations.'
            }
          />
        </AgentTurn>
      ) : null}
      {step.kind !== 'routine'
        ? questions.slice(0, state.answers.length + 1).map((question, index) => {
            const given = state.answers[index];
            if (!given)
              return (
                <AgentTurn key={question.id} agent={agent}>
                  {index === 0 ? <Said text="So I start out knowing you:" /> : null}
                  <div className="log-block">
                    <Questionnaire
                      question={asQuestion(`ask-${question.id}`, question.question, [
                        { id: 'skip', label: 'Skip this one' },
                      ])}
                      answered={null}
                      active
                      busy={busy}
                      placeholder={question.placeholder || 'Type your answer'}
                      onAnswer={() => void answer(question, null)}
                      onOwn={(text) => void answer(question, text)}
                    />
                  </div>
                </AgentTurn>
              );
            return (
              <div key={question.id} className="welcome-pair">
                <AgentTurn agent={agent}>
                  <Said text={question.question} />
                </AgentTurn>
                {given.text ? <Mine text={given.text} /> : null}
                {given.text ? null : <p className="welcome-skipped">Skipped</p>}
              </div>
            );
          })
        : null}
      {step.kind === 'done' ? (
        <AgentTurn agent={agent}>
          <Said
            text={[
              saved
                ? `Thank you. ${saved === 1 ? 'That’s' : 'Those are'} saved to memory, where you can read or change ${saved === 1 ? 'it' : 'them'}.`
                : '',
              'Whenever you’re ready, tell me what you need. You could start with this:',
            ]
              .filter(Boolean)
              .join(' ')}
          />
          <div>
            <button type="button" className="welcome-try" onClick={() => onTry(template.day.ask)}>
              <Icon name="arrowUpRight" size={14} />
              {template.day.ask}
            </button>
          </div>
        </AgentTurn>
      ) : null}
    </section>
  );
}

/** The chat's link as it stands, which the welcome keeps current without a navigation. */
const linkQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

/**
 * The welcome for a chat, when there is one and its agent and template are
 * known. Progress made in this session is used as it is; otherwise it is read
 * back from the service and the chat's link, so a reload keeps the welcome.
 */
export function WelcomeThread({
  welcome,
  onTry,
}: {
  welcome: WelcomeRef;
  onTry: (text: string) => void;
}) {
  const { agents } = useApp();
  const templates = useLoad(() => adapter.agentTemplates(), []);
  const automations = useLoad(() => adapter.automations(), []);
  const memory = useLoad(() => adapter.memory(), []);
  const agent = agents.find((item) => item.id === welcome.agentId);
  const template = templates.data?.templates.find((item) => item.id === welcome.templateId);
  if (!agent || !template) return null;
  let initial = sessionWelcome(welcome);
  if (!initial) {
    // Wait for what the service holds; a failed read starts from the beginning.
    if ((automations.loading || memory.loading) && !(automations.error || memory.error))
      return null;
    const link = linkQuery();
    const routine = template.starter_routine;
    initial = restoreWelcome({
      hasRoutine: routine !== null,
      routineMade:
        routine !== null &&
        agent.usage.routines > 0 &&
        (automations.data?.automations ?? []).some((item) => item.title === routine.title),
      routineDeclined: link.get('routine') === 'no',
      questions: template.questions,
      saved: new Map((memory.data?.items ?? []).map((item) => [item.key, item.value])),
      skipped: new Set((link.get('skipped') ?? '').split(',').filter(Boolean)),
    });
  }
  return (
    <AgentWelcome
      key={`${welcome.agentId}:${welcome.templateId}`}
      agent={agent}
      template={template}
      initial={initial}
      onProgress={(next) => {
        saveWelcome(welcome, next);
        const link = linkQuery();
        const query = new URLSearchParams(welcomeQuery(template.id, next));
        const agentId = link.get('agent');
        if (agentId) query.set('agent', agentId);
        const path = window.location.hash.slice(1).split('?')[0] ?? '';
        window.history.replaceState(window.history.state, '', `#${path}?${query.toString()}`);
      }}
      onTry={onTry}
    />
  );
}
