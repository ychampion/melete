/**
 * Saved sign-ins: a person's username and password for one site, and the secret
 * its one-time codes come from, kept sealed so Melete's browser can sign in for
 * them. Nothing here ever carries a saved password or code secret back out: a
 * list shows the username and a mask, and the most a person can ask for is the
 * current six-digit code.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

export const savedSignInId = prefixedId(ID_PREFIXES.saved_sign_in);

/** Shown in place of every saved password. The same for each, so it says nothing about length. */
export const PASSWORD_MASK = '••••••••';

/** How a saved sign-in may be used: whenever the agent needs it, or only once the person says yes. */
export const savedSignInPolicy = z.enum(['whenever_needed', 'ask_first']);
export type SavedSignInPolicy = z.infer<typeof savedSignInPolicy>;

/** What came of the last time Melete's browser used a saved sign-in. */
export const signInOutcome = z.enum([
  'signed_in',
  'needs_code',
  'needs_person',
  'form_not_found',
  'not_accepted',
  'wrong_site',
  'failed',
]);
export type SignInOutcome = z.infer<typeof signInOutcome>;

export const savedSignIn = z
  .object({
    id: savedSignInId,
    /** The exact site it is used on: scheme, host and port, nothing more. */
    origin: z.string().min(1).max(300),
    /** The host alone, for reading. */
    site: z.string().min(1).max(255),
    label: z.string().min(1).max(120),
    username: z.string().min(1).max(512),
    /** Always the same mask; the password itself is never sent back. */
    password: z.literal(PASSWORD_MASK),
    has_code: z.boolean(),
    policy: savedSignInPolicy,
    created_at: timestamp,
    updated_at: timestamp,
    last_used_at: timestamp.nullable(),
    last_outcome: signInOutcome.nullable(),
  })
  .meta({ id: 'SavedSignIn' });
export type SavedSignIn = z.infer<typeof savedSignIn>;

export const savedSignInList = z
  .object({ sign_ins: z.array(savedSignIn).max(500) })
  .meta({ id: 'SavedSignInList' });

/** A site as a person types it: `example.com` or `https://example.com/login` both name `https://example.com`. */
const siteInput = z.string().trim().min(1).max(2048);
/** A code secret as base32, or the `otpauth://totp/...` link a site's set-up page shows. */
const codeSecretInput = z.string().trim().min(1).max(4096);

export const savedSignInCreate = z
  .object({
    site: siteInput,
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(1024),
    code_secret: codeSecretInput.optional(),
    label: z.string().trim().min(1).max(120).optional(),
    policy: savedSignInPolicy.default('whenever_needed'),
  })
  .strict()
  .meta({ id: 'SavedSignInCreate' });
export type SavedSignInCreate = z.input<typeof savedSignInCreate>;

/**
 * A change to a saved sign-in. Its site cannot change: a password belongs to
 * the site it was saved for, so another site is a new sign-in. `code_secret`
 * null removes the code; an empty `label` names it after its site again.
 */
export const savedSignInUpdate = z
  .object({
    username: z.string().min(1).max(512).optional(),
    password: z.string().min(1).max(1024).optional(),
    code_secret: codeSecretInput.nullable().optional(),
    label: z.string().trim().max(120).optional(),
    policy: savedSignInPolicy.optional(),
  })
  .strict()
  .refine((change) => Object.keys(change).length > 0, { message: 'Nothing to change.' })
  .meta({ id: 'SavedSignInUpdate' });
export type SavedSignInUpdate = z.input<typeof savedSignInUpdate>;

export const savedSignInDeleted = z
  .object({ id: savedSignInId, deleted: z.literal(true) })
  .meta({ id: 'SavedSignInDeleted' });

/** The code a saved sign-in's site would take right now, for the person to see or type. */
export const savedSignInCode = z
  .object({
    code: z.string().regex(/^\d{6,8}$/),
    expires_in: z.number().int().min(1).max(300),
  })
  .meta({ id: 'SavedSignInCode' });

/** One check of a saved sign-in, in words a person reads. */
export const savedSignInCheckItem = z.object({
  name: z.enum(['site', 'sealed', 'password', 'code']),
  ok: z.boolean(),
  detail: z.string().max(400),
});

/**
 * Whether a saved sign-in is ready for Melete's browser to use: its site can
 * be signed in to, it opens under this installation's key, and its code works.
 */
export const savedSignInCheck = z
  .object({ id: savedSignInId, ok: z.boolean(), checks: z.array(savedSignInCheckItem).max(8) })
  .meta({ id: 'SavedSignInCheck' });
export type SavedSignInCheck = z.infer<typeof savedSignInCheck>;
