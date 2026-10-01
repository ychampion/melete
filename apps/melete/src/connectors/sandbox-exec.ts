/**
 * Running a command in a remote sandbox, from this side of the seam.
 *
 * Unlike `exec`, this connector does the work: the sandbox belongs to the
 * broker, so the service opens the session, syncs the job workspace in, wraps
 * the command in its marker, runs it, reads the output back, hashes it here and
 * syncs the workspace out. The sandbox holds no credential and has the egress
 * the owner chose; the model only ever asks for a command.
 *
 * Because the service wrote the output file itself, a receipt from here always
 * says `digest_verified: true`: the bytes it hashed are the bytes on disk, not
 * a claim from somewhere else. What it cannot say is what the command did
 * inside the sandbox — that is the provider's isolation, and the manifest on
 * the connection says which one.
 *
 * Every outcome comes from the marker rules: a command whose record is there
 * succeeded, even late; a start the provider refused failed and may be sent
 * again; anything that leaves the outcome open is `unknown` and is never
 * re-dispatched.
 */
import { createHash } from 'node:crypto';
import {
  type Action,
  ARTIFACT_MIME,
  type ArtifactExpectation,
  type ConnectorManifest,
  EXEC_LIMITS,
  type JsonValue,
  type Receipt,
  type SandboxConnectionConfig,
  type VerifyResult,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { validateArtifact } from '../artifact/validate.ts';
import { appendEvent } from '../broker/records.ts';
import { SANDBOX_SYNC_ALLOWANCE_MS } from '../env.ts';
import { isDesktopProvider } from '../sandbox/adapters/docker.ts';
import {
  checkSandboxConfiguration,
  probeSandboxProvider,
  sandboxSpecFor,
  sandboxTimeZone,
} from '../sandbox/connection.ts';
import { SandboxRefusal } from '../sandbox/manifest.ts';
import { type CommandResult, type ExecutionRecord, runCommand } from '../sandbox/marker.ts';
import {
  NOT_STARTED,
  type SandboxSessions,
  type SessionRow,
  sessionHandle,
} from '../sandbox/sessions.ts';
import { SandboxAdapterRefusal, type SandboxProvider } from '../sandbox/types.ts';
import { readWorkspaceFile, SANDBOX_WORKDIR, syncIn, syncOut } from '../sandbox/workspace.ts';
import {
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOLS,
  ComputerPayloadRefusal,
  HumanControlRefusal,
  runComputerAction,
} from './sandbox-computer.ts';
import type { Connector, ConnectorContext } from './types.ts';

export type SandboxExecOptions = {
  sessions: SandboxSessions;
  provider: SandboxProvider;
  config: SandboxConnectionConfig;
  /** The connection this connector serves, and the space that installed it. */
  connectionId: string;
  spaceId: string;
  /** The `melete.project` label of this installation. */
  project: string;
  /** Where job workspaces live: `<workRoot>/<job_id>` is one job's `/work`. */
  workRoot: string;
  sql: Sql;
  /** E2B's maximum lifetime follows the account's plan. */
  e2bPlan?: 'hobby' | 'pro';
  /** Releases whatever the provider holds when the connection is closed. */
  close?: () => Promise<void>;
  /** The most sandboxes this installation may have running at once, over every connection. */
  maxConcurrent?: number;
  /**
   * The most this one connection may have running. A provider quota belongs to
   * an account, and an account is a connection here, so a busy space cannot
   * spend another space's allowance. Defaults to the installation ceiling, and
   * is held under it: no connection is ever allowed more than the whole service.
   */
  maxPerConnection?: number;
  /** How long a command waits for the agent's computer while another conversation uses it. */
  workspaceWaitMs?: number;
};

/**
 * How long a command waits for the agent's computer while another
 * conversation of the same agent has it, before it is refused with the reason.
 */
export const WORKSPACE_WAIT_MS = 60_000;

/** Why a command cut off by a stop or restart of the service was not finished. */
export const INTERRUPTED =
  "Melete stopped while this command was running in the agent's computer, so its result was not captured. It may have run in part or in full, and anything it changed is inside that computer: check before running it again";
const WORKSPACE_POLL_MS = 2_000;

/** The conversation holding the computer, as the model can repeat it to the person. */
function holderName(holder: { jobId: string | null; title: string | null } | null, self: string) {
  if (holder?.jobId === self)
    return 'an earlier step of this same conversation that is still ending';
  const title = holder?.title
    ?.replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 120);
  return title ? `another conversation ("${title}")` : 'another conversation';
}

