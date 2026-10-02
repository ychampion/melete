/**
 * A turn as a work log: the agent's own messages in order, the work between
 * two of them as one quiet row that opens onto each piece, a command opening
 * onto its shell output, an edit as a card with its changes. While the turn
 * runs the log is open; once it ends it folds behind "Worked for …", and the
 * final answer stays below it. Every string from outside is drawn as plain text.
 */
import { type ReactNode, useId, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { Button, Dialog } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { TranscriptTurn, TurnBlock } from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import { href } from '../router.ts';
import { toolIcon } from './activity.tsx';
import { Markdown } from './Markdown.tsx';
import { stoppedLine } from './parts.tsx';
import {
  type DiffSummary,
  editedFile,
  type LogItem,
  staysInView,
  summarize,
  summaryKind,
  turnSeconds,
  type Work,
  type WorkKind,
  workedFor,
  workKind,
} from './worklog.ts';

const RUNNING = new Set(['queued', 'working', 'streaming', 'paused']);

const KIND_ICON: Partial<Record<WorkKind, IconName>> = {
  command: 'terminal',
  read: 'fileText',
  edit: 'pencil',
  search_files: 'search',
  web_search: 'search',
  page: 'globe',
  open: 'globe',
  screenshot: 'image',
  ask: 'messages',
};

const iconFor = (work: Work): IconName =>
  work.type === 'tool' ? (KIND_ICON[workKind(work)] ?? toolIcon(work.tool)) : 'connectors';

/** A title with the one command or name it sets off in backticks, drawn as code. */
function Title({ title }: { title: string }) {
  const parts = title.split('`');
  if (parts.length !== 3) return <>{title}</>;
  return (
    <>
      {parts[0]}
      <code className="log-code">{parts[1]}</code>
      {parts[2]}
    </>
  );
}

/** The command a row ran: its whole input when the service sent it, else the one in its title. */
const commandOf = (tool: ToolEntry): string | null =>
  tool.input_excerpt?.text ?? tool.title.split('`')[1] ?? null;

const isCommand = (tool: ToolEntry) => workKind({ type: 'tool', tool }) === 'command';

const STATUS_WORDS: Record<ToolEntry['status'], string> = {
  running: 'Running…',
  done: 'Success',
  failed: 'Failed',
  needs_approval: 'Waiting for you',
  unknown: 'Not confirmed',
};

/** A command's shell: what was run, what it printed, and how it ended. */
export function ShellBlock({ tool, live }: { tool: ToolEntry; live: boolean }) {
  const command = commandOf(tool);
  const output = tool.output_excerpt?.text ?? '';
  const failedWhy = tool.status === 'failed' ? tool.output_summary?.text : undefined;
  return (
    <div className="log-shell" data-status={tool.status}>
      <div className="log-shell-head">Shell</div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: wide output scrolls, so it takes focus for the keyboard */}
      <section className="log-shell-scroll" tabIndex={0} aria-label="Command and output">
        {command ? (
          <pre className="log-shell-pre log-shell-command">
            <span className="log-shell-prompt" aria-hidden="true">
              ${' '}
            </span>
            {command}
          </pre>
        ) : null}
        {output ? (
          <pre className="log-shell-pre">
            {output}
            {tool.output_excerpt?.more ? '\n…' : ''}
          </pre>
        ) : null}
      </section>
      <div className="log-shell-foot" role="status">
        {tool.status === 'running' ? (
          <Icon name="loader" size={13} stroke={2} className={live ? 'spin' : undefined} />
        ) : tool.status === 'done' ? (
          <Icon name="check" size={13} stroke={2} />
        ) : tool.status === 'failed' ? (
          <Icon name="circleX" size={13} stroke={2} />
        ) : (
          <Icon name="clock" size={13} stroke={2} />
        )}
        <span>
          {STATUS_WORDS[tool.status]}
          {failedWhy ? ` · ${failedWhy}` : ''}
        </span>
      </div>
    </div>
  );
}

function Summary({ summary }: { summary: NonNullable<ToolEntry['input_summary']> }) {
  return (
    <p className="log-summary">
      {summary.text}
      {summary.quote ? (
        <>
          {' '}
          <q title={`From a ${summary.quote.from}`}>{summary.quote.text}</q>
        </>
      ) : null}
    </p>
  );
}

