/**
 * Maritime computers behind the `SandboxProvider` seam.
 *
 * One surface, Maritime's REST API (`https://api.maritime.sh/api/v1/computers`,
 * documented at maritime.sh/docs/computers and in its OpenAPI document), over
 * plain `fetch` with the API key as a bearer token: create (get-or-create by
 * `externalUserId`), get, list, delete, wake, sleep, actions, screenshot,
 * `exec`, files and viewer links. A key whose only scope is `computers` is
 * enough, and is the one an operator should use: it reaches nothing else on
 * the account.
 *
 * The key is lent to this adapter one call at a time through `credential`,
 * never read from the environment, never sent into the computer, and scrubbed
 * from every error message.
 *
 * A Maritime computer is a persistent Linux desktop in a micro-VM of its own.
 * It sleeps by itself after five minutes without an action, with its memory
 * snapshotted, and wakes on the next one; its disk under `/data` and
 * `/home/desk` is kept until it is deleted. A workspace persists by putting the
 * computer to sleep and waking it again (`persistence: pause`).
 *
 * Commands. Maritime's `exec` runs one shell command as the desktop user for at
 * most thirty seconds and takes no working directory, environment or stdin. So
 * an admitted command never runs on that channel: its argv goes into a file
 * under `/data/.melete-run`, and a short launcher enters the working directory
 * (exiting 112, before any marker exists, when it cannot), starts a runner in a
 * session of its own in the background and answers at once with its pid. The
 * runner reads the sandbox's environment and the command's own, runs the
 * marker-wrapped command under `timeout -s KILL`, and writes its exit status
 * aside and renames it into place. The adapter then polls for that status with
 * short `exec` calls that wait inside the computer. The launch answer is the
 * proof the command started; whatever is lost after it is left to the marker,
 * never to a second run.
 *
 * Files. Maritime's files API reads and writes up to 8 MiB under `/data` and
 * `/home/desk` only. `/work` is made a link to `/data/work`, so the workspace
 * sits on the computer's kept disk, and every transfer outside those two roots
 * is staged through `/data/.melete-tmp` and moved with a short command. An
 * upload above 8 MiB is refused; a read above it is refused unless the caller
 * wants no more than 8 MiB of it. Listings are made with `find`, because the
 * files API's own listing is one level deep and carries no modes or links.
 *
 * What Maritime's documentation does not promise is not offered: there is no
 * egress control (so `open` is the only policy, and a deny-all or allow-list
 * connection is refused before a computer is made), no preview URL or inbound
 * port, no region choice and no custom image. The image names the desktop:
 * `linux` (x86_64) or `linux-arm64`.
 *
 * Maritime has no labels. A computer's `externalUserId` is a hash of the
 * installation, connection and session it serves, and its `name` carries those
 * labels in plain text so reconciliation can tell whose it is.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  LABEL_CONNECTION,
  LABEL_OWNER,
  LABEL_PROJECT,
  LABEL_SESSION,
  ownedLabels,
} from '../manifest.ts';
import { envFileBody, reattachByMarker, shellQuote } from '../marker.ts';
import {
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  SandboxAdapterRefusal,
  type SandboxCapabilities,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import { readLimited, readPrefix } from './connect.ts';
import type { DesktopCommand } from './docker.ts';

export type MaritimeCredential = <T>(use: (apiKey: string) => Promise<T>) => Promise<T>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MaritimeOptions = {
  /** Lends the API key for one call; for example a sealed-secret reader. */
  credential: MaritimeCredential;
  fetch?: Fetch;
  apiUrl?: string;
  /**
   * How long past its own timeout a command may run before the adapter ends
   * its process group itself.
   */
  graceMs?: number;
  /** Names for staged files; only a test replaces it, so its requests repeat. */
  nonce?: () => string;
  /** The clock the keep-awake touch is judged by; only a test replaces it. */
  now?: () => number;
};

const MiB = 1024 * 1024;
export const MARITIME_API_URL = 'https://api.maritime.sh';
const COMPUTERS = '/api/v1/computers';
/** Maritime's cap on one file read or write. */
export const MARITIME_FILE_LIMIT = 8 * MiB;
/** Maritime's cap on one `exec`, in seconds, and on its command's length. */
const EXEC_SECONDS = 30;
const COMMAND_CHARS = 8192;
const REQUEST_TIMEOUT_MS = 60_000;
/** A first create can take up to a minute on a cold placement. */
const CREATE_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 30_000;
/** One poll waits inside the computer for at most this many quarter seconds. */
const POLL_STEPS = 80;
const POLL_STEP_MS = 250;
/** Maritime sleeps a computer after five minutes without an action. */
const TOUCH_EVERY_MS = 4 * 60_000;
/** How long, after its last use, a computer is counted awake: Maritime's five minutes and a margin. */
export const MARITIME_IDLE_SECONDS = 5 * 60 + 30;
const COMPUTER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAIN = /^[A-Za-z0-9._-]{1,128}$/;
const NOT_FOUND_EXIT = 3;

export const MARITIME_WORKDIR = '/work';
/** Where `/work` lives: on the disk Maritime keeps. */
export const MARITIME_WORK_STORE = '/data/work';
export const MARITIME_MARKER_ROOT = '/data/.melete-exec';
export const MARITIME_RUN_ROOT = '/data/.melete-run';
export const MARITIME_TMP_ROOT = '/data/.melete-tmp';
/** The sandbox's own environment (`SandboxSpec.env`), read by every command. */
const SANDBOX_ENV_FILE = `${MARITIME_RUN_ROOT}/sandbox-env`;
/** The roots Maritime's files API reaches. */
const FILE_ROOTS = ['/data/', '/home/desk/'];