const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** As with a command in the cell: plain text, no checks, no renderer. */
const STORED_OUTPUT: ArtifactExpectation = {
  kind: 'text',
  checks: [],
  render: false,
  critique: null,
  human: false,
  template: null,
};

/** A run name: what the engine's terminal sets on every command it forwards. */
const RUN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const runSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1, maxLength: 20000 },
    cwd: { type: 'string', minLength: 1, maxLength: 1024 },
    timeout_ms: { type: 'integer', minimum: 100, maximum: EXEC_LIMITS.max_timeout_ms },
    run: {
      type: 'string',
      pattern: RUN_PATTERN.source,
      description:
        'Names this run, so running the same command again later is a new run rather than a repeat of the first.',
    },
  },
};

/** A sandbox's terminal alone, for an adapter whose sandboxes have no desktop. */
export const sandboxTerminalManifest: ConnectorManifest = {
  name: 'terminal',
  version: '0.1.0',
  provider: 'sandbox',
  description: 'Run a command in a remote sandbox this service owns.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'terminal.run',
      description:
        'Run a shell command in the job workspace inside a remote sandbox. Output above the cap is stored as an artifact.',
      input_schema: runSchema,
      effect_class: 'write_reversible',
      required_scopes: ['terminal.run'],
      verify: true,
      requires_approval: false,
      // Brokered: the service runs it and reads the result back itself.
      record_schema: null,
    },
  ],
};

/** Every grant a sandbox connection offers: the terminal, and the desktop where there is one. */
export const sandboxExecManifest: ConnectorManifest = {
  ...sandboxTerminalManifest,
  description: 'Run commands and use the desktop in a sandbox this service owns.',
  tools: [...sandboxTerminalManifest.tools, ...COMPUTER_TOOLS],
};

/** What one provider's sandboxes can do: a desktop only where the adapter has one. */
export const sandboxManifestFor = (provider: SandboxProvider): ConnectorManifest =>
  isDesktopProvider(provider) ? sandboxExecManifest : sandboxTerminalManifest;

/** How long one computer action may take, the desktop's own wait for a page included. */
const COMPUTER_BUDGET_MS = 60_000;

type Payload = { command: string; cwd?: string; timeout_ms?: number; run?: string };

function payloadOf(action: Pick<Action, 'canonical_payload'>): Payload {
  const payload = action.canonical_payload as Record<string, unknown>;
  const command = payload.command;
  if (typeof command !== 'string' || !command.length || command.length > 20_000)
    throw new Error('a command is required');
  const cwd = payload.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.length || cwd.length > 1024))
    throw new Error('a working directory must be a short path');
  const timeout = payload.timeout_ms;
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 100 ||
      timeout > EXEC_LIMITS.max_timeout_ms)
  )
    throw new Error('a timeout must be a whole number of milliseconds within the cap');
  const run = payload.run;
  if (run !== undefined && (typeof run !== 'string' || !RUN_PATTERN.test(run)))
    throw new Error('a run name is 8 to 64 letters, digits, dashes or underscores');
  return {
    command,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof timeout === 'number' ? { timeout_ms: timeout } : {}),
    ...(typeof run === 'string' ? { run } : {}),
  };
}

/** How long one dispatch of this payload may take before its outcome is unknown. */
export function sandboxDispatchBudgetMs(
  action: Pick<Action, 'canonical_payload'> & Partial<Pick<Action, 'kind'>>,
): number {
  if (action.kind && COMPUTER_TOOL_NAMES.has(action.kind))
    return COMPUTER_BUDGET_MS + SANDBOX_SYNC_ALLOWANCE_MS + WORKSPACE_WAIT_MS;
  let timeout: number = EXEC_LIMITS.max_timeout_ms;
  try {
    timeout = payloadOf(action).timeout_ms ?? timeout;
  } catch {
    // A payload this connector refuses is refused at once; the default serves.
  }
  // Waiting for the computer, opening the session and syncing the workspace
  // both ways, around the command.
  return timeout + SANDBOX_SYNC_ALLOWANCE_MS + WORKSPACE_WAIT_MS;
}

/**
 * The captured output as text a receipt can hold, and whether it was text.
 * Output that is not UTF-8, or that carries a NUL, is marked binary and shown
 * with the undecodable bytes replaced; the digest still names the real bytes.
 * A preview cut at the cap may end inside a character, which is not binary.
 */
