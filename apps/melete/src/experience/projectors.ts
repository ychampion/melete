import { createHash } from 'node:crypto';
import {
  type ActionReview,
  type BecauseLink,
  DEVICE_LIMITS,
  type ExperienceDecision,
  type ExperienceDraft,
  type ExperienceSource,
  experienceDecision,
  experienceDraft,
  experienceReceipt,
  handOff,
  mcpCatalogEntry,
  PERMISSION_FILE_PREVIEW_CHARS,
  type PermissionCard,
  permissionCard,
  type ResultCard,
  resultCard,
  type TrailStep,
} from '@melete/contracts';
import { mimeForName, savedFile, shownInPlace } from '../artifact/shown.ts';
import type { action, artifact, connection } from '../db/schema.ts';
import { namesLocalNetwork } from '../devices/paths.ts';
import { isEgressTool } from '../egress/adapters/types.ts';
import { ENDED_NOTE, OUTDATED_NOTE } from '../jobs/withdraw.ts';
import { answerText, hideSecrets, isInternalRecord } from './answer-filter.ts';

export type ActionRow = Pick<
  typeof action.$inferSelect,
  | 'id'
  | 'jobId'
  | 'attemptId'
  | 'connectionId'
  | 'kind'
  | 'effectClass'
  | 'canonicalPayload'
  | 'receipt'
  | 'status'
  | 'createdAt'
  | 'resolvedAt'
>;
export type ConnectionRow = Pick<typeof connection.$inferSelect, 'id' | 'label' | 'provider'> &
  Partial<Pick<typeof connection.$inferSelect, 'configuration'>>;
export const object = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
const array = (input: unknown): unknown[] => (Array.isArray(input) ? input : []);
/**
 * Words only an internal record carries: a tool's name, a field of an action
 * record or a credential, or a model's id. Projections the service writes
 * itself are checked against it; text a person or a model wrote is filtered
 * by `answerText`, where these words are ordinary prose.
 */
export const BACKEND_VOCABULARY =
  /(?<![\w@.-])(?:email|calendar|files|web|test)\.(?:search|read|draft|send|discard|list|create|update|delete|write|move|restore|share|fetch|echo|inspect)(?:_[a-z]+)*(?![\w-]|\.[a-z])|\b(?:canonical_payload|payload_hash|tool_call|model_actual|access_token|refresh_token|chain.of.thought)\b|(?<![@.])\b(?:gpt-|claude-|deepseek-)[\w.-]*/i;

/**
 * Titles and labels are content, never a channel for an internal record or
 * credential: a whole record gives the fallback, a credential is hidden where
 * it stands, and everything else is kept.
 */
export function plainText(value: unknown, fallback: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim() || isInternalRecord(value)) return fallback;
  const text = hideSecrets(value)
    .replace(/\p{Cc}/gu, (character) => (['\n', '\r', '\t'].includes(character) ? character : ''))
    .trim()
    .slice(0, limit);
  return text || fallback;
}
export { answerText };
/**
 * A link that may be shown: web only, query and fragment cut, and none at all
 * when its address carries a credential or it is a sign-in callback carrying
 * an access token.
 */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[?&#](?:access|refresh|id)_token=/i.test(value))
    return undefined;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return undefined;
    parsed.search = '';
    parsed.hash = '';
    if (hideSecrets(parsed.href) !== parsed.href) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}
export function appName(row: ConnectionRow): string {
  const names: Record<string, string> = {
    caldav: 'Calendar',
    imap: 'Mail',
    drive: 'Drive',
    files: 'Files',
    web: 'Web',
    test: 'Test connection',
    device: 'Computer',
    sandbox: 'Computer',
  };
  if (row.provider === 'generation')
    return row.configuration?.builtin === 'transcription' ? 'Transcription' : 'Speech';
  // An app connected from the catalog is shown as that app.
  const catalog = catalogId(row);
  if (catalog) return mcpCatalogEntry(catalog)?.title ?? 'Connected app';
  return names[row.provider] ?? 'Connected app';
}

