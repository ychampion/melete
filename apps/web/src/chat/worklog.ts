/**
 * How a turn reads: the agent's own messages in the order it wrote them, the
 * work between two messages gathered into one quiet row, and the cards that
 * need the person where they happened. Pure functions over the transcript, so
 * the grouping, the wording and the order can be tested without a screen.
 */
import {
  answerOf,
  blockId,
  type FlowEntry,
  type TranscriptTurn,
  type TurnBlock,
} from '../experience/reduce.ts';
import type { ToolEntry } from '../experience/trace.ts';
import type { ResultCard, TrailStep, TurnStatus } from '../experience/types.ts';

/** A step the trail tells without a tool entry: grouped app work and its sources. */
export type GroupStep = Extract<TrailStep, { type: 'action' }>;

/** One line of work: a tool entry, or grouped app work the service described. */
export type Work = { type: 'tool'; tool: ToolEntry } | { type: 'group'; step: GroupStep };

export type LogItem =
  | { type: 'message'; key: string; text: string }
  | { type: 'work'; key: string; work: Work[] }
  | { type: 'edit'; key: string; tool: ToolEntry; diff: DiffSummary }
  | { type: 'note'; key: string; text: string }
  /** Pages the work found or read, drawn as one quiet row that opens onto their links. */
  | { type: 'sources'; key: string; cards: ResultCard[] }
  | { type: 'block'; key: string; block: TurnBlock };

export const FINISHED: TurnStatus[] = ['done', 'stopped', 'failed'];

/* ---------- edits ---------- */

export type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'same'; text: string };
export type DiffSummary = { added: number; removed: number; lines: DiffLine[] };

/** A unified diff, read line by line; null when the text is not one. */
export function readDiff(text: string): DiffSummary | null {
  if (!/^@@ /m.test(text) && !/^(\+\+\+|---) /m.test(text)) return null;
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = text.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff '))
      return { kind: 'meta', text: line };
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+')) {
      added += 1;
      return { kind: 'add', text: line };
    }
    if (line.startsWith('-')) {
      removed += 1;
      return { kind: 'del', text: line };
    }
    return { kind: 'same', text: line };
  });
  return added + removed > 0 ? { added, removed, lines } : null;
}

/** The changes a file edit carries, when its output is a diff the person may read. */
export function editOf(tool: ToolEntry): DiffSummary | null {
  if (tool.kind !== 'file' || tool.status !== 'done') return null;
  if (!/^(Edited|Wrote|Patched|Updated|Changed)\b/.test(tool.title)) return null;
  return tool.output_excerpt ? readDiff(tool.output_excerpt.text) : null;
}

/** The file an edit names: the title after its verb, without its folders or notes. */
export function editedFile(tool: ToolEntry): string {
  const rest = tool.title.replace(/^\S+\s+/, '').replace(/\s+\(.*\)$/, '');
  return rest.replace(/^`|`$/g, '') || 'a file';
}

/* ---------- what kind of work a row is ---------- */

export type WorkKind =
  | 'command'
  | 'read'
  | 'edit'
  | 'search_files'
  | 'web_search'
  | 'held'
  | 'page'
  | 'open'
  | 'screenshot'
  | 'browser'
  | 'memory'
  | 'skill'
  | 'ask'
  | 'app'
  | 'other';

export function workKind(work: Work): WorkKind {
  if (work.type === 'group') return 'app';
  const { kind, title } = work.tool;
  if (/screenshot|at the screen|at your screen/i.test(title)) return 'screenshot';
  if (/^Ask(ed|ing) you\b/.test(title)) return 'ask';
  if (/^(Ran|Running)\b/.test(title) || (kind === 'sandbox' && title.includes('`')))
    return 'command';
  if (kind === 'web') {
    if (/^Search held back\b/.test(title)) return 'held';
    return /^Search/.test(title) ? 'web_search' : 'page';
  }
  if (kind === 'file') {
    if (/^(Edit|Wrote|Writ|Sav|Patch|Updat|Chang)/.test(title)) return 'edit';
    if (/^Search/.test(title)) return 'search_files';
    return 'read';
  }
  if (kind === 'browser') return /^Open/.test(title) ? 'open' : 'browser';
  if (kind.startsWith('memory_')) return 'memory';
  if (kind === 'skill') return 'skill';
  if (kind === 'connector') return 'app';
  if (/^(Read|Reading)\b/.test(title)) return 'read';
  if (/^Open/.test(title)) return 'open';
  return 'other';
}