export function outputText(preview: Uint8Array, cut: boolean): { text: string; binary: boolean } {
  let binary = preview.includes(0);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(preview, { stream: cut });
  } catch {
    binary = true;
    text = new TextDecoder('utf-8').decode(preview);
  }
  // Postgres cannot keep a NUL inside a JSON string.
  return { text: text.replaceAll('\0', '�'), binary };
}

/**
 * The words a command runs as. The person's time zone is set on each command,
 * not only when the sandbox was made, so a workspace resumed after the zone
 * changed still reads the current one.
 */
export const commandArgv = (command: string, timeZone: string | null): string[] =>
  timeZone ? ['env', `TZ=${timeZone}`, 'sh', '-c', command] : ['sh', '-c', command];

/** A path inside the sandbox's own workspace; the marker runner refuses the rest. */
const sandboxCwd = (cwd: string | undefined) =>
  cwd === undefined || cwd === '.' ? SANDBOX_WORKDIR : `${SANDBOX_WORKDIR}/${cwd}`;

export function createSandboxExecConnector(options: SandboxExecOptions): Connector {
  const { sessions, provider, sql } = options;

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key ||
      action.connection_id !== options.connectionId
    )
      throw new Error('connector action identity mismatch');
  };

  /** What the job says about its agent, its sandbox-time cap and the person's time zone. */
  const jobFacts = async (jobId: string) => {
    const [row] = await sql`select j.agent_id, j.budget, p.time_zone from job j
      left join experience_profile p on p.space_id = j.space_id
      where j.id = ${jobId}`;
    const budget = (row?.budget ?? {}) as Record<string, unknown>;
    const cap = budget.max_sandbox_seconds;
    return {
      agentId: (row?.agent_id as string | null) ?? null,
      timeZone: sandboxTimeZone(row?.time_zone as string | null | undefined),
      // The field belongs to the job budget; absent means no cap.
      maxSandboxSeconds: typeof cap === 'number' && Number.isFinite(cap) ? cap : null,
    };
  };

  /**
   * The session this command runs in: the one this attempt already has, this
   * agent's persistent workspace, or a new one. A later command in the same
   * attempt therefore reuses the sandbox rather than opening a second.
   */
  const sessionFor = async (action: Action, ctx: ConnectorContext, signal: AbortSignal) => {
    // Only this connection's own session: another connection's is another
    // account's sandbox, even under the same adapter.
    const [existing] = await sql`select * from sandbox_session
      where attempt_id = ${action.attempt_id} and adapter = ${provider.capabilities.adapter}
        and connection_id = ${options.connectionId} and status = 'ready'
      limit 1`;
    if (existing) {
      const row = await sessions.get(existing.id as string);
      if (row) {
        // A session opened by an earlier command, possibly in another process.
        await provider.connect(sessionHandle(row), signal);
        return { row, reused: true };
      }
    }
    // The two allowances this session must fit inside. They are counted where
    // the row is written, under a lock, because counting here and inserting
    // there would let concurrent attempts all read the same number and pass.
    const ceiling = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    const concurrency = {
      perConnection: Math.min(options.maxPerConnection ?? ceiling, ceiling),
      installation: ceiling,
    };
    const facts = await jobFacts(ctx.job_id);
    checkSandboxConfiguration(options.config, {
      project: options.project,
      spaceId: options.spaceId,
      ...(options.e2bPlan ? { plan: options.e2bPlan } : {}),
    });
    const specFor = (session: string) =>
      sandboxSpecFor(options.config, {
        project: options.project,
        connectionId: options.connectionId,
        spaceId: ctx.space_id,
        jobId: ctx.job_id,
        attemptId: action.attempt_id,
        session,
        timeZone: facts.timeZone,
      });
    const opening = {
      connectionId: options.connectionId,
      spaceId: ctx.space_id,
      jobId: ctx.job_id,
      attemptId: action.attempt_id,
      maxSandboxSeconds: facts.maxSandboxSeconds,
      concurrency,
    };
    if (facts.agentId && options.config.persistence !== 'ephemeral') {
      const agentId = facts.agentId;
      const persistence = options.config.persistence;
      return {
        row: await waitForWorkspace(ctx, agentId, signal, () =>
          sessions.openWorkspace({ ...opening, agentId, persistence }, provider, specFor, signal),
        ),
        reused: false,
      };
    }
    return {
      row: await sessions.open({ ...opening, agentId: null }, provider, specFor, signal),
      reused: false,
    };
  };

  /**
   * Open the agent's workspace, waiting a bounded time while another
   * conversation of the same agent holds it. A holder whose attempt is gone (a
   * restart, a stop) is released at once rather than when its lease runs out.
   * The conversation that waits says so, and a refusal after the wait names
   * the conversation that has the computer, so the model can tell the person
   * instead of retrying blind.
   */
  const waitForWorkspace = async <T>(
    ctx: ConnectorContext,
    agentId: string,
    signal: AbortSignal,
    open: () => Promise<T>,
  ): Promise<T> => {
    const scope = { spaceId: ctx.space_id, agentId };
    const deadline = Date.now() + (options.workspaceWaitMs ?? WORKSPACE_WAIT_MS);
    let announced = false;
    for (;;) {
      try {
        return await open();
      } catch (error) {
        if (!(error instanceof SandboxRefusal) || error.code !== 'workspace_busy') throw error;
      }
      if (
        await sessions.releaseOrphanedWorkspace(
          scope,
          { connectionId: options.connectionId, provider },
          signal,
        )
      )
        continue;
      const holder = await sessions.workspaceHolder(ctx.space_id, agentId);
      const by = holderName(holder, ctx.job_id);
      if (Date.now() >= deadline)
        throw new SandboxRefusal(
          'workspace_busy',
          `the agent's computer is in use by ${by}, and only one conversation can use it at a time. Nothing ran. Tell the person, and try again once that conversation has finished, or carry on without the computer`,
        );
      if (!announced) {
        announced = true;
        await appendEvent(
          sql,
          ctx.job_id,
          null,
          'notice',
          { kind: 'computer_busy', held_by: holder?.title ?? null },
          `${ctx.idempotency_key}:computer_busy`,
        ).catch(() => {});
      }
      await Bun.sleep(Math.min(WORKSPACE_POLL_MS, Math.max(0, deadline - Date.now())));
      signal.throwIfAborted();
    }
  };

  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
    late: boolean,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late,
  });

  /** Everything the receipt says about one recorded command. */
  const detailFor = async (
    payload: Payload,
    record: ExecutionRecord,
    session: SessionRow,
    stored: Uint8Array | null,
  ): Promise<Record<string, JsonValue>> => {
    // The receipt is the only way the result travels back to the engine that
    // asked, so the preview the service kept goes on it, capped as it was.
    const shown = outputText(record.preview, record.truncated);
    const detail: Record<string, JsonValue> = {
      language: 'shell',
      command: payload.command,
      cwd: payload.cwd ?? '.',
      output: shown.text,
      output_binary: shown.binary,
      exit_code: record.exitCode,
      signal: record.signal,
      timed_out: record.timedOut,
      duration_ms: record.durationMs,
      output_digest: record.outputDigest,
      output_bytes: record.outputBytes,
      truncated: record.truncated,
      output_path: record.outputPath,
      stored_bytes: stored ? stored.byteLength : null,
      // The service captured and hashed these bytes itself, so it can say so.
      digest_verified: true,
      captured_bytes: record.outputBytes,
      total_bytes: record.totalBytes,
      capture_limited: record.captureLimited,
      adapter: session.adapter,
      sandbox_id: session.providerSandboxId,
      session_id: session.id,
      image_ref: session.imageRef,
      image_digest: session.imageDigest,
      egress: session.egressPolicy.kind,
      persistence: session.persistence,
    };
    if (stored && record.outputPath) {
      Object.assign(detail, {
        artifact: {
          area: 'work',
          path: record.outputPath,
          kind: STORED_OUTPUT.kind,
          mime: ARTIFACT_MIME[STORED_OUTPUT.kind],
          size: stored.byteLength,
          content_hash: digest(stored),
          template: null,
          evidence: [],
        },
        expectation: STORED_OUTPUT as unknown as JsonValue,
        validations: validateArtifact(STORED_OUTPUT, Buffer.from(stored)) as unknown as JsonValue,
      });
    }
    return detail;
  };

  const workspaceFile = async (jobId: string, relative: string | null) =>
    relative
      ? readWorkspaceFile(options.workRoot, jobId, relative, EXEC_LIMITS.max_capture_bytes)
      : null;

  const finish = async (
    action: Action,
    ctx: ConnectorContext,
    payload: Payload,
    session: SessionRow,
    result: CommandResult,
  ) => {
    await sessions.settleCommand(action.id, {
      outcome: result.outcome === 'failed' && result.retryable ? NOT_STARTED : result.outcome,
      exitCode: result.outcome === 'succeeded' ? result.record.exitCode : null,
      reattached: result.outcome === 'succeeded' ? result.reattached : false,
    });
    if (result.outcome === 'failed')
      return { outcome: 'failed' as const, reason: result.reason, retryable: result.retryable };
    if (result.outcome === 'unknown') return { outcome: 'unknown' as const, reason: result.reason };
    const stored = await workspaceFile(ctx.job_id, result.record.outputPath).catch(() => null);
    const detail = await detailFor(payload, result.record, session, stored);
    return {
      outcome: 'succeeded' as const,
      receipt: receiptFor(action, detail, result.record.outputDigest, result.late),
    };
  };

  /** A computer action: the same session as the terminal, the desktop instead of a command. */
  const computer = async (action: Action, ctx: ConnectorContext, signal: AbortSignal) => {
    if (!isDesktopProvider(provider))
      return {
        outcome: 'failed' as const,
        reason: `the ${provider.capabilities.adapter} adapter has no desktop`,
        retryable: false,
      };
    let session: SessionRow;
    try {
      const opened = await sessionFor(action, ctx, signal);
      const renewed = await sessions.renew(opened.row.id);
      if (!renewed) throw new Error('the sandbox session ended before the action was sent');
      session = renewed;
    } catch (error) {
      return {
        outcome: 'failed' as const,
        reason:
          error instanceof SandboxRefusal
            ? `${error.code}: ${error.message}`
            : (error as Error).message,
        retryable: true,
      };
    }
    try {
      const detail = await runComputerAction({
        action,
        jobId: ctx.job_id,
        workRoot: options.workRoot,
        session,
        provider,
        signal,
      });
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          { ...detail, adapter: session.adapter, egress: session.egressPolicy.kind },
          null,
          false,
        ),
      };
    } catch (error) {
      // Refused before anything reached the desktop: a person holds it, or the
      // arguments or the adapter said no. Anything after that is not known.
      if (
        error instanceof HumanControlRefusal ||
        error instanceof SandboxAdapterRefusal ||
        error instanceof ComputerPayloadRefusal
      )
        return { outcome: 'failed' as const, reason: error.message, retryable: false };
      return {
        outcome: 'unknown' as const,
        reason: `the desktop did not answer: ${(error as Error).message}`,
      };
    } finally {
      await sessions.renew(session.id).catch(() => {});
    }
  };

  const verify = async (action: Action, ctx: ConnectorContext): Promise<VerifyResult> => {
    checkIdentity(action, ctx);
    // Nothing records a click the way a marker records a command: whether it
    // landed is not something the sandbox can say afterwards.
    if (COMPUTER_TOOL_NAMES.has(action.kind))
      return { decision: 'undecided', reason: 'a computer action leaves no record to ask' };
    const signal = ctx.signal ?? AbortSignal.timeout(120_000);
    const [dispatched] = await sql`select session_id from sandbox_command
      where action_id = ${action.id}`;
    const session = dispatched ? await sessions.get(dispatched.session_id as string) : null;
    if (!session) return { decision: 'undecided', reason: 'this command has no session to ask' };
    let payload: Payload;
    try {
      payload = payloadOf(action);
    } catch (error) {
      return { decision: 'undecided', reason: (error as Error).message };
    }
    const result = await runCommand({
      provider,
      handle: sessionHandle(session),
      request: {
        marker: action.id,
        argv: ['sh', '-c', payload.command],
        cwd: sandboxCwd(payload.cwd),
        timeoutMs: payload.timeout_ms ?? EXEC_LIMITS.max_timeout_ms,
        // Never a first run: a verify asks what the marker says, and nothing else.
        dispatch: 'again',
      },
      workRoot: options.workRoot,
      jobId: ctx.job_id,
      signal,
    });
    if (result.outcome === 'succeeded') {
      const stored = await workspaceFile(ctx.job_id, result.record.outputPath).catch(() => null);
      const detail = await detailFor(payload, result.record, session, stored);
      const evidence: Record<string, JsonValue> = {
        output_digest: result.record.outputDigest,
        sandbox_id: session.providerSandboxId,
        session_id: session.id,
      };
      return {
        decision: 'succeeded',
        evidence,
        receipt: receiptFor(action, detail, result.record.outputDigest, result.late),
      };
    }
    if (result.outcome === 'failed' && result.retryable) {
      // The provider refused the start: nothing ran, and the ledger can say so.
      const evidence: Record<string, JsonValue> = { reason: result.reason };
      return { decision: 'failed', evidence };
    }
    return { decision: 'undecided', reason: result.reason };
  };

  return {
    manifest: sandboxManifestFor(provider),
    catalog: { audience: 'owner' },

    dispatchBudgetMs: sandboxDispatchBudgetMs,

    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      const signal = ctx.signal ?? AbortSignal.timeout(sandboxDispatchBudgetMs(action));
      if (COMPUTER_TOOL_NAMES.has(action.kind)) return computer(action, ctx, signal);
      let payload: Payload;
      let session: SessionRow;
      let timeZone: string | null = null;
      try {
        payload = payloadOf(action);
        timeZone = (await jobFacts(ctx.job_id)).timeZone;
        const opened = await sessionFor(action, ctx, signal);
        // Renewed before anything is sent: a session reused near the end of
        // its lease would otherwise be swept while this command runs.
        const renewed = await sessions.renew(opened.row.id);
        if (!renewed) throw new Error('the sandbox session ended before the command was sent');
        session = renewed;
        await syncIn({
          provider,
          handle: sessionHandle(session),
          workRoot: options.workRoot,
          jobId: ctx.job_id,
          signal,
        });
      } catch (error) {
        // Nothing was dispatched: no sandbox took a command, so this is a
        // plain failure and the same action may be sent again.
        return {
          outcome: 'failed',
          reason:
            error instanceof SandboxRefusal
              ? `${error.code}: ${error.message}`
              : (error as Error).message,
          retryable: true,
        };
      }
      const dispatch = await sessions.beginCommand(session.id, action.id, action.id);
      const result = await runCommand({
        provider,
        handle: sessionHandle(session),
        request: {
          marker: action.id,
          argv: commandArgv(payload.command, timeZone),
          cwd: sandboxCwd(payload.cwd),
          timeoutMs: payload.timeout_ms ?? EXEC_LIMITS.max_timeout_ms,
          dispatch,
        },
        workRoot: options.workRoot,
        jobId: ctx.job_id,
        signal,
      });
      const outcome = await finish(action, ctx, payload, session, result);
      await sessions.renew(session.id).catch(() => {});
      // The workspace is read back after every command, so a file that lives
      // only in the sandbox at completion is a wrong answer, not a slow one.
      if (result.outcome !== 'unknown')
        await syncOut({
          provider,
          handle: sessionHandle(session),
          workRoot: options.workRoot,
          jobId: ctx.job_id,
          signal,
        }).catch(() => {});
      return outcome;
    },

    verify,

    async abandoned(action, ctx) {
      // A click has no record to read back, and it can reach a page outside.
      if (COMPUTER_TOOL_NAMES.has(action.kind))
        return { outcome: 'unknown', reason: 'the service stopped before the desktop answered' };
      let verdict: VerifyResult;
      try {
        verdict = await verify(action, { ...ctx, signal: AbortSignal.timeout(30_000) });
      } catch {
        verdict = { decision: 'undecided', reason: 'the command could not be asked about' };
      }
      if (verdict.decision === 'succeeded' && verdict.receipt)
        return { outcome: 'succeeded', receipt: verdict.receipt };
      if (verdict.decision === 'failed')
        return {
          outcome: 'failed',
          reason: 'the command never started, so it can be run again',
          retryable: true,
        };
      // The command ran, or may have, inside the agent's own computer, and its
      // result cannot be read now. Asking the person whether it "arrived"
      // would be a question about a place only the agent uses.
      return { outcome: 'failed', reason: INTERRUPTED, retryable: false };
    },

    close: options.close,

    async health() {
      const checkedAt = new Date().toISOString();
      try {
        checkSandboxConfiguration(options.config, {
          project: options.project,
          spaceId: options.spaceId,
          ...(options.e2bPlan ? { plan: options.e2bPlan } : {}),
        });
      } catch (error) {
        return {
          status: 'failing',
          detail:
            error instanceof SandboxRefusal
              ? `the provider cannot honour this configuration: ${error.code}`
              : 'this configuration cannot be used',
          checked_at: checkedAt,
        };
      }
      const answered = await probeSandboxProvider(provider, AbortSignal.timeout(20_000));
      return answered === 'ok'
        ? { status: 'ok', detail: 'the provider accepted this key', checked_at: checkedAt }
        : {
            status: 'failing',
            detail: 'the provider did not answer, or refused this key',
            checked_at: checkedAt,
          };
    },
  };
}
