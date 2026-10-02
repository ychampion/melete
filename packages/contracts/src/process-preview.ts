/**
 * A person's side of the background processes in an agent's computer: a
 * preview of a server one of them runs, the end of what it printed, and
 * stopping it. Each route answers only to the person whose job started the
 * process, and only while that process runs in a computer they may watch.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';
import { PROCESS_STATES } from './execution.ts';

export const PREVIEW_LIMITS = {
  /** The most one answer from the previewed server may carry. */
  response_max_bytes: 50 * 1024 * 1024,
  /** Pages, scripts and styles up to this size have their own-site links kept inside the preview. */
  rewrite_max_bytes: 8 * 1024 * 1024,
  /** How long the server has to start answering one request. */
  upstream_timeout_ms: 30_000,
  /** How much of the end of a process's output the person is shown. */
  output_bytes: 16_384,
} as const;

const processId = z.string().regex(/^prc_[0-9A-Z]{26}$/);

export const processPreview = z
  .strictObject({
    process_id: processId,
    /** Below the API's own address; framed by Melete, never opened on its own. */
    path: z.string().regex(/^\/previews\/[A-Za-z0-9._-]+\/$/),
    port: z.number().int().min(1).max(65_535),
    expires_at: timestamp,
  })
  .meta({ id: 'ProcessPreview' });
export type ProcessPreview = z.infer<typeof processPreview>;

export const processOutput = z
  .strictObject({
    process_id: processId,
    state: z.enum(PROCESS_STATES),
    /** The end of what it printed, scrubbed; the last line recorded when the computer is not reachable. */
    text: z.string().max(PREVIEW_LIMITS.output_bytes * 2),
  })
  .meta({ id: 'ProcessOutput' });
export type ProcessOutput = z.infer<typeof processOutput>;

export const processStopped = z
  .strictObject({ process_id: processId, state: z.enum(PROCESS_STATES) })
  .meta({ id: 'ProcessStopped' });
export type ProcessStopped = z.infer<typeof processStopped>;
