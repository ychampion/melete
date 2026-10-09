/**
 * Whether an app from the catalog can be connected here now, and if not, what
 * is missing: in plain words for the person, and as the one thing to change
 * for whoever runs this Melete.
 *
 * An app whose server registers its own clients (Notion, Linear, Atlassian,
 * Sentry and Stripe answer dynamic client registration) needs nothing from
 * whoever runs Melete but an address for the browser to come back to. Only an
 * app that takes no client it did not register itself (GitHub) waits for one.
 */
import type { McpCatalogEntry } from '@melete/contracts';

/** For whoever runs this Melete: the setting a sign-in's return needs. */
export const RETURN_ADDRESS_NEEDED =
  'Signing in needs the address people open this service at. Set MELETE_PUBLIC_URL to an https:// address, or a localhost one.';

/** The same, for the person: what is missing, without the setting. */
export const RETURN_ADDRESS_MISSING =
  'Signing in needs Melete to be opened at an https:// address, or on the computer it runs on. Whoever runs this Melete can give it one.';

export type CatalogAppMissing = { reason: string; hint: string };

export function catalogAppMissing(
  entry: McpCatalogEntry,
  /** Where the sign-in would send the browser back; null when there is nowhere. */
  returnTo: string | null,
  /** Whether the operator set the client an app that needs one asks for. */
  hasClient: boolean,
): CatalogAppMissing | undefined {
  if (!returnTo) return { reason: RETURN_ADDRESS_MISSING, hint: RETURN_ADDRESS_NEEDED };
  if (entry.client && !hasClient)
    return {
      reason: `${entry.title} only accepts apps registered with ${entry.title} ahead of time, and this Melete does not have one yet. Whoever runs it can register one.`,
      hint: `Register an OAuth app at ${entry.client.register_at} with ${returnTo} as its callback, then set ${entry.client.id_setting} and ${entry.client.secret_setting}.`,
    };
  return undefined;
}
