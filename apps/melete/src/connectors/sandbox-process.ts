/**
 * Background processes in the agent's computer, as tools on the sandbox
 * connection.
 *
 * A command through `terminal.run` ends within two minutes. Work that takes
 * longer, and servers that should keep running, are started here instead:
 * the process runs on in the agent's computer after the turn and the job
 * that started it, and any later job of the same agent can list it, read its
 * output, type into it and stop it. Each tool is one brokered action with a
 * receipt. A start is run once by its action, and starting the same command
 * again is a second process, never the first one handed back.
 *
 * Output stays in the computer in a ring of a fixed size. A read returns a
 * page of it, and that page is kept in the job workspace under
 * `.melete/proc/<process>/` with its digest on the receipt, checked against
 * the copy the service wrote. Caps and time limits are in `processes.ts`.
 */
import { createHash } from 'node:crypto';
import {
  type Action,
  type ConnectorManifest,
  compileWatchPattern,
  type DispatchResult,
  type JsonValue,
  PROCESS_LIMITS,
  PROCESS_WATCH_KINDS,
  type ProcessWatchKind,
  type Receipt,
  type SandboxConnectionConfig,
  type VerifyResult,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { SANDBOX_SYNC_ALLOWANCE_MS } from '../env.ts';
import { terminalText } from '../experience/computer.ts';
import { createProcessWatch, ProcessWatchRefusal } from '../jobs/triggers.ts';
import {
  PROCESS_SIGNALS,
  type ProcessComputer,
  type ProcessFacts,
  ProcessHelperLost,
  ProcessHelperRefusal,
  ProcessHelperUnavailable,
  type ProcessSignal,
} from '../sandbox/process-helper.ts';
import { lineOf } from '../sandbox/process-monitor.ts';
import {
  END_REASONS,
  LIVE_STATES,
  ProcessRefusal,
  type ProcessRow,
  type SandboxProcesses,
} from '../sandbox/processes.ts';
import { type SessionRow, sessionHandle } from '../sandbox/sessions.ts';
import type { SandboxProvider } from '../sandbox/types.ts';
import {
  readWorkspaceFile,
  SANDBOX_WORKDIR,
  syncIn,
  writeWorkspaceFile,
} from '../sandbox/workspace.ts';
import type { ConnectorContext } from './types.ts';

type ToolManifest = ConnectorManifest['tools'][number];

/**
 * Every process action names its step, as computer actions do: the broker
 * treats a proposal with the same arguments as the same action, so without a
 * counter a second read would return the first, and a second start of the
 * same command would hand back the first process.
 */
const step = {
  type: 'integer',
  minimum: 1,
  maximum: 1_000_000,
  description:
    'Counts your process actions in this job: 1, 2, 3 and so on. A number used before repeats nothing and returns the earlier result.',
};
const processId = { type: 'string', pattern: '^prc_[A-Za-z0-9]{8,64}$' };
const watchPattern = { type: 'string', maxLength: 1000 };
const notifySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['on'],
  properties: { on: { type: 'string', enum: [...PROCESS_WATCH_KINDS] }, pattern: watchPattern },
};
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  required: ['step', ...required],
  properties: { step, ...properties },
});
const tool = (
  name: string,
  description: string,
  input_schema: Record<string, unknown>,
  effect_class: 'read' | 'write_reversible',
): ToolManifest => ({
  name,
  description,
  input_schema,
  effect_class,
  required_scopes: [name],
  verify: true,
  requires_approval: false,
  record_schema: null,
});