/** What the person can open from a row, when there is something. */
function DetailLink({ tool }: { tool: ToolEntry }) {
  const detail = tool.detail;
  if (!detail) return null;
  if (detail.type === 'page' && detail.url)
    return (
      <a className="log-link" href={detail.url} target="_blank" rel="noreferrer">
        <Icon name="arrowUpRight" size={12} /> Open the page
      </a>
    );
  if (detail.type === 'artifact')
    return (
      <a className="log-link" href={adapter.artifactUrl(detail.id)} download>
        <Icon name="fileText" size={12} /> Download the file
      </a>
    );
  if (detail.type === 'memory')
    return (
      <a className="log-link" href={href('/settings/memory')}>
        <Icon name="book" size={12} /> See it in memory
      </a>
    );
  return null;
}

/** A row's preview once opened: the shell for a command, a picture, or what came back. */
function Preview({ tool, live }: { tool: ToolEntry; live: boolean }) {
  if (isCommand(tool)) return <ShellBlock tool={tool} live={live} />;
  const shot =
    workKind({ type: 'tool', tool }) === 'screenshot' && tool.detail?.type === 'artifact'
      ? tool.detail.id
      : null;
  return (
    <div className="log-preview">
      {shot ? (
        <img
          className="log-shot"
          src={adapter.artifactUrl(shot)}
          alt="The screenshot it took"
          loading="lazy"
        />
      ) : null}
      {tool.input_summary && !tool.input_excerpt ? <Summary summary={tool.input_summary} /> : null}
      {tool.input_excerpt ? <pre className="log-pre">{tool.input_excerpt.text}</pre> : null}
      {tool.output_excerpt ? (
        <pre className="log-pre">
          {tool.output_excerpt.text}
          {tool.output_excerpt.more ? '\n…' : ''}
        </pre>
      ) : tool.output_summary ? (
        <Summary summary={tool.output_summary} />
      ) : null}
      <DetailLink tool={tool} />
    </div>
  );
}

const opens = (tool: ToolEntry): boolean =>
  isCommand(tool) ||
  Boolean(
    tool.input_summary ||
      tool.output_summary ||
      tool.input_excerpt ||
      tool.output_excerpt ||
      (tool.detail && tool.detail.type !== 'permission' && tool.detail.type !== 'receipt'),
  );

