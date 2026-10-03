import type { PrincipalService } from './service.ts';

/** How often guests whose time is up are taken out of their rooms. */
export const GUEST_EXPIRY_MS = 60_000;

/**
 * Ends guests' places in rooms when their invites run out, once now and then
 * every minute, through the same path as a removal. A guest already reads
 * nothing from the moment their time is up; this fences the room's work and
 * withdraws what only they could answer. Returns the function that stops it.
 */
export function startGuestExpiry(principals: PrincipalService, everyMs = GUEST_EXPIRY_MS) {
  const sweep = () => {
    void principals
      .expireGuests()
      .catch((error: unknown) =>
        process.stderr.write(
          `guest expiry sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
  };
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