export const PROCESS_TOOLS: ToolManifest[] = [
  tool(
    'process.start',
    "Start a command in the agent's computer in the background: a test suite, a build, a dev server, anything longer than two minutes. Never use & or nohup in a terminal command instead. It keeps running after this job until it ends, is stopped or reaches its time limit (two hours unless set). Returns its id and first output. Give port for a server, and notify to be woken by it.",
    schema(
      {
        command: { type: 'string', minLength: 1, maxLength: 20000 },
        cwd: { type: 'string', minLength: 1, maxLength: 1024 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: PROCESS_LIMITS.max_ttl_minutes },
        notify: notifySchema,
      },
      ['command'],
    ),
    'write_reversible',
  ),
  tool(
    'process.list',
    "List the background processes in the agent's computer, the ones running and the latest ended: state, how long, port, last line printed.",
    schema({}),
    'read',
  ),
  tool(
    'process.read',
    "Read a background process's output. Without a cursor you get its newest output; pass the next_cursor of an earlier read to continue from there. wait_seconds waits up to 30 seconds for new output.",
    schema(
      {
        process_id: processId,
        cursor: { type: 'integer', minimum: 0 },
        max_bytes: { type: 'integer', minimum: 1, maximum: PROCESS_LIMITS.read_max_bytes },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: PROCESS_LIMITS.read_max_wait_seconds,
        },
      },
      ['process_id'],
    ),
    'read',
  ),
  tool(
    'process.write',
    "Type a line into a running background process's input. Enter is pressed after it unless newline is false.",
    schema(
      {
        process_id: processId,
        text: { type: 'string', minLength: 1, maxLength: PROCESS_LIMITS.write_max_bytes },
        newline: { type: 'boolean' },
      },
      ['process_id', 'text'],
    ),
    'write_reversible',
  ),
  tool(
    'process.signal',
    'Send a signal to a running background process and everything it started.',
    schema({ process_id: processId, signal: { type: 'string', enum: [...PROCESS_SIGNALS] } }, [
      'process_id',
      'signal',
    ]),
    'write_reversible',
  ),
  tool(
    'process.stop',
    'Stop a background process: TERM, then KILL after ten seconds.',
    schema({ process_id: processId }, ['process_id']),
    'write_reversible',
  ),
  // A read: it waits, or with `later` it records a watch for this job, which is
  // Melete's own state, idempotent and bounded at a few per job.
  tool(
    'process.wait',
    'Wait up to 100 s in this turn for a background process to exit, print a line matching pattern (RE2) or listen on its port. With later, nothing waits now: this job is woken when it happens; end the turn with job.wait, event_name process:<process_id>.',
    schema(
      {
        process_id: processId,
        until: { type: 'string', enum: ['exit', 'pattern', 'listening'] },
        pattern: watchPattern,
        cursor: { type: 'integer', minimum: 0 },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: PROCESS_LIMITS.wait_max_seconds },
        later: { type: 'boolean' },
      },
      ['process_id', 'until'],
    ),
    'read',
  ),
  tool(
    'process.extend',
    'Give a running background process more time: its time limit becomes this many minutes from now, up to twelve hours from its start.',
    schema(
      {
        process_id: processId,
        ttl_minutes: { type: 'integer', minimum: 1, maximum: PROCESS_LIMITS.max_ttl_minutes },
      },
      ['process_id', 'ttl_minutes'],
    ),
    'write_reversible',
  ),
];

export const PROCESS_TOOL_NAMES = new Set(PROCESS_TOOLS.map((each) => each.name));

/** A payload this connector will not send; nothing reached the computer. */
export class ProcessPayloadRefusal extends Error {
  override readonly name = 'ProcessPayloadRefusal';
}

type Payload = Record<string, unknown>;