/** One piece of work on one line; it opens onto its preview when there is one. */
export function WorkLine({
  work,
  live,
  initiallyOpen = false,
}: {
  work: Work;
  live: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  if (work.type === 'group') {
    const step = work.step;
    return (
      <div className="log-line" data-static="true">
        <span className="log-icon" aria-hidden="true">
          <Icon name="connectors" size={15} />
        </span>
        <span className="log-title">
          {step.label}
          {step.meta ? <span className="log-meta"> · {step.meta}</span> : null}
          {step.sources.length ? (
            <span className="log-meta">
              {' '}
              · {step.sources.map((source) => source.title).join(', ')}
            </span>
          ) : null}
        </span>
      </div>
    );
  }
  const tool = work.tool;
  const running = tool.status === 'running';
  const reason = tool.status === 'failed' ? tool.output_summary?.text : undefined;
  const line = (
    <>
      <span className="log-icon" aria-hidden="true">
        {running ? (
          <Icon name="loader" size={14} stroke={2} className={live ? 'spin' : undefined} />
        ) : (
          <Icon name={iconFor(work)} size={15} />
        )}
      </span>
      <span className="log-title">
        <Title title={tool.title} />
      </span>
      {tool.status === 'failed' ? (
        <span className="log-flag" data-tone="danger">
          Didn’t work
        </span>
      ) : tool.status === 'needs_approval' ? (
        <span className="log-flag">Waiting for you</span>
      ) : tool.status === 'unknown' ? (
        <span className="log-flag">Not confirmed</span>
      ) : null}
    </>
  );
  if (!opens(tool))
    return (
      <div className="log-line" data-static="true" data-status={tool.status}>
        {line}
      </div>
    );
  return (
    <div className="log-row" data-status={tool.status}>
      <button
        type="button"
        className="log-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        title={reason}
      >
        {line}
        <span className="log-chevron" aria-hidden="true">
          <Icon name="chevronDown" size={13} />
        </span>
      </button>
      {open ? (
        <div id={id} className="log-detail">
          <Preview tool={tool} live={live} />
        </div>
      ) : null}
    </div>
  );
}

/** The work between two messages: one row as it is, more folded behind what they were. */
export function WorkGroup({
  work,
  live,
  initiallyOpen = false,
}: {
  work: Work[];
  live: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  const first = work[0];
  if (!first) return null;
  if (work.length === 1) return <WorkLine work={first} live={live} initiallyOpen={initiallyOpen} />;
  const current = live
    ? [...work].reverse().find((entry) => entry.type === 'tool' && entry.tool.status === 'running')
    : undefined;
  const kind = summaryKind(work);
  const failed = work.filter((entry) => entry.type === 'tool' && entry.tool.status === 'failed');
  return (
    <div className="log-group">
      <button
        type="button"
        className="log-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="log-icon" aria-hidden="true">
          {current ? (
            <Icon name="loader" size={14} stroke={2} className="spin" />
          ) : (
            <Icon name={KIND_ICON[kind] ?? iconFor(first)} size={15} />
          )}
        </span>
        <span className="log-title">
          {current?.type === 'tool' ? <Title title={current.tool.title} /> : summarize(work)}
        </span>
        {failed.length ? (
          <span className="log-flag" data-tone="danger">
            {failed.length} didn’t work
          </span>
        ) : null}
        <span className="log-chevron" aria-hidden="true">
          <Icon name="chevronDown" size={13} />
        </span>
      </button>
      {open ? (
        <div id={id} className="log-group-rows">
          {work.map((entry, index) => (
            <WorkLine
              key={entry.type === 'tool' ? entry.tool.id : `group-${index}`}
              work={entry}
              live={live}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A file the agent changed, with what changed. There is no way to take an edit back, so no Undo. */
export function EditCard({ tool, diff }: { tool: ToolEntry; diff: DiffSummary }) {
  const [open, setOpen] = useState(false);
  const file = editedFile(tool);
  return (
    <div className="edit-card">
      <span className="edit-tile" aria-hidden="true">
        <Icon name="pencil" size={16} />
      </span>
      <span className="edit-text">
        <span className="edit-title">Edited {file}</span>
        <span className="edit-count">
          <span data-tone="add">+{diff.added}</span> <span data-tone="del">−{diff.removed}</span>
          <span className="sr-only">{` ${diff.added} lines added, ${diff.removed} removed`}</span>
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        View changes
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Changes to ${file}`}
        sub={`${diff.added} added, ${diff.removed} removed`}
        width={760}
        footer={
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a long diff scrolls, so it takes focus for the keyboard */}
        <section className="diff" aria-label="The changes" tabIndex={0}>
          {diff.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, in order
            <div key={index} className="diff-line" data-kind={line.kind}>
              {line.text || ' '}
            </div>
          ))}
        </section>
      </Dialog>
    </div>
  );
}

/** Another agent taking the turn, or handing it back. */
export function AgentLine({ face, text }: { face: ReactNode; text: string }) {
  return (
    <div className="log-line log-agent" data-static="true">
      <span className="log-icon" aria-hidden="true">
        {face}
      </span>
      <span className="log-title">{text}</span>
    </div>
  );
}

/** A message the agent wrote as it worked, in its own voice. */
function Message({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="log-message">
      <Markdown text={text} streaming={streaming} />
    </div>
  );
}

export function LogEntries({
  items,
  live,
  streaming,
  renderBlock,
}: {
  items: LogItem[];
  live: boolean;
  /** The newest message is still being written. */
  streaming: boolean;
  renderBlock: (block: TurnBlock) => ReactNode;
}) {
  return (
    <>
      {items.map((item, index) => {
        switch (item.type) {
          case 'message':
            return (
              <Message
                key={item.key}
                text={item.text}
                streaming={streaming && index === items.length - 1}
              />
            );
          case 'work':
            return <WorkGroup key={item.key} work={item.work} live={live} />;
          case 'edit':
            return <EditCard key={item.key} tool={item.tool} diff={item.diff} />;
          case 'note':
            return (
              <div key={item.key} className="log-line log-note" data-static="true">
                <span className="log-icon" aria-hidden="true">
                  <Icon name="info" size={14} />
                </span>
                <span className="log-title">{item.text}</span>
              </div>
            );
          case 'block':
            return (
              <div key={item.key} className="log-block">
                {renderBlock(item.block)}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** The header over a turn's work: live while it runs, how long it worked once it ends. */
export function headerWords(turn: TranscriptTurn, now: number): string {
  const seconds = turnSeconds(turn, now);
  const took = seconds === null ? null : workedFor(seconds);
  switch (turn.status) {
    case 'paused':
      return took ? `Paused after ${took}` : 'Paused';
    case 'needs_you':
      return 'Waiting for you';
    case 'stopped':
      return took ? `Stopped after ${took}` : 'Stopped';
    case 'failed':
      return 'Stopped without finishing';
    case 'done':
      return took ? `Worked for ${took}` : 'Worked on it';
    default:
      return took ? `Working for ${took}` : 'Working';
  }
}

/**
 * The work log of one turn. Open while the turn runs or waits on the person;
 * folded once it ends, keeping cards that need the person and results in view.
 */
export function WorkLog({
  turn,
  now,
  items,
  finished,
  renderBlock,
}: {
  turn: TranscriptTurn;
  now: number;
  items: LogItem[];
  finished: boolean;
  renderBlock: (block: TurnBlock) => ReactNode;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const id = useId();
  const running = RUNNING.has(turn.status);
  const anyRunning = items.some(
    (item) =>
      item.type === 'work' &&
      item.work.some((work) => work.type === 'tool' && work.tool.status === 'running'),
  );
  const hasWork = items.some((item) => item.type !== 'block' || !finished);
  if (!hasWork && !running) {
    // Nothing to fold: whatever is here is a card that needs the person.
    return items.length ? (
      <LogEntries items={items} live={false} streaming={false} renderBlock={renderBlock} />
    ) : null;
  }
  const open = choice ?? !finished;
  const kept = open ? [] : items.filter(staysInView);
  const stopped = turn.status === 'stopped' ? stoppedLine(stoppedTools(items)) : null;
  return (
    <div className="worklog" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="worklog-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChoice(!open)}
      >
        {running ? (
          <span className="working-dots" aria-hidden="true">
            <span className="pulse" />
            <span className="pulse" style={{ animationDelay: '.2s' }} />
            <span className="pulse" style={{ animationDelay: '.4s' }} />
          </span>
        ) : null}
        <span>{headerWords(turn, now)}</span>
        <Icon name="chevronDown" size={14} className="worklog-chevron" />
      </button>
      {stopped ? <p className="worklog-sub">{stopped}</p> : null}
      {open ? (
        <div id={id} className="worklog-body">
          <LogEntries
            items={items}
            live={running}
            streaming={turn.streaming && running}
            renderBlock={renderBlock}
          />
          {running && !anyRunning && !turn.streaming ? (
            <div className="log-line log-live" data-static="true" role="status">
              <span className="log-icon" aria-hidden="true">
                {turn.status === 'paused' ? (
                  <Icon name="clock" size={14} />
                ) : (
                  <Icon name="loader" size={14} stroke={2} className="spin" />
                )}
              </span>
              <span className="log-title">
                {turn.status === 'paused' ? 'Paused' : (turn.live?.title ?? 'Working')}
              </span>
            </div>
          ) : null}
        </div>
      ) : kept.length ? (
        <div className="worklog-body">
          <LogEntries items={kept} live={false} streaming={false} renderBlock={renderBlock} />
        </div>
      ) : null}
    </div>
  );
}

/** The tool entries a log holds, in order, for the line under a stopped turn. */
function stoppedTools(items: LogItem[]): { title: string }[] {
  return items.flatMap((item) =>
    item.type === 'work'
      ? item.work.flatMap((work) => (work.type === 'tool' ? [work.tool] : []))
      : item.type === 'edit'
        ? [item.tool]
        : [],
  );
}
