/**
 * How Melete reaches a service for one piece of work.
 *
 * `api` is a connected app's own tools, `browser` is the agent's browser, and
 * `person` is the person themselves, handed everything Melete has done so far.
 * The service decides the path; the model may only propose on one.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId } from './common.ts';

export const ACTION_PATHS = ['api', 'browser', 'person'] as const;
export const actionPath = z.enum(ACTION_PATHS);
export type ActionPath = z.infer<typeof actionPath>;

/** What reading a page back after a browser submit found. */
export const READ_BACK_VERDICTS = ['done', 'not_done', 'unclear'] as const;
export const readBackVerdict = z.enum(READ_BACK_VERDICTS);
export type ReadBackVerdict = z.infer<typeof readBackVerdict>;

/** Something on a page only the person can get past. */
export const PAGE_BLOCKERS = ['captcha', 'two_factor', 'payment'] as const;
export const pageBlocker = z.enum(PAGE_BLOCKERS);
export type PageBlocker = z.infer<typeof pageBlocker>;

export const readBack = z.object({
  verdict: readBackVerdict,
  blocker: pageBlocker.nullable(),
  /** One short sentence: what on the page decided it. */
  evidence: z.string().max(300),
  /** How many times the page was read: a second look follows an unclear first. */
  looks: z.number().int().min(1).max(2),
  /** Where the page ended up. */
  url: z.string().max(2048).nullable(),
});
export type ReadBack = z.infer<typeof readBack>;

export const HAND_OFF_REASONS = [...PAGE_BLOCKERS, 'sign_in', 'unclear', 'path'] as const;
export const handOffReason = z.enum(HAND_OFF_REASONS);
export type HandOffReason = z.infer<typeof handOffReason>;

/**
 * What the person is handed when Melete is stuck: what is done, what is left,
 * and where to take over the agent's browser. Work goes on once they hand it back.
 */
export const handOff = z
  .object({
    reason: handOffReason,
    /** The site or app it is about. */
    service: z.string().max(253),
    done: z.array(z.string().max(300)).max(12),
    left: z.string().max(500),
    take_over: z.object({
      surface: z.literal('browser'),
      session_id: z.string().min(1).max(200),
      /** An address in the app that opens the agent's computer for this work. */
      link: z.string().max(300),
    }),
    /** The submit whose outcome is in doubt, when there is one. */
    action_id: prefixedId(ID_PREFIXES.action).nullable(),
  })
  .meta({ id: 'HandOff' });
export type HandOff = z.infer<typeof handOff>;
