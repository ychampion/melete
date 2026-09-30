/**
 * Which browser the agent uses for a page.
 *
 * A space can have two: the cloud browser the service runs, and the person's
 * own browser on a computer they connected, where they are already signed in.
 * The rule is simple and stated to the model in the tools themselves:
 *
 * - A site where the person has an account (a bill, insurance, school or a
 *   government portal) goes to their own browser. If that computer is off, the
 *   step waits for it rather than moving to the cloud browser, where the
 *   person is not signed in and would have to type a password.
 * - A public page that needs no sign-in goes to the cloud browser, which works
 *   whether or not the computer is on.
 *
 * Without the person's browser, the cloud browser keeps every job it has today.
 */

export const PUBLIC_ONLY_NOTE =
  ' Use this only for public pages that need no sign-in. For any site where the person has an ' +
  'account, use device.browser_open, which opens it in their own browser, already signed in.';

export const SIGNED_IN_NOTE =
  ' Prefer this over the cloud browser for every site that needs the person to be signed in; ' +
  'if their computer is off, the step waits for it.';

/** A connection offers the person's own browser when its scopes include opening a page there. */
export function offersPersonsBrowser(
  connections: readonly { provider: string; scopes: unknown }[],
): boolean {
  return connections.some(
    (row) =>
      row.provider === 'device' &&
      Array.isArray(row.scopes) &&
      row.scopes.includes('device.browser_open'),
  );
}

/** A tool's description with the routing rule added where it applies. */
export function routedDescription(
  name: string,
  description: string,
  personsBrowser: boolean,
): string {
  if (!personsBrowser) return description;
  if (name.startsWith('browser.')) return `${description}${PUBLIC_ONLY_NOTE}`;
  if (name === 'device.browser_open') return `${description}${SIGNED_IN_NOTE}`;
  return description;
}
