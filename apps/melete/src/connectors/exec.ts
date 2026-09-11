/**
 * The ledger side of running code in the cell.
 *
 * This connector runs nothing. It cannot: the command has to run inside the
 * cell, which is the only place with no route out and no credentials, and this
 * process is the place with both. After admission the cell runs the command and
 * settles the record of what it ran; this connector checks that
 * record and turns it into a receipt.
 *
 * What it can check, it checks. The working directory and the stored output
 * path have to resolve inside this job's workspace, with no symbolic link on
 * the way, or nothing is recorded: a cell claiming to have run in another job's
 * directory is refused at the ledger even though the ledger cannot stop the
 * command. Where a full output was stored, the bytes are hashed again here and
 * the claimed digest has to match.
 *
 * What it cannot check is what the command did to the filesystem. That is the
 * container's job: a read-only root, `/work` as the only writable mount, no
 * capabilities, and a network with no route out. The honest reading of a
 * recorded execution is "this command ran, in this directory, and produced this
 * output", not "this command could not have done anything else".
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import {
  type Action,
  ARTIFACT_MIME,
  type ArtifactExpectation,
  type ConnectorManifest,
  EXEC_LIMITS,
  EXEC_RECORD_JSON_SCHEMA,
  execRecord,
  type JsonValue,
  type Receipt,
} from '@melete/contracts';
import { validateArtifact } from '../artifact/validate.ts';
import { noLinks, segmentsFor } from './files.ts';
import type { Connector, ConnectorContext } from './types.ts';

export type ExecOptions = {
  /** The root every job workspace lives under; `<workRoot>/<job_id>` is one cell's /work. */
  workRoot: string;
  /** The most output bytes this connector will read back to re-hash. */
  maxBytes?: number;
};

const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

/**
 * What a stored command output is declared to be. Plain text, no checks, and no
 * renderer: there is nothing to promise about the output of an arbitrary
 * command beyond that it is the bytes the command produced. Declaring it is
 * still worth doing, because a declared write is the only kind that becomes an
 * artifact, and an artifact is the only kind of thing this release will publish.
 */
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

export const execManifest: ConnectorManifest = {
  name: 'exec',
  version: '0.1.0',
  provider: 'exec',
  description: 'Run a command or a Python snippet inside this job workspace.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'exec.run',
      description:
        'Run a shell command in the job workspace. Output above the cap is truncated and stored.',
      input_schema: runSchema,
      effect_class: 'write_reversible',
      required_scopes: ['exec.run'],
      verify: true,
      requires_approval: false,
      execution: 'in_cell',
      record_schema: EXEC_RECORD_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      name: 'exec.python',
      description:
        'Run a Python snippet in the job workspace. Write files with ordinary relative paths.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 20000 },
          cwd: { type: 'string', minLength: 1, maxLength: 1024 },
          timeout_ms: { type: 'integer', minimum: 100, maximum: EXEC_LIMITS.max_timeout_ms },
        },
      },
      effect_class: 'write_reversible',
      required_scopes: ['exec.python'],
      verify: true,
      requires_approval: false,
      execution: 'in_cell',
      record_schema: EXEC_RECORD_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  ],
};

