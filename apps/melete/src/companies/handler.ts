/**
 * The seam between finding something and doing something about it.
 *
 * Finding items and serving them is one concern; writing to a company is
 * another. The route lives with the first and the message lives with the
 * second, so the route asks for the work through this interface instead of
 * reaching into it. A reviewer checking that the map itself cannot send has
 * this one file to read: the map calls `handleLedgerItem`, `handleLedgerItem`
 * composes a job, and the job's only way out is the broker it shares with
 * everything else.
 *
 * The route stays the one that records the outcome. It owns the ledger row, it
 * already holds the owner the row is scoped to, and it writes `job_id` and
 * `handling` once the handler has returned an id — which is why the adapter
 * below deliberately leaves `onStatusChange` unset. Passing it as well would
 * write the same transition twice, from two places, for one click.
 */

import type { AwaitedReply, Company, LedgerItem, LedgerItemAction } from '@melete/contracts';
import { type HandleDeps, handleLedgerItem } from './handle.ts';
import { handleAwaitedReply } from './handle-reply.ts';
import { handlePublishedItem } from './published.ts';

/** Everything the playbook needs, already checked, with the text its quotes cite. */
export type HandleRequest = {
  item: LedgerItem;
  company: Company;
  /** The stored message text, or null when the message is no longer held. */
  messageText: string | null;
  /** The principal and space the route proved before it read the item. */
  principalId: string;
  spaceId: string;
  /** The mail connection the message would go out on, when the space has one. */
  connectionId?: string;
};

export type HandleResult = { job_id: string };

/** A reply the person is waiting on, with the stored text of what they sent. */
export type ReplyChaseRequest = {
  reply: AwaitedReply;
  /** The stored text of their sent message, or null when it is no longer held. */
  messageText: string | null;
  principalId: string;
  spaceId: string;
  connectionId?: string;
};

/** One action on an item a connection published, already checked against its installation. */
export type PublishedHandleRequest = {
  item: LedgerItem;
  company: Company;
  action: LedgerItemAction;
  /** The brokered name of the tool the action runs. */
  toolName: string;
  /** The stored text of every source the item quotes, by stored message id. */
  texts: ReadonlyMap<string, string>;
  principalId: string;
  spaceId: string;
};

/**
 * What the route calls. One call, one job. It is given an item that has already
 * passed the evidence gate, so it never has to decide whether a figure is real;
 * it decides what to say about it and takes the approval.
 */
export interface LedgerItemHandler {
  handleLedgerItem(request: HandleRequest): Promise<HandleResult>;
  /** Chase a reply the person is waiting on. Absent, "Chase this" is not connected. */
  handleAwaitedReply?(request: ReplyChaseRequest): Promise<HandleResult>;
  /** Take an action on a published item. Absent, such actions are not connected. */
  handlePublishedItem?(request: PublishedHandleRequest): Promise<HandleResult>;
}

/** A handler is unavailable in a way a route can answer with, not crash on. */
export class HandlerUnavailable extends Error {
  constructor(message = 'Handling is not connected yet.') {
    super(message);
  }
}

/**
 * The refusing handler, for an app assembled without the job service. It
 * refuses rather than pretends: an item cannot be marked as being handled by a
 * job that does not exist, and a person who is told a message went out when
 * none did is worse off than one who is told to wait.
 */
export function stubLedgerItemHandler(): LedgerItemHandler {
  return {
    async handleLedgerItem(): Promise<HandleResult> {
      throw new HandlerUnavailable();
    },
  };
}

/**
 * The real handler, over the services the process already built.
 *
 * `messageText` is required rather than optional here. Every quote is re-checked
 * against the stored text before it can be put in the person's mouth, so a
 * message the installation no longer holds is a message whose quotes cannot be
 * checked, and the answer is to refuse rather than to write from memory.
 */
export function playbookHandler(deps: HandleDeps): LedgerItemHandler {
  return {
    async handleLedgerItem(request: HandleRequest): Promise<HandleResult> {
      if (request.messageText === null)
        throw new HandlerUnavailable('The message this item came from is no longer held.');
      return handleLedgerItem(deps, {
        item: request.item,
        company: request.company,
        messageText: request.messageText,
        principalId: request.principalId,
        spaceId: request.spaceId,
        ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      });
    },
    async handlePublishedItem(request: PublishedHandleRequest): Promise<HandleResult> {
      return handlePublishedItem(deps, request);
    },
    async handleAwaitedReply(request: ReplyChaseRequest): Promise<HandleResult> {
      if (request.messageText === null)
        throw new HandlerUnavailable('The message you sent is no longer held.');
      return handleAwaitedReply(deps, {
        reply: request.reply,
        messageText: request.messageText,
        principalId: request.principalId,
        spaceId: request.spaceId,
        ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      });
    },
  };
}
