import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/** Owner-class account identities reuse the established owner ID and login wire shape. */
export const principal = z.object({
  id: prefixedId(ID_PREFIXES.owner),
  email: z.email(),
  created_at: timestamp,
});
export type Principal = z.infer<typeof principal>;
export const createPrincipalRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(1024),
});
export type CreatePrincipalRequest = z.infer<typeof createPrincipalRequest>;
export const createSharedSpaceRequest = z.object({ name: z.string().min(1).max(120) });
export const spaceMembership = z.object({
  principal_id: prefixedId(ID_PREFIXES.owner),
  space_id: prefixedId(ID_PREFIXES.space),
  /** `guest`: someone invited into a room for a while; see `roomInvite`. */
  role: z.enum(['owner', 'member', 'guest']),
  generation: z.number().int().nonnegative(),
  revoked_at: timestamp.nullable(),
});
export type SpaceMembership = z.infer<typeof spaceMembership>;
export const grantMembershipRequest = z.object({ principal_id: prefixedId(ID_PREFIXES.owner) });

/** Qualified audiences keep their exact space binding through parsing. */
export const qualifiedAudience = z.union([
  z.enum(['private', 'space', 'public']),
  z.string().regex(/^space:sp_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
]);
export function normalizeAudience(value: z.infer<typeof qualifiedAudience>, spaceId: string) {
  if (!value.startsWith('space:')) return { audience: value, space_id: spaceId };
  if (value.slice(6) !== spaceId) throw new Error('audience space does not match its container');
  return { audience: 'space' as const, space_id: spaceId };
}

/** An account on this Melete, as the person who set it up sees it. */
export const accountSummary = z.object({
  id: prefixedId(ID_PREFIXES.owner),
  /** Null once the account is being deleted: its email is wiped first. */
  email: z.email().nullable(),
  display_name: z.string().nullable(),
  kind: z.enum(['person', 'guest']),
  created_at: timestamp,
  /** The account that set Melete up, which manages the others and cannot be deleted. */
  setup_owner: z.boolean(),
  state: z.enum(['active', 'removing']),
});
export type AccountSummary = z.infer<typeof accountSummary>;
export const accountList = z.object({ accounts: z.array(accountSummary) });

/** What deleting an account takes with it, shown before anything is deleted. */
export const accountRemovalPreview = z.object({
  account: accountSummary,
  /** Spaces it owns, each removed with everything in it. A room goes for everyone in it. */
  spaces: z.array(
    z.object({
      id: prefixedId(ID_PREFIXES.space),
      name: z.string(),
      kind: z.enum(['personal', 'room']),
      chats: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
      connections: z.number().int().nonnegative(),
    }),
  ),
  /** Rooms other people own, which it leaves; what it wrote there stays with the room. */
  rooms_left: z.array(z.object({ id: prefixedId(ID_PREFIXES.space), name: z.string() })),
  /** What has to be typed to confirm: the account's email. */
  confirm: z.string(),
  /** Why it cannot be deleted, when it cannot. */
  blocked_reason: z.string().nullable(),
});
export type AccountRemovalPreview = z.infer<typeof accountRemovalPreview>;

/** The account's email has to be typed out, so the wrong account cannot go by a stray click. */
export const deleteAccountRequest = z.object({ confirm_email: z.string().min(1).max(254) });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequest>;

/** Where deleting an account has got to. */
export const accountRemoval = z.object({
  principal_id: prefixedId(ID_PREFIXES.owner),
  /** `removed` once every space it owned is gone and its records with them. */
  state: z.enum(['removing', 'removed']),
  spaces: z.array(
    z.object({
      space_id: prefixedId(ID_PREFIXES.space),
      name: z.string(),
      removal_id: prefixedId('rem'),
      state: z.string(),
    }),
  ),
});
export type AccountRemoval = z.infer<typeof accountRemoval>;