/** How each kind of work is told in a summary: once, and more than once. */
const PHRASES: Record<WorkKind, [one: string, many: string]> = {
  command: ['ran a command', 'ran commands'],
  read: ['read a file', 'read files'],
  edit: ['edited a file', 'edited files'],
  search_files: ['searched files', 'searched files'],
  web_search: ['searched the web', 'searched the web'],
  held: ['held back a search', 'held back searches'],
  page: ['read a page', 'read pages'],
  open: ['opened a site', 'opened sites'],
  screenshot: ['took a screenshot', 'took screenshots'],
  browser: ['used the browser', 'used the browser'],
  memory: ['used memory', 'used memory'],
  skill: ['used a skill', 'used skills'],
  ask: ['asked you', 'asked you'],
  app: ['used an app', 'used apps'],
  other: ['used a tool', 'used tools'],
};

/** "Read files, ran a command": each kind once, in the order the work first did it. */
export function summarize(work: Work[]): string {
  const counts = new Map<WorkKind, number>();
  for (const entry of work) {
    const kind = workKind(entry);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const words = [...counts.entries()].map(([kind, count]) => PHRASES[kind][count > 1 ? 1 : 0]);
  const text = words.join(', ');
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : '';
}

/** How each kind of work is counted in a turn's one-line summary: once, and n times. */
const COUNTED: Record<WorkKind, [one: string, many: (n: number) => string]> = {
  command: ['ran a command', (n) => `ran ${n} commands`],
  read: ['read a file', (n) => `read ${n} files`],
  edit: ['edited a file', (n) => `edited ${n} files`],
  search_files: ['searched files', (n) => `searched files ${n} times`],
  web_search: ['searched the web', (n) => `searched the web ${n} times`],
  held: ['held back a search', (n) => `held back ${n} searches`],
  page: ['read a page', (n) => `read ${n} pages`],
  open: ['opened a site', (n) => `opened ${n} sites`],
  screenshot: ['took a screenshot', (n) => `took ${n} screenshots`],
  browser: ['used the browser', () => 'used the browser'],
  memory: ['used memory', () => 'used memory'],
  skill: ['used a skill', (n) => `used ${n} skills`],
  ask: ['asked you', (n) => `asked you ${n} times`],
  app: ['used an app', (n) => `used ${n} apps`],
  other: ['used a tool', (n) => `used ${n} tools`],
};

/** At most this many kinds are named in a turn's summary line; the log holds the rest. */
const SUMMARY_KINDS = 3;

/**
 * "ran 6 commands, read 3 files": what a whole turn did, counted, each kind once
 * in the order the turn first did it. Edit cards count as edits. Empty when the
 * turn did no work.
 */
export function countWork(items: LogItem[]): string {
  const counts = new Map<WorkKind, number>();
  const add = (kind: WorkKind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  for (const item of items) {
    if (item.type === 'work') for (const work of item.work) add(workKind(work));
    else if (item.type === 'edit') add('edit');
  }
  return [...counts.entries()]
    .slice(0, SUMMARY_KINDS)
    .map(([kind, count]) => (count > 1 ? COUNTED[kind][1](count) : COUNTED[kind][0]))
    .join(', ');
}

/** The icon a summary row wears: what most says what the work was. */
export function summaryKind(work: Work[]): WorkKind {
  const kinds = new Set(work.map(workKind));
  for (const kind of ['edit', 'command', 'web_search', 'read', 'page'] as const)
    if (kinds.has(kind)) return kind;
  return work[0] ? workKind(work[0]) : 'other';
}

/* ---------- the turn as a log ---------- */

/** The final answer: the saved copy once there is one, else the newest thing the agent said. */
export function finalText(turn: TranscriptTurn): string {
  const saved = turn.turn.answer.trim();
  if (saved) return saved;
  for (let index = turn.flow.length - 1; index >= 0; index--) {
    const entry = turn.flow[index];
    if (entry?.type === 'text' && entry.text.trim()) return entry.text.trim();
    if (entry?.type === 'step' && entry.step.type === 'say') return entry.step.text;
  }
  return answerOf(turn).trim();
}

/**
 * A card that only points at a page: a search result or a page read. It
 * carries nothing to act on but the link, so it is drawn as a line among the
 * sources rather than as a card of its own.
 */
export const isLinkCard = (card: ResultCard): boolean =>
  card.primary_action?.kind === 'open' &&
  Boolean(card.primary_action.url) &&
  card.facts.length === 0 &&
  card.secondary_actions.length === 0;

/** A message that ends on one of these marks is whole. */
const ENDED = /[.!?:;…)\]"'”’`*]$/;

/**
 * Whether `next` is the tail of `previous`, cut off when a tool row was drawn
 * before the last word of the message arrived: the message stops mid-sentence
 * and what follows is one lowercase word or a closing mark ("release.").
 */
export function continuesMessage(previous: string, next: string): boolean {
  if (ENDED.test(previous.trimEnd())) return false;
  const tail = next.trim();
  return tail.length <= 40 && !/\s/.test(tail) && /^[\p{Ll},.;:!?)]/u.test(tail);
}

