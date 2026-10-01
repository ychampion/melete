/**
 * The agent's activity above an answer: one row per tool entry, in the order
 * the work started, each opening onto what went in, what came out and what
 * can be opened. The model's reasoning sits between rows as a closed
 * "Thinking" block. Every string is drawn as plain text.
 */
import { useId, useState } from 'react';
import { Icon, type IconName } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import type { ToolEntry } from '../experience/trace.ts';
import { href } from '../router.ts';

type Excerpt = NonNullable<ToolEntry['input_excerpt']>;

const KIND_ICON: Record<ToolEntry['kind'], IconName> = {
  connector: 'connectors',
  web: 'globe',
  file: 'fileText',
  artifact: 'upload',
  browser: 'compass',
  sandbox: 'monitor',
  skill: 'sparkles',
  memory_recall: 'book',
  memory_write: 'book',
  memory_correct: 'pencil',
  memory_forget: 'trash',
  model: 'sparkles',
  retry: 'clock',
  tool: 'sliders',
};

/** The icon for an entry: its family, and for a connected app, the kind of app. */
export function toolIcon(tool: ToolEntry): IconName {
  if (tool.kind === 'web' && /^Search/.test(tool.title)) return 'search';
  if (tool.kind === 'sandbox' && /`/.test(tool.title)) return 'terminal';
  if (tool.kind === 'connector') {
    const title = tool.title.toLowerCase();
    if (title.includes('calendar')) return 'calendar';
    if (title.includes('email') || title.includes('inbox') || title.includes('message'))
      return 'mail';
  }
  return KIND_ICON[tool.kind] ?? 'sliders';
}

/** How long something took, the way a person says it. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${seconds % 60} s`;
}

/** How long an entry took, or has taken so far while it runs. */
export function toolDuration(tool: ToolEntry, now: number): string {
  const start = Date.parse(tool.started_at);
  if (Number.isNaN(start)) return '';
  if (tool.ended_at) return duration(Date.parse(tool.ended_at) - start);
  return tool.status === 'running' ? duration(Math.max(0, now - start)) : '';
}

const STATUS_WORDS: Record<ToolEntry['status'], string> = {
  running: 'Under way',
  done: 'Done',
  failed: 'Did not happen',
  needs_approval: 'Waiting for you',
  unknown: 'Not confirmed',
};

function StatusMark({ tool, live }: { tool: ToolEntry; live: boolean }) {
  const label = STATUS_WORDS[tool.status];
  const mark =
    tool.status === 'running' ? (
      <Icon name="loader" size={13} stroke={2} className={live ? 'spin' : undefined} />
    ) : tool.status === 'done' ? (
      <Icon name="check" size={13} stroke={2} />
    ) : tool.status === 'failed' ? (
      <Icon name="circleX" size={13} stroke={2} />
    ) : tool.status === 'needs_approval' ? (
      <Icon name="clock" size={13} stroke={2} />
    ) : (
      <Icon name="alert" size={13} stroke={2} />
    );
  return (
    <span
      className="act-status"
      data-status={tool.status}
      role="img"
      aria-label={label}
      title={label}
    >
      {mark}
    </span>
  );
}

const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 480;

/** A longer stretch of input or output, monospace, cut short until asked for. */
function ExcerptBlock({ label, excerpt }: { label: string; excerpt: Excerpt }) {
  const [all, setAll] = useState(false);
  const id = useId();
  const lines = excerpt.text.split('\n');
  const long = lines.length > PREVIEW_LINES || excerpt.text.length > PREVIEW_CHARS;
  const shown =
    all || !long
      ? excerpt.text
      : lines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS).trimEnd();
  return (
    <div className="act-excerpt">
      <span className="act-excerpt-label">{label}</span>
      <pre id={id} className="act-pre" data-from={excerpt.from}>
        {shown}
        {(long && !all) || (all && excerpt.more) ? '\n…' : ''}
      </pre>
      {long ? (
        <button
          type="button"
          className="act-more"
          aria-expanded={all}
          aria-controls={id}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

function SummaryLine({ summary }: { summary: NonNullable<ToolEntry['input_summary']> }) {
  return (
    <span className="act-summary">
      {summary.text}
      {summary.quote ? (
        <q className="trail-quote" title={`From a ${summary.quote.from}`}>
          {summary.quote.text}
        </q>
      ) : null}
    </span>
  );
}

/**
 * A title with the command it names set as code. A title only ever wraps one
 * outside value in backticks, so an odd count means none was meant.
 */
export function TitleText({ title }: { title: string }) {
  const parts = title.split('`');
  if (parts.length !== 3) return <>{title}</>;
  return (
    <>
      {parts[0]}
      <code className="act-code">{parts[1]}</code>
      {parts[2]}
    </>
  );
}

/** What the person can open from an entry, when there is something. */
function DetailLink({ tool }: { tool: ToolEntry }) {
  const detail = tool.detail;
  if (!detail) return null;
  if (detail.type === 'page' && detail.url)
    return (
      <a className="act-link" href={detail.url} target="_blank" rel="noreferrer">
        <Icon name="arrowUpRight" size={12} /> Open the page
      </a>
    );
  if (detail.type === 'artifact')
    return (
      <a className="act-link" href={adapter.artifactUrl(detail.id)} download>
        <Icon name="fileText" size={12} /> Download the file
      </a>
    );
  if (detail.type === 'memory')
    return (
      <a className="act-link" href={href('/settings/memory')}>
        <Icon name="book" size={12} /> See it in memory
      </a>
    );
  if (detail.type === 'permission')
    return <span className="act-note">Your decision is asked for below.</span>;
  if (detail.type === 'receipt') return <span className="act-note">The receipt is below.</span>;
  return null;
}

/** Whether opening a row would show anything beyond its title. */
const hasDetail = (tool: ToolEntry) =>
  Boolean(
    tool.input_summary ||
      tool.output_summary ||
      tool.input_excerpt ||
      tool.output_excerpt ||
      tool.detail,
  );

/**
 * One tool entry. Closed, it is the title, how long it took and how it went;
 * a failure also says why, in red. Open, it shows the input and output.
 */
export function ActivityRow({
  tool,
  now,
  live,
  initiallyOpen = false,
}: {
  tool: ToolEntry;
  now: number;
  /** The turn is still running, so a running row is the work under way. */
  live: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const detailId = useId();
  const expandable = hasDetail(tool);
  const took = toolDuration(tool, now);
  const reason = tool.status === 'failed' ? tool.output_summary?.text : undefined;
  const current = live && tool.status === 'running';
  const line = (
    <>
      <span className="act-icon" aria-hidden="true">
        <Icon name={toolIcon(tool)} size={14} />
      </span>
      <span className="act-title" data-current={current ? 'true' : undefined}>
        <TitleText title={tool.title} />
      </span>
      {took ? <span className="act-time">{took}</span> : null}
      <StatusMark tool={tool} live={live} />
      {expandable ? (
        <span className="act-chevron" aria-hidden="true">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        </span>
      ) : null}
    </>
  );
  return (
    <li className="act-row" data-status={tool.status} data-kind={tool.kind}>
      {expandable ? (
        <button
          type="button"
          className="act-line"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
        >
          {line}
        </button>
      ) : (
        <div className="act-line" data-static="true">
          {line}
        </div>
      )}
      {reason && !open ? <span className="act-reason">{reason}</span> : null}
      {open ? (
        <div className="act-detail" id={detailId}>
          {/* With an excerpt, the summary's words label it and its quote is not repeated. */}
          {tool.input_excerpt ? (
            <ExcerptBlock
              label={tool.input_summary?.text ?? 'Input'}
              excerpt={tool.input_excerpt}
            />
          ) : tool.input_summary ? (
            <SummaryLine summary={tool.input_summary} />
          ) : null}
          {tool.output_excerpt ? (
            <ExcerptBlock
              label={tool.output_summary?.text ?? 'Output'}
              excerpt={tool.output_excerpt}
            />
          ) : tool.output_summary ? (
            <SummaryLine summary={tool.output_summary} />
          ) : null}
          <DetailLink tool={tool} />
        </div>
      ) : null}
    </li>
  );
}

const TAIL = 140;

/**
 * The model's reasoning between rows: closed under one word. While it is
 * still being written, the newest words show beside it so the person can see
 * it moving.
 */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const words = text.trim();
  const tail = words.length > TAIL ? `…${words.slice(-TAIL).trimStart()}` : words;
  return (
    <li className="act-thinking" data-live={live ? 'true' : undefined}>
      <button
        type="button"
        className="act-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="act-icon" aria-hidden="true">
          <Icon name="sparkles" size={14} />
        </span>
        <span className="act-title">{live ? 'Thinking…' : 'Thinking'}</span>
        {live && !open ? <span className="act-tail clamp1">{tail}</span> : null}
        <span className="act-chevron" aria-hidden="true">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        </span>
      </button>
      {open ? (
        <div id={id} className="trail-reasoning">
          {words}
        </div>
      ) : null}
    </li>
  );
}
