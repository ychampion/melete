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
  role: z.enum(['owner', 'member']),
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