const sameWords = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

const toolsById = (turn: TranscriptTurn): Map<string, ToolEntry> => {
  const map = new Map<string, ToolEntry>();
  for (const step of turn.trail)
    if (step.type === 'action' && step.tool) map.set(step.tool.id, step.tool);
  return map;
};

/**
 * Whether grouped app work only repeats what the turn already shows: each of
 * its actions is a tool row of its own, and each of its sources a card (a
 * page as a link among the sources, anything else as its card).
 */
function toldElsewhere(turn: TranscriptTurn, step: GroupStep, hasTools: boolean): boolean {
  if (!hasTools) return false;
  const urls = new Set<string>();
  const titles = new Set<string>();
  for (const block of turn.blocks) {
    if (block.type !== 'card') continue;
    titles.add(block.card.title);
    const action = block.card.primary_action;
    if (action?.kind === 'open' && action.url) urls.add(action.url);
  }
  return step.sources.every((source) =>
    source.url ? urls.has(source.url) : titles.has(source.title),
  );
}

/**
 * The turn's flow as the rows to draw, oldest first. Work between two messages
 * becomes one `work` item; a message, a note, an edit or a block ends it.
 * Blocks the flow never named (a permission added by a send here) follow at
 * the end, and a turn read with no flow at all is its saved answer alone.
 */
export function logItems(turn: TranscriptTurn): LogItem[] {
  const tools = toolsById(turn);
  const hasTools = turn.flow.some((entry) => entry.type === 'tool' && tools.has(entry.id));
  const blocks = new Map(turn.blocks.map((block) => [blockId(block), block]));
  const named = new Set<string>();
  const items: LogItem[] = [];
  let run: Work[] = [];
  let runKey = '';
  const close = () => {
    if (run.length) items.push({ type: 'work', key: runKey, work: run });
    run = [];
  };
  const add = (work: Work, key: string) => {
    if (!run.length) runKey = `work-${key}`;
    run.push(work);
  };
  turn.flow.forEach((entry: FlowEntry, index) => {
    switch (entry.type) {
      case 'text': {
        const text = entry.text.trim();
        if (!text) return;
        // The tail of the message before the work joins it; the work stays after.
        const previous = items.at(-1);
        if (run.length && previous?.type === 'message' && continuesMessage(previous.text, text)) {
          const glue = /^[,.;:!?)]/.test(text) ? '' : ' ';
          items[items.length - 1] = { ...previous, text: `${previous.text}${glue}${text}` };
          return;
        }
        close();
        items.push({ type: 'message', key: `text-${index}`, text });
        return;
      }
      case 'tool': {
        const tool = tools.get(entry.id);
        if (!tool) return;
        const diff = editOf(tool);
        if (diff) {
          close();
          items.push({ type: 'edit', key: `edit-${tool.id}`, tool, diff });
          return;
        }
        add({ type: 'tool', tool }, tool.id);
        return;
      }
      case 'step': {
        const step = entry.step;
        if (step.type === 'say') {
          close();
          items.push({ type: 'message', key: `say-${index}`, text: step.text });
        } else if (step.type === 'note') {
          close();
          items.push({ type: 'note', key: `note-${index}`, text: step.text });
        } else if (step.type === 'action' && !toldElsewhere(turn, step, hasTools))
          add({ type: 'group', step }, `group-${index}`);
        return;
      }
      case 'block': {
        const block = blocks.get(entry.id);
        if (!block || named.has(entry.id)) return;
        named.add(entry.id);
        close();
        if (block.type === 'card' && isLinkCard(block.card)) {
          const last = items.at(-1);
          if (last?.type === 'sources') last.cards.push(block.card);
          else items.push({ type: 'sources', key: `sources-${entry.id}`, cards: [block.card] });
          return;
        }
        // A question that repeats the message before it is told once, by the question.
        const previous = items.at(-1);
        if (
          block.type === 'question' &&
          previous?.type === 'message' &&
          sameWords(previous.text, block.question.text)
        )
          items.pop();
        items.push({ type: 'block', key: `block-${entry.id}`, block });
        return;
      }
    }
  });
  close();
  for (const [id, block] of blocks)
    if (!named.has(id)) items.push({ type: 'block', key: `block-${id}`, block });
  return items;
}

/**
 * The turn split for drawing. `log` is the work and the messages before the
 * final answer; `answer` is that answer; `after` is what came after it (a
 * saved file, a receipt). While the turn runs there is no final answer yet:
 * every message is in the log, the newest one still being written.
 */