/** The catalog entry an MCP connection was made from, when it was. */
export function catalogId(row: ConnectionRow): string | undefined {
  const value = row.configuration?.catalog;
  return row.provider === 'mcp' && typeof value === 'string' ? value : undefined;
}
const LABELS: Record<string, string> = {
  'calendar.list': 'Checked your calendar',
  'calendar.freebusy': 'Checked when you are free',
  'calendar.create': 'Created an event',
  'calendar.update': 'Updated an event',
  'calendar.delete': 'Removed an event',
  'email.search': 'Checked your mail',
  'email.read': 'Read a message',
  'email.draft': 'Prepared a draft',
  'email.send': 'Sent a message',
  'email.discard': 'Discarded a draft',
  'files.list': 'Checked your files',
  'documents.status': 'Checked a document',
  'files.read': 'Read a file',
  'files.write': 'Saved a file',
  'files.move': 'Moved a file',
  'files.delete': 'Deleted a file',
  'files.restore': 'Restored a file',
  'files.save_attachment': 'Saved your file to its workspace',
  'web.fetch': 'Read a web page',
  'web.search': 'Searched the web',
  'web.weather': 'Checked the weather',
  'test.read': 'Checked the connected app',
  'test.send': 'Sent a message',
  'computer.open': 'Opened a page in its computer',
  'computer.screenshot': 'Looked at the screen of its computer',
  'computer.click': 'Clicked in its computer',
  'computer.type': 'Typed in its computer',
  'computer.key': 'Pressed keys in its computer',
  'computer.scroll': 'Scrolled in its computer',
  'computer.batch': 'Did a few steps in its computer',
  'browser.open': 'Opened a page in its browser',
  'browser.observe': 'Read the page in its browser',
  'browser.read': 'Read the page in its browser',
  'browser.click': 'Clicked in its browser',
  'browser.fill': 'Filled in a field in its browser',
  'browser.select': 'Chose an option in its browser',
  'browser.submit': 'Submitted a form',
};
/** What an open that left the window where it was reads as. */
export const NOT_OPENED = 'Tried to open a page in its computer; the window did not change';
/** How each connector verb reads while it runs and once it is done. */
export const ACTION_VERBS: Record<string, [doing: string, done: string]> = {
  'calendar.list': ['Checking your calendar', 'Checked your calendar'],
  'calendar.freebusy': ['Checking when you are free', 'Checked when you are free'],
  'calendar.create': ['Adding an event', 'Added an event'],
  'calendar.update': ['Updating an event', 'Updated an event'],
  'calendar.delete': ['Removing an event', 'Removed an event'],
  'email.search': ['Searching your mail', 'Searched your mail'],
  'email.read': ['Reading a message', 'Read a message'],
  'email.draft': ['Drafting a message', 'Drafted a message'],
  'email.send': ['Sending the email', 'Sent the email'],
  'email.discard': ['Discarding a draft', 'Discarded a draft'],
  'files.list': ['Looking through your files', 'Looked through your files'],
  'documents.status': ['Checking a document', 'Checked a document'],
  'files.read': ['Reading a file', 'Read a file'],
  'files.write': ['Saving a file', 'Saved a file'],
  'files.move': ['Moving a file', 'Moved a file'],
  'files.delete': ['Deleting a file', 'Deleted a file'],
  'files.restore': ['Restoring a file', 'Restored a file'],
  'files.save_attachment': [
    'Saving your file to its workspace',
    'Saved your file to its workspace',
  ],
  'web.fetch': ['Reading a web page', 'Read a web page'],
  'web.search': ['Searching the web', 'Searched the web'],
  'exec.run': ['Running a command', 'Ran a command'],
  'exec.python': ['Running code', 'Ran code'],
  'terminal.run': ['Running a command', 'Ran a command'],
  'browser.open': ['Opening a page', 'Opened a page'],
  'browser.observe': ['Looking at the page', 'Looked at the page'],
  'browser.fill': ['Filling in a form', 'Filled in a form'],
  'browser.click': ['Clicking on the page', 'Clicked on the page'],
  'browser.select': ['Choosing an option', 'Chose an option'],
  'browser.read': ['Reading the page', 'Read the page'],
  'browser.submit': ['Submitting a form', 'Submitted a form'],
  'artifact.publish': ['Publishing a file', 'Published a file'],
  'notes.write': ['Noting this for later', 'Noted this for later'],
  'skills.create': ['Saving a skill', 'Saved a skill'],
  'skills.update': ['Changing a skill', 'Changed a skill'],
  'skills.list': ['Looking through your skills', 'Looked through your skills'],
  'skills.delete': ['Deleting a skill', 'Deleted a skill'],
  'skills.restore': ['Putting a skill back', 'Put a skill back'],
  'web.weather': ['Checking the weather', 'Checked the weather'],
  'apps.publish': ['Publishing an app', 'Published an app'],
  'apps.rollback': ['Changing the version of an app', 'Changed the version of an app'],
  'apps.list': ['Looking through your apps', 'Looked through your apps'],
  'apps.routines': ['Looking through your routines', 'Looked through your routines'],
  'apps.read_submissions': ['Reading responses to an app', 'Read responses to an app'],
  'audio.synthesize': ['Making audio', 'Made audio'],
  'audio.transcribe': ['Transcribing a recording', 'Transcribed a recording'],
  'test.read': ['Checking the connected app', 'Checked the connected app'],
  'test.send': ['Sending a message', 'Sent a message'],
  'device.status': ['Checking your computer', 'Checked your computer'],
  'device.list_files': [
    'Looking through files on your computer',
    'Looked through files on your computer',
  ],
  'device.read_file': ['Reading a file on your computer', 'Read a file on your computer'],
  'device.write_file': ['Saving a file on your computer', 'Saved a file on your computer'],
  'device.run': ['Running a command on your computer', 'Ran a command on your computer'],
  'device.open_url': ['Opening a page on your computer', 'Opened a page on your computer'],
  'device.screenshot': ['Looking at your screen', 'Looked at your screen'],
  'device.browser_open': ['Opening a page in your browser', 'Opened a page in your browser'],
  'device.browser_read': ['Reading a page in your browser', 'Read a page in your browser'],
  'device.browser_click': ['Clicking in your browser', 'Clicked in your browser'],
  'device.browser_type': [
    'Filling in a field in your browser',
    'Filled in a field in your browser',
  ],
  'device.browser_screenshot': [
    'Looking at a page in your browser',
    'Looked at a page in your browser',
  ],
};
/** The past-tense verbs of the labels above, as a permission card asks for them. */
const ASKED: Record<string, string> = {
  Added: 'Add',
  Changed: 'Change',
  Chose: 'Choose',
  Clicked: 'Click',
  Created: 'Create',
  Discarded: 'Discard',
  Drafted: 'Draft',
  'Filled in': 'Fill in',
  Made: 'Make',
  Moved: 'Move',
  Opened: 'Open',
  Published: 'Publish',
  Ran: 'Run',
  Removed: 'Remove',
  Restored: 'Restore',
  Saved: 'Save',
  Sent: 'Send',
  Submitted: 'Submit',
  Transcribed: 'Transcribe',
  Updated: 'Update',
};
/** What a permission card asks for a command or code in the agent's own computer. */
const SANDBOX_ASKS: Record<string, string> = {
  'terminal.run': "Run a command on the agent's computer",
  'exec.run': "Run a command in the agent's workspace",
  'exec.python': "Run code in the agent's workspace",
};

/** What a permission card asks for a connected computer, before anything has run. */
const DEVICE_ASKS: Record<string, string> = {
  'device.run': 'Run a command on your computer',
  'device.write_file': 'Save a file on your computer',
  'device.open_url': 'Open a page on your computer',
  'device.screenshot': 'Look at your screen',
  'device.browser_click': 'Click in your browser',
  'device.browser_type': 'Fill in a field in your browser',
};

/** A page's host, as a title names it: "example.com". */
function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return host ? showInvisible(host) : null;
  } catch {
    return null;
  }
}