/** The desktops this adapter offers, by the image name a connection gives. */
export const MARITIME_IMAGES: Readonly<Record<string, { os: 'linux'; arch: 'x86_64' | 'arm64' }>> =
  {
    linux: { os: 'linux', arch: 'x86_64' },
    'linux-arm64': { os: 'linux', arch: 'arm64' },
  };

/**
 * Make the kept directories and `/work`, as a link to `/data/work`, through
 * `sudo` where the desktop user cannot. Exit 4: the kept disk is not writable;
 * exit 5: `/work` cannot be made.
 */
const PREPARE = [
  'w="$1"; s="$2"; r="$3"; t="$4"',
  'mkdir -p -m 0700 "$r" "$t" 2>/dev/null',
  'mkdir -p "$s" 2>/dev/null',
  '[ -d "$s" ] && [ -w "$s" ] && [ -d "$r" ] && [ -w "$r" ] && [ -d "$t" ] && [ -w "$t" ] || exit 4',
  '[ -e "$w" ] || ln -s "$s" "$w" 2>/dev/null || sudo -n ln -s "$s" "$w" 2>/dev/null',
  '[ -d "$w" ] && [ -w "$w" ] || exit 5',
  'echo ready',
].join('\n');

/**
 * Start an admitted command in the background. `$1` is the base of its files
 * in the run root, `$2` the working directory, `$3` its stdin, `$4` its
 * environment file or `-`, `$5` its timeout in seconds, `$6` the sandbox's
 * environment file and `$7` the runner. Exit 112 means nothing started.
 */
const LAUNCH = [
  'b="$1"; c="$2"; i="$3"; e="$4"',
  'cd "$c" 2>/dev/null || exit 112',
  '[ -f "$b.cmd" ] || exit 112',
  '[ "$e" = - ] || [ -f "$e" ] || exit 112',
  'rm -f "$b.rc" "$b.rc.tmp" "$b.log"',
  'setsid sh -c "$7" melete-run "$b" "$e" "$5" "$6" < "$i" > /dev/null 2>&1 &',
  'echo "pid=$!"',
].join('\n');

/**
 * The background half: environments, then the command under `timeout`, then
 * its status, written aside and renamed so a reader never sees half of it.
 */
const RUNNER = [
  'b="$1"',
  '[ -f "$4" ] && . "$4"',
  '[ "$2" = - ] || . "$2"',
  '[ "$2" = - ] || rm -f "$2"',
  `timeout -s KILL "$3" sh -c '. "$1"' melete-cmd "$b.cmd" > "$b.log" 2>&1`,
  'printf \'%s\' "$?" > "$b.rc.tmp"',
  'mv -f "$b.rc.tmp" "$b.rc"',
].join('\n');

/** Wait inside the computer for the status; exit 75 while there is none yet. */
function pollScript(steps: number): string {
  return [
    'b="$1"',
    ...Array.from({ length: steps }, () => `[ -f "$b.rc" ] || sleep ${POLL_STEP_MS / 1000}`),
    '[ -f "$b.rc" ] || exit 75',
    'cat "$b.rc"',
    "printf '\\n'",
    'head -c 4096 "$b.log"',
  ].join('\n');
}
const PENDING_EXIT = 75;

const LIST =
  '[ -d "$1" ] || exit 3\ncd "$1" && find . -mindepth 1 -printf \'%y %s %m %T@:%C@:%i %P\\0\' > "$2"';
const STAGE_OUT = '[ -f "$1" ] || exit 3\nhead -c "$2" "$1" > "$3"';

/** Labels a computer carries in its name; Maritime has no labels of its own. */
const NAME_PREFIX = 'melete v1';

export function maritimeCapabilities(): SandboxCapabilities {
  return {
    adapter: 'maritime',
    // Maritime's documentation: each computer is its own micro-VM with its own disk.
    isolation: 'microvm',
    // Maritime documents no egress control for computers. The agent's own
    // computer has open egress, and nothing narrower can be promised.
    egress: ['open'],
    persistence: ['none', 'pause'],
    maxLifetimeSeconds: 86_400,
    maxIdleSeconds: null,
    streaming: false,
    reattach: 'marker_only',
    // On the kept disk, and inside the files API's reach.
    markerRoot: MARITIME_MARKER_ROOT,
    // No inbound port or preview URL is documented for computers.
    ports: 'none',
    image: 'template',
    // A flat monthly price per machine; the coarsest unit this type names.
    billing: 'per_hour',
    regions: [],
    maxUploadBytes: MARITIME_FILE_LIMIT,
    // A computer sleeps after five minutes without an action.
    keepAwake: false,
  };
}

