/**
 * Every piece of work the service does for a person, told as a tool entry in
 * the conversation. The sources are the durable records the work already
 * leaves (broker actions, runtime tool events, gateway receipts, memory
 * contexts); nothing here decides anything, it only describes.
 *
 * Summaries are held to one rule: the service's own words go in `text`, and
 * anything read from outside (a page, a message, a file name, what the model
 * asked a tool) goes in `quote`, scrubbed and clipped. A quote that looks like
 * it carries a credential is left out rather than shortened; the step's own
 * words still show.
 */
import { createHash } from 'node:crypto';
import {
  MEMORY_TOOL_NOTICE,
  type MemoryToolNotice,
  memoryToolNotice,
  TOOL_EXCERPT_LIMIT,
  TOOL_QUOTE_LIMIT,
  TOOL_SUMMARY_LIMIT,
  TOOL_TITLE_LIMIT,
  TOOL_TRACE_NOTICE,
  type ToolCall,
  type ToolDetail,
  type ToolExcerpt,
  type ToolFailure,
  type ToolKind,
  type ToolQuote,
  type ToolStatus,
  type ToolSummary,
  toolCall,
} from '@melete/contracts';
import { appendEvent, type Query } from '../broker/records.ts';
import { SEARCH_KEPT_DETAILS, SEARCH_KEPT_PRIVATE, SEARCH_KEPT_TOPIC } from '../privacy/router.ts';
import { HIDDEN, hideSecrets } from './answer-filter.ts';
import {
  ACTION_VERBS,
  type ActionRow,
  appName,
  BACKEND_VOCABULARY,
  type ConnectionRow,
  NOT_OPENED,
  object,
  plainText,
  safeUrl,
} from './projectors.ts';

const CREDENTIAL_SHAPES =
  /\bBearer\s+\S|\bsk-[A-Za-z0-9_-]{8,}|\bgh[opsu]_[A-Za-z0-9]{8,}|\bgithub_pat_|\bxox[abprs]-|\bAKIA[0-9A-Z]{12}|\bAIza[0-9A-Za-z_-]{20}|\beyJ[A-Za-z0-9_-]{8,}\.|sealed-box-v1:|-----BEGIN|(?:^|[^A-Za-z])[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential)[A-Za-z_]*\s*[:=]/i;
/** A long random run mixing cases and digits; a lowercase path, slug or model id is not one. */
const RANDOM_RUN =
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}/;
/**
 * The service's own record id standing as a whole name, with the extension a
 * saved file gives it (`act_….png`). It names a file the agent saved, not a
 * secret, so it is taken out before the random-run test; nothing else is.
 */
const RECORD_NAME =
  /(?<![A-Za-z0-9+_-])[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{26}(?:\.[A-Za-z0-9]{1,8})?(?![A-Za-z0-9+_-])/g;

export const CREDENTIAL = {
  test: (text: string): boolean =>
    CREDENTIAL_SHAPES.test(text) || RANDOM_RUN.test(text.replace(RECORD_NAME, ' ')),
};
/** A path segment that reads like a key rather than a word: long, and mixing letters and digits. */
const TOKEN_SEGMENT = /^(?=[^/]*\d)(?=[^/]*[A-Za-z])[A-Za-z0-9_.~-]{12,}$/;

/**
 * A link as it may be shown: scheme, host and path, with no credentials or
 * query. A path that carries something shaped like a key (a reset link, a
 * webhook address) is cut back to the site itself.
 */
export function displayUrl(value: unknown): string | undefined {
  const url = safeUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  return parsed.pathname.split('/').some((segment) => TOKEN_SEGMENT.test(segment))
    ? `${parsed.origin}/`
    : url;
}

const MEMORY_LABEL_LIMIT = 80;
const MEMORY_LABEL_COUNT = 20;
const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/** A whole JSON object or array: a tool's arguments, not something to quote. */
function isJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    return typeof JSON.parse(text) === 'object';
  } catch {
    return false;
  }
}

/**
 * One line of outside text, safe to show its owner, or nothing. Links keep only
 * their scheme, host and path; a value shaped like a credential or a whole JSON
 * record gives nothing. Model ids, tool names, paths and titles that start with
 * a bracket are ordinary text.
 */
export function toolText(value: unknown, limit: number = TOOL_QUOTE_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const flat = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat || isJson(flat) || CREDENTIAL.test(flat)) return null;
  const linked = flat.replace(/\bhttps?:\/\/\S+/gi, (match) => displayUrl(match) ?? 'a link');
  return clip(linked, limit);
}

/** What stands in for a line of an excerpt that still looked like a key after filtering. */
export const HIDDEN_LINE = HIDDEN;
const EXCERPT_LINES = 40;
/** A secret the filter already hid, with the name it was given to: `API_KEY=[hidden]`. */
const HIDDEN_SPAN = /[\w.-]*\s*[:=]?\s*\[hidden\]/g;

/**
 * Several lines of outside text, safe to show its owner: a whole command, what
 * it printed, a list of subjects. The answer filter runs over the whole of it,
 * so a secret is hidden where it stands and an internal record is taken out,
 * the words around them kept. A line that still carries something shaped like
 * a credential is replaced whole. Nothing comes back when nothing is left.
 */
export function toolExcerpt(
  value: unknown,
  from: ToolQuote['from'],
  limit: number = TOOL_EXCERPT_LIMIT,
): ToolExcerpt | undefined {
  if (typeof value !== 'string') return undefined;
  const lines = hideSecrets(
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\p{Cc}/gu, (character) =>
        character === '\n' || character === '\t' ? character : '',
      ),
  )
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\s+$/, '');
      if (!trimmed.trim()) return '';
      if (CREDENTIAL.test(trimmed.replace(HIDDEN_SPAN, ' '))) return HIDDEN_LINE;
      return trimmed.replace(/\bhttps?:\/\/\S+/gi, (match) => displayUrl(match) ?? 'a link');
    });
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  const kept = (line: string) => line.replace(HIDDEN_SPAN, '').trim().length > 0;
  if (!lines.some(kept)) return undefined;
  let more = lines.length > EXCERPT_LINES;
  let text = lines.slice(0, EXCERPT_LINES).join('\n');
  if (text.length > limit) {
    text = text.slice(0, limit - 1).trimEnd();
    more = true;
  }
  return { text, from, more };
}