/** Words from the request inside a title: trimmed, short, in quotation marks. */
function named(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = showInvisible(value.trim());
  return `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
}

const AGENT = "the agent's";

/**
 * What a permission card asks for a step in a browser or on a computer, in
 * the present tense and with its target, so nobody approves without knowing
 * what: the page it opens, the control it clicks, the keys it presses.
 */
export function stepAsk(kind: string, payload: Record<string, unknown>): string | null {
  const intent =
    payload.intent && typeof payload.intent === 'object'
      ? (payload.intent as Record<string, unknown>)
      : {};
  const keys = Array.isArray(payload.keys)
    ? payload.keys.filter((key): key is string => typeof key === 'string').join('+')
    : '';
  const page = (where: string, url: unknown) => {
    const host = hostOf(url);
    return host ? `Open ${host} ${where}` : `Open a page ${where}`;
  };
  switch (kind) {
    case 'computer.open':
    case 'browser.open':
      return page(`in ${AGENT} browser`, payload.url);
    case 'computer.screenshot':
      return `Look at ${AGENT} screen`;
    case 'computer.click':
      return `Click on ${AGENT} screen`;
    case 'computer.type':
      return `Type on ${AGENT} computer`;
    case 'computer.key':
      return keys
        ? `Press ${showInvisible(keys)} on ${AGENT} computer`
        : `Press keys on ${AGENT} computer`;
    case 'computer.scroll':
      return `Scroll on ${AGENT} screen`;
    case 'computer.batch':
      return `Do a few steps on ${AGENT} computer`;
    case 'browser.observe':
    case 'browser.read':
      return `Read the page in ${AGENT} browser`;
    case 'browser.click': {
      const control = named(payload.name);
      return control ? `Click ${control} in ${AGENT} browser` : `Click in ${AGENT} browser`;
    }
    case 'browser.fill': {
      const field = named(payload.label);
      return field ? `Fill in ${field} in ${AGENT} browser` : `Fill in a field in ${AGENT} browser`;
    }
    case 'browser.select': {
      const field = named(payload.label);
      return field
        ? `Choose an option for ${field} in ${AGENT} browser`
        : `Choose an option in ${AGENT} browser`;
    }
    case 'browser.submit': {
      const host = hostOf(intent.url);
      return `Submit ${named(intent.name) ?? 'a form'}${host ? ` to ${host}` : ''}`;
    }
    case 'device.open_url':
      return page('on your computer', payload.url);
    case 'device.browser_open':
      return page('in your browser', payload.url);
    case 'device.browser_read':
      return 'Read a page in your browser';
    case 'device.browser_screenshot':
      return 'Look at a page in your browser';
    case 'device.list_files':
      return 'Look through a folder on your computer';
    case 'device.read_file':
      return 'Read a file on your computer';
    case 'device.status':
      return 'Check your computer is connected';
    case 'files.move': {
      const file = named(typeof payload.from === 'string' ? payload.from.split('/').pop() : null);
      const into = (payload.to_area ?? payload.area) === 'artifacts';
      const from = payload.area === 'artifacts';
      const what = file ?? 'a file';
      if (into && !from) return `Move ${what} into your Files`;
      if (from && !into) return `Move ${what} out of your Files`;
      return into ? `Move ${what} within your Files` : null;
    }
    case 'files.delete': {
      const checked = object(payload.checked);
      const file = named(typeof payload.path === 'string' ? payload.path.split('/').pop() : null);
      const what = `${checked.what === 'folder' ? 'the folder ' : ''}${file ?? 'a file'}`;
      return payload.area === 'artifacts' ? `Delete ${what} from your Files` : `Delete ${what}`;
    }
    default:
      return null;
  }
}

/**
 * What a delete would take, as the service found it before asking: the path,
 * how much is in it, and the warning that it cannot be undone.
 */
function deleteFacts(payload: Record<string, unknown>) {
  const checked = object(payload.checked);
  const files = typeof checked.files === 'number' ? checked.files : null;
  const bytes = typeof checked.bytes === 'number' ? checked.bytes : null;
  const names = Array.isArray(checked.names)
    ? checked.names.filter((name): name is string => typeof name === 'string')
    : [];
  return [
    ...(typeof payload.path === 'string'
      ? [
          {
            label: checked.what === 'folder' ? 'Folder' : 'File',
            value: plainText(payload.path, 'A file'),
          },
        ]
      : []),
    ...(checked.what === 'folder' && files !== null
      ? [{ label: 'Files in it', value: String(files) }]
      : []),
    ...(bytes !== null ? [{ label: 'Size', value: appBytes(bytes) }] : []),
    ...(names.length
      ? [
          {
            label: 'Inside',
            value: plainText(
              `${names.join(', ')}${files !== null && files > names.length ? `, and ${files - names.length} more` : ''}`,
              'Its files',
            ),
          },
        ]
      : []),
    // Only the person's own files are asked about for being theirs; Melete's
    // own work asks only when the person's settings say so.
    ...(typeof checked.reason === 'string' && checked.owner !== 'agent'
      ? [{ label: 'Why you are asked', value: plainText(checked.reason, 'It is yours.') }]
      : []),
    ...(typeof checked.warning === 'string'
      ? [{ label: 'Warning', value: plainText(checked.warning, 'It goes to the trash.') }]
      : []),
  ];
}

/** The target of a step in a browser or on the agent's computer, whole, for the card's facts. */
function stepFacts(kind: string, payload: Record<string, unknown>) {
  if (kind === 'files.delete') return deleteFacts(payload);
  if (!kind.startsWith('computer.') && !kind.startsWith('browser.')) return [];
  const intent =
    payload.intent && typeof payload.intent === 'object'
      ? (payload.intent as Record<string, unknown>)
      : {};
  const limit = DEVICE_LIMITS.max_command_chars;
  const fact = (label: string, value: unknown) =>
    typeof value === 'string' && value.length
      ? [
          {
            label,
            value: showInvisible(value.length > limit ? `${value.slice(0, limit)}…` : value),
          },
        ]
      : [];
  const fields =
    intent.fields && typeof intent.fields === 'object'
      ? Object.entries(intent.fields as Record<string, unknown>).flatMap(([name, value]) =>
          // A checkbox group sends each chosen value under one name. Each is its own line, so a
          // long one cannot push the next off the card, and one value never reads as two.
          Array.isArray(value) ? value.flatMap((item) => fact(name, item)) : fact(name, value),
        )
      : [];
  return [
    ...fact('Page', payload.url),
    ...fact('Page', intent.url),
    ...(typeof payload.x === 'number' && typeof payload.y === 'number'
      ? [{ label: 'Where', value: `${payload.x}, ${payload.y} on the screen` }]
      : []),
    ...(typeof payload.amount === 'number'
      ? [
          {
            label: 'Scroll',
            value: `${Math.abs(payload.amount)} steps ${payload.amount < 0 ? 'up' : 'down'}`,
          },
        ]
      : []),
    ...fact('Text', payload.text),
    ...(Array.isArray(payload.keys)
      ? fact('Keys', payload.keys.filter((key) => typeof key === 'string').join(' then '))
      : []),
    ...fact('Control', payload.name),
    ...fact('Control', intent.name),
    ...fact('Field', payload.label),
    ...fact('Value', payload.value),
    ...fields,
    { label: 'Computer', value: "The agent's own computer, not yours" },
  ];
}

/**
 * Characters that change how text around them reads without showing
 * themselves: direction overrides and isolates, zero-width characters, other
 * format characters, and controls apart from newline and tab. On a permission
 * card each is written out as its code point, so what is approved reads the
 * way it will run.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0]/gu;
export function showInvisible(text: string): string {
  return text.replace(INVISIBLE, (char) =>
    char === '\n' || char === '\t'
      ? char
      : `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

/**
 * The exact command, folder, file or page a permission is for, as it will be
 * sent. A command is never longer than this limit (the connector refuses a
 * longer one), so it is always shown whole, with anything invisible in it
 * written out.
 */
/** An element as a person reads it: `button "Delete account"`, and what it shows or leads to when that says more. */
function describeElement(element: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const role = text(element.role) || 'element';
  return [
    `${role} "${text(element.name)}"`,
    ...(text(element.shows) ? [`showing "${text(element.shows)}"`] : []),
    ...(text(element.target) ? [`going to ${text(element.target)}`] : []),
  ].join(', ');
}

function deviceFacts(kind: string, payload: Record<string, unknown>) {
  if (!kind.startsWith('device.')) return [];
  const expected =
    payload.expect && typeof payload.expect === 'object'
      ? (payload.expect as { url?: unknown; title?: unknown; element?: unknown })
      : undefined;
  const element =
    expected?.element && typeof expected.element === 'object'
      ? (expected.element as Record<string, unknown>)
      : undefined;
  const fact = (label: string, value: unknown, limit: number = DEVICE_LIMITS.max_command_chars) =>
    typeof value === 'string' && value.length
      ? [
          {
            label,
            value: showInvisible(value.length > limit ? `${value.slice(0, limit)}…` : value),
          },
        ]
      : [];
  return [
    ...fact('Command', payload.command),
    ...fact('Runs in', payload.cwd),
    ...fact('File', payload.path),
    ...fact('Content', payload.content),
    ...fact('Page', payload.url),
    // A click or an entry names what the person saw in the latest read of the
    // tab: its address without the query, its title, and the element.
    ...fact('Page', expected?.url),
    ...fact('Title', expected?.title),
    ...fact('Element', element ? describeElement(element) : undefined),
    ...fact('Text', payload.text, DEVICE_LIMITS.max_typed_chars),
    ...(payload.submit === true ? [{ label: 'Then', value: 'Press Enter to submit' }] : []),
    ...(namesLocalNetwork(payload.url)
      ? [{ label: 'Network', value: 'This page is on your computer or your local network' }]
      : []),
  ];
}

/** The command or code of a sandbox action, as it will run. */
function sandboxIntent(kind: string, payload: Record<string, unknown>) {
  if (!(kind in SANDBOX_ASKS)) return null;
  return kind === 'terminal.run'
    ? payload
    : payload.intent && typeof payload.intent === 'object'
      ? (payload.intent as Record<string, unknown>)
      : {};
}

/**
 * Why a sandbox command or code cannot be asked about, or null when it can: a
 * card shows what will run whole, with anything invisible written out, and
 * one longer than a card shows is refused rather than shown in part.
 */
export function tooLongToAsk(kind: string, payload: unknown): string | null {
  const intent = sandboxIntent(
    kind,
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
  );
  if (!intent) return null;
  for (const [label, value] of [
    ['command', intent.command],
    ['code', intent.code],
  ] as const) {
    if (typeof value !== 'string') continue;
    const shown = showInvisible(value).length;
    if (shown > DEVICE_LIMITS.max_command_chars)
      return `This ${label} needs the person's approval, and at ${shown} characters as the approval card shows it, it is longer than the ${DEVICE_LIMITS.max_command_chars} a card shows whole, so it was not asked for. Nothing ran. Split it into shorter steps.`;
  }
  return null;
}

/**
 * The exact command or code a sandbox action will run, and where, as a
 * computer card shows it. A command runs from the agent's workspace, `/work`,
 * unless it names a folder inside it. One longer than a card shows is refused
 * when it is proposed (`tooLongToAsk`), so it is always shown whole; should one
 * still reach a card, it is cut and says so.
 */
function sandboxFacts(kind: string, payload: Record<string, unknown>) {
  const intent = sandboxIntent(kind, payload);
  if (!intent) return [];
  const limit = DEVICE_LIMITS.max_command_chars;
  const cut: Array<{ label: string; value: string }> = [];
  const shown = (value: unknown) => {
    if (typeof value !== 'string' || !value.length) return null;
    const whole = showInvisible(value);
    if (whole.length <= limit) return whole;
    cut.push({
      label: 'Length',
      value: `${whole.length} characters; only the first ${limit} are shown, so the rest is not on this card. Deny it unless you know what it runs.`,
    });
    return `${whole.slice(0, limit)}…`;
  };
  const command = shown(intent.command);
  const code = shown(intent.code);
  const cwd = typeof intent.cwd === 'string' && intent.cwd && intent.cwd !== '.' ? intent.cwd : '';
  return [
    ...(command ? [{ label: 'Command', value: command }] : []),
    ...(code ? [{ label: 'Code', value: code }] : []),
    ...cut,
    { label: 'Runs in', value: showInvisible(cwd ? `/work/${cwd}` : '/work').slice(0, limit) },
    {
      label: 'Computer',
      value: "The agent's own computer, not yours",
    },
  ];
}

/** How a finished action of this kind reads, when the kind is a known one. */
export const doneLabel = (kind: string): string | undefined =>
  LABELS[kind] ?? ACTION_VERBS[kind]?.[1];

/** An open on its computer whose window never moved to the address says so. */
export const openDidNotNavigate = (row: Pick<ActionRow, 'kind' | 'receipt'>): boolean =>
  row.kind === 'computer.open' && object(object(row.receipt).detail).navigated === false;

const KB = 1024;
const appBytes = (bytes: number) =>
  bytes < KB
    ? `${bytes} bytes`
    : bytes < KB * KB
      ? `${Math.round(bytes / KB)} KB`
      : `${(bytes / KB / KB).toFixed(1)} MB`;

/** What a permission card asks for an app: its name, never only "an app". */
function appAsk(kind: string, payload: Record<string, unknown>): string | null {
  const text = (value: unknown) => (typeof value === 'string' ? plainText(value, '', 200) : '');
  const name = text(payload.name);
  // A new version is named by the app it replaces, as it is called now.
  const current = text(payload.current_name);
  if (kind === 'apps.publish') {
    if (payload.create === true) return name ? `Publish ${name}` : null;
    return current ? `Publish a new version of ${current}` : null;
  }
  if (kind === 'apps.rollback') return name ? `Change which version of ${name} people see` : null;
  return null;
}

/** The data an app shows, as one card line. */
const dataFact = (shown: unknown) => {
  const lines = Array.isArray(shown) ? shown.map(String) : [];
  return {
    label: 'Data it shows',
    value: lines.length
      ? plainText(`${lines.join('; ')}. Viewers see each new version automatically.`, 'None')
      : 'None',
  };
};

/**
 * Why this publish or rollback came to the person rather than going ahead on
 * its own: the reasons the service bound before asking, in plain words.
 */
const risksFact = (risks: unknown) => {
  const lines = Array.isArray(risks) ? risks.map(String).filter(Boolean) : [];
  return lines.length
    ? [{ label: 'Why you are asked', value: plainText(lines.join(' '), 'It needs your yes.') }]
    : [];
};

const collectionsFact = (names: string[]) =>
  names.length
    ? [{ label: 'Responses it collects', value: plainText(names.join(', '), 'None') }]
    : [];

/**
 * Everything a person needs to decide on publishing an app, or on changing
 * which version people see: which app, how much it is, who will be able to
 * open it, and which data it shows them, all bound into the payload before the
 * question was asked.
 */
function appFacts(kind: string, payload: Record<string, unknown>) {
  if (kind === 'apps.rollback') {
    const at = typeof payload.version_published_at === 'string' ? payload.version_published_at : '';
    const viewers = typeof payload.viewers_now === 'string' ? payload.viewers_now : 'only you';
    return [
      ...risksFact(payload.risks),
      ...(typeof payload.name === 'string'
        ? [{ label: 'App', value: plainText(payload.name, 'App', 200) }]
        : []),
      { label: 'Version', value: at ? `The one published ${at}` : 'An earlier version' },
      {
        label: 'Viewers',
        value: plainText(viewers.charAt(0).toUpperCase() + viewers.slice(1), 'Only you'),
      },
      dataFact(payload.data_shown),
      ...collectionsFact(
        Array.isArray(payload.collections_shown) ? payload.collections_shown.map(String) : [],
      ),
    ];
  }
  if (kind !== 'apps.publish') return [];
  const audience = object(payload.audience);
  const emails = Array.isArray(audience.emails) ? audience.emails.map(String) : [];
  // Who keeps access whatever the audience says: the space's owner, the publisher, managers.
  const also = typeof audience.also === 'string' && audience.also ? [audience.also] : [];
  const viewers =
    audience.kind === 'everyone'
      ? 'Everyone with an account here'
      : audience.kind === 'people' && emails.length
        ? `You and ${[...emails, ...also].join(', ')}`
        : audience.kind === 'unchanged' && typeof audience.now === 'string'
          ? `Unchanged: ${audience.now}`
          : also.length
            ? `You and ${also.join(', ')}`
            : 'Only you';
  const files = typeof payload.file_count === 'number' ? payload.file_count : 0;
  const bytes = typeof payload.total_bytes === 'number' ? payload.total_bytes : 0;
  const name = typeof payload.name === 'string' ? plainText(payload.name, 'App', 200) : null;
  const current =
    typeof payload.current_name === 'string' ? plainText(payload.current_name, 'App', 200) : null;
  return [
    ...risksFact(payload.risks),
    ...(current
      ? [
          { label: 'App', value: current },
          // A new name is part of what is asked, never done unseen.
          ...(name && name !== current ? [{ label: 'Renames it to', value: name }] : []),
        ]
      : name
        ? [{ label: 'App', value: name }]
        : []),
    {
      label: 'Files',
      value: `${files} ${files === 1 ? 'file' : 'files'}, ${appBytes(bytes)}`,
    },
    { label: 'Viewers', value: plainText(viewers, 'Only you') },
    dataFact(payload.data_shown),
    ...collectionsFact(Object.keys(object(payload.collections))),
    ...connectionsFact(payload.opens_connections),
  ];
}

/**
 * A warning, never a refusal: the app's code uses WebRTC, which can send what
 * it shows, or what a viewer types into it, to another server.
 */
function connectionsFact(files: unknown) {
  const named = Array.isArray(files) ? files.map(String).filter(Boolean) : [];
  if (!named.length) return [];
  return [
    {
      label: 'Warning',
      value: plainText(
        `Its code can open direct connections to other servers (WebRTC, in ${named.join(', ')}), which can send what the app shows, or what a viewer types into it, anywhere. Publish it only if you trust that code with that data.`,
        'Its code can open direct connections to other servers.',
      ),
    },
  ];
}

export function actionLabel(row: ActionRow, connection?: ConnectionRow): string {
  if (openDidNotNavigate(row)) return NOT_OPENED;
  return (
    LABELS[row.kind] ??
    ACTION_VERBS[row.kind]?.[1] ??
    (connection
      ? `Used ${plainText(connection.label, appName(connection), 60)}`
      : 'Completed a step')
  );
}

export function actionSources(row: ActionRow, connection: ConnectionRow): ExperienceSource[] {
  if (row.status !== 'succeeded') return [];
  const detail = object(object(row.receipt).detail);
  const payload = object(row.canonicalPayload);
  const source = (
    kind: ExperienceSource['kind'],
    title: unknown,
    fallback: string,
    address?: unknown,
  ): ExperienceSource => {
    const url = safeUrl(address);
    return {
      app: appName(connection),
      title: plainText(title, fallback),
      kind,
      connection_id: connection.id,
      ...(url ? { url } : {}),
    };
  };
  switch (row.kind) {
    case 'calendar.list':
      return array(detail.events).map((item) =>
        source('event', object(item).summary, 'Calendar event', object(item).url),
      );
    case 'calendar.create':
    case 'calendar.update':
    case 'calendar.delete':
      return [source('event', payload.summary ?? detail.summary, 'Calendar event')];
    case 'email.search':
      return array(detail.messages).map((item) =>
        source('message', object(item).subject, 'Message'),
      );
    case 'email.read':
      return [source('message', object(detail.message).subject, 'Message')];
    case 'email.draft':
      return [source('draft', payload.subject, 'Draft')];
    case 'email.send':
      return [source('message', payload.subject, 'Sent message')];
    case 'files.list':
      return array(detail.entries)
        .filter((item) => object(item).kind === 'file')
        .map((item) => source('file', filename(object(item).name), 'File'));
    case 'files.read':
    case 'files.write':
    case 'files.move':
    case 'files.restore':
      return [source('file', filename(detail.path ?? detail.to ?? payload.path), 'File')];
    case 'web.fetch':
      return [
        source(
          'page',
          pageTitle(detail) ?? hostname(safeUrl(detail.final_url ?? detail.url)),
          'Web page',
          detail.final_url ?? detail.url,
        ),
      ];
    case 'web.search':
      // Every page the search returned is a source the answer can cite.
      return array(detail.results).map((item) =>
        source(
          'page',
          object(item).title ?? hostname(safeUrl(object(item).url)),
          'Web page',
          object(item).url,
        ),
      );
    default:
      return [];
  }
}
const filename = (value: unknown) =>
  typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() : undefined;
/** A page with no title is named by its site: "open-meteo.com", not the whole address. */
const hostname = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};
/**
 * Looking through files or reading one makes nothing new: what was looked at
 * stays in the turn's activity, and only what an action made becomes a card.
 */