export class MaritimeApiError extends Error {
  override readonly name = 'MaritimeApiError';
  constructor(
    readonly status: number,
    /** Maritime's error slug, such as `concurrency` or `human_in_control`. */
    readonly slug: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

type ComputerRecord = {
  id?: unknown;
  status?: unknown;
  name?: unknown;
  externalUserId?: unknown;
  mode?: unknown;
};

const scrub = (text: string, secrets: readonly (string | undefined)[]) =>
  secrets.reduce<string>(
    (current, secret) => (secret ? current.split(secret).join('[redacted]') : current),
    text,
  );

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Statuses Maritime's documentation implies; its schema names none. */
const AWAKE = new Set([
  'awake',
  'running',
  'ready',
  'active',
  'waking',
  'creating',
  'booting',
  'starting',
]);
const ASLEEP = new Set(['asleep', 'sleeping', 'sleep', 'suspended', 'stopped', 'snapshotted']);

/**
 * The stable id a computer is found by: a hash of the installation, the
 * connection and the session it serves. Never a person's email or name.
 */
export function maritimeExternalUserId(labels: Readonly<Record<string, string>>): string {
  const parts = [
    labels[LABEL_OWNER] ?? '',
    labels[LABEL_PROJECT] ?? '',
    labels[LABEL_CONNECTION] ?? '',
    labels[LABEL_SESSION] ?? '',
  ];
  return `melete-${sha256(parts.join('\0')).slice(0, 48)}`;
}

/** The computer's name: the labels reconciliation needs, in plain text. */
export function maritimeName(labels: Readonly<Record<string, string>>): string {
  const session = labels[LABEL_SESSION];
  const project = labels[LABEL_PROJECT];
  if (labels[LABEL_OWNER] !== 'v1' || !project || !session)
    throw new SandboxAdapterRefusal(
      'a Maritime computer needs its owner, project and session labels',
    );
  const name = `${NAME_PREFIX} ${project} ${labels[LABEL_CONNECTION] ?? '-'} ${session}`;
  if (name.length > 256)
    throw new SandboxAdapterRefusal('the labels do not fit in a Maritime computer name');
  return name;
}

/** The labels read back from a computer's name, or null when it is not one of ours. */
export function maritimeLabels(name: unknown): Record<string, string> | null {
  if (typeof name !== 'string' || !name.startsWith(`${NAME_PREFIX} `)) return null;
  const [project, connection, session, ...rest] = name.slice(NAME_PREFIX.length + 1).split(' ');
  if (rest.length || !project || !connection || !session) return null;
  if (![project, connection, session].every((value) => PLAIN.test(value))) return null;
  return {
    [LABEL_OWNER]: 'v1',
    [LABEL_PROJECT]: project,
    ...(connection === '-' ? {} : { [LABEL_CONNECTION]: connection }),
    [LABEL_SESSION]: session,
  };
}

/** What one Maritime computer action asks for: the documented canonical schema. */
export type MaritimeAction = {
  action: string;
  coordinate?: [number, number];
  text?: string;
  repeat?: number;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  noScreenshot?: boolean;
};

/**
 * Melete's desktop commands as Maritime actions. Coordinates are in the frame
 * of Maritime's last screenshot. What has no Maritime action is refused.
 */
export function maritimeActionsFor(command: DesktopCommand): MaritimeAction[] {
  const point = (x: number, y: number): [number, number] => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 4096 || y >= 4096)
      throw new SandboxAdapterRefusal('a screen position must be a whole number on the screen');
    return [x, y];
  };
  switch (command.kind) {
    case 'screenshot':
      return [{ action: 'screenshot' }];
    case 'click': {
      const action =
        command.count === 1
          ? ({ 1: 'left_click', 2: 'middle_click', 3: 'right_click' } as const)[command.button]
          : command.button === 1
            ? command.count === 2
              ? 'double_click'
              : 'triple_click'
            : null;
      if (!action)
        throw new SandboxAdapterRefusal('Maritime repeats clicks of the left button only');
      return [{ action, coordinate: point(command.x, command.y) }];
    }
    case 'type':
      if (!command.text.length || command.text.length > 4096 || command.text.includes('\0'))
        throw new SandboxAdapterRefusal('text to type is 1 to 4096 characters');
      return [{ action: 'type', text: command.text }];
    case 'key':
      if (
        !command.keys.length ||
        command.keys.length > 16 ||
        command.keys.some((key) => !/^[A-Za-z0-9_+]{1,48}$/.test(key))
      )
        throw new SandboxAdapterRefusal('keys are 1 to 16 names such as Return or ctrl+l');
      return command.keys.map((key) => ({ action: 'key', text: key }));
    case 'scroll':
      if (!Number.isInteger(command.dy) || command.dy === 0 || Math.abs(command.dy) > 50)
        throw new SandboxAdapterRefusal('a scroll is 1 to 50 steps up or down');
      return [
        {
          action: 'scroll',
          coordinate: point(command.x, command.y),
          scrollDirection: command.dy > 0 ? 'down' : 'up',
          scrollAmount: Math.abs(command.dy),
        },
      ];
    case 'info':
    case 'text':
    case 'open':
    case 'input':
      throw new SandboxAdapterRefusal(`a Maritime computer has no ${command.kind} command`);
  }
}

export type MaritimeViewer = { url: string; expiresAt: string; mode: 'watch' | 'control' };
export type MaritimeScreenshot = {
  bytes: Uint8Array;
  type: string;
  frameId: number | null;
  width: number | null;
  height: number | null;
};

