/**
 * The morning brief, as first-run setup and Home offer it: what it brings,
 * when it comes, and the topics its news line covers. Setting it up is one
 * request through the normal routine path, so it shows on Automations, where
 * it pauses like any routine.
 */
import { MORNING_BRIEF_TITLE, MORNING_BRIEF_TOPICS } from '@melete/contracts/morning-brief';
import { Icon, type IconName } from '../design/icons.tsx';
import { Chip, Select } from '../design/primitives.tsx';
import type { Automation } from '../experience/types.ts';
import './first-run.css';

/** When the brief comes unless the person picks another time. */
export const BRIEF_DEFAULT_AT = '08:00';
/** The most news topics a brief takes, as the service allows. */
export const BRIEF_TOPIC_LIMIT = 5;

/** Morning times on the half hour, 5:00 to 11:00. */
export const BRIEF_TIMES: readonly string[] = Array.from({ length: 13 }, (_, index) => {
  const minutes = 5 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

/** "08:30" as a person reads it: "8:30 AM". */
export function clockWords(at: string): string {
  const [hour = 0, minute = 0] = at.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** Whether a brief is already set up: one that has not ended, paused or not. */
export const hasMorningBrief = (automations: readonly Automation[]) =>
  automations.some((routine) => routine.title === MORNING_BRIEF_TITLE && !routine.ended);

/**
 * A brief that ended, to start again rather than make another: with one
 * already there, setting up a new one would leave two on Automations.
 */
export const endedMorningBrief = (automations: readonly Automation[]): Automation | null =>
  automations.find((routine) => routine.title === MORNING_BRIEF_TITLE && routine.ended) ?? null;

/** A topic turned on or off, keeping at most the limit. */
export function toggleTopic(topics: readonly string[], topic: string): string[] {
  if (topics.includes(topic)) return topics.filter((item) => item !== topic);
  return topics.length >= BRIEF_TOPIC_LIMIT ? [...topics] : [...topics, topic];
}

const PARTS: { icon: IconName; text: string }[] = [
  { icon: 'sun', text: 'The weather where you are' },
  { icon: 'calendar', text: 'Today’s calendar, once it’s connected' },
  { icon: 'bell', text: 'What needs you: reminders, tasks and replies' },
  { icon: 'globe', text: 'A few lines of news on what you follow' },
];

/** What a brief brings, line by line. */
export function BriefParts() {
  return (
    <ul className="brief-parts">
      {PARTS.map((part) => (
        <li key={part.text}>
          <span className="brief-part-mark" aria-hidden="true">
            <Icon name={part.icon} size={14} />
          </span>
          {part.text}
        </li>
      ))}
    </ul>
  );
}

/** The time and the topics, as the person sets them before the brief is made. */
export function BriefChoices({
  at,
  topics,
  zone,
  disabled,
  onAt,
  onTopics,
}: {
  at: string;
  topics: readonly string[];
  /** The person's time zone by name, shown beside the time. */
  zone: string;
  disabled?: boolean;
  onAt: (at: string) => void;
  onTopics: (topics: string[]) => void;
}) {
  return (
    <div className="col brief-choices">
      <div className="col" style={{ gap: 6 }}>
        <span className="brief-choice-label">Every morning at</span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Select
            label="Morning brief time"
            value={at}
            onChange={onAt}
            width={140}
            options={BRIEF_TIMES.map((value) => ({ value, label: clockWords(value) }))}
          />
          <span className="brief-choice-note">{zone}</span>
        </div>
      </div>
      <fieldset className="field-group col" style={{ gap: 8 }} disabled={disabled}>
        <legend className="brief-choice-label">News on</legend>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {MORNING_BRIEF_TOPICS.map((topic) => {
            const on = topics.includes(topic);
            return (
              <Chip
                key={topic}
                on={on}
                aria-pressed={on}
                onClick={() => onTopics(toggleTopic(topics, topic))}
              >
                {topic}
              </Chip>
            );
          })}
        </div>
        <span className="brief-choice-note">
          {topics.length
            ? `Up to ${BRIEF_TOPIC_LIMIT} topics.`
            : 'Pick a few, or get the news worth knowing today.'}
        </span>
      </fieldset>
    </div>
  );
}
