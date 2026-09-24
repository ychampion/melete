/**
 * Code and shell execution inside the cell.
 *
 * The cell has no route out and every external effect is brokered, so running
 * code inside it is not a new kind of power: whatever a command does lands in
 * the job's own directory (`/work` inside the cell, `<workRoot>/<job>` on the
 * host), which the owner can read, diff and delete. What running code
 * does add is a record, and this file is the shape of that record.
 *
 * The execution intent is admitted before the cell starts; its result is settled afterwards,
 * because the broker cannot run the
 * command, because the broker process holds the credentials the cell must never
 * reach. So the tool's arguments (what the model asked for) and the action's
 * payload (what actually ran, and what came of it) are two different shapes.
 * `connectorTool.record_schema` is how a connector declares the second one.
 */
import { z } from 'zod';

export const EXECUTION_MODES = ['brokered', 'in_cell'] as const;
export const executionMode = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionMode>;

/**
 * The caps the cell applies to one command. They are not a security boundary -
 * the container is - they are what keeps one runaway loop from spending an
 * attempt's whole wall clock and filling the workspace volume.
 */
export const EXEC_LIMITS = {
  /** Default wall clock for one command when the caller names none. */
  default_timeout_ms: 30_000,
  /** The most a caller may ask for. A longer job is several commands. */
  max_timeout_ms: 120_000,
  /** How much combined output the model is shown before truncation. */
  max_output_bytes: 16_384,
  /** How much output is captured at all. Past this the tail is dropped. */
  max_capture_bytes: 4_194_304,
  /** Where retained command output is stored, under the workspace. */
  output_dir: '.melete/exec',
} as const;

export const EXEC_LANGUAGES = ['shell', 'python'] as const;
export const execLanguage = z.enum(EXEC_LANGUAGES);
export type ExecLanguage = z.infer<typeof execLanguage>;

/**
 * One execution, as it is written to the ledger. Every field is a fact about a
 * command that has already finished. `exit_code` is null exactly when the
 * command was killed, which is also when `timed_out` or `signal` says why.
 */
export const execRecord = z.object({
  language: execLanguage,
  /** The command line, or the snippet, exactly as it ran. */
  command: z.string().min(1).max(20_000),
  /** Relative to the job workspace root. `.` is the root itself. */
  cwd: z.string().min(1).max(1024),
  exit_code: z.number().int().nullable(),
  signal: z.string().max(64).nullable().default(null),
  timed_out: z.boolean().default(false),
  duration_ms: z.number().int().nonnegative(),
  /** sha256 of the captured combined output, before truncation. */
  output_digest: z.string().regex(/^[0-9a-f]{64}$/),
  output_bytes: z.number().int().nonnegative(),
  /** Retained bytes. Optional for records from an older plugin. */
  captured_bytes: z.number().int().nonnegative().optional(),
  /** All bytes drained from the command, including discarded bytes. */
  total_bytes: z.number().int().nonnegative().optional(),
  /** True when the capture cap discarded output; distinct from the display cap. */
  capture_limited: z.boolean().optional(),
  truncated: z.boolean().default(false),
  /**
   * Where retained output was stored when it did not fit, relative to the
   * workspace root. Null when the output fit and nothing was written.
   */
  output_path: z.string().max(1024).nullable().default(null),
});
export type ExecRecord = z.infer<typeof execRecord>;

/** The marker the cell leaves in place of the bytes it did not show the model. */
export const execTruncationMarker = (bytes: number, path: string | null): string =>
  `\n[melete: output truncated, ${bytes} bytes captured${path ? `, captured output at ${path}` : ''}]\n`;

/**
 * A JSON Schema for the record above, for `connectorTool.record_schema`. The
 * broker validates a proposed execution against this, so a cell that reports
 * something the shape does not allow is refused before anything is written.
 */
export const EXEC_RECORD_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'language',
    'command',
    'cwd',
    'exit_code',
    'duration_ms',
    'output_digest',
    'output_bytes',
  ],
  properties: {
    language: { type: 'string', enum: [...EXEC_LANGUAGES] },
    command: { type: 'string', minLength: 1, maxLength: 20000 },
    cwd: { type: 'string', minLength: 1, maxLength: 1024 },
    exit_code: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'], maxLength: 64 },
    timed_out: { type: 'boolean' },
    duration_ms: { type: 'integer', minimum: 0 },
    output_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    output_bytes: { type: 'integer', minimum: 0 },
    captured_bytes: { type: 'integer', minimum: 0 },
    total_bytes: { type: 'integer', minimum: 0 },
    capture_limited: { type: 'boolean' },
    truncated: { type: 'boolean' },
    output_path: { type: ['string', 'null'], maxLength: 1024 },
  },
} as const;
