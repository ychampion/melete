/**
 * A conversation's computer, as its owner may see it: the page the agent's
 * browser was last seen on and the commands it ran in its sandbox.
 *
 * Everything here is read from records the work already left: the browser
 * session binding says who holds the browser, the browser actions' receipts
 * carry the observation handles, and the terminal actions' receipts carry what
 * each command printed. Nothing is fetched from the worker. What a worker
 * withheld after a person handed a page back (the picture, the query string,
 * a code in the title) is absent from the receipt, so it is absent here too.
 */
import {
  type AgentComputer,
  agentComputer,
  COMPUTER_PROCESS_LIMIT,
  COMPUTER_TERMINAL_LIMIT,
  type ComputerBrowser,
  type ComputerCommand,
  type ComputerProcess,
  type ProcessState,
} from '@melete/contracts';
import type { ActionRow } from './projectors.ts';
import { object } from './projectors.ts';
import { actionToolStatus, CREDENTIAL, displayUrl, toolText } from './tools.ts';

/** One background process of the conversation's agent, as its row records it. */
export type ComputerProcessRow = {
  id: string;
  name: string;
  state: ProcessState;
  started_at: Date | null;
  created_at: Date;
  port: number | null;
  last_line: string | null;
  /** False for a process started by another person or in a sensitive conversation. */
  attributable?: boolean;
  /** True only when the person reading the conversation started the process through a job of theirs. */
  previewable?: boolean;
};

export type ComputerBinding = {
  id: string;
  control: string;
  updated_at: Date;
};

const TERMINAL_KINDS = new Set(['terminal.run', 'exec.run']);
const OUTPUT_LINES = 40;
const LINE_LIMIT = 240;
const HIDDEN = '[hidden]';

/**
 * Secrets in the shapes commands print most that the credential pattern does
 * not cover: a quoted key in JSON (`"password": "…"`) and a connection string
 * that carries a password (`postgres://user:pass@host`).
 */
const QUOTED_SECRET =
  /["'][A-Za-z_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential)[A-Za-z_-]{0,64}["']\s*[:=]/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@:]+:[^\s/@]+@/i;
const secretLine = (line: string) =>
  CREDENTIAL.test(line) || QUOTED_SECRET.test(line) || URL_PASSWORD.test(line);

const clipLine = (line: string) =>
  line.length <= LINE_LIMIT ? line : `${line.slice(0, LINE_LIMIT - 1)}…`;

/**
 * Terminal text as it may be shown: control characters taken out, each line
 * clipped, and a line that looks like it carries a credential replaced whole.
 * `keep` chooses the first or the last lines of a long text.
 */
export function terminalText(value: unknown, limit: number, keep: 'first' | 'last'): string {
  if (typeof value !== 'string' || !value) return '';
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/\t/g, '  ')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are removed on purpose
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\p{Cc}/gu, '')
        .trimEnd(),
    )
    .map((line) => (secretLine(line) ? HIDDEN : clipLine(line)));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const chosen = keep === 'last' ? lines.slice(-OUTPUT_LINES) : lines.slice(0, OUTPUT_LINES);
  let text = chosen.join('\n');
  if (text.length > limit)
    text = keep === 'last' ? `…${text.slice(-(limit - 1))}` : `${text.slice(0, limit - 1)}…`;
  return text;
}

function command(row: ActionRow): ComputerCommand {
  const payload = object(row.canonicalPayload);
  const detail = object(object(row.receipt).detail);
  const status = actionToolStatus(row.status);
  return {
    id: row.id,
    command: terminalText(payload.command, 2000, 'first'),
    output:
      status === 'done' && detail.output_binary !== true
        ? terminalText(detail.output, 4000, 'last')
        : '',
    status: status === 'done' || status === 'failed' || status === 'unknown' ? status : 'running',
    exit_code:
      typeof detail.exit_code === 'number' && Number.isInteger(detail.exit_code)
        ? detail.exit_code
        : null,
    started_at: row.createdAt.toISOString(),
  };
}

const last = <T>(rows: T[], match: (row: T) => boolean): T | undefined => {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] as T;
    if (match(row)) return row;
  }
  return undefined;
};

function browser(binding: ComputerBinding, rows: ActionRow[]): ComputerBrowser {
  const mine = rows.filter(
    (row) =>
      row.kind.startsWith('browser.') &&
      object(object(row.receipt).detail).session_id === binding.id,
  );
  // The newest observation the worker returned says where the page is and what it looked like.
  const seen = last(
    mine,
    (row) =>
      row.status === 'succeeded' &&
      Object.keys(object(object(object(row.receipt).detail).observation)).length > 0,
  );
  const observation = object(object(object(seen?.receipt).detail).observation);
  const picture = object(observation.screenshot).artifact_id;
  // Without an observation, the address the agent last asked to open is the best account.
  const opened = last(mine, (row) => row.kind === 'browser.open');
  const url =
    displayUrl(observation.url) ?? displayUrl(object(opened?.canonicalPayload).url) ?? null;
  return {
    session_id: binding.id,
    control: binding.control === 'human' ? 'you' : 'agent',
    url,
    title: seen ? toolText(observation.title, 200) : null,
    screenshot:
      typeof picture === 'string' && /^art_/.test(picture) ? { artifact_id: picture } : null,
    seen_at: (seen?.resolvedAt ?? seen?.createdAt ?? opened?.createdAt)?.toISOString() ?? null,
  };
}

const LIVE = new Set<ProcessState>(['starting', 'running']);

/** The live processes first, newest first, then the latest ended ones. */
function processes(rows: readonly ComputerProcessRow[]): ComputerProcess[] {
  return [...rows]
    .sort(
      (a, b) =>
        Number(LIVE.has(b.state)) - Number(LIVE.has(a.state)) ||
        b.created_at.getTime() - a.created_at.getTime(),
    )
    .slice(0, COMPUTER_PROCESS_LIMIT)
    .map((row) => ({
      id: row.id,
      // A process this conversation may not attribute shows no name and no output.
      name:
        row.attributable === false
          ? 'Process'
          : terminalText(row.name, 120, 'first').split('\n')[0] || 'process',
      state: row.state,
      started_at: (row.started_at ?? row.created_at).toISOString(),
      port: row.port,
      last_line:
        row.attributable !== false && row.last_line
          ? terminalText(row.last_line, 240, 'last') || null
          : null,
      // Offered to the person whose job started a running server; opening it checks again.
      can_preview: row.previewable === true && row.state === 'running' && row.port !== null,
    }));
}

/**
 * The computer view from a conversation's actions (oldest first), its
 * browser session bindings and its agent's background processes. The binding
 * touched last is the browser shown.
 */
export function projectComputer(input: {
  rows: ActionRow[];
  bindings: ComputerBinding[];
  processes?: readonly ComputerProcessRow[];
  available: AgentComputer['available'];
}): AgentComputer {
  const binding = input.bindings.reduce<ComputerBinding | undefined>(
    (latest, next) =>
      !latest || next.updated_at.getTime() > latest.updated_at.getTime() ? next : latest,
    undefined,
  );
  const terminal = input.rows
    .filter((row) => TERMINAL_KINDS.has(row.kind))
    .slice(-COMPUTER_TERMINAL_LIMIT)
    .map(command);
  return agentComputer.parse({
    browser: binding ? browser(binding, input.rows) : null,
    terminal,
    processes: processes(input.processes ?? []),
    available: input.available,
  });
}
