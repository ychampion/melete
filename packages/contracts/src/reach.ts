/**
 * Reaching the person on their own phone: a number they verify once with a
 * code, and their one-time agreement that Melete may text, and then call,
 * that number when a deadline they set is about to be missed and its push went
 * unanswered. Every number other than this one keeps asking per message.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

/** A phone number in E.164 form: a plus, the country code and the number, digits only. */
export const e164Number = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Write the number with + and the country code, digits only')
  .meta({ id: 'PhoneNumber' });

/** Start verifying a number: a code is texted to it. */
export const reachNumberRequest = z.strictObject({ number: e164Number });
export type ReachNumberRequest = z.infer<typeof reachNumberRequest>;

/** The code that was texted to the number. */
export const reachVerifyRequest = z.strictObject({ code: z.string().regex(/^\d{6}$/) });

/** What the person agrees to, once. Texts are always part of it; calls and nights are theirs to add. */
export const reachConsentRequest = z.strictObject({
  calls: z.boolean(),
  nights: z.boolean(),
});
export type ReachConsentRequest = z.infer<typeof reachConsentRequest>;

/** One text, call or push Melete made to reach the person, and why. */
export const reachContactView = z.strictObject({
  id: z.string(),
  channel: z.enum(['push', 'text', 'call']),
  /** `ladder` for a deadline, `code` for a verification code. */
  purpose: z.enum(['ladder', 'code']),
  /** `waiting`, `sending`, `sent`, `delivered`, `failed`, `skipped`, `cancelled` or `unknown`. */
  state: z.string(),
  /** Why it was made, or why it was not, in plain words. */
  reason: z.string(),
  situation_id: z.string().nullable(),
  due_at: timestamp,
  sent_at: timestamp.nullable(),
  cost_usd: z.number(),
});

export const reachState = z
  .strictObject({
    /** Whether this installation can text and call at all. Without it, Melete reaches people by push only. */
    available: z.boolean(),
    /** When it is not available, the sentence that says so. */
    unavailable_reason: z.string().nullable(),
    /** The number texts and calls come from, so the person can save it. */
    from_number: z.string().nullable(),
    /** The person's verified number. */
    number: e164Number.nullable(),
    verified_at: timestamp.nullable(),
    /** A number waiting for its code. */
    pending_number: e164Number.nullable(),
    pending_expires_at: timestamp.nullable(),
    /** What the person agreed to, and when; null when they have not, or withdrew. */
    consent: z
      .strictObject({
        number: e164Number,
        texts: z.boolean(),
        calls: z.boolean(),
        nights: z.boolean(),
        wording: z.string(),
        agreed_at: timestamp,
      })
      .nullable(),
    /** The person replied STOP: nothing is texted or called until they agree again. */
    opted_out_at: timestamp.nullable(),
    /** The wording shown beside the agreement, the same words that are recorded with it. */
    wording: z.strictObject({ texts: z.string(), calls: z.string(), nights: z.string() }),
    today: z.strictObject({
      texts: z.number().int(),
      calls: z.number().int(),
      text_cap: z.number().int(),
      call_cap: z.number().int(),
    }),
    recent: z.array(reachContactView),
  })
  .meta({ id: 'ReachState' });
export type ReachState = z.infer<typeof reachState>;
export const reachStateResponse = z
  .strictObject({ reach: reachState })
  .meta({ id: 'ReachStateResponse' });
