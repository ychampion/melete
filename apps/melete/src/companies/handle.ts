/**
 * The seam between finding something and doing something about it.
 *
 * This lane finds items and serves them. It does not write to anybody: the
 * playbooks lane owns the message, the approval and the follow-up, and it does
 * so over the existing broker path, which is the only path that sends. So the
 * route exists here and the work is an interface, implemented on the other
 * branch and swapped in by whoever integrates the two.
 *
 * The whole seam is this file. A reviewer checking that nothing here can send
 * has one file to read.
 */

import type { Company, LedgerItem } from '@melete/contracts';

/** Everything the playbook needs, already checked, with the text its quotes cite. */
export type HandleRequest = {
  item: LedgerItem;
  company: Company;
  /** The stored message text, or null when the message is no longer held. */
  messageText: string | null;
};

export type HandleResult = { job_id: string };

/**
 * What the playbooks lane implements. One call, one job. It is given an item
 * that has already passed the evidence gate, so it never has to decide whether
 * a figure is real; it decides what to say about it and takes the approval.
 */
export interface LedgerItemHandler {
  handleLedgerItem(request: HandleRequest): Promise<HandleResult>;
}

/** A handler is unavailable in a way a route can answer with, not crash on. */
export class HandlerUnavailable extends Error {
  constructor(message = 'Handling is not connected yet.') {
    super(message);
  }
}

/**
 * The stub this lane ships. It refuses rather than pretends: an item cannot be
 * marked as being handled by a job that does not exist, and a person who is told
 * a message went out when none did is worse off than one who is told to wait.
 */
export function stubLedgerItemHandler(): LedgerItemHandler {
  return {
    async handleLedgerItem(): Promise<HandleResult> {
      throw new HandlerUnavailable();
    },
  };
}