const LOOKED_AT = new Set(['files.list', 'files.read']);
/** A read page names its title; a receipt from before that carries the page itself. */
const pageTitle = (detail: Record<string, unknown>) =>
  typeof detail.title === 'string' && detail.title.trim()
    ? detail.title
    : typeof detail.body === 'string'
      ? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(detail.body)?.[1]?.replace(/&amp;/g, '&')
      : undefined;

export function projectActionGroup(
  rows: Array<{ action: ActionRow; connection: ConnectionRow }>,
): Extract<TrailStep, { type: 'action' }> | null {
  const succeeded = rows.filter(({ action }) => action.status === 'succeeded');
  if (!succeeded.length) return null;
  const labels = [
    ...new Set(succeeded.map(({ action, connection }) => actionLabel(action, connection))),
  ];
  const sources = succeeded.flatMap(({ action, connection }) => actionSources(action, connection));
  return {
    type: 'action',
    label: labels.join(', '),
    meta: `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`,
    sources,
  };
}

export function projectReceipt(
  row: ActionRow,
  connection: ConnectionRow,
  undo?: { handle: string; valid_until: string },
  review?: ActionReview | null,
  because?: BecauseLink[],
  /** The change this one took back, when it was an undo. */
  reverses?: string,
) {
  // A web search is a read, but its words left Melete for an outside service,
  // so it keeps a receipt like any change does.
  const search = row.kind === 'web.search';
  if (
    row.status !== 'succeeded' ||
    !(search || ['write_external', 'write_reversible', 'spend'].includes(row.effectClass)) ||
    !row.receipt
  )
    return null;
  const query = search ? plainText(object(object(row.receipt).detail).query, '', 200) : '';
  return experienceReceipt.parse({
    id: row.id,
    what: query ? `Searched the web for “${query}”` : actionLabel(row),
    where: plainText(connection.label, appName(connection)),
    when: row.resolvedAt?.toISOString() ?? row.createdAt.toISOString(),
    ...(undo ? { undo } : {}),
    // Only an approval auto-review gave is shown here; an escalation was the person's call.
    ...(review?.outcome === 'auto_approved' ? { review } : {}),
    ...(because?.length ? { because } : {}),
    ...(reverses ? { reverses } : {}),
  });
}