/** The Maritime provider: the sandbox seam, plus the computer's screen and its viewer links. */
export interface MaritimeProvider extends SandboxProvider {
  readonly maritime: true;
  /** Run Maritime actions in order; the last one's result comes back. */
  act(
    handle: SandboxHandle,
    actions: readonly MaritimeAction[],
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  screenshot(
    handle: SandboxHandle,
    signal: AbortSignal,
    format?: 'png' | 'jpeg',
  ): Promise<MaritimeScreenshot>;
  /**
   * A signed link to the computer's screen: `watch` to look, `control` for a
   * person to take the wheel (Maritime refuses agent actions while they hold
   * it). The link is a credential for that one computer until it expires:
   * hand it to the person, never to a log, a receipt or the model.
   */
  viewerLink(
    handle: SandboxHandle,
    options: { mode: 'watch' | 'control'; ttlSeconds?: number; reason?: string },
    signal: AbortSignal,
  ): Promise<MaritimeViewer>;
}

export const isMaritimeProvider = (provider: SandboxProvider): provider is MaritimeProvider =>
  (provider as Partial<MaritimeProvider>).maritime === true;

export function createMaritimeProvider(options: MaritimeOptions): MaritimeProvider {
  const fetchImpl: Fetch = options.fetch ?? fetch;
  const apiUrl = (options.apiUrl ?? MARITIME_API_URL).replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl))
    throw new Error('the Maritime API must be an https URL');
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const nonce = options.nonce ?? (() => randomBytes(8).toString('hex'));
  const now = options.now ?? Date.now;
  const capabilities = maritimeCapabilities();
  /** When each computer was last given an action, so it does not sleep under a command. */
  const touched = new Map<string, number>();

  const computerId = (handle: SandboxHandle | string) => {
    const id = typeof handle === 'string' ? handle : handle.providerSandboxId;
    if (!COMPUTER_ID.test(id)) throw new SandboxAdapterRefusal('not a Maritime computer id');
    return id;
  };

  type Answer = { status: number; json: unknown; response: Response | null; text: string };

  /**
   * One call with the key the caller was lent. Throws `SandboxTransportError`
   * when no answer came back, `MaritimeApiError` for a status not in `accept`.
   * With `stream`, an accepted answer's body is left unread for the caller.
   */
  async function api(
    method: string,
    path: string,
    body: { json?: unknown; bytes?: Uint8Array } | undefined,
    accept: readonly number[],
    signal: AbortSignal,
    settings: { timeoutMs?: number; stream?: boolean } = {},
  ): Promise<Answer> {
    return options.credential(async (key) => {
      const what = `${method} ${path.split('?')[0]}`;
      let response: Response;
      try {
        response = await fetchImpl(`${apiUrl}${COMPUTERS}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            ...(body?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(body?.bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
          },
          ...(body?.json !== undefined ? { body: JSON.stringify(body.json) } : {}),
          ...(body?.bytes ? { body: body.bytes } : {}),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(settings.timeoutMs ?? REQUEST_TIMEOUT_MS),
          ]),
        });
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`Maritime did not answer ${what}: ${describeError(error)}`, [key]),
        );
      }
      if (accept.includes(response.status) && settings.stream)
        return { status: response.status, json: null, response, text: '' };
      let text: string;
      try {
        text = new TextDecoder().decode(await readLimited(response, 4 * MiB));
      } catch (error) {
        throw new SandboxTransportError(
          scrub(`the Maritime answer to ${what} could not be read: ${describeError(error)}`, [key]),
        );
      }
      text = scrub(text, [key]);
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {}
      }
      if (!accept.includes(response.status)) {
        const parsed = (json ?? {}) as {
          error?: unknown;
          message?: unknown;
          retryAfterS?: unknown;
        };
        const slug = typeof parsed.error === 'string' ? parsed.error : 'unknown';
        const detail = typeof parsed.message === 'string' ? parsed.message : text;
        throw new MaritimeApiError(
          response.status,
          slug,
          `Maritime answered ${response.status} (${slug}) to ${what}: ${detail.slice(0, 300)}`,
          typeof parsed.retryAfterS === 'number' ? parsed.retryAfterS : null,
        );
      }
      return { status: response.status, json, response: null, text };
    });
  }

  const record = async (id: string, signal: AbortSignal): Promise<ComputerRecord | null> => {
    const { status, json } = await api('GET', `/${id}`, undefined, [200, 404], signal);
    return status === 404 ? null : ((json ?? {}) as ComputerRecord);
  };

  /** A 404 about a computer is Maritime saying it is gone. */
  const goneOr = (id: string, error: unknown, what: string): unknown =>
    error instanceof MaritimeApiError && error.status === 404
      ? new SandboxGone(`Maritime has no computer ${id} to ${what}`)
      : error;

  /**
   * Wake the computer and give it one action, at most every four minutes, so
   * it is awake now and does not sleep under a running command. A person
   * holding it (409) keeps it awake themselves.
   */
  async function touch(id: string, signal: AbortSignal, force = false): Promise<void> {
    const last = touched.get(id);
    if (!force && last !== undefined && now() - last < TOUCH_EVERY_MS) return;
    try {
      await api('POST', `/${id}/wake`, undefined, [200], signal, { timeoutMs: CREATE_TIMEOUT_MS });
      await api(
        'POST',
        `/${id}/actions`,
        { json: { action: 'cursor_position', noScreenshot: true } },
        [200, 409],
        signal,
      );
    } catch (error) {
      throw goneOr(id, error, 'wake');
    }
    touched.set(id, now());
  }

  type Ran = { exitCode: number | null; stdout: string; stderr: string };

  /** One `exec`. Throws when no answer came back or Maritime refused it. */
  async function execRaw(id: string, command: string, signal: AbortSignal): Promise<Ran> {
    if (command.length > COMMAND_CHARS)
      throw new SandboxAdapterRefusal('the command is longer than Maritime accepts');
    const { json } = await api(
      'POST',
      `/${id}/exec`,
      { json: { command, timeoutS: EXEC_SECONDS } },
      [200],
      signal,
      { timeoutMs: (EXEC_SECONDS + 30) * 1000 },
    );
    const answer = (json ?? {}) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof answer.exitCode === 'number' ? answer.exitCode : null,
      stdout: typeof answer.stdout === 'string' ? answer.stdout : '',
      stderr: typeof answer.stderr === 'string' ? answer.stderr : '',
    };
  }

  const commandOf = (script: string, args: readonly string[]) =>
    ['/bin/sh', '-c', script, 'melete', ...args].map(shellQuote).join(' ');

  /** Run one of the adapter's own short commands; never an admitted one. */
  async function run(
    id: string,
    script: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<Ran> {
    try {
      return await execRaw(id, commandOf(script, args), signal);
    } catch (error) {
      throw goneOr(id, error, 'run a command on');
    }
  }

  async function putRaw(id: string, path: string, bytes: Uint8Array, signal: AbortSignal) {
    try {
      await api(
        'PUT',
        `/${id}/files?${new URLSearchParams({ path })}`,
        { bytes },
        [200, 201, 204],
        signal,
      );
    } catch (error) {
      throw goneOr(id, error, 'write a file on');
    }
  }

  /** A file under the files API's roots, read straight; null when Maritime has none there. */
  async function getRaw(
    id: string,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    let answer: Answer;
    try {
      answer = await api(
        'GET',
        `/${id}/files?${new URLSearchParams({ path })}`,
        undefined,
        [200],
        signal,
        { stream: true },
      );
    } catch (error) {
      if (error instanceof MaritimeApiError && error.status === 404) {
        // The same status says the computer is gone; ask which it is.
        if (!(await record(id, signal))) throw new SandboxGone(`Maritime has no computer ${id}`);
        return null;
      }
      throw error;
    }
    return readPrefix(answer.response as Response, maxBytes);
  }

  const direct = (path: string) =>
    FILE_ROOTS.some((root) => path.startsWith(root)) && !path.split('/').includes('..');

  const checkPath = (path: string) => {
    if (!path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.'))
      throw new SandboxAdapterRefusal('a path must be absolute and plain');
    if (path.includes('\0')) throw new SandboxAdapterRefusal('a path cannot hold a NUL byte');
  };

  /** Remove the adapter's own staged files; a failure leaves them for the next time. */
  async function cleanup(id: string, paths: readonly string[]): Promise<void> {
    if (!paths.length) return;
    await run(id, 'rm -f -- "$@"', paths, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).catch(() => {});
  }

  function checkSpec(spec: SandboxSpec): { os: 'linux'; arch: 'x86_64' | 'arm64' } {
    if (!capabilities.egress.includes(spec.egress.kind))
      throw new SandboxAdapterRefusal(
        `the maritime adapter cannot enforce ${spec.egress.kind}: Maritime documents no egress control`,
      );
    if (spec.region !== null) throw new SandboxAdapterRefusal('Maritime placement is not offered');
    if (spec.idleSeconds !== null)
      throw new SandboxAdapterRefusal('Maritime idle timeouts are fixed at five minutes');
    if (
      !Number.isInteger(spec.lifetimeSeconds) ||
      spec.lifetimeSeconds <= 0 ||
      spec.lifetimeSeconds > capabilities.maxLifetimeSeconds
    )
      throw new SandboxAdapterRefusal('the lifetime is outside what this adapter allows');
    if (spec.cpu !== undefined || spec.memoryMb !== undefined || spec.diskMb !== undefined)
      throw new SandboxAdapterRefusal(
        'Maritime sizes a computer from the account settings, not per computer',
      );
    if (spec.workdir !== MARITIME_WORKDIR)
      throw new SandboxAdapterRefusal(`the working directory must be ${MARITIME_WORKDIR}`);
    for (const [key, value] of Object.entries(spec.labels))
      if (!PLAIN.test(key) || !PLAIN.test(value))
        throw new SandboxAdapterRefusal('a label is not plain enough to keep');
    const image = MARITIME_IMAGES[spec.image];
    if (!image)
      throw new SandboxAdapterRefusal(
        `Maritime runs its own desktop; the image is ${Object.keys(MARITIME_IMAGES).join(' or ')}, not a custom image`,
      );
    return image;
  }

  /** Wake, make `/work` and the kept directories, and write the sandbox's environment. */
  async function ready(id: string, spec: SandboxSpec, signal: AbortSignal): Promise<void> {
    await touch(id, signal, true);
    const prepared = await run(
      id,
      PREPARE,
      [MARITIME_WORKDIR, MARITIME_WORK_STORE, MARITIME_RUN_ROOT, MARITIME_TMP_ROOT],
      signal,
    );
    if (prepared.exitCode === 4)
      throw new SandboxAdapterRefusal('the computer has no writable /data for the workspace');
    if (prepared.exitCode === 5)
      throw new SandboxAdapterRefusal(
        'the computer has no writable /work, and the desktop user cannot make one (no passwordless sudo)',
      );
    if (prepared.exitCode !== 0)
      throw new SandboxTransportError(`preparing the computer exited ${prepared.exitCode}`);
    await putRaw(id, SANDBOX_ENV_FILE, envFileBody(spec.env), signal);
  }

  const handleOf = (id: string): SandboxHandle => ({
    providerSandboxId: id,
    imageDigest: null,
    region: null,
  });

  const provider: MaritimeProvider = {
    capabilities,
    maritime: true,

    async create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
      const image = checkSpec(spec);
      const name = maritimeName(spec.labels);
      signal.throwIfAborted();
      // Get-or-create: a create whose answer was lost finds the same computer
      // when it is sent again, and reconciliation finds it by its name.
      const { json } = await api(
        'POST',
        '',
        { json: { externalUserId: maritimeExternalUserId(spec.labels), name, ...image } },
        [200, 201],
        signal,
        { timeoutMs: CREATE_TIMEOUT_MS },
      );
      const created = (json ?? {}) as ComputerRecord;
      const id = typeof created.id === 'string' ? created.id : '';
      if (!COMPUTER_ID.test(id))
        throw new SandboxTransportError('Maritime answered without a computer id');
      try {
        await ready(id, spec, signal);
        return handleOf(id);
      } catch (error) {
        // A computer this adapter will not use is not kept.
        touched.delete(id);
        await api(
          'DELETE',
          `/${id}`,
          undefined,
          [204, 404],
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ).catch(() => {});
        throw error;
      }
    },

    async connect(handle: SandboxHandle, signal: AbortSignal): Promise<void> {
      const id = computerId(handle);
      if (!(await record(id, signal))) throw new SandboxGone(`Maritime has no computer ${id}`);
      await touch(id, signal, true);
    },

    async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
      const id = computerId(handle);
      if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
        throw new SandboxAdapterRefusal('a command timeout must be a positive number of ms');
      if (!spec.cwd.startsWith('/'))
        throw new SandboxAdapterRefusal('a working directory must be absolute');
      if (spec.stdin && spec.stdin.byteLength > MARITIME_FILE_LIMIT)
        throw new SandboxAdapterRefusal('stdin above 8 MiB is refused');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(spec.marker))
        throw new SandboxAdapterRefusal('a marker must be an action id');
      const base = `${MARITIME_RUN_ROOT}/${spec.marker}`;
      const hasEnv = spec.env !== undefined && Object.keys(spec.env).length > 0;
      const stdin = spec.stdin ? `${base}.in` : '/dev/null';
      const envFile = hasEnv ? `${base}.env` : '-';
      const files = [`${base}.cmd`, ...(spec.stdin ? [stdin] : []), ...(hasEnv ? [envFile] : [])];
      const command = commandOf(LAUNCH, [
        base,
        spec.cwd,
        stdin,
        envFile,
        String(spec.timeoutMs / 1000),
        SANDBOX_ENV_FILE,
        RUNNER,
      ]);
      // Everything before the launch is sent is provably not the command.
      try {
        await touch(id, signal);
        await putRaw(
          id,
          `${base}.cmd`,
          new TextEncoder().encode(`${spec.argv.map(shellQuote).join(' ')}\n`),
          signal,
        );
        if (spec.stdin) await putRaw(id, stdin, spec.stdin, signal);
        if (hasEnv) await putRaw(id, envFile, envFileBody(spec.env ?? {}), signal);
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal || error instanceof SandboxGone) throw error;
        throw new SandboxStartRefused(`the command was not sent: ${describeError(error)}`);
      }
      // The launcher's own words name the action, so a lost launch can be told apart.
      const launch = `: melete-launch ${spec.marker}; ${command}`;
      if (launch.length > COMMAND_CHARS)
        throw new SandboxAdapterRefusal('the launch is longer than Maritime accepts');
      let launched: Ran;
      try {
        launched = await execRaw(id, launch, signal);
      } catch (error) {
        if (
          error instanceof MaritimeApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        )
          // Refused before the command reached the computer's shell: a plan
          // refusal, a person holding the desktop, or a malformed request.
          throw new SandboxStartRefused(`Maritime refused the command: ${error.message}`);
        throw new SandboxTransportError(
          `no answer to the command: ${describeError(error)}`,
          'unknown',
        );
      }
      const started = performance.now();
      const pid = /^pid=(\d+)$/m.exec(launched.stdout)?.[1];
      if (launched.exitCode !== 0 || !pid) {
        await cleanup(id, [...files, `${base}.rc`, `${base}.log`]);
        // 112 is the launcher saying nothing started; the service decides the rest.
        const said = new TextEncoder().encode(`${launched.stdout}${launched.stderr}`);
        const output = said.slice(0, spec.maxOutputBytes);
        return {
          started: launched.exitCode === 112 ? 'no' : 'unknown',
          state: 'exited',
          exitCode: launched.exitCode,
          signal: null,
          timedOut: false,
          durationMs: 0,
          output,
          totalBytes: said.byteLength,
          captureLimited: said.byteLength > output.byteLength,
        };
      }
      // From here the command has started; whatever is lost now, the marker decides.
      const after = (error: unknown) =>
        new SandboxTransportError(`the command started, then: ${describeError(error)}`, 'yes');
      const steps = Math.max(
        1,
        Math.min(POLL_STEPS, Math.ceil((spec.timeoutMs + graceMs) / POLL_STEP_MS)),
      );
      const poll = commandOf(pollScript(steps), [base]);
      let failures = 0;
      let lastError: unknown = null;
      for (;;) {
        if (performance.now() - started > spec.timeoutMs + graceMs) {
          // The command outlived its own `timeout`: end its whole session.
          await run(
            id,
            // The runner leads a session of its own; `timeout` runs the
            // command in a group inside it, so the session is what is ended.
            'pkill -KILL -s "$1" 2>/dev/null; kill -KILL -- "-$1" 2>/dev/null; true',
            [pid],
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ).catch(() => {});
          if (lastError && failures > 0) throw after(lastError);
          await cleanup(id, files);
          return {
            started: 'yes',
            state: 'killed',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
            durationMs: Math.round(performance.now() - started),
            output: new Uint8Array(),
            totalBytes: 0,
            captureLimited: false,
          };
        }
        let polled: Ran;
        try {
          signal.throwIfAborted();
          await touch(id, signal);
          polled = await execRaw(id, poll, signal);
          failures = 0;
          lastError = null;
        } catch (error) {
          if (signal.aborted) throw after(error);
          // A poll only reads, so asking again is safe; a person holding the
          // desktop or a lost answer is waited out until the deadline.
          failures += 1;
          lastError = error;
          const wait =
            error instanceof MaritimeApiError && error.retryAfterSeconds
              ? error.retryAfterSeconds * 1000
              : Math.min(5_000, 250 * 2 ** failures);
          try {
            await delay(wait, signal);
          } catch (aborted) {
            throw after(aborted);
          }
          continue;
        }
        if (polled.exitCode === PENDING_EXIT) continue;
        const newline = polled.stdout.indexOf('\n');
        const status = (newline < 0 ? polled.stdout : polled.stdout.slice(0, newline)).trim();
        if (polled.exitCode !== 0 || !/^\d{1,3}$/.test(status))
          throw after(new Error(`the status could not be read (exit ${polled.exitCode})`));
        const durationMs = Math.round(performance.now() - started);
        await cleanup(id, [...files, `${base}.rc`, `${base}.log`]);
        const exitCode = Number(status);
        // `timeout -s KILL` reports the kill it sent as 137.
        const timedOut = exitCode === 137 && durationMs >= spec.timeoutMs - 50;
        const said = new TextEncoder().encode(newline < 0 ? '' : polled.stdout.slice(newline + 1));
        const output = said.slice(0, spec.maxOutputBytes);
        return {
          started: 'yes',
          state: timedOut ? 'killed' : 'exited',
          exitCode: timedOut ? null : exitCode,
          signal: timedOut ? 'SIGKILL' : null,
          timedOut,
          durationMs,
          output,
          totalBytes: said.byteLength,
          captureLimited: said.byteLength > output.byteLength,
        };
      }
    },

    reattach(handle: SandboxHandle, marker: string, signal: AbortSignal) {
      return reattachByMarker(provider, handle, marker, signal);
    },

    async putFiles(handle, files, signal): Promise<void> {
      const id = computerId(handle);
      await touch(id, signal);
      // Every file is staged on the kept disk and moved into place, so a file
      // outside the files API's roots, and a parent that does not exist yet,
      // need nothing more.
      let batch: string[] = [];
      let length = 0;
      const flush = async () => {
        if (!batch.length) return;
        const count = batch.length / 4;
        const script = Array.from(
          { length: count },
          () =>
            'mkdir -p -- "$1" && mv -f -- "$2" "$3" && chmod "$4" -- "$3" || exit 1; shift; shift; shift; shift',
        ).join('\n');
        const moved = await run(id, script, batch, signal);
        if (moved.exitCode !== 0)
          throw new SandboxTransportError(
            `placing uploaded files exited ${moved.exitCode}: ${moved.stdout}${moved.stderr}`.slice(
              0,
              300,
            ),
          );
        batch = [];
        length = 0;
      };
      for await (const file of files) {
        checkPath(file.path);
        if (file.bytes.byteLength > MARITIME_FILE_LIMIT)
          throw new SandboxAdapterRefusal(
            `a file above Maritime's 8 MiB transfer limit: ${file.path}`,
          );
        const stage = `${MARITIME_TMP_ROOT}/put-${nonce()}`;
        await putRaw(id, stage, file.bytes, signal);
        const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
        const words = [parent, stage, file.path, (file.mode & 0o111) !== 0 ? '755' : '644'];
        const added = words.reduce((sum, word) => sum + shellQuote(word).length + 1, 110);
        if (length + added > COMMAND_CHARS - 600 || batch.length / 4 >= 40) await flush();
        batch.push(...words);
        length += added;
      }
      await flush();
    },

    async listFiles(handle, root, signal): Promise<FileEntry[]> {
      const id = computerId(handle);
      const base = root.replace(/\/+$/, '') || '/';
      checkPath(base);
      await touch(id, signal);
      const stage = `${MARITIME_TMP_ROOT}/list-${nonce()}`;
      const listed = await run(id, LIST, [base, stage], signal);
      if (listed.exitCode === NOT_FOUND_EXIT) {
        throw new SandboxFileNotFound(`no such directory: ${root}`);
      }
      if (listed.exitCode !== 0) {
        await cleanup(id, [stage]);
        throw new SandboxTransportError(`listing ${root} failed with exit ${listed.exitCode}`);
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await getRaw(id, stage, MARITIME_FILE_LIMIT, signal);
      } finally {
        await cleanup(id, [stage]);
      }
      if (!bytes) throw new SandboxTransportError('the listing was not written');
      if (bytes.byteLength >= MARITIME_FILE_LIMIT)
        throw new SandboxAdapterRefusal('the listing is larger than the adapter reads');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new SandboxAdapterRefusal('the listing holds a name that is not UTF-8');
      }
      return text
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const match = /^([a-z]) (\d+) ([0-7]+) (\S+) (.+)$/s.exec(entry);
          if (!match) throw new SandboxAdapterRefusal('the listing could not be read');
          const [, type, size, mode, stamp, relative] = match as unknown as [
            string,
            string,
            string,
            string,
            string,
            string,
          ];
          if (type !== 'f' && type !== 'd' && type !== 'l')
            throw new SandboxAdapterRefusal(
              `the listing holds an entry of type ${type}: ${relative}`,
            );
          return {
            path: relative,
            size: type === 'f' ? Number(size) : 0,
            mode: Number.parseInt(mode, 8) & 0o777,
            symlink: type === 'l',
            directory: type === 'd',
            ...(stamp === '0.0:0.0:0' ? {} : { stamp: `t:${stamp}` }),
          };
        });
    },

    async getFile(handle, path, maxBytes, signal): Promise<Uint8Array> {
      const id = computerId(handle);
      checkPath(path);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new SandboxAdapterRefusal('a read takes a whole number of bytes');
      await touch(id, signal);
      const limit = Math.min(maxBytes, MARITIME_FILE_LIMIT);
      // Under the files API's roots a file is read straight; the marker's own
      // files, read after every command, are there.
      if (direct(path) && maxBytes <= MARITIME_FILE_LIMIT) {
        try {
          const bytes = await getRaw(id, path, limit, signal);
          if (bytes) return bytes;
          throw new SandboxFileNotFound(`no such file: ${path}`);
        } catch (error) {
          // A directory, a link out of the roots or a file above the cap:
          // the staged read below answers those the way a shell would.
          if (!(error instanceof MaritimeApiError) || error.status === 404) throw error;
        }
      }
      const stage = `${MARITIME_TMP_ROOT}/get-${nonce()}`;
      const staged = await run(id, STAGE_OUT, [path, String(limit), stage], signal);
      if (staged.exitCode === NOT_FOUND_EXIT)
        throw new SandboxFileNotFound(`no such file: ${path}`);
      let bytes: Uint8Array | null = null;
      try {
        if (staged.exitCode !== 0)
          throw new SandboxTransportError(`reading ${path} exited ${staged.exitCode}`);
        bytes = await getRaw(id, stage, limit, signal);
      } finally {
        await cleanup(id, [stage]);
      }
      if (!bytes) throw new SandboxTransportError(`the copy of ${path} was not written`);
      if (maxBytes > MARITIME_FILE_LIMIT && bytes.byteLength >= MARITIME_FILE_LIMIT)
        throw new SandboxAdapterRefusal(
          `${path} is larger than Maritime's 8 MiB transfer limit; read at most 8 MiB of it`,
        );
      return bytes;
    },

    async pause(handle, signal): Promise<{ resumeRef: string }> {
      const id = computerId(handle);
      try {
        // Memory is snapshotted and the disk kept; the computer is free while it sleeps.
        await api('POST', `/${id}/sleep`, undefined, [200], signal);
      } catch (error) {
        throw goneOr(id, error, 'put to sleep');
      }
      touched.delete(id);
      return { resumeRef: id };
    },

    async resume(resumeRef, spec, signal): Promise<SandboxHandle> {
      const id = computerId(resumeRef);
      checkSpec(spec);
      if (!(await record(id, signal)))
        throw new SandboxGone(`Maritime has no computer ${id} to wake`);
      // The same computer comes back: its disk always, its open windows while
      // the memory snapshot lasts (seven days).
      await ready(id, spec, signal);
      return handleOf(id);
    },

    async destroy(handle, signal): Promise<void> {
      const id = computerId(handle);
      // Maritime deletes the computer's disk and snapshots with it.
      await api('DELETE', `/${id}`, undefined, [200, 204, 404], signal);
      touched.delete(id);
    },

    async inspect(handle, signal): Promise<'running' | 'paused' | 'gone'> {
      const found = await record(computerId(handle), signal);
      if (!found) return 'gone';
      const status = String(found.status ?? '').toLowerCase();
      if (AWAKE.has(status)) return 'running';
      if (ASLEEP.has(status)) return 'paused';
      if (status === 'deleted' || status === 'deleting') return 'gone';
      throw new SandboxTransportError(
        `Maritime reported a computer status this adapter does not know: ${status.slice(0, 40)}`,
      );
    },

    async reconcile(project, live, signal, connection): Promise<string[]> {
      if (!PLAIN.test(project)) throw new SandboxAdapterRefusal('the project label is not plain');
      const { json } = await api('GET', '', undefined, [200], signal);
      const listed = ((json ?? {}) as { computers?: unknown }).computers;
      const destroyed: string[] = [];
      for (const computer of Array.isArray(listed) ? (listed as ComputerRecord[]) : []) {
        const id = typeof computer.id === 'string' ? computer.id : '';
        const labels = maritimeLabels(computer.name);
        // Ownership is decided by the labels, never by the account's listing.
        if (!COMPUTER_ID.test(id) || !labels || !ownedLabels(labels, project, connection)) continue;
        // A name can be edited; the id it was created under cannot.
        if (computer.externalUserId !== maritimeExternalUserId(labels)) continue;
        const session = labels[LABEL_SESSION];
        if (live.has(id) || (session !== undefined && live.has(session))) continue;
        await provider.destroy(handleOf(id), signal);
        destroyed.push(id);
      }
      return destroyed;
    },

    async act(handle, actions, signal): Promise<Record<string, unknown>> {
      const id = computerId(handle);
      if (!actions.length || actions.length > 50)
        throw new SandboxAdapterRefusal('Maritime runs 1 to 50 actions at a time');
      const body = actions.length === 1 ? actions[0] : { actions };
      const { json } = await api('POST', `/${id}/actions`, { json: body }, [200], signal);
      touched.set(id, now());
      const answer = (json ?? {}) as { results?: unknown };
      const last = Array.isArray(answer.results) ? answer.results[answer.results.length - 1] : json;
      return (last ?? {}) as Record<string, unknown>;
    },

    async screenshot(handle, signal, format = 'png'): Promise<MaritimeScreenshot> {
      const id = computerId(handle);
      const answer = await api(
        'GET',
        `/${id}/screenshot?${new URLSearchParams({ format })}`,
        undefined,
        [200],
        signal,
        { stream: true },
      );
      const response = answer.response as Response;
      const number = (name: string) => {
        const value = Number(response.headers.get(name));
        return Number.isFinite(value) && response.headers.has(name) ? value : null;
      };
      const meta = {
        type: response.headers.get('content-type') ?? `image/${format}`,
        frameId: number('x-frame-id'),
        width: number('x-screen-width'),
        height: number('x-screen-height'),
      };
      touched.set(id, now());
      return { bytes: await readLimited(response, 16 * MiB), ...meta };
    },

    async viewerLink(handle, request, signal): Promise<MaritimeViewer> {
      const id = computerId(handle);
      const ttl = request.ttlSeconds ?? 600;
      if (!Number.isInteger(ttl) || ttl < 30 || ttl > 3600)
        throw new SandboxAdapterRefusal('a viewer link lasts 30 seconds to an hour');
      const { json } = await api(
        'POST',
        `/${id}/viewer`,
        {
          json: {
            mode: request.mode,
            ttlS: ttl,
            ...(request.reason ? { reason: request.reason.slice(0, 512) } : {}),
          },
        },
        [200],
        signal,
      );
      const answer = (json ?? {}) as { url?: unknown; expiresAt?: unknown; mode?: unknown };
      if (typeof answer.url !== 'string' || !/^https:\/\//.test(answer.url))
        throw new SandboxTransportError('Maritime answered without a viewer link');
      if (answer.mode !== request.mode)
        throw new SandboxAdapterRefusal('Maritime minted a viewer link of another mode');
      return {
        url: answer.url,
        expiresAt: typeof answer.expiresAt === 'string' ? answer.expiresAt : '',
        mode: request.mode,
      };
    },
  };
  return provider;
}
