/**
 * What a member of someone else's shared space is not shown. The service
 * refuses these reads for a member anyway; asking would only bring refusals.
 */

/** The day is the owner's calendar and tasks: a member's pages have no rail, and a docked panel replaces it. */
export const showsRail = ({
  rail,
  panel,
  member,
}: {
  rail: boolean;
  panel: unknown;
  member: boolean;
}): boolean => rail && !panel && !member;

/** Agents are set up by the space's owner; a member's address for them goes Home. */
export const opensAgents = (member: boolean): boolean => !member;