export type TurnLayout = {
  log: LogItem[];
  answer: string;
  after: LogItem[];
  finished: boolean;
};

export function layoutTurn(turn: TranscriptTurn): TurnLayout {
  const items = logItems(turn);
  const finished = FINISHED.includes(turn.status);
  if (!finished) return { log: items, answer: '', after: [], finished };
  // A saved answer that only repeats what a question asks is told once, by the question.
  const saved = finalText(turn);
  const asked = turn.blocks.some(
    (block) => block.type === 'question' && sameWords(block.question.text, saved),
  );
  const answer = asked ? '' : saved;
  let last = -1;
  items.forEach((item, index) => {
    if (item.type === 'message') last = index;
  });
  if (last < 0) return { log: items, answer, after: [], finished };
  // The saved answer stands for the newest message, which it replaces.
  // Earlier messages the saved answer already holds are not told twice.
  const log = items
    .slice(0, last)
    .filter((item) => item.type !== 'message' || !answer.includes(item.text));
  return { log, answer, after: items.slice(last + 1), finished };
}

/**
 * What stays in view when a finished turn's work is folded away: anything that
 * still needs the person, and every result they can open or undo.
 */
export const staysInView = (item: LogItem): boolean =>
  item.type === 'block' || item.type === 'edit';

/* ---------- time ---------- */

/** How long a turn worked, the way a clock reads it: "45s", "26m 42s", "1h 5m". */
export function workedFor(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return s % 60 ? `${minutes}m ${s % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** Seconds a turn has worked: its closing step's count, or from its start to its last work. */
export function turnSeconds(turn: TranscriptTurn, now: number): number | null {
  const running = !FINISHED.includes(turn.status) && turn.status !== 'needs_you';
  const started = Date.parse(turn.turn.created_at);
  if (Number.isNaN(started)) return null;
  if (running) return Math.max(0, (now - started) / 1000);
  const done = turn.trail.filter(
    (step): step is Extract<TrailStep, { type: 'done' }> => step.type === 'done',
  );
  const total = done.reduce((sum, step) => sum + step.elapsed_ms, 0);
  if (total > 0) return Math.max(1, total / 1000);
  let latest: number | null = null;
  for (const step of turn.trail)
    if (step.type === 'action' && step.tool)
      for (const at of [step.tool.started_at, step.tool.ended_at]) {
        const time = at ? Date.parse(at) : Number.NaN;
        if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
      }
  return latest === null ? null : Math.max(1, (latest - started) / 1000);
}

/* ---------- long chats ---------- */

/** Turns beyond this many fold behind "N previous messages". */
export const KEEP_TURNS = 6;
const FOLD_FROM = 10;

/**
 * Where the agent's memory of the chat was last summarised: the index of the
 * newest turn during which the earlier conversation was compacted, or 0 when
 * it never was (a summary before the first turn leaves nothing to fold).
 */
export function summarisedBefore(turns: TranscriptTurn[]): number {
  for (let index = turns.length - 1; index > 0; index--) if (turns[index]?.compacted) return index;
  return 0;
}

export type Fold = {
  /** How many of the oldest turns are folded away. */
  count: number;
  /** How many messages those turns hold. */
  messages: number;
  /** The index of the turn the earlier part was summarised before, or 0. */
  summarised: number;
};

/**
 * How many of the oldest turns fold away, and how many messages they hold. A
 * long chat folds all but its newest turns; a chat whose earlier part was
 * summarised folds at least that part. A turn still waiting on the person
 * never folds, nor any turn after it.
 */
export function foldedTurns(turns: TranscriptTurn[]): Fold {
  const summarised = summarisedBefore(turns);
  let count = Math.max(turns.length < FOLD_FROM ? 0 : turns.length - KEEP_TURNS, summarised);
  if (count <= 0) return { count: 0, messages: 0, summarised };
  const waiting = turns.findIndex((turn) =>
    turn.blocks.some(
      (block) =>
        (block.type === 'permission' && block.decided === null) ||
        (block.type === 'question' && block.answered === null),
    ),
  );
  if (waiting >= 0) count = Math.min(count, waiting);
  let messages = 0;
  for (const turn of turns.slice(0, count)) {
    if (turn.turn.text) messages += 1;
    const said = turn.flow.filter((entry) => entry.type === 'text' && entry.text.trim()).length;
    messages += Math.max(said, finalText(turn) ? 1 : 0);
  }
  return { count: Math.max(0, count), messages, summarised };
}

/* ---------- the person's message ---------- */

const LONG_CHARS = 600;
const LONG_LINES = 8;

/** Whether a message is long enough to fold under "Show more". */
export const longMessage = (text: string): boolean =>
  text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