const quote = (value: unknown, from: ToolQuote['from']): ToolQuote | undefined => {
  const text = toolText(value, TOOL_QUOTE_LIMIT);
  return text ? { text, from } : undefined;
};
const summary = (text: string, quoted?: ToolQuote): ToolSummary => ({
  text: clip(text, TOOL_SUMMARY_LIMIT),
  ...(quoted ? { quote: quoted } : {}),
});
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const array = (input: unknown): unknown[] => (Array.isArray(input) ? input : []);
const filename = (value: unknown) =>
  typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() : undefined;
const firstLine = (value: unknown) =>
  typeof value === 'string' ? value.split(/\r?\n/).find((line) => line.trim()) : undefined;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const addresses = (value: unknown): string[] =>
  (typeof value === 'string' ? [value] : array(value)).filter(
    (entry): entry is string => typeof entry === 'string' && EMAIL.test(entry.trim()),
  );
/** A page as a title names it: the site and its path, without the scheme. */
function pageName(value: unknown): string | null {
  const url = displayUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return clip(`${parsed.hostname.replace(/^www\./, '')}${path}`, 60);
}
/** Outside words inside a title: short, scrubbed, in quotation marks. */
const quoted = (value: unknown, limit = 60): string | null => {
  const text = toolText(
    typeof value === 'string' ? value.replace(/^["'“]+|["'”]+$/g, '') : value,
    limit,
  );
  return text ? `“${text}”` : null;
};
/** A file named in a title: its name, never its folders. */
const fileName = (value: unknown): string | null => toolText(filename(value), 60);
/** A command named in a title: its first line, in backticks. */
const commandName = (value: unknown): string | null => {
  const text = toolText(firstLine(value), 60);
  return text ? `\`${text.replaceAll('`', "'")}\`` : null;
};
const byteSize = (bytes: unknown): string | null => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const lowerFirst = (text: string) => `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}`;
/** Who a message goes to, as a title names them: the first address, and how many more. */
const recipients = (value: unknown): string | null => {
  const to = addresses(value).map((entry) => entry.trim());
  const first = to[0];
  if (!first) return null;
  return to.length > 1 ? `${first} and ${to.length - 1} more` : first;
};
const host = (value: unknown): string | undefined => {
  const url = safeUrl(value);
  return url ? new URL(url).hostname : undefined;
};
const when = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? undefined
    : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};
/** A read page names its title; a receipt from before that carries the page itself. */
const pageTitle = (detail: Record<string, unknown>) =>
  typeof detail.title === 'string' && detail.title.trim()
    ? detail.title
    : typeof detail.body === 'string'
      ? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(detail.body)?.[1]?.replace(/&amp;/g, '&')
      : undefined;

/** A stable id no longer than the contract allows, whatever the source identifiers were. */
export function toolId(prefix: string, ...parts: string[]): string {
  const raw = `${prefix}:${parts.join(':')}`;
  return raw.length <= 200 && !BACKEND_VOCABULARY.test(raw) && /^[\w:.@-]+$/.test(raw)
    ? raw
    : `${prefix}:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

// --------------------------------------------------------------------------
// Broker actions: connectors, web, files, artifacts, browser, sandbox
// --------------------------------------------------------------------------

export function actionKind(kind: string): ToolKind {
  const family = kind.split('.')[0];
  if (family === 'web') return 'web';
  if (family === 'files') return 'file';
  if (family === 'browser') return 'browser';
  // The agent's own computer: its commands and its screen.
  if (family === 'exec' || family === 'terminal' || family === 'computer') return 'sandbox';
  if (family === 'device')
    return kind === 'device.run'
      ? 'sandbox'
      : kind === 'device.open_url' || kind.startsWith('device.browser_')
        ? 'browser'
        : ['device.list_files', 'device.read_file', 'device.write_file'].includes(kind)
          ? 'file'
          : 'tool';
  if (kind === 'artifact.publish' || kind === 'audio.synthesize' || kind === 'audio.transcribe')
    return 'artifact';
  return 'connector';
}

const ACTION_STATUS: Record<string, ToolStatus> = {
  proposed: 'running',
  approved: 'running',
  admitted: 'running',
  dispatched: 'running',
  needs_approval: 'needs_approval',
  succeeded: 'done',
  failed: 'failed',
  denied: 'failed',
  unknown: 'unknown',
  unresolved: 'unknown',
};
export const actionToolStatus = (status: unknown): ToolStatus =>
  (typeof status === 'string' && ACTION_STATUS[status]) || 'running';

function actionInput(row: ActionRow): ToolSummary | null {
  const payload = object(row.canonicalPayload);
  switch (row.kind) {
    case 'email.search':
      return typeof payload.query === 'string' && payload.query.trim()
        ? summary('Looked for', quote(payload.query, 'request'))
        : summary('Recent messages');
    case 'email.draft':
    case 'email.send': {
      const to = addresses(payload.to);
      const shown = to.slice(0, 3).join(', ');
      return summary(
        to.length
          ? `To ${shown}${to.length > 3 ? ` and ${to.length - 3} more` : ''}`
          : 'To the selected recipient',
        quote(payload.subject, 'request'),
      );
    }
    case 'calendar.create':
    case 'calendar.update':
    case 'calendar.delete': {
      const start = when(payload.start);
      return summary(start ? `Starts ${start}` : 'An event', quote(payload.summary, 'request'));
    }
    case 'files.read':
    case 'files.write':
    case 'files.restore':
    case 'files.delete':
    case 'files.list':
      return payload.path === undefined
        ? null
        : summary('File', quote(filename(payload.path), 'file'));
    case 'files.move': {
      const to = toolText(filename(payload.to), 80);
      return summary(to ? `To ${to}` : 'File', quote(filename(payload.from), 'file'));
    }
    case 'web.fetch':
    case 'browser.open': {
      const site = host(payload.url);
      return site ? summary(`On ${site}`) : null;
    }
    case 'web.search':
      return typeof payload.query === 'string' && payload.query.trim()
        ? summary('Looked for', quote(payload.query, 'request'))
        : null;
    case 'exec.run':
    case 'terminal.run':
    case 'device.run':
      return summary('Command', quote(firstLine(payload.command), 'request'));
    case 'device.list_files':
    case 'device.read_file':
    case 'device.write_file':
      return payload.path === undefined
        ? null
        : summary('On your computer', quote(filename(payload.path), 'file'));
    case 'device.open_url': {
      const site = host(payload.url);
      return site ? summary(`On ${site}`) : null;
    }
    case 'exec.python':
      return summary('Python code', quote(firstLine(payload.code), 'request'));
    case 'artifact.publish':
      return summary('File', quote(filename(payload.path ?? payload.name), 'file'));
    case 'audio.synthesize':
      return summary('Spoken text', quote(payload.text, 'request'));
    case 'audio.transcribe':
      return summary('Recording', quote(filename(payload.source), 'file'));
    default:
      return null;
  }
}

/**
 * Why the broker would not let an action through, in plain words, by the
 * refusal's code. The broker's own message is written for operators and is
 * never shown.
 */
const REFUSALS: Record<string, string> = {
  scope_denied: 'A rule here does not allow this, so nothing was sent.',
  budget_exceeded: 'This would have gone over the limit for this conversation.',
  payload_invalid: 'The request was incomplete, so nothing was sent.',
  connector_unavailable: 'The app could not be reached, so nothing was sent.',
  unknown_tool: 'That tool is not available here.',
  approval_required: 'This needed your OK again, so nothing was sent.',
  approval_hash_mismatch: 'This changed after you approved it, so nothing was sent.',
};
const REFUSED = 'This was not allowed, so nothing was sent.';

/** Which way a failed action went: the person said no, a rule said no, or it went wrong. */
export function actionFailure(raw: string, refusal?: string): ToolFailure {
  if (raw === 'denied') return 'declined';
  return refusal !== undefined ? 'refused' : 'error';
}

function actionOutput(
  row: ActionRow,
  status: ToolStatus,
  raw: string,
  refusal?: string,
): ToolSummary | null {
  if (status === 'running') return null;
  if (status === 'needs_approval') return summary('Waiting for your OK');
  if (status === 'unknown')
    return summary('The app never confirmed whether this went through. Nothing was sent again.');
  if (status === 'failed') {
    const failure = actionFailure(raw, refusal);
    return summary(
      failure === 'declined'
        ? 'You declined this.'
        : failure === 'refused'
          ? (REFUSALS[refusal ?? ''] ?? REFUSED)
          : 'This did not go through.',
    );
  }
  const detail = object(object(row.receipt).detail);
  switch (row.kind) {
    case 'calendar.list': {
      const events = array(detail.events);
      return summary(
        count(events.length, 'event', 'events'),
        quote(object(events[0]).summary, 'event'),
      );
    }
    case 'email.search': {
      const messages = array(detail.messages);
      return summary(
        count(messages.length, 'message', 'messages'),
        quote(object(messages[0]).subject, 'message'),
      );
    }
    case 'email.read':
      return summary('Opened the message', quote(object(detail.message).subject, 'message'));
    case 'email.draft':
      return summary('Draft saved');
    case 'email.send':
    case 'test.send':
      return summary('Sent');
    case 'calendar.create':
      return summary('Added to your calendar');
    case 'calendar.update':
      return summary('Updated in your calendar');
    case 'calendar.delete':
      return summary('Removed from your calendar');
    case 'files.list': {
      const files = array(detail.entries).filter((entry) => object(entry).kind === 'file');
      return summary(count(files.length, 'file', 'files'));
    }
    case 'files.read':
      return summary('File read');
    case 'files.write':
      return summary('Saved');
    case 'files.move':
      return summary('Moved');
    case 'files.restore':
      return summary('Restored');
    case 'files.delete': {
      const count = typeof detail.deleted_count === 'number' ? detail.deleted_count : 1;
      return summary(
        `Deleted ${count === 1 ? 'a file' : `${count} files`}, restorable from the trash`,
      );
    }
    case 'web.fetch':
      return summary('Page read', quote(pageTitle(detail), 'page'));
    case 'web.search': {
      const results = array(detail.results);
      return summary(
        results.length ? count(results.length, 'result', 'results') : 'Nothing found',
        quote(object(results[0]).title, 'page'),
      );
    }
    case 'device.list_files':
      return summary(count(array(detail.entries).length, 'item', 'items'));
    case 'device.read_file':
      return summary('File read');
    case 'device.write_file':
      return summary('Saved');
    case 'device.open_url':
      return summary('Opened in your browser');
    case 'device.screenshot':
      return summary('Screenshot taken');
    case 'device.status':
      return summary(object(detail).online === true ? 'Connected' : 'Not connected right now');
    case 'exec.run':
    case 'exec.python':
    case 'terminal.run':
    case 'device.run': {
      // Files a command deleted lead, however the command itself ended: they
      // are in the trash, and the receipt's Undo puts them back.
      const deleted =
        typeof detail.workspace_deleted_count === 'number' ? detail.workspace_deleted_count : 0;
      const ended =
        detail.timed_out === true
          ? 'Stopped after running too long'
          : typeof detail.exit_code === 'number' && detail.exit_code !== 0
            ? `Finished with exit code ${detail.exit_code}`
            : 'Finished';
      return summary(
        deleted
          ? `Deleted ${deleted === 1 ? 'a file' : `${deleted} files`} from the workspace, restorable from the trash. ${ended}`
          : ended,
        // What a command printed is outside text; binary output is never shown.
        detail.output_binary === true ? undefined : quote(firstLine(detail.output), 'app'),
      );
    }
    case 'artifact.publish':
      return summary('Published');
    case 'audio.synthesize':
      return summary('Audio ready');
    case 'audio.transcribe':
      return summary('Transcript ready');
    default:
      return summary('Done');
  }
}

function actionDetail(
  row: ActionRow,
  status: ToolStatus,
  approvalId: string | null,
): ToolDetail | null {
  if (status === 'needs_approval' && approvalId) return { type: 'permission', id: approvalId };
  if (status !== 'done') return null;
  const detail = object(object(row.receipt).detail);
  if (typeof detail.artifact_id === 'string' && /^art_/.test(detail.artifact_id))
    return { type: 'artifact', id: detail.artifact_id };
  // The person sees every screenshot taken for them, their own computer's too.
  if (SCREENSHOT_KINDS.has(row.kind)) return { type: 'screenshot', id: row.id };
  if (row.kind === 'web.fetch') {
    const url = displayUrl(detail.final_url ?? detail.url);
    return url ? { type: 'page', id: row.id, url } : null;
  }
  if (['write_external', 'write_reversible', 'spend'].includes(row.effectClass) && row.receipt)
    return { type: 'receipt', id: row.id };
  return null;
}

/** The actions whose picture the person's trail shows (`GET /screenshots/{id}`). */
const SCREENSHOT_KINDS = new Set([
  'computer.screenshot',
  'device.screenshot',
  'device.browser_screenshot',
]);

/** How an action is named while it runs, once it is done, and when it asks first. */
type Phrase = { doing: string; done: string; ask: string };
const phrase = (doing: string, done: string): Phrase => ({ doing, done, ask: lowerFirst(doing) });
const MCP_KIND = /^mcp_[^.]+\.(.+)$/;

/**
 * The title words for an action: what it did, with what. Names, queries and
 * commands taken from the request are scrubbed like any quote; a value that
 * fails the scrub leaves the plain verb.
 */
export function actionPhrase(row: ActionRow, app: string): Phrase {
  const payload = object(row.canonicalPayload);
  const detail = object(object(row.receipt).detail);
  const verbs = ACTION_VERBS[row.kind];
  const base = verbs ? phrase(verbs[0], verbs[1]) : phrase(`Using ${app}`, `Used ${app}`);
  const page = pageName(payload.url);
  const file = fileName(payload.path ?? payload.name);
  const command = commandName(payload.command);
  switch (row.kind) {
    case 'web.fetch':
      return page ? phrase(`Reading page ${page}`, `Read page ${page}`) : base;
    case 'web.search': {
      const query = quoted(payload.query);
      return query
        ? phrase(`Searching the web for ${query}`, `Searched the web for ${query}`)
        : base;
    }
    case 'browser.open':
      return page
        ? phrase(`Opening ${page} in the browser`, `Opened ${page} in the browser`)
        : base;
    case 'computer.open':
      if (detail.navigated === false)
        return page
          ? phrase(
              `Opening ${page} in its computer`,
              `Tried to open ${page} in its computer; the window did not change`,
            )
          : phrase('Opening a page in its computer', NOT_OPENED);
      return page
        ? phrase(`Opening ${page} in its computer`, `Opened ${page} in its computer`)
        : phrase('Opening a page in its computer', 'Opened a page in its computer');
    case 'computer.screenshot':
      return phrase('Looking at the screen of its computer', 'Took a screenshot of its computer');
    case 'computer.click':
      return phrase('Clicking in its computer', 'Clicked in its computer');
    case 'computer.type':
      // What was typed can be anything, a password included; it is never named.
      return phrase('Typing in its computer', 'Typed in its computer');
    case 'computer.key': {
      const keys = array(payload.keys)
        .flatMap((key) => toolText(key, 20) ?? [])
        .join('+');
      return keys
        ? phrase(`Pressing ${keys} in its computer`, `Pressed ${keys} in its computer`)
        : phrase('Pressing a key in its computer', 'Pressed a key in its computer');
    }
    case 'computer.scroll':
      return phrase('Scrolling in its computer', 'Scrolled in its computer');
    case 'exec.run':
    case 'terminal.run':
      return command
        ? phrase(`Running ${command} in its computer`, `Ran ${command} in its computer`)
        : phrase('Running a command in its computer', 'Ran a command in its computer');
    case 'exec.python':
      return phrase('Running Python code in its computer', 'Ran Python code in its computer');
    case 'device.run':
      return command
        ? phrase(`Running ${command} on your computer`, `Ran ${command} on your computer`)
        : base;
    case 'device.read_file':
      return file
        ? phrase(`Reading ${file} on your computer`, `Read ${file} on your computer`)
        : base;
    case 'device.write_file':
      return file
        ? phrase(`Saving ${file} on your computer`, `Saved ${file} on your computer`)
        : base;
    case 'device.open_url':
      return page
        ? phrase(`Opening ${page} on your computer`, `Opened ${page} on your computer`)
        : base;
    case 'device.browser_open':
      return page
        ? phrase(`Opening ${page} in your browser`, `Opened ${page} in your browser`)
        : base;
    case 'files.read':
      return file ? phrase(`Reading ${file}`, `Read ${file}`) : base;
    case 'files.write': {
      if (!file) return base;
      const size = byteSize(
        typeof detail.bytes === 'number'
          ? detail.bytes
          : typeof payload.content === 'string'
            ? Buffer.byteLength(payload.content, 'utf8')
            : undefined,
      );
      return phrase(`Writing ${file}`, `Wrote ${file}${size ? ` (${size})` : ''}`);
    }
    case 'files.list':
      return file ? phrase(`Looking through ${file}`, `Looked through ${file}`) : base;
    case 'files.move': {
      const from = fileName(payload.from);
      return from ? phrase(`Moving ${from}`, `Moved ${from}`) : base;
    }
    case 'files.restore':
      return file ? phrase(`Restoring ${file}`, `Restored ${file}`) : base;
    case 'files.delete':
      return file ? phrase(`Deleting ${file}`, `Deleted ${file}`) : base;
    case 'email.search': {
      const query = quoted(payload.query);
      const messages = array(detail.messages).length;
      const doing = query ? `Searching your inbox for ${query}` : 'Checking your inbox';
      if (!row.receipt) return phrase(doing, 'Searched your inbox');
      return phrase(
        doing,
        messages
          ? `Read ${count(messages, 'email', 'emails')} from your inbox`
          : `Found no emails${query ? ` for ${query}` : ''}`,
      );
    }
    case 'email.read':
      return phrase('Reading an email', 'Read an email');
    case 'email.draft':
    case 'email.send': {
      const to = recipients(payload.to);
      const draft = row.kind === 'email.draft';
      if (!to) return base;
      return draft
        ? phrase(`Drafting an email to ${to}`, `Drafted an email to ${to}`)
        : phrase(`Sending an email to ${to}`, `Sent an email to ${to}`);
    }
    case 'calendar.list': {
      if (!row.receipt) return base;
      const events = array(detail.events).length;
      return phrase(base.doing, `Checked your calendar: ${count(events, 'event', 'events')}`);
    }
    case 'calendar.create':
    case 'calendar.update':
    case 'calendar.delete': {
      const event = quoted(payload.summary);
      if (!event) return base;
      if (row.kind === 'calendar.create')
        return phrase(`Adding ${event} to your calendar`, `Added ${event} to your calendar`);
      if (row.kind === 'calendar.update')
        return phrase(`Updating ${event} in your calendar`, `Updated ${event} in your calendar`);
      return phrase(`Removing ${event} from your calendar`, `Removed ${event} from your calendar`);
    }
    case 'artifact.publish':
      return file ? phrase(`Publishing ${file}`, `Published ${file}`) : base;
    case 'apps.publish': {
      const app = quoted(payload.name);
      return app ? phrase(`Publishing the app ${app}`, `Published the app ${app}`) : base;
    }
    case 'apps.read_submissions': {
      if (!row.receipt) return base;
      const app = quoted(detail.name);
      const read = count(array(detail.submissions).length, 'response', 'responses');
      return app ? phrase(base.doing, `Read ${read} to ${app}`) : base;
    }
    default: {
      // A tool from an installed server: the server's name, then the tool's.
      const tool = MCP_KIND.exec(row.kind)?.[1];
      const words = tool ? toolText(tool.replace(/[_-]+/g, ' ').trim(), 40) : null;
      return words ? phrase(`Using ${app} → ${words}`, `Used ${app} → ${words}`) : base;
    }
  }
}

/** The fuller input and output a row shows when it is opened. */
function actionExcerpts(
  row: ActionRow,
  status: ToolStatus,
): { input_excerpt?: ToolExcerpt; output_excerpt?: ToolExcerpt } {
  const payload = object(row.canonicalPayload);
  const detail = object(object(row.receipt).detail);
  const done = status === 'done';
  const printed =
    done && detail.output_binary !== true ? toolExcerpt(detail.output, 'app') : undefined;
  const pick = (input?: ToolExcerpt, output?: ToolExcerpt) => ({
    ...(input ? { input_excerpt: input } : {}),
    ...(output ? { output_excerpt: output } : {}),
  });
  switch (row.kind) {
    case 'exec.run':
    case 'terminal.run':
    case 'device.run':
      return pick(toolExcerpt(payload.command, 'request'), printed);
    case 'exec.python':
      return pick(toolExcerpt(payload.code, 'request'), printed);
    // A message body or a file's contents stays out of the activity: the draft,
    // the permission card and the file itself are where those are read.
    case 'email.search':
      return pick(
        undefined,
        done
          ? toolExcerpt(
              array(detail.messages)
                .flatMap((message) => toolText(object(message).subject, 120) ?? [])
                .join('\n'),
              'message',
            )
          : undefined,
      );
    case 'calendar.list':
      return pick(
        undefined,
        done
          ? toolExcerpt(
              array(detail.events)
                .flatMap((event) => toolText(object(event).summary, 120) ?? [])
                .join('\n'),
              'event',
            )
          : undefined,
      );
    default:
      return {};
  }
}

/** An action as it stood when `raw` became its status, observed at `at`. */
export function actionCall(input: {
  action: ActionRow;
  connection: ConnectionRow;
  raw: string;
  at: Date;
  approvalId?: string | null;
  /** The broker's refusal code, when it would not let the action through. */
  refusal?: string;
}): ToolCall {
  const { action: row, connection } = input;
  const status = actionToolStatus(input.raw);
  const app = plainText(connection.label, appName(connection), 60);
  const words = actionPhrase(row, app);
  const title =
    status === 'done'
      ? words.done
      : status === 'needs_approval'
        ? `Proposed ${words.ask} — waiting for you`
        : words.doing;
  return toolCall.parse({
    id: toolId('action', row.id),
    kind: actionKind(row.kind),
    title: clip(title, TOOL_TITLE_LIMIT),
    status,
    started_at: row.createdAt.toISOString(),
    ended_at: ['done', 'failed', 'unknown'].includes(status) ? input.at.toISOString() : null,
    input_summary: actionInput(row),
    output_summary: actionOutput(row, status, input.raw, input.refusal),
    detail: actionDetail(row, status, input.approvalId ?? null),
    parent: null,
    ...actionExcerpts(row, status),
    ...(status === 'failed' ? { failure: actionFailure(input.raw, input.refusal) } : {}),
  });
}

/**
 * An action for the person's own computer is waiting for that computer to
 * connect. It says what it will do, and goes by itself when the computer is
 * back; stopping the conversation cancels it.
 */
export function deviceWaitCall(input: {
  action: ActionRow;
  connection: ConnectionRow;
  key: string;
  at: Date;
}): ToolCall {
  const [doing] = ACTION_VERBS[input.action.kind] ?? ['Using your computer'];
  const computer = plainText(input.connection.label, 'your computer', 60);
  const browser = input.action.kind.startsWith('device.browser_');
  return toolCall.parse({
    id: toolId('wait', input.key),
    kind: 'retry',
    title: clip(
      browser ? `Waiting for your browser on ${computer}` : `Waiting for ${computer}`,
      TOOL_TITLE_LIMIT,
    ),
    status: 'done',
    started_at: input.at.toISOString(),
    ended_at: input.at.toISOString(),
    input_summary: actionInput(input.action),
    output_summary: summary(
      clip(`${doing} as soon as it connects. Stop the conversation to cancel.`, TOOL_SUMMARY_LIMIT),
    ),
    detail: null,
    parent: toolId('action', input.action.id),
  });
}

/** A rate limit or a transient failure put the action back to wait for another try. */
export function retryCall(parentId: string, key: string, at: Date): ToolCall {
  return toolCall.parse({
    id: toolId('retry', key),
    kind: 'retry',
    title: 'Scheduled another try',
    status: 'done',
    started_at: at.toISOString(),
    ended_at: at.toISOString(),
    input_summary: null,
    output_summary: summary('The app asked to wait. The same request goes again shortly.'),
    detail: null,
    parent: parentId,
  });
}

// --------------------------------------------------------------------------
// Runtime tool events: skills and the tools a runtime runs itself
// --------------------------------------------------------------------------

/** Plumbing, or already told another way: the model speaking, a glyph, loading a tool. */
const UNSHOWN = new Set([
  'say',
  'react',
  'search_tools',
  'load_tool',
  'resume_action',
  // A question for the person is its own card in the conversation.
  'ask_person',
  // In a cell every terminal command and poll is one broker `terminal.run` action,
  // which carries the command and its receipt.
  'terminal',
  'process',
  // Reading a skill from the index; the broker's own entry names the skill that was read.
  'skills.read',
]);
const NATIVE: Record<string, [ToolKind, doing: string, done: string]> = {
  compose: ['tool', 'Working through several steps', 'Worked through several steps'],
  'job.wait': ['tool', 'Scheduling a follow-up', 'Scheduled a follow-up'],
  'run.start': ['tool', 'Starting work in the background', 'Started work in the background'],
  'run.list': [
    'tool',
    'Looking through your background work',
    'Looked through your background work',
  ],
  'run.pause': ['tool', 'Pausing background work', 'Paused background work'],
  'run.resume': ['tool', 'Resuming background work', 'Resumed background work'],
  'run.stop': ['tool', 'Stopping background work', 'Stopped background work'],
  'run.log': ['tool', 'Noting progress', 'Noted progress'],
  'run.try': ['sandbox', 'Trying something and measuring it', 'Tried something and measured it'],
  'run.delegate': ['tool', 'Handing part to a helper', 'Handed part to a helper'],
  'run.checkpoint': ['tool', 'Saving where it got to', 'Saved where it got to'],
  'run.finish': ['tool', 'Wrapping up', 'Wrapped up'],
  web_search: ['web', 'Searching the web', 'Searched the web'],
  web_extract: ['web', 'Reading a web page', 'Read a web page'],
  execute_code: ['sandbox', 'Running code', 'Ran code'],
  read_file: ['file', 'Reading a file', 'Read a file'],
  write_file: ['file', 'Saving a file', 'Saved a file'],
  patch: ['file', 'Editing a file', 'Edited a file'],
  search_files: ['file', 'Searching files', 'Searched files'],
  memory: ['memory_write', 'Updating what I remember', 'Updated what I remember'],
  skill_view: ['skill', 'Opening a skill', 'Opened a skill'],
  skills_list: ['skill', 'Looking through skills', 'Looked through skills'],
  vision_analyze: ['tool', 'Looking at an image', 'Looked at an image'],
  text_to_speech: ['artifact', 'Making audio', 'Made audio'],
  delegate_task: ['tool', 'Handing off a smaller task', 'Handed off a smaller task'],
};

/** How a runtime-named tool is shown, or null when another record already shows it. */
export function runtimeTool(name: string): { kind: ToolKind; doing: string; done: string } | null {
  if (UNSHOWN.has(name)) return null;
  const native = NATIVE[name];
  if (native) return { kind: native[0], doing: native[1], done: native[2] };
  if (name.startsWith('skills.')) {
    const words = name.slice('skills.'.length).replace(/[_-]+/g, ' ').trim();
    const title = words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : 'a skill';
    return {
      kind: 'skill',
      doing: `Using the skill: ${title}`,
      done: `Used the skill: ${title}`,
    };
  }
  // A dotted name is a connector verb served by the broker, whose action
  // record carries the real inputs, approvals and receipt.
  if (name.includes('.')) return null;
  if (name.startsWith('browser_'))
    return { kind: 'browser', doing: 'Using the browser', done: 'Used the browser' };
  return { kind: 'tool', doing: 'Using a tool', done: 'Used a tool' };
}

/**
 * A runtime tool's title with what it was given, from the one-line preview the
 * runtime sends with each call. Null leaves the tool's plain verbs.
 */
export function runtimePhrase(
  name: string,
  preview: unknown,
): { doing: string; done: string } | null {
  const text = typeof preview === 'string' ? preview.trim() : '';
  const query = quoted(text);
  const file = fileName(text);
  const links = text.match(/\bhttps?:\/\/\S+/gi) ?? [];
  switch (name) {
    case 'web_search':
      return query
        ? { doing: `Searching the web for ${query}`, done: `Searched the web for ${query}` }
        : null;
    case 'web_extract': {
      if (links.length > 1)
        return {
          doing: `Reading ${links.length} pages`,
          done: `Read ${links.length} pages`,
        };
      const page = pageName(links[0] ?? text);
      return page ? { doing: `Reading page ${page}`, done: `Read page ${page}` } : null;
    }
    case 'read_file':
      return file ? { doing: `Reading ${file}`, done: `Read ${file}` } : null;
    case 'write_file':
      return file ? { doing: `Writing ${file}`, done: `Wrote ${file}` } : null;
    case 'patch':
      return file ? { doing: `Editing ${file}`, done: `Edited ${file}` } : null;
    case 'search_files':
      return query
        ? { doing: `Searching files for ${query}`, done: `Searched files for ${query}` }
        : null;
    case 'skill_view':
      return query
        ? { doing: `Opening the skill ${query}`, done: `Opened the skill ${query}` }
        : null;
    default: {
      if (NATIVE[name] || name.startsWith('skills.') || name.startsWith('browser_')) return null;
      // A tool with no words of its own is named by its name, made readable.
      const words = /^[a-z][a-z0-9_-]{1,60}$/i.test(name)
        ? toolText(name.replace(/[_-]+/g, ' ').trim(), 40)
        : null;
      return words
        ? { doing: `Using the tool “${words}”`, done: `Used the tool “${words}”` }
        : null;
    }
  }
}

/** Why a web search was held back, in the row's words and in its receipt's. */
const HELD_SEARCH: { reason: string; title: string; why: string }[] = [
  {
    reason: SEARCH_KEPT_PRIVATE,
    title: 'Search held back: this chat is private',
    why: 'Nothing was sent to a search service, because this conversation is private.',
  },
  {
    reason: SEARCH_KEPT_TOPIC,
    title: 'Search held back: it was about a private topic',
    why: 'Nothing was sent to a search service, because the search was about a topic kept private here.',
  },
  {
    reason: SEARCH_KEPT_DETAILS,
    title: 'Search held back: it named something private',
    why: 'Nothing was sent to a search service, because the search carried a personal detail your privacy settings keep from outside services.',
  },
];

/**
 * A web search refused before it left. Nothing is recorded as tried, so this
 * entry is the only sign of it: a quiet row saying it was held back, and why.
 * The query is not repeated, since it is what was held back.
 */
export function heldSearchCall(input: {
  attemptId: string;
  /** The words the model searched for; only their hash names the entry. */
  query: string;
  reason: string;
  at: Date;
}): ToolCall {
  const known = HELD_SEARCH.find((entry) => entry.reason === input.reason);
  const reason = plainText(input.reason, '', TOOL_SUMMARY_LIMIT);
  const at = input.at.toISOString();
  return toolCall.parse({
    id: toolId(
      'held-search',
      input.attemptId,
      createHash('sha256').update(input.query).digest('hex').slice(0, 16),
    ),
    kind: 'web',
    title: known?.title ?? 'Search held back',
    status: 'done',
    started_at: at,
    ended_at: at,
    input_summary: null,
    output_summary: summary(
      known?.why ??
        (reason
          ? `Nothing was sent to a search service. ${reason}`
          : 'Nothing was sent to a search service.'),
    ),
    detail: null,
    parent: null,
  });
}

export function runtimeCall(input: {
  attemptId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  proposedAt: Date;
  result?: { ok: boolean; at: Date };
}): ToolCall | null {
  const shown = runtimeTool(input.tool);
  if (!shown) return null;
  const status: ToolStatus = !input.result ? 'running' : input.result.ok ? 'done' : 'failed';
  const args = object(input.arguments);
  const asked = quote(args.preview, 'request');
  const words = runtimePhrase(input.tool, args.preview) ?? shown;
  return toolCall.parse({
    id: toolId('call', input.attemptId, input.callId),
    kind: shown.kind,
    title: clip(status === 'done' ? words.done : words.doing, TOOL_TITLE_LIMIT),
    ...(status === 'failed' ? { failure: 'error' } : {}),
    status,
    started_at: input.proposedAt.toISOString(),
    ended_at: input.result ? input.result.at.toISOString() : null,
    input_summary: asked ? summary('Asked for', asked) : null,
    output_summary:
      status === 'done'
        ? summary('Done')
        : status === 'failed'
          ? summary('This did not work.')
          : null,
    detail: null,
    parent: null,
  });
}

// --------------------------------------------------------------------------
// Model calls through the gateway
// --------------------------------------------------------------------------

export function modelCall(input: {
  reservationId: string;
  requestedAt: Date;
  receipt?: { status: unknown; latencyMs: unknown; at: Date; stopped?: boolean };
}): ToolCall {
  const settled = input.receipt;
  // A call cut off by Stop ended as asked: it is finished, not failed.
  const stopped = settled?.stopped === true && settled.status !== 'succeeded';
  const status: ToolStatus = !settled
    ? 'running'
    : settled.status === 'succeeded' || stopped
      ? 'done'
      : settled.status === 'failed'
        ? 'failed'
        : 'unknown';
  const seconds =
    typeof settled?.latencyMs === 'number' && Number.isFinite(settled.latencyMs)
      ? Math.max(0.1, Math.round(settled.latencyMs / 100) / 10)
      : null;
  return toolCall.parse({
    id: toolId('model', input.reservationId),
    kind: 'model',
    title: stopped ? 'Stopped' : status === 'done' ? 'Thought it through' : 'Thinking',
    status,
    started_at: input.requestedAt.toISOString(),
    ended_at: settled ? settled.at.toISOString() : null,
    input_summary: null,
    output_summary: stopped
      ? summary('Stopped when you asked.')
      : status === 'done'
        ? summary(seconds === null ? 'Answered' : `Answered in ${seconds} s`)
        : status === 'failed'
          ? summary('No answer came back.')
          : status === 'unknown'
            ? summary('It is unclear whether an answer came back.')
            : null,
    detail: null,
    parent: null,
  });
}

// --------------------------------------------------------------------------
// Traces other subsystems append, and memory recall
// --------------------------------------------------------------------------

/**
 * Re-scrub a trace another subsystem wrote. The writer is trusted to describe
 * its own work, not to have kept outside text out of it, so every string is
 * held to the same bar as the projections above.
 */
export function traceCall(raw: unknown): ToolCall | null {
  const parsed = toolCall.safeParse(raw);
  if (!parsed.success) return null;
  const call = parsed.data;
  const clean = (value: ToolSummary | null): ToolSummary | null => {
    if (!value) return null;
    const text = toolText(value.text, TOOL_SUMMARY_LIMIT);
    if (!text) return null;
    const quoted = value.quote ? quote(value.quote.text, value.quote.from) : undefined;
    return summary(text, quoted);
  };
  const url = call.detail?.url ? displayUrl(call.detail.url) : undefined;
  const { input_excerpt, output_excerpt, ...rest } = call;
  const input = input_excerpt ? toolExcerpt(input_excerpt.text, input_excerpt.from) : undefined;
  const output = output_excerpt ? toolExcerpt(output_excerpt.text, output_excerpt.from) : undefined;
  return toolCall.parse({
    ...rest,
    ...(input ? { input_excerpt: input } : {}),
    ...(output ? { output_excerpt: output } : {}),
    id: toolId('trace', call.id),
    // A parent names an entry as shown, such as `action:<action id>` or `trace:<id>`.
    parent: call.parent,
    title: toolText(call.title, TOOL_TITLE_LIMIT) ?? 'Used a tool',
    input_summary: clean(call.input_summary),
    output_summary: clean(call.output_summary),
    detail: call.detail
      ? { type: call.detail.type, id: call.detail.id, ...(url ? { url } : {}) }
      : null,
  });
}

/**
 * One write per job, entry, status and content. The same write retried lands
 * once; a status revisited with different content, or an id another job also
 * uses, is a write of its own.
 */
const traceKey = (prefix: string, jobId: string, id: string, status: string, value: unknown) =>
  `${prefix}:${jobId}:${createHash('sha256')
    .update(JSON.stringify([id, status, value]))
    .digest('hex')
    .slice(0, 32)}`;

/**
 * Record work as a tool entry on the job's stream. Call it inside the
 * transaction that records the work, or in a short transaction right after it
 * commits when that transaction holds a lock taken before the job's (memory's
 * space lock). A retried write lands once.
 */
export async function appendToolTrace(
  tx: Query,
  jobId: string,
  attemptId: string | null,
  call: ToolCall,
): Promise<void> {
  const value = toolCall.parse(call);
  await appendEvent(
    tx,
    jobId,
    attemptId,
    'notice',
    { kind: TOOL_TRACE_NOTICE, call: value },
    traceKey('tool', jobId, value.id, value.status, value),
  );
}

/** Record what memory did, the same way. See `memoryToolNotice` for what may be named. */
export async function appendMemoryTool(
  tx: Query,
  jobId: string,
  attemptId: string | null,
  notice: Omit<MemoryToolNotice, 'kind'>,
): Promise<void> {
  // A key label can be longer than the contract's bound, and a recall can
  // touch more details than it names; the entry keeps the count either way.
  const labels = notice.labels
    .map((label) => clip(label.trim(), MEMORY_LABEL_LIMIT))
    .filter((label) => label.length > 0)
    .slice(0, MEMORY_LABEL_COUNT);
  const value = memoryToolNotice.parse({
    ...notice,
    labels,
    value: notice.value?.trim() ? clip(notice.value.trim(), TOOL_QUOTE_LIMIT) : null,
    kind: MEMORY_TOOL_NOTICE,
  });
  await appendEvent(
    tx,
    jobId,
    attemptId,
    'notice',
    value,
    traceKey('memory-tool', jobId, value.id, value.status, value),
  );
}

const MEMORY_TITLES: Record<MemoryToolNotice['op'], [ToolKind, string, string]> = {
  recall: ['memory_recall', 'Used what you told me', 'Checking what I remember'],
  write: ['memory_write', 'Remembered', 'Remembering'],
  correct: ['memory_correct', 'Updated', 'Updating what I remember'],
  forget: ['memory_forget', 'Forgot', 'Forgetting'],
};

/** A memory notice as a tool entry. Labels are re-scrubbed; values stay quotations. */
export function memoryCall(raw: unknown): ToolCall | null {
  const parsed = memoryToolNotice.safeParse(raw);
  if (!parsed.success) return null;
  const notice = parsed.data;
  const [kind, done, doing] = MEMORY_TITLES[notice.op];
  const labels = [...new Set(notice.labels.flatMap((label) => toolText(label, 40) ?? []))];
  const named = labels.slice(0, 3);
  const more = Math.max(0, notice.count - named.length);
  const list = named.length ? `${named.join(', ')}${more ? ` and ${more} more` : ''}` : '';
  const finished = notice.status === 'done';
  const title = finished
    ? list
      ? `${done}: ${list}`
      : notice.op === 'recall'
        ? `Used ${count(notice.count, 'thing', 'things')} you told me`
        : `${done} ${count(Math.max(1, notice.count), 'detail', 'details')}`
    : doing;
  return toolCall.parse({
    id: toolId('memory', notice.id),
    kind,
    title: clip(title, TOOL_TITLE_LIMIT),
    status: notice.status,
    started_at: notice.started_at,
    ended_at: notice.ended_at,
    input_summary: null,
    output_summary: finished
      ? summary(
          notice.op === 'recall'
            ? count(notice.count, 'saved detail', 'saved details')
            : notice.op === 'forget'
              ? 'No longer used'
              : 'Saved',
          notice.op === 'forget' ? undefined : quote(notice.value, 'message'),
        )
      : notice.status === 'failed'
        ? summary('Memory could not be changed this time.')
        : null,
    detail:
      notice.memory_item_id && notice.op !== 'forget'
        ? { type: 'memory', id: notice.memory_item_id }
        : null,
    parent: notice.parent,
    ...(notice.status === 'failed' ? { failure: 'error' } : {}),
  });
}
