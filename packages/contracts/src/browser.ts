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

/**
 * A site this space is signed in to. One browser profile holds the space's cookies, so this is a
 * record over that profile: a registrable domain, not what anybody did there.
 */
export const browserSite = z
  .object({
    domain: z.string().min(1).max(255),
    label: z.string().min(1).max(255),
    last_used: z.string(),
  })
  .meta({ id: 'BrowserSite' });

export const browserSiteList = z
  .object({ sites: z.array(browserSite).max(100) })
  .meta({ id: 'BrowserSiteList' });

export const browserSiteForgotten = z
  .object({ domain: z.string().min(1).max(255), forgotten: z.literal(true) })
  .meta({ id: 'BrowserSiteForgotten' });

export type BrowserSite = z.infer<typeof browserSite>;
