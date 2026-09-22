/**
 * Every piece of work the service does for a person, told as a tool entry in
 * the conversation. The sources are the durable records the work already
 * leaves (broker actions, runtime tool events, gateway receipts, memory
 * contexts); nothing here decides anything, it only describes.
 *
 * Summaries are held to one rule: the service's own words go in `text`, and
 * anything read from outside (a page, a message, a file name, what the model
 * asked a tool) goes in `quote`, scrubbed and clipped. A value that looks like
 * a credential is dropped rather than shortened.
 */
import { createHash } from 'node:crypto';
import {
  MEMORY_TOOL_NOTICE,
  type MemoryToolNotice,
  memoryToolNotice,
  TOOL_QUOTE_LIMIT,
  TOOL_SUMMARY_LIMIT,
  TOOL_TITLE_LIMIT,
  TOOL_TRACE_NOTICE,
  type ToolCall,
  type ToolDetail,
  type ToolKind,
  type ToolQuote,
  type ToolStatus,
  type ToolSummary,
  toolCall,
} from '@melete/contracts';
import { appendEvent, type Query } from '../broker/records.ts';
import {
  ACTION_VERBS,
  type ActionRow,
  appName,
  BACKEND_VOCABULARY,
  type ConnectionRow,
  object,
  plainText,
  safeUrl,
} from './projectors.ts';

const CREDENTIAL =
  /\bBearer\s+\S|\bsk-[A-Za-z0-9_-]{8,}|\bgh[opsu]_[A-Za-z0-9]{8,}|\bgithub_pat_|\bxox[abprs]-|\bAKIA[0-9A-Z]{12}|\bAIza[0-9A-Za-z_-]{20}|\beyJ[A-Za-z0-9_-]{8,}\.|sealed-box-v1:|-----BEGIN|\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]|[A-Za-z0-9+/_-]{40,}/i;

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * One line of outside text, safe to show its owner, or nothing. Links keep only
 * their scheme, host and path; anything shaped like a credential or an internal
 * record discards the whole value.
 */
export function toolText(value: unknown, limit: number = TOOL_QUOTE_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const flat = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat || /^[[{]/.test(flat) || CREDENTIAL.test(flat) || BACKEND_VOCABULARY.test(flat))
    return null;
  const linked = flat.replace(/\bhttps?:\/\/\S+/gi, (match) => safeUrl(match) ?? 'a link');
  return clip(linked, limit);
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
const pageTitle = (value: unknown) =>
  typeof value === 'string'
    ? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(value)?.[1]?.replace(/&amp;/g, '&')
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
  if (family === 'exec') return 'sandbox';
  if (kind === 'artifact.publish' || kind === 'audio.synthesize') return 'artifact';
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
    case 'exec.run':
      return summary('Command', quote(firstLine(payload.command), 'request'));
    case 'exec.python':
      return summary('Python code', quote(firstLine(payload.code), 'request'));
    case 'artifact.publish':
      return summary('File', quote(filename(payload.path ?? payload.name), 'file'));
    case 'audio.synthesize':
      return summary('Spoken text', quote(payload.text, 'request'));
    default:
      return null;
  }
}

function actionOutput(row: ActionRow, status: ToolStatus, raw: string): ToolSummary | null {
  if (status === 'running') return null;
  if (status === 'needs_approval') return summary('Waiting for your OK');
  if (status === 'unknown')
    return summary('The app never confirmed whether this went through. Nothing was sent again.');
  if (status === 'failed')
    return summary(raw === 'denied' ? 'You declined this.' : 'This did not go through.');
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
    case 'web.fetch':
      return summary('Page read', quote(pageTitle(detail.body), 'page'));
    case 'exec.run':
    case 'exec.python':
      return summary(
        detail.timed_out === true
          ? 'Stopped after running too long'
          : typeof detail.exit_code === 'number' && detail.exit_code !== 0
            ? `Finished with exit code ${detail.exit_code}`
            : 'Finished',
      );
    case 'artifact.publish':
      return summary('Published');
    case 'audio.synthesize':
      return summary('Audio ready');
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
  if (row.kind === 'web.fetch') {
    const url = safeUrl(detail.final_url ?? detail.url);
    return url ? { type: 'page', id: row.id, url } : null;
  }
  if (['write_external', 'write_reversible', 'spend'].includes(row.effectClass) && row.receipt)
    return { type: 'receipt', id: row.id };
  return null;
}

