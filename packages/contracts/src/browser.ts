/** Owner-facing control for a browser lease; the worker token is never part of this response. */
import { z } from 'zod';

export const browserControlResponse = z
  .object({
    session_id: z.string().min(1),
    control_epoch: z.number().int().nonnegative(),
    control: z.enum(['automation', 'human']),
    fresh_observation_required: z.literal(true),
  })
  .meta({ id: 'BrowserControlResponse' });

export type BrowserControlResponse = z.infer<typeof browserControlResponse>;
