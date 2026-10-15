/**
 * Who administers this installation: the account that set it up, and any
 * person's account it made an admin. An admin provisions accounts and chooses
 * the installation's model; granting or taking admin stays with the setup
 * owner, who is always an admin and whom no admin can change.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { owner, principal } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

type Reader = Database | Transaction;

export type InstallationRole = { setupOwner: boolean; admin: boolean };

/** The account's standing on the installation, read now. */
export async function installationRole(
  db: Reader,
  principalId: string | null | undefined,
): Promise<InstallationRole> {
  if (!principalId) return { setupOwner: false, admin: false };
  const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
  if (installation?.id === principalId) return { setupOwner: true, admin: true };
  const [granted] = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        eq(principal.id, principalId),
        eq(principal.admin, true),
        // Only a person's account that can still sign in administers anything.
        eq(principal.kind, 'person'),
        isNull(principal.disabledAt),
      ),
    );
  return { setupOwner: false, admin: Boolean(granted) };
}

export async function isAdmin(db: Reader, principalId: string | null | undefined) {
  return (await installationRole(db, principalId)).admin;
}