/** An action as it stood when `raw` became its status, observed at `at`. */
export function actionCall(input: {
  action: ActionRow;
  connection: ConnectionRow;
  raw: string;
  at: Date;
  approvalId?: string | null;
}): ToolCall {
  const { action: row, connection } = input;
  const status = actionToolStatus(input.raw);
  const app = plainText(connection.label, appName(connection), 60);
  const [doing, done] = ACTION_VERBS[row.kind] ?? [`Using ${app}`, `Used ${app}`];
  return toolCall.parse({
    id: toolId('action', row.id),
    kind: actionKind(row.kind),
    title: clip(status === 'done' ? done : doing, TOOL_TITLE_LIMIT),
    status,
    started_at: row.createdAt.toISOString(),
    ended_at: ['done', 'failed', 'unknown'].includes(status) ? input.at.toISOString() : null,
    input_summary: actionInput(row),
    output_summary: actionOutput(row, status, input.raw),
    detail: actionDetail(row, status, input.approvalId ?? null),
    parent: null,
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
const UNSHOWN = new Set(['say', 'react', 'search_tools', 'load_tool', 'resume_action']);
const NATIVE: Record<string, [ToolKind, doing: string, done: string]> = {
  compose: ['tool', 'Working through several steps', 'Worked through several steps'],
  'job.wait': ['tool', 'Scheduling a follow-up', 'Scheduled a follow-up'],
  web_search: ['web', 'Searching the web', 'Searched the web'],
  web_extract: ['web', 'Reading a web page', 'Read a web page'],
  terminal: ['sandbox', 'Running a command', 'Ran a command'],
  execute_code: ['sandbox', 'Running code', 'Ran code'],
  process: ['sandbox', 'Checking a running command', 'Checked a running command'],
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
  return toolCall.parse({
    id: toolId('call', input.attemptId, input.callId),
    kind: shown.kind,
    title: clip(status === 'done' ? shown.done : shown.doing, TOOL_TITLE_LIMIT),
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
  receipt?: { status: unknown; latencyMs: unknown; at: Date };
}): ToolCall {
  const settled = input.receipt;
  const status: ToolStatus = !settled
    ? 'running'
    : settled.status === 'succeeded'
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
    title: status === 'done' ? 'Thought it through' : 'Thinking',
    status,
    started_at: input.requestedAt.toISOString(),
    ended_at: settled ? settled.at.toISOString() : null,
    input_summary: null,
    output_summary:
      status === 'done'
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
  const url = call.detail?.url ? safeUrl(call.detail.url) : undefined;
  return toolCall.parse({
    ...call,
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
 * Record work as a tool entry on the job's stream. Call it inside the
 * transaction that records the work itself, so the entry exists exactly when
 * the work does; a retried write lands once.
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
    `tool:${value.id}:${value.status}`,
  );
}

/** Record what memory did, the same way. See `memoryToolNotice` for what may be named. */
export async function appendMemoryTool(
  tx: Query,
  jobId: string,
  attemptId: string | null,
  notice: Omit<MemoryToolNotice, 'kind'>,
): Promise<void> {
  const value = memoryToolNotice.parse({ ...notice, kind: MEMORY_TOOL_NOTICE });
  await appendEvent(
    tx,
    jobId,
    attemptId,
    'notice',
    value,
    `memory-tool:${value.id}:${value.status}`,
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
  });
}