function integer(payload: Payload, key: string, min: number, max: number, required = false) {
  const value = payload[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ProcessPayloadRefusal(`${key} must be a whole number from ${min} to ${max}`);
  return value;
}

function string(payload: Payload, key: string, max: number, required = false) {
  const value = payload[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new ProcessPayloadRefusal(`${key} must be text of at most ${max} characters`);
  return value;
}

const PROCESS_ID = /^prc_[A-Za-z0-9]{8,64}$/;
function idOf(payload: Payload): string {
  const value = payload.process_id;
  if (typeof value !== 'string' || !PROCESS_ID.test(value))
    throw new ProcessPayloadRefusal('process_id must be an id from process.start or process.list');
  return value;
}

/** What a job asks to be woken by, checked before anything runs. */
function watchOf(
  on: unknown,
  pattern: unknown,
  where: string,
): { kind: ProcessWatchKind; pattern: string | null } {
  if (!PROCESS_WATCH_KINDS.includes(on as ProcessWatchKind))
    throw new ProcessPayloadRefusal(`${where} must be one of ${PROCESS_WATCH_KINDS.join(', ')}`);
  if (pattern === undefined) return { kind: on as ProcessWatchKind, pattern: null };
  if (on !== 'output') throw new ProcessPayloadRefusal('a pattern is for watching output');
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 1000)
    throw new ProcessPayloadRefusal('pattern must be text of at most 1000 characters');
  try {
    compileWatchPattern(pattern);
  } catch {
    throw new ProcessPayloadRefusal(
      'pattern is not a supported regular expression (RE2: no lookarounds or backreferences)',
    );
  }
  return { kind: 'output', pattern };
}

function notifyOf(payload: Payload): { kind: ProcessWatchKind; pattern: string | null } | null {
  const notify = payload.notify;
  if (notify === undefined) return null;
  if (!notify || typeof notify !== 'object' || Array.isArray(notify))
    throw new ProcessPayloadRefusal('notify must be an object with on');
  const value = notify as Payload;
  if (Object.keys(value).some((key) => key !== 'on' && key !== 'pattern'))
    throw new ProcessPayloadRefusal('notify takes on and pattern only');
  return watchOf(value.on, value.pattern, 'notify.on');
}

const WAIT_UNTIL = ['exit', 'pattern', 'listening'] as const;
type WaitUntil = (typeof WAIT_UNTIL)[number];

function waitOf(payload: Payload): {
  until: WaitUntil;
  pattern: string | null;
  seconds: number;
  later: boolean;
} {
  const until = payload.until;
  if (!WAIT_UNTIL.includes(until as WaitUntil))
    throw new ProcessPayloadRefusal(`until must be one of ${WAIT_UNTIL.join(', ')}`);
  const seconds =
    integer(payload, 'timeout_seconds', 1, PROCESS_LIMITS.wait_max_seconds) ??
    PROCESS_LIMITS.wait_default_seconds;
  if (payload.later !== undefined && typeof payload.later !== 'boolean')
    throw new ProcessPayloadRefusal('later must be true or false');
  const later = payload.later === true;
  if (until !== 'pattern') {
    if (payload.pattern !== undefined)
      throw new ProcessPayloadRefusal('a pattern is for waiting until a line matches it');
    return { until: until as WaitUntil, pattern: null, seconds, later };
  }
  const pattern = string(payload, 'pattern', 1000, true) as string;
  try {
    compileWatchPattern(pattern);
  } catch {
    throw new ProcessPayloadRefusal(
      'pattern is not a supported regular expression (RE2: no lookarounds or backreferences)',
    );
  }
  return { until: 'pattern', pattern, seconds, later };
}

/** A working directory inside the computer's `/work`, never above it. */
function cwdOf(payload: Payload): { relative: string; absolute: string } {
  const cwd = string(payload, 'cwd', 1024);
  if (cwd === undefined || cwd === '.') return { relative: '.', absolute: SANDBOX_WORKDIR };
  const parts = cwd
    .replace(/^\/work\/?/, '')
    .split('/')
    .filter(Boolean);
  if (cwd.startsWith('/') && !cwd.startsWith('/work') && cwd !== '/work')
    throw new ProcessPayloadRefusal('cwd must be inside /work');
  if (parts.some((part) => part === '..' || part.includes('\0')))
    throw new ProcessPayloadRefusal('cwd must stay inside /work');
  return parts.length
    ? { relative: parts.join('/'), absolute: `${SANDBOX_WORKDIR}/${parts.join('/')}` }
    : { relative: '.', absolute: SANDBOX_WORKDIR };
}

/** How long one dispatch of a process action may take before its outcome is unknown. */
export function processDispatchBudgetMs(
  action: Pick<Action, 'kind' | 'canonical_payload'>,
  waitForComputerMs: number,
): number {
  const payload = (action.canonical_payload ?? {}) as Payload;
  const margin = SANDBOX_SYNC_ALLOWANCE_MS + waitForComputerMs + 15_000;
  switch (action.kind) {
    case 'process.start':
      return PROCESS_LIMITS.first_output_wait_ms + margin;
    case 'process.read': {
      const wait = payload.wait_seconds;
      return (typeof wait === 'number' ? Math.min(wait, 30) * 1000 : 0) + margin;
    }
    case 'process.stop':
      return PROCESS_LIMITS.stop_grace_ms + margin;
    case 'process.wait': {
      const wait = payload.timeout_seconds;
      return (
        (typeof wait === 'number'
          ? Math.min(wait, PROCESS_LIMITS.wait_max_seconds)
          : PROCESS_LIMITS.wait_default_seconds) *
          1000 +
        margin
      );
    }
    default:
      return 30_000 + margin;
  }
}

/** How often a wait for an exit or a port asks the computer. */
const WAIT_POLL_MS = 1_000;

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Output as text a receipt can hold, and whether it was text; the digest names the real bytes. */
function shown(bytes: Uint8Array): { text: string; binary: boolean } {
  let binary = bytes.includes(0);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    binary = true;
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return { text: text.replaceAll('\0', '�'), binary };
}

export type ProcessToolOptions = {
  processes: SandboxProcesses;
  provider: SandboxProvider;
  sql: Sql;
  config: SandboxConnectionConfig;
  connectionId: string;
  workRoot: string;
  /**
   * This attempt's session in the agent's computer, opened or resumed the way
   * a terminal command opens it, and renewed. Throws when it cannot be had.
   */
  openSession(action: Action, ctx: ConnectorContext, signal: AbortSignal): Promise<SessionRow>;
  /** Renews the session's lease after the action, as a terminal command does. */
  renew(sessionId: string): Promise<unknown>;
};

type Failure = { outcome: 'failed'; reason: string; retryable: boolean };
const refused = (reason: string, retryable = false): Failure => ({
  outcome: 'failed',
  reason,
  retryable,
});

export function createProcessTools(options: ProcessToolOptions) {
  const { processes, provider, sql } = options;

  const receipt = (action: Action, detail: Record<string, JsonValue>): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: typeof detail.process_id === 'string' ? detail.process_id : null,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  const view = (row: ProcessRow): Record<string, JsonValue> => ({
    process_id: row.id,
    name: row.name,
    state: row.state,
    command: row.command,
    cwd: row.cwd,
    port: row.port,
    exit_code: row.exitCode,
    started_at: (row.startedAt ?? row.createdAt).toISOString(),
    expires_at: row.expiresAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    ended_because: row.endReason,
    last_line: row.lastLine === null ? null : terminalText(row.lastLine, 240, 'last') || null,
    output_cursor: row.outputCursor,
  });

  /** The agent this job runs as, which names the computer; null for a job with no agent. */
  const agentOf = async (jobId: string): Promise<string | null> => {
    const [row] = await sql`select agent_id from job where id = ${jobId}`;
    return (row?.agent_id as string | null) ?? null;
  };

  /** The rows of this computer that belong to the asking job's computer, or a refusal. */
  const owned = async (ctx: ConnectorContext, agentId: string, id: string) => {
    const row = await processes.get(id);
    // Another computer's process is not named, whoever's it is.
    if (
      !row ||
      row.spaceId !== ctx.space_id ||
      row.agentId !== agentId ||
      row.connectionId !== options.connectionId
    )
      return null;
    return row;
  };

  /** The titles of the jobs that started these processes, where the asking job may see them. */
  const starters = async (rows: ProcessRow[], self: string): Promise<Map<string, string>> => {
    const ids = [...new Set(rows.map((row) => row.jobId).filter((id): id is string => !!id))];
    if (!ids.length) return new Map();
    const found = await sql`select h.id, h.title from job h, job c
      where h.id in ${sql(ids)} and c.id = ${self}
        and coalesce(h.principal_id, (select id from owner limit 1)) is not distinct from
          coalesce(c.principal_id, (select id from owner limit 1))
        and not exists (select 1 from privacy_conversation p
          where p.conversation_id = coalesce(h.experience_parent_id, h.id)
            and p.sensitive <> 'none')`;
    return new Map(
      found.map((row) => [
        String(row.id),
        String(row.title)
          .replace(/\p{Cc}/gu, ' ')
          .trim()
          .slice(0, 120),
      ]),
    );
  };

  /** Keep a page of output in the job workspace, and check the copy hashes as the bytes did. */
  const capture = async (jobId: string, id: string, from: number, bytes: Uint8Array) => {
    if (!bytes.byteLength) return null;
    const relative = `${PROCESS_LIMITS.output_dir}/${id}/${from}-${from + bytes.byteLength}.out`;
    await writeWorkspaceFile(options.workRoot, jobId, relative, bytes, 0o644);
    const stored = await readWorkspaceFile(options.workRoot, jobId, relative, bytes.byteLength + 1);
    if (digest(stored) !== digest(bytes))
      throw new Error('the stored output does not hash to the bytes read');
    return relative;
  };

  const helperFailure = (error: unknown): DispatchResult | null => {
    if (error instanceof ProcessHelperUnavailable || error instanceof ProcessHelperRefusal)
      return refused(error.message);
    if (error instanceof ProcessHelperLost) return refused(error.message, true);
    return null;
  };

  const sessionFacts = (session: SessionRow): Record<string, JsonValue> => ({
    adapter: session.adapter,
    sandbox_id: session.providerSandboxId,
    session_id: session.id,
    egress: session.egressPolicy.kind,
  });

  /**
   * Make the watch a job asked for, and say on the receipt how to wait on it,
   * or why there is nothing to wait for.
   */
  const watchFor = async (
    ctx: ConnectorContext,
    row: ProcessRow,
    asked: { kind: ProcessWatchKind; pattern: string | null },
    fromCursor: number,
  ): Promise<Record<string, JsonValue>> => {
    try {
      const made = await createProcessWatch(sql, {
        jobId: ctx.job_id,
        spaceId: ctx.space_id,
        connectionId: options.connectionId,
        processId: row.id,
        kind: asked.kind,
        pattern: asked.pattern,
        fromCursor,
      });
      return {
        watch: {
          trigger_id: made.triggerId,
          on: asked.kind,
          pattern: asked.pattern,
          event_name: made.eventName,
          wait_with: `process:${row.id}`,
        },
        next_step: `End your turn with job.wait, kind event and event_name process:${row.id}. This job wakes when it happens, and nothing is spent until then.`,
      };
    } catch (error) {
      if (error instanceof ProcessWatchRefusal)
        return { watch: null, watch_refused: error.message };
      throw error;
    }
  };

  /**
   * Wait inside this attempt for a process to end, print a matching line or
   * open its port, for a bounded time. Lines are read whole, from `cursor`
   * or from the oldest output the computer still holds.
   */
  async function wait(
    action: Action,
    row: ProcessRow,
    computer: ProcessComputer,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const payload = action.canonical_payload as Payload;
    const asked = waitOf(payload);
    const began = Date.now();
    const deadline = began + asked.seconds * 1000;
    let current = row;
    let met: Record<string, JsonValue> | null = null;
    let nextCursor: number | null = null;
    if (asked.until === 'pattern') {
      const pattern = compileWatchPattern(asked.pattern as string);
      let cursor = integer(payload, 'cursor', 0, Number.MAX_SAFE_INTEGER) ?? 0;
      let carry = new Uint8Array(0);
      for (;;) {
        signal.throwIfAborted();
        const left = deadline - Date.now();
        const answer = await computer.read(
          current.id,
          cursor,
          PROCESS_LIMITS.read_max_bytes,
          Math.max(0, Math.min(left, PROCESS_LIMITS.read_max_wait_seconds * 1000)),
          signal,
        );
        current = await processes.apply(current, answer.process, answer.boot);
        // Bytes the ring dropped meanwhile break the line that was carried.
        if (answer.read.from !== cursor) carry = new Uint8Array(0);
        const start = answer.read.from - carry.byteLength;
        const bytes = new Uint8Array(carry.byteLength + answer.data.byteLength);
        bytes.set(carry);
        bytes.set(answer.data, carry.byteLength);
        cursor = answer.read.next;
        nextCursor = cursor;
        const ended = !LIVE_STATES.includes(current.state);
        const end = ended ? bytes.byteLength : bytes.lastIndexOf(0x0a) + 1;
        for (let offset = 0; offset < end; ) {
          const newline = bytes.indexOf(0x0a, offset);
          const stop = newline === -1 || newline >= end ? end : newline;
          const line = lineOf(bytes.subarray(offset, stop));
          if (pattern.matcher(line).find()) {
            met = { line, line_cursor: start + offset };
            nextCursor = start + stop + 1;
            break;
          }
          offset = stop + 1;
        }
        if (met || ended || Date.now() >= deadline) break;
        carry = bytes.slice(end);
        if (carry.byteLength > PROCESS_LIMITS.read_max_bytes) carry = new Uint8Array(0);
      }
    } else {
      for (;;) {
        signal.throwIfAborted();
        const status = await computer.status([current.id], signal);
        const facts: ProcessFacts | undefined = status.processes.find(
          (each) => each.id === current.id,
        );
        if (facts) current = await processes.apply(current, facts, status.boot);
        const live = LIVE_STATES.includes(current.state);
        if (asked.until === 'exit' && !live) met = {};
        if (asked.until === 'listening' && live && facts) {
          const open =
            current.port === null ? facts.ports.length > 0 : facts.ports.includes(current.port);
          if (open) met = { port: current.port ?? facts.ports[0] ?? null, ports: facts.ports };
        }
        if (met || !live || Date.now() >= deadline) break;
        await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    }
    const ended = !LIVE_STATES.includes(current.state);
    let tail: string | null = null;
    if (ended) {
      const last = await computer
        .read(current.id, -1, PROCESS_LIMITS.wake_tail_bytes, 0, signal)
        .catch(() => null);
      tail = last
        ? terminalText(new TextDecoder().decode(last.data), PROCESS_LIMITS.wake_tail_bytes, 'last')
        : null;
    }
    return {
      outcome: 'succeeded',
      receipt: receipt(action, {
        ...view(current),
        until: asked.until,
        met: met !== null,
        ...(met ?? {}),
        waited_seconds: Math.round((Date.now() - began) / 1000),
        next_cursor: nextCursor,
        tail,
        ...(met === null
          ? {
              note: ended
                ? 'The process ended first.'
                : 'Not yet. For a longer wait, call process.wait with later and end your turn with job.wait.',
            }
          : {}),
      }),
    };
  }

  async function start(
    action: Action,
    ctx: ConnectorContext,
    agentId: string,
    computer: ProcessComputer,
    session: SessionRow,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const payload = action.canonical_payload as Payload;
    const command = string(payload, 'command', 20_000, true) as string;
    const cwd = cwdOf(payload);
    const name = string(payload, 'name', 80);
    const port = integer(payload, 'port', 1, 65_535) ?? null;
    const ttl = integer(payload, 'ttl_minutes', 1, PROCESS_LIMITS.max_ttl_minutes) ?? null;
    const notify = notifyOf(payload);
    // Ended processes free their places before the caps are counted.
    await processes.reconcile(ctx.space_id, agentId, computer, signal);
    let admitted: Awaited<ReturnType<SandboxProcesses['admit']>>;
    try {
      admitted = await processes.admit({
        actionId: action.id,
        spaceId: ctx.space_id,
        agentId,
        connectionId: options.connectionId,
        sessionId: session.id,
        jobId: ctx.job_id,
        command: terminalText(command, 2000, 'first') || '[hidden]',
        commandDigest: digest(new TextEncoder().encode(command)),
        cwd: cwd.relative,
        name:
          (name ?? command)
            .replace(/\p{Cc}/gu, ' ')
            .trim()
            .slice(0, 80) || 'process',
        port,
        ttlMinutes: ttl,
      });
    } catch (error) {
      if (error instanceof ProcessRefusal) return refused(error.message);
      throw error;
    }
    const { row } = admitted;
    const detail = async (current: ProcessRow, first: Uint8Array, dropped: number) => {
      const text = shown(first);
      const watching = notify ? await watchFor(ctx, current, notify, 0) : {};
      return receipt(action, {
        ...watching,
        ...view(current),
        first_output: text.text,
        first_output_binary: text.binary,
        first_output_digest: digest(first),
        first_output_bytes: first.byteLength,
        first_output_dropped: dropped,
        digest_verified: true,
        ...sessionFacts(session),
        // Said on every start where it applies, so the agent can tell the person.
        ...(provider.capabilities.keepAwake
          ? {}
          : {
              keeps_running_after_this_turn: false,
              note: `On ${session.adapter} computers, background processes stop when this turn ends, because the computer is suspended then. Wait for it in this turn with process.read, or use a computer that keeps processes running`,
            }),
      });
    };
    if (admitted.repeated && row.state !== 'starting')
      return { outcome: 'succeeded', receipt: await detail(row, new Uint8Array(0), 0) };
    try {
      await syncIn({
        provider,
        handle: sessionHandle(session),
        workRoot: options.workRoot,
        jobId: ctx.job_id,
        signal,
      });
    } catch (error) {
      await processes.abandon(
        row.id,
        `the workspace could not be copied in: ${(error as Error).message}`,
      );
      return refused(
        `the workspace could not be copied into the computer: ${(error as Error).message}`,
        true,
      );
    }
    let answer: Awaited<ReturnType<ProcessComputer['start']>>;
    try {
      answer = await computer.start(
        {
          id: row.id,
          cwd: cwd.absolute,
          command,
          halfBytes: Math.floor(processes.limits.outputMaxBytes / 2),
          waitMs: PROCESS_LIMITS.first_output_wait_ms,
          firstMaxBytes: PROCESS_LIMITS.first_output_max_bytes,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ProcessHelperLost) {
        // The start may have reached the computer. Its own directory says.
        const found = await computer.status([row.id], signal).catch(() => null);
        const facts = found?.processes.find((each) => each.id === row.id);
        if (found && facts) {
          const current = await processes.apply(row, facts, found.boot);
          return { outcome: 'succeeded', receipt: await detail(current, new Uint8Array(0), 0) };
        }
        return {
          outcome: 'unknown',
          reason: `the computer did not answer the start, so whether the process runs is not known; process.list will show it if it does (${error.message})`,
        };
      }
      await processes.abandon(row.id, (error as Error).message);
      return helperFailure(error) ?? refused((error as Error).message);
    }
    if (answer.outcome === 'reentered') {
      // An earlier dispatch of this action started it: report that process.
      const found = await computer.status([row.id], signal);
      const facts = found.processes.find((each) => each.id === row.id);
      const current = facts ? await processes.apply(row, facts, found.boot) : row;
      return { outcome: 'succeeded', receipt: await detail(current, new Uint8Array(0), 0) };
    }
    const current = await processes.apply(row, answer.process, answer.boot);
    return {
      outcome: 'succeeded',
      receipt: await detail(current, answer.data, answer.read.dropped),
    };
  }

  async function list(
    action: Action,
    ctx: ConnectorContext,
    agentId: string,
    computer: ProcessComputer,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const rows = await processes.reconcile(ctx.space_id, agentId, computer, signal);
    const titles = await starters(rows, ctx.job_id);
    const shownRows = rows.slice(0, 20);
    return {
      outcome: 'succeeded',
      receipt: receipt(action, {
        processes: shownRows.map((row) => ({
          ...view(row),
          started_by: (row.jobId && titles.get(row.jobId)) || null,
        })),
        running: rows.filter((row) => LIVE_STATES.includes(row.state)).length,
        max_per_computer: processes.limits.maxPerComputer,
      }),
    };
  }

  async function read(
    action: Action,
    ctx: ConnectorContext,
    row: ProcessRow,
    computer: ProcessComputer,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    const payload = action.canonical_payload as Payload;
    const cursor = integer(payload, 'cursor', 0, Number.MAX_SAFE_INTEGER);
    const max =
      integer(payload, 'max_bytes', 1, PROCESS_LIMITS.read_max_bytes) ??
      PROCESS_LIMITS.read_default_bytes;
    const wait = integer(payload, 'wait_seconds', 0, PROCESS_LIMITS.read_max_wait_seconds) ?? 0;
    const answer = await computer.read(row.id, cursor ?? -1, max, wait * 1000, signal);
    const current = await processes.apply(row, answer.process, answer.boot);
    const path = await capture(ctx.job_id, row.id, answer.read.from, answer.data);
    const text = shown(answer.data);
    return {
      outcome: 'succeeded',
      receipt: receipt(action, {
        ...view(current),
        cursor: answer.read.from,
        next_cursor: answer.read.next,
        dropped_bytes: answer.read.dropped,
        total_bytes: answer.read.total,
        output: text.text,
        output_binary: text.binary,
        output_bytes: answer.data.byteLength,
        output_digest: digest(answer.data),
        output_path: path,
        digest_verified: true,
      }),
    };
  }

  async function execute(
    action: Action,
    ctx: ConnectorContext,
    signal: AbortSignal,
  ): Promise<DispatchResult> {
    try {
      const agentId = await agentOf(ctx.job_id);
      if (!agentId)
        return refused(
          "Background processes run in an agent's own computer, and this job has no agent. Nothing was started. Ask an agent with a computer to do it",
        );
      if (options.config.persistence === 'ephemeral')
        return refused(
          "This computer is made fresh for each attempt, so it cannot keep a process running. Nothing was started. Use terminal.run, or ask the person to keep the agent's computer between conversations",
        );
      const payload = action.canonical_payload as Payload;
      integer(payload, 'step', 1, 1_000_000, true);
      let row: ProcessRow | null = null;
      if (action.kind !== 'process.start' && action.kind !== 'process.list') {
        row = await owned(ctx, agentId, idOf(payload));
        if (!row) return refused('There is no process with that id in this computer');
      }
      if (action.kind === 'process.extend') {
        const minutes = integer(
          payload,
          'ttl_minutes',
          1,
          PROCESS_LIMITS.max_ttl_minutes,
          true,
        ) as number;
        const extended = row ? await processes.extend(row.id, minutes) : null;
        if (!extended)
          return refused(
            `The process has ended (${row?.state}), so it has no time limit to extend`,
          );
        return { outcome: 'succeeded', receipt: receipt(action, view(extended)) };
      }
      if (action.kind === 'process.wait' && waitOf(payload).later) {
        // A wait for later needs only the record: the monitor asks the computer.
        const asked = waitOf(payload);
        const current = row as ProcessRow;
        const made = await watchFor(
          ctx,
          current,
          {
            kind: asked.until === 'pattern' ? 'output' : asked.until,
            pattern: asked.pattern,
          },
          current.outputCursor,
        );
        if (made.watch === null) return refused(String(made.watch_refused));
        return { outcome: 'succeeded', receipt: receipt(action, { ...view(current), ...made }) };
      }
      if (action.kind === 'process.start') {
        // Checked before the computer opens, so a malformed start opens nothing.
        string(payload, 'command', 20_000, true);
        cwdOf(payload);
        string(payload, 'name', 80);
        integer(payload, 'port', 1, 65_535);
        integer(payload, 'ttl_minutes', 1, PROCESS_LIMITS.max_ttl_minutes);
        notifyOf(payload);
      }
      if (action.kind === 'process.write') {
        string(payload, 'text', PROCESS_LIMITS.write_max_bytes, true);
        if (payload.newline !== undefined && typeof payload.newline !== 'boolean')
          throw new ProcessPayloadRefusal('newline must be true or false');
      }
      if (action.kind === 'process.signal') {
        const which = payload.signal;
        if (!PROCESS_SIGNALS.includes(which as ProcessSignal))
          throw new ProcessPayloadRefusal(`signal must be one of ${PROCESS_SIGNALS.join(', ')}`);
      }
      let session: SessionRow;
      try {
        session = await options.openSession(action, ctx, signal);
      } catch (error) {
        return refused((error as Error).message, true);
      }
      const computer = processes.computer(provider, sessionHandle(session));
      try {
        switch (action.kind) {
          case 'process.start':
            return await start(action, ctx, agentId, computer, session, signal);
          case 'process.list':
            return await list(action, ctx, agentId, computer, signal);
          case 'process.read':
            return await read(action, ctx, row as ProcessRow, computer, signal);
          case 'process.wait':
            return await wait(action, row as ProcessRow, computer, signal);
          case 'process.write': {
            const current = row as ProcessRow;
            if (!LIVE_STATES.includes(current.state))
              return refused(`The process has ended (${current.state}), so nothing was written`);
            // Payload text is trimmed when it is admitted, so the line end is added here.
            const text = new TextEncoder().encode(
              `${String(payload.text)}${payload.newline === false ? '' : '\n'}`,
            );
            const { written } = await computer.write(current.id, text, signal);
            return {
              outcome: 'succeeded',
              receipt: receipt(action, {
                ...view(current),
                written_bytes: written,
                complete: written === text.byteLength,
              }),
            };
          }
          case 'process.signal': {
            const current = row as ProcessRow;
            // An ended process's session number may belong to something else by now.
            if (!LIVE_STATES.includes(current.state))
              return refused(`The process has ended (${current.state}), so no signal was sent`);

            const answer = await computer.signal(
              current.id,
              payload.signal as ProcessSignal,
              signal,
            );
            const updated = await processes.apply(current, answer.process, answer.boot);
            return {
              outcome: 'succeeded',
              receipt: receipt(action, { ...view(updated), signal: String(payload.signal) }),
            };
          }
          case 'process.stop': {
            const current = row as ProcessRow;
            if (!LIVE_STATES.includes(current.state))
              return {
                outcome: 'succeeded',
                receipt: receipt(action, { ...view(current), already_ended: true }),
              };
            const stopped = await processes.end(
              current,
              computer,
              'stopped',
              END_REASONS.stopped,
              signal,
              PROCESS_LIMITS.stop_grace_ms,
            );
            return { outcome: 'succeeded', receipt: receipt(action, view(stopped)) };
          }
          default:
            return refused(`${action.kind} is not a process tool`);
        }
      } finally {
        await options.renew(session.id).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ProcessPayloadRefusal) return refused(error.message);
      const known = helperFailure(error);
      if (known) return known;
      throw error;
    }
  }

  async function verify(action: Action): Promise<VerifyResult> {
    if (action.kind !== 'process.start')
      return { decision: 'undecided', reason: 'this process action leaves no record to ask' };
    const row = await processes.byAction(action.id);
    if (!row) {
      const evidence: Record<string, JsonValue> = { reason: 'no process was recorded' };
      return { decision: 'failed', evidence };
    }
    if (row.state === 'starting')
      return { decision: 'undecided', reason: 'the start has not been confirmed by the computer' };
    const evidence: Record<string, JsonValue> = { process_id: row.id, state: row.state };
    return { decision: 'succeeded', evidence, receipt: receipt(action, view(row)) };
  }

  /** What a dispatch cut off by a stop of the service is settled as. */
  async function abandoned(action: Action): Promise<DispatchResult> {
    switch (action.kind) {
      case 'process.list':
      case 'process.read':
      case 'process.wait':
        return refused(
          'the service stopped before the answer came back; reading again is safe',
          true,
        );
      case 'process.signal':
      case 'process.stop':
      case 'process.extend':
        return refused(
          'the service stopped before the answer came back; it may have taken effect, and sending it again is harmless',
          true,
        );
      case 'process.start': {
        const verdict = await verify(action);
        if (verdict.decision === 'succeeded' && verdict.receipt)
          return { outcome: 'succeeded', receipt: verdict.receipt };
        if (verdict.decision === 'failed')
          return refused('the start never reached the computer, so it can be sent again', true);
        return {
          outcome: 'unknown',
          reason:
            'the service stopped while the process was starting; process.list shows whether it runs',
        };
      }
      default:
        return { outcome: 'unknown', reason: 'the service stopped before the computer answered' };
    }
  }

  return { execute, verify, abandoned };
}
