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
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { validateArtifact } from '../artifact/validate.ts';
import {
  checkSandboxConfiguration,
  probeSandboxProvider,
  sandboxSpecFor,
} from '../sandbox/connection.ts';
import { SandboxRefusal } from '../sandbox/manifest.ts';
import { type CommandResult, type ExecutionRecord, runCommand } from '../sandbox/marker.ts';
import {
  NOT_STARTED,
  type SandboxSessions,
  type SessionRow,
  sessionHandle,
} from '../sandbox/sessions.ts';
import type { SandboxProvider } from '../sandbox/types.ts';
import { readWorkspaceFile, SANDBOX_WORKDIR, syncIn, syncOut } from '../sandbox/workspace.ts';
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
};

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

const runSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1, maxLength: 20000 },
    cwd: { type: 'string', minLength: 1, maxLength: 1024 },
    timeout_ms: { type: 'integer', minimum: 100, maximum: EXEC_LIMITS.max_timeout_ms },
  },
};

export const sandboxExecManifest: ConnectorManifest = {
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

type Payload = { command: string; cwd?: string; timeout_ms?: number };

function payloadOf(action: Action): Payload {
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
  return {
    command,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof timeout === 'number' ? { timeout_ms: timeout } : {}),
  };
}

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

  /** What the job says about its agent and its sandbox-time cap. */
  const jobFacts = async (jobId: string) => {
    const [row] = await sql`select agent_id, budget from job where id = ${jobId}`;
    const budget = (row?.budget ?? {}) as Record<string, unknown>;
    const cap = budget.max_sandbox_seconds;
    return {
      agentId: (row?.agent_id as string | null) ?? null,
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
    const [existing] = await sql`select * from sandbox_session
      where attempt_id = ${action.attempt_id} and adapter = ${provider.capabilities.adapter}
        and status = 'ready'
      limit 1`;
    if (existing) {
      const row = await sessions.get(existing.id as string);
      if (row) {
        // A session opened by an earlier command, possibly in another process.
        await provider.connect(sessionHandle(row), signal);
        return { row, reused: true };
      }
    }
    // Two allowances, counted once. The connection's own comes first, because it
    // names the account that is full; the installation's ceiling holds over all
    // of them, so one connection can never take more than the service has.
    const ceiling = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    const own = Math.min(options.maxPerConnection ?? ceiling, ceiling);
    if (Number.isFinite(own) || Number.isFinite(ceiling)) {
      const [counted] = await sql`select count(*)::int as live,
          count(*) filter (where connection_id = ${options.connectionId})::int as own
        from sandbox_session where status in ('opening', 'ready')`;
      const live = Number(counted?.live ?? 0);
      const mine = Number(counted?.own ?? 0);
      if (mine >= own)
        throw new SandboxRefusal(
          'concurrency_exhausted',
          `this connection already has ${mine} running, which is its limit`,
        );
      if (live >= ceiling)
        throw new SandboxRefusal(
          'concurrency_exhausted',
          `this installation already has ${live} running, which is its limit`,
        );
    }
    const facts = await jobFacts(ctx.job_id);
    checkSandboxConfiguration(options.config, {
      project: options.project,
      spaceId: options.spaceId,
      ...(options.e2bPlan ? { plan: options.e2bPlan } : {}),
    });
    const specFor = (session: string) =>
      sandboxSpecFor(options.config, {
        project: options.project,
        spaceId: ctx.space_id,
        jobId: ctx.job_id,
        attemptId: action.attempt_id,
        session,
      });
    const opening = {
      connectionId: options.connectionId,
      spaceId: ctx.space_id,
      jobId: ctx.job_id,
      attemptId: action.attempt_id,
      maxSandboxSeconds: facts.maxSandboxSeconds,
    };
    if (facts.agentId && options.config.persistence !== 'ephemeral')
      return {
        row: await sessions.openWorkspace(
          { ...opening, agentId: facts.agentId, persistence: options.config.persistence },
          provider,
          specFor,
          signal,
        ),
        reused: false,
      };
    return {
      row: await sessions.open({ ...opening, agentId: null }, provider, specFor, signal),
      reused: false,
    };
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
    const detail: Record<string, JsonValue> = {
      language: 'shell',
      command: payload.command,
      cwd: payload.cwd ?? '.',
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

  return {
    manifest: sandboxExecManifest,
    catalog: { audience: 'owner' },

    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      const signal = ctx.signal ?? AbortSignal.timeout(EXEC_LIMITS.max_timeout_ms + 120_000);
      let payload: Payload;
      let session: SessionRow;
      try {
        payload = payloadOf(action);
        const opened = await sessionFor(action, ctx, signal);
        session = opened.row;
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
          argv: ['sh', '-c', payload.command],
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

    async verify(action, ctx) {
      checkIdentity(action, ctx);
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