export function createExecConnector(options: ExecOptions): Connector {
  const limit = options.maxBytes ?? EXEC_LIMITS.max_capture_bytes;

  /** Resolve a relative path inside this job's workspace, refusing every escape. */
  const resolveInWorkspace = async (ctx: ConnectorContext, relative: string): Promise<string> => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id)) throw new Error('invalid trusted file scope');
    const base = await realpath(options.workRoot);
    return noLinks(base, [ctx.job_id, ...segmentsFor(relative)], false);
  };

  const readStored = async (target: string): Promise<Buffer> => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new Error('stored output is not a regular file or exceeds the read limit');
      return await file.readFile();
    } finally {
      await file.close();
    }
  };

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key
    )
      throw new Error('connector action identity mismatch');
  };

  /**
   * Everything about the record that can be decided from this side. Returns the
   * detail to put on the receipt, or throws with the reason it is not credible.
   */
  const check = async (action: Action, ctx: ConnectorContext) => {
    const record = execRecord.parse(action.canonical_payload);
    // `.` is the workspace root itself; anything else must resolve inside it.
    if (record.cwd !== '.') {
      await resolveInWorkspace(ctx, record.cwd).catch(() => {
        throw new Error(
          `the recorded working directory is outside this job workspace: ${record.cwd}`,
        );
      });
    }
    if (record.duration_ms > EXEC_LIMITS.max_timeout_ms + 5_000)
      throw new Error('the recorded duration exceeds the cell time cap');
    let verified = false;
    let storedBytes: number | null = null;
    let stored: Buffer | null = null;
    if (record.output_path) {
      const target = await resolveInWorkspace(ctx, record.output_path).catch(() => {
        throw new Error(
          `the recorded output file is outside this job workspace: ${record.output_path}`,
        );
      });
      await lstat(target);
      stored = await readStored(target);
      storedBytes = stored.byteLength;
      if (digest(stored) !== record.output_digest)
        throw new Error('the stored output does not hash to the recorded digest');
      verified = true;
    }
    const detail: Record<string, JsonValue> = {
      language: record.language,
      command: record.command,
      cwd: record.cwd,
      exit_code: record.exit_code,
      signal: record.signal,
      timed_out: record.timed_out,
      duration_ms: record.duration_ms,
      output_digest: record.output_digest,
      output_bytes: record.output_bytes,
      truncated: record.truncated,
      output_path: record.output_path,
      stored_bytes: storedBytes,
      // False means the output was small enough that nothing was stored, so the
      // digest is the cell's word. It is said rather than implied.
      digest_verified: verified,
    };
    // Output that did not fit is not a loose file in a hidden directory: it is
    // an artifact of this job, with a handle a later attempt can cite and a
    // person can publish. The bytes were already read to re-hash them, so the
    // validators cost nothing extra and the record is made from what is on
    // disk rather than from what the cell said about it.
    if (stored && record.output_path) {
      Object.assign(detail, {
        artifact: {
          area: 'work',
          path: record.output_path,
          kind: STORED_OUTPUT.kind,
          mime: ARTIFACT_MIME[STORED_OUTPUT.kind],
          size: stored.byteLength,
          content_hash: record.output_digest,
          template: null,
          evidence: [],
        },
        expectation: STORED_OUTPUT as unknown as JsonValue,
        validations: validateArtifact(STORED_OUTPUT, stored) as unknown as JsonValue,
      });
    }
    return { record, detail };
  };

  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  return {
    manifest: execManifest,
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      try {
        const { record, detail } = await check(action, ctx);
        return {
          outcome: 'succeeded',
          receipt: receiptFor(action, detail, record.output_digest),
        };
      } catch (error) {
        // A record this side will not vouch for is a failed record, not an
        // uncertain one: nothing left this machine, and the ledger knows
        // exactly why it refused. `unknown` would send the job to
        // reconciliation over a claim that was simply not credible.
        return { outcome: 'failed', reason: (error as Error).message, retryable: false };
      }
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      try {
        const { record, detail } = await check(action, ctx);
        // Without a stored output there is nothing on disk to re-read, so the
        // honest answer is that the record cannot be confirmed from here.
        if (!record.output_path)
          return {
            decision: 'undecided',
            reason: 'the execution stored no output, so nothing can be re-read',
          };
        return {
          decision: 'succeeded',
          evidence: { output_digest: record.output_digest, output_path: record.output_path },
          receipt: receiptFor(action, detail, record.output_digest),
        };
      } catch (error) {
        return { decision: 'undecided', reason: (error as Error).message };
      }
    },
    async health() {
      try {
        await realpath(options.workRoot);
        return {
          status: 'ok',
          detail: 'the workspace root is available',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'the workspace root is missing',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