/**
 * The receipt of a message that is held before sending (Undo cancels it), or
 * that was cancelled while it was held, so nothing left. Null for anything else.
 */
export function projectHeldReceipt(
  row: ActionRow,
  connection: ConnectionRow,
  held: { until: string; undo?: { handle: string; valid_until: string } } | { cancelled: true },
) {
  return experienceReceipt.parse({
    id: row.id,
    what: 'cancelled' in held ? 'Cancelled a message before it was sent' : 'Sending a message',
    where: plainText(connection.label, appName(connection)),
    when: row.resolvedAt?.toISOString() ?? row.createdAt.toISOString(),
    ...('until' in held
      ? { sending_until: held.until, ...(held.undo ? { undo: held.undo } : {}) }
      : {}),
  });
}

/**
 * A prepared draft the person can still send carries the send action, keyed by
 * the draft's id, which is what the send route takes. One already sent, waiting
 * on a decision, discarded, or unreadable in full has none.
 */
function sendAction(row: ActionRow, draft: ExperienceDraft['status'] | undefined) {
  if (row.kind !== 'email.draft' || row.status !== 'succeeded') return null;
  if (draft !== 'draft' && draft !== 'denied') return null;
  if (!draftForReview(row)) return null;
  return { kind: 'send' as const, label: 'Review and send', handle: row.id };
}

/** `draft` is the draft's status when the action prepared one; a fresh draft is `draft`. */
export function projectCards(
  row: ActionRow,
  connection: ConnectionRow,
  draft?: ExperienceDraft['status'],
): ResultCard[] {
  if (LOOKED_AT.has(row.kind)) return [];
  const send = sendAction(row, draft);
  const sources = actionSources(row, connection);
  const payload = object(row.canonicalPayload);
  const detail = object(object(row.receipt).detail);
  return sources.map((source, index) => {
    const event = row.kind === 'calendar.list' ? object(array(detail.events)[index]) : payload;
    const facts: Array<{ label: string; value: string }> = [];
    if (source.kind === 'event')
      for (const [field, label] of [
        ['start', 'Starts'],
        ['end', 'Ends'],
        ['location', 'Place'],
      ] as const) {
        const value = plainText(event[field], '');
        if (value) facts.push({ label, value });
      }
    if (source.kind === 'draft') facts.push({ label: 'To', value: recipientText(payload) });
    // A file a files action saved or moved opens from that action's own route.
    const saved = source.kind === 'file' ? savedFile(row.kind, row.receipt) : null;
    return resultCard.parse({
      id: `${row.id}:${index}`,
      title: source.title,
      meta: source.app,
      facts,
      ...(saved
        ? fileActions(row.id, mimeForName(saved.path))
        : {
            primary_action: source.url
              ? { kind: 'open', label: 'Open', handle: `${row.id}:${index}`, url: source.url }
              : source.kind === 'draft'
                ? send
                : null,
            secondary_actions: [],
          }),
      source_connection: connection.id,
    });
  });
}
export function recipientText(payload: Record<string, unknown>): string {
  const raw = payload.to ?? payload.recipient;
  return plainText(Array.isArray(raw) ? raw.join(', ') : raw, 'The selected recipient');
}
/**
 * Files the app can open in place: a PDF, a picture, or anything read as text
 * (a web page's source included, shown as text). Anything else downloads.
 */
const openable = (mime: string) =>
  shownInPlace(mime) !== null || mime.startsWith('text/') || mime === 'application/json';

/**
 * A file's buttons: Open, where the app can show it, and always Download. The
 * handle names the file to the app: an artifact id, or the files action that
 * saved it, each read from its own authenticated route.
 */
export function fileActions(
  handle: string,
  mime: string,
): Pick<ResultCard, 'primary_action' | 'secondary_actions'> {
  const download = { kind: 'download' as const, label: 'Download', handle };
  return openable(mime)
    ? { primary_action: { kind: 'open', label: 'Open', handle }, secondary_actions: [download] }
    : { primary_action: download, secondary_actions: [] };
}

export function projectArtifact(row: typeof artifact.$inferSelect): ResultCard {
  return resultCard.parse({
    id: row.id,
    title: plainText(filename(row.path), 'File'),
    meta: 'File',
    facts: [{ label: 'Size', value: `${row.size} bytes` }],
    // The handle is the artifact id; the app reads it from the content route.
    ...fileActions(row.id, row.mime),
    source_connection: null,
  });
}
/**
 * The card that hands the work to the person (`notice {kind: handed_to_person}`): where the
 * work is stuck, what is left for them, what is done, and a Take over that gives them the
 * agent's browser or computer. Null for a notice that carries no hand-off.
 */
export function projectHandOff(payload: unknown, seq: number): ResultCard | null {
  const parsed = handOff.safeParse(payload);
  if (!parsed.success) return null;
  const card = parsed.data;
  const done = plainText(card.done.join('; '), '');
  return resultCard.parse({
    id: `handoff_${seq}`,
    title: `Over to you at ${plainText(card.service, 'this site', 253)}`,
    meta: 'Needs you',
    facts: [
      { label: 'About', value: plainText(card.left, 'Take over, then hand it back.', 500) },
      ...(done ? [{ label: 'Done so far', value: done }] : []),
    ],
    primary_action: {
      label: 'Take over',
      kind: 'take_over',
      handle: card.take_over.session_id,
      surface: card.take_over.surface,
    },
    secondary_actions: [],
    source_connection: null,
  });
}

/** Approval must show the exact recipients and complete body, without hiding unsafe content. */
export function draftForReview(row: ActionRow) {
  const payload = object(row.canonicalPayload);
  const addresses = (value: unknown) =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? (value as string[])
        : [];
  const to = addresses(payload.to);
  const cc = addresses(payload.cc);
  const bcc = addresses(payload.bcc);
  const safe = (value: unknown, limit: number) =>
    typeof value === 'string' &&
    value.length <= limit &&
    (!value || plainText(value, '', limit) === value.trim());
  if (
    !to.length ||
    ![...to, ...cc, ...bcc].every((value) => safe(value, 4000)) ||
    !safe(payload.body, 100000) ||
    !safe(payload.subject, 1000) ||
    ![to, cc, bcc].every((addresses) => safe(addresses.join(', '), 4000))
  )
    return null;
  const parsed = experienceDraft.safeParse({
    id: row.id,
    recipient: to.join(', '),
    channel: 'email',
    body: payload.body,
    subject: payload.subject,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    connection_id: row.connectionId,
    status: 'draft',
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The address a message would leave from, read off the connection it would
 * leave through.
 *
 * It is not part of the message payload — a send names only its recipients, and
 * the mailbox is a property of the connection — so a person cannot see it in
 * the words they are approving unless it is put there. Someone with two
 * mailboxes connected is being asked a different question depending on which
 * one this is, and they should be able to tell which.
 *
 * Unknown is unknown: an operator-configured mailbox keeps its address in the
 * environment rather than on the row, and nothing is invented to fill the gap.
 */
export function senderAddress(configuration: unknown): string | null {
  const stored = object(configuration);
  const value = object(stored.mail).from ?? stored.from;
  if (typeof value !== 'string' || !value.trim()) return null;
  // Held to the same bar as the recipients beside it: shown exactly, or not at
  // all. A fallback string in this row would read as an address and not be one.
  return plainText(value, '', 4000) === value.trim() ? value.trim() : null;
}

/** The note on a permission a later message in its conversation made stale. */
export const SUPERSEDED_NOTE = 'replaced';
/** The note on a permission withdrawn because the person stopped the turn it waited in. */
export const STOPPED_NOTE = 'stopped';

/**
 * A decided permission as the conversation shows it. An approval that saved a
 * standing rule was "always"; any other approval was this once.
 */
export function projectPermissionDecision(input: {
  approvalId: string;
  decision: unknown;
  ruleSaved: boolean;
  /** Why it was decided, when the service decided it rather than the person. */
  note?: unknown;
  at: Date;
}): ExperienceDecision {
  return experienceDecision.parse({
    kind: 'permission',
    id: input.approvalId,
    outcome:
      input.decision === 'denied'
        ? input.note === SUPERSEDED_NOTE
          ? 'replaced'
          : input.note === OUTDATED_NOTE
            ? 'outdated'
            : input.note === STOPPED_NOTE || input.note === ENDED_NOTE
              ? 'withdrawn'
              : 'deny'
        : input.ruleSaved
          ? 'always'
          : 'allow_once',
    answer: null,
    decided_at: input.at.toISOString(),
  });
}

/** A closed question: answered with the chosen text, or withdrawn by another input. */
export function projectQuestionDecision(input: {
  questionId: string;
  state: unknown;
  answer: string | null;
  at: Date;
}): ExperienceDecision {
  const answered = input.state === 'answered';
  return experienceDecision.parse({
    kind: 'question',
    id: input.questionId,
    outcome: answered ? 'answered' : 'withdrawn',
    answer: answered && input.answer ? plainText(input.answer, '', 4000) || null : null,
    decided_at: input.at.toISOString(),
  });
}

/**
 * Why a calendar write is the person's to decide, naming the people it would
 * invite from outside their own accounts and what a double-booking lands on.
 */
export function calendarReasons(kind: string, payload: Record<string, unknown>): string[] {
  if (kind !== 'calendar.create' && kind !== 'calendar.update') return [];
  const checked = object(payload.checked);
  const strings = (value: unknown) =>
    array(value).filter((item): item is string => typeof item === 'string');
  const outside = checked.outside ? strings(checked.outside) : strings(payload.attendees);
  const reasons: string[] = [];
  if (outside.length)
    reasons.push(
      plainText(
        `It invites ${outside.length === 1 ? 'someone' : 'people'} outside your own accounts: ${outside.join(', ')}. Your calendar sends them the invitation.`,
        'It invites people outside your own accounts.',
      ),
    );
  const doubleBook = object(payload.double_book);
  if (typeof doubleBook.reason === 'string') {
    const blocks = array(checked.conflicts).map((block) => object(block));
    // Titles are bound only when this work may read the calendar.
    const over =
      checked.names === true
        ? blocks.map((block) => plainText(block.title, 'an untitled event'))
        : [];
    const landsOn = over.length
      ? `It goes on top of ${over.join(', ')}`
      : blocks.length
        ? `It goes on top of ${blocks.length === 1 ? 'something' : `${blocks.length} things`} already on your calendar`
        : 'It was asked for on top of what is already there';
    reasons.push(
      plainText(
        `${landsOn}. The reason given: ${doubleBook.reason}`,
        'It double-books your calendar.',
      ),
    );
  }
  // Said whenever the calendar could not be read before asking: the check
  // just before it is added may still stop it.
  if (checked.read === false)
    reasons.push(
      'Melete could not check your calendar for anything already at this time before asking. It checks again just before adding it, and stops if the time is taken.',
    );
  return reasons;
}

/**
 * What a calendar write adds to its card: who it invites (those outside the
 * person's own accounts named as such), whether it is a hold, and, for a
 * double-booking the agent asked for, what it lands on and why.
 */
export function calendarFacts(
  kind: string,
  payload: Record<string, unknown>,
): { label: string; value: string }[] {
  if (kind !== 'calendar.create' && kind !== 'calendar.update') return [];
  const checked = object(payload.checked);
  const guests = array(payload.attendees).filter(
    (value): value is string => typeof value === 'string',
  );
  const outside = new Set(
    array(checked.outside).filter((value): value is string => typeof value === 'string'),
  );
  const facts: { label: string; value: string }[] = [];
  const named = (list: string[]) => plainText(list.join(', '), 'Not specified');
  const away = guests.filter((guest) => outside.has(guest) || !checked.outside);
  if (away.length) facts.push({ label: 'Invites', value: named(away) });
  const own = guests.filter((guest) => !away.includes(guest));
  if (own.length) facts.push({ label: 'Also invites your own', value: named(own) });
  if (payload.tentative === true) facts.push({ label: 'Hold', value: 'Marked tentative' });
  const doubleBook = object(payload.double_book);
  if (typeof doubleBook.reason === 'string') {
    const over =
      checked.names === true
        ? array(checked.conflicts)
            .map((block) => object(block))
            .map((block) => plainText(block.title, 'an untitled event'))
        : [];
    if (over.length) facts.push({ label: 'On top of', value: plainText(over.join(', '), '') });
    facts.push({ label: 'Why both', value: plainText(doubleBook.reason, 'No reason given') });
  }
  return facts;
}

/**
 * The file a write would save, as the person reviews it: the path and the
 * exact text, with only control characters taken out. Content past the preview
 * limit is cut and marked, never silently dropped.
 */
export function proposedFile(payload: Record<string, unknown>): PermissionCard['file'] | null {
  // A path is shown as given: names like "test.txt" or "email.md" are ordinary files.
  const path =
    typeof payload.path === 'string'
      ? payload.path
          .replace(/\p{Cc}/gu, '')
          .trim()
          .slice(0, 1000)
      : '';
  if (!path || typeof payload.content !== 'string') return null;
  const shown = payload.content.replace(/\p{Cc}/gu, (character) =>
    ['\n', '\r', '\t'].includes(character) ? character : '',
  );
  let content = shown.slice(0, PERMISSION_FILE_PREVIEW_CHARS);
  // Never end on half of a character.
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
  return {
    path,
    bytes: Buffer.byteLength(payload.content, 'utf8'),
    content,
    truncated: content.length < shown.length,
  };
}

/** A card value within a card's limit, saying how much was left out when it is cut. */
function shownWhole(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  const kept = limit - 80;
  return `${text.slice(0, kept)}\n… ${text.length - kept} more characters not shown`;
}

/**
 * A change a command in the agent's computer asked to make with a connected
 * account: the adapter's own summary, whether it deletes or overwrites, and
 * the request in full under Details. Read from the canonical payload the
 * person approves, never from model text.
 */

function egressCard(
  kind: string,
  payload: Record<string, unknown>,
): { title: string; facts: Array<{ label: string; value: string }> } | null {
  if (!isEgressTool(kind)) return null;
  const summary = object(payload.summary);
  const facts = Array.isArray(summary.facts)
    ? summary.facts.flatMap((fact) => {
        const item = object(fact);
        // Long enough for a body and its note of what was left out; invisible characters shown.
        const value = shownWhole(showInvisible(plainText(item.value, '', 8000)));
        return typeof item.label === 'string' && value
          ? [{ label: plainText(item.label, 'Detail', 60), value }]
          : [];
      })
    : [];
  return {
    title: showInvisible(plainText(summary.title, 'Make a change with your account', 300)),
    facts: [
      ...(payload.destructive === true
        ? [{ label: 'Warning', value: 'This deletes or overwrites something.' }]
        : []),
      ...facts,
    ],
  };
}

/**
 * Which asks are answered as one: the same kind of change through the same
 * connection, proposed by one attempt of the work, for the same reasons. An
 * attempt stops at the step that asked, so its asks were made together. The
 * reasons are part of it because a folded card shows the first ask's reasons
 * only: an ask with a doubt of its own (a destination nobody confirmed,
 * guests from outside, a double booking) is read on its own. Opaque to the reader.
 */
export const permissionGroup = (
  action: Pick<ActionRow, 'attemptId' | 'connectionId' | 'kind'>,
  reasons: readonly string[],
) =>
  `grp_${createHash('sha256')
    .update(
      JSON.stringify([action.attemptId, action.connectionId, action.kind, [...reasons].sort()]),
    )
    .digest('hex')
    .slice(0, 24)}`;

export function projectPermission(input: {
  id: string;
  version: string;
  action: ActionRow;
  connection: ConnectionRow & { sender?: string | null };
  reasons: string[];
  canAlways: boolean;
  /** When permission was asked for. */
  requestedAt: Date;
  /** Why auto-review sent this to the person, when it looked first. */
  review?: ActionReview | null;
  /** The beliefs the action rested on, when any were recorded. */
  because?: BecauseLink[];
}) {
  const payload = object(input.action.canonicalPayload);
  const isSend = input.action.kind.endsWith('.send');
  const draft = isSend ? draftForReview(input.action) : null;
  const file = input.action.kind === 'files.write' ? proposedFile(payload) : null;
  const canApprove = !isSend || Boolean(draft);
  // A card asks before anything has happened, so it never reads in the past tense.
  const label = actionLabel(input.action);
  const past = Object.keys(ASKED).find((verb) => label.startsWith(`${verb} `));
  const base = past ? `${ASKED[past]}${label.slice(past.length)}` : label;
  const egress = egressCard(input.action.kind, payload);
  const what = isSend
    ? `${base} to ${recipientText(payload)}`
    : file
      ? // Where it lands, plainly: the person's own Files are not the agent's workspace.
        `Save ${file.path}${payload.area === 'artifacts' ? ' to your Files' : ''}`
      : (egress?.title ??
        stepAsk(input.action.kind, payload) ??
        DEVICE_ASKS[input.action.kind] ??
        SANDBOX_ASKS[input.action.kind] ??
        appAsk(input.action.kind, payload) ??
        base);
  const facts = [
    ...(egress?.facts ?? []),
    ...(file
      ? [
          { label: 'File', value: file.path },
          { label: 'Size', value: `${file.bytes} bytes` },
        ]
      : []),
    ...deviceFacts(input.action.kind, payload),
    ...sandboxFacts(input.action.kind, payload),
    ...stepFacts(input.action.kind, payload),
    ...appFacts(input.action.kind, payload),
    ...(draft
      ? [
          ...(input.connection.sender ? [{ label: 'From', value: input.connection.sender }] : []),
          { label: 'To', value: draft.recipient },
          ...(draft.cc?.length ? [{ label: 'Cc', value: draft.cc.join(', ') }] : []),
          ...(draft.bcc?.length ? [{ label: 'Bcc', value: draft.bcc.join(', ') }] : []),
        ]
      : []),
    ...(typeof payload.subject === 'string'
      ? [{ label: 'Subject', value: plainText(payload.subject, 'Message') }]
      : []),
    ...(typeof payload.body === 'string'
      ? [
          {
            label:
              typeof payload.body === 'string' && payload.body.length > 4000
                ? 'Message preview'
                : 'Message',
            value: plainText(payload.body, 'Message content is not available for preview.'),
          },
        ]
      : []),
    ...(typeof payload.summary === 'string'
      ? [{ label: 'Event', value: plainText(payload.summary, 'Event') }]
      : []),
    ...(['start', 'end', 'location'] as const).flatMap((key) =>
      typeof payload[key] === 'string'
        ? [
            {
              label: key === 'start' ? 'Starts' : key === 'end' ? 'Ends' : 'Place',
              value: plainText(payload[key], 'Not specified'),
            },
          ]
        : [],
    ),
    ...calendarFacts(input.action.kind, payload),
  ];
  return permissionCard.parse({
    id: input.id,
    conversation_id: input.action.jobId,
    what,
    why: canApprove
      ? input.reasons
      : [
          ...input.reasons,
          'The full message cannot be shown safely. Prepare a new draft before sending.',
        ],
    ...(draft ? { draft } : {}),
    ...(file ? { file } : {}),
    options: !canApprove
      ? ['deny']
      : input.canAlways
        ? ['allow_once', 'always', 'deny']
        : ['allow_once', 'deny'],
    version: input.version,
    ...(input.review?.outcome === 'escalated' ? { review: input.review } : {}),
    created_at: input.requestedAt.toISOString(),
    ...(input.because?.length ? { because: input.because } : {}),
    // Asks of one kind made together, in one step of the work, are answered
    // together. A card that shows a message or a file to read is not, nor one
    // auto-review sent to the person with a reason of its own, so each of
    // those is still read on its own.
    ...(draft || file || input.review?.outcome === 'escalated'
      ? {}
      : { group: permissionGroup(input.action, input.reasons) }),
    preview: {
      id: input.id,
      title: what,
      meta: appName(input.connection),
      facts,
      primary_action: null,
      secondary_actions: [],
      source_connection: input.connection.id,
    },
  });
}
