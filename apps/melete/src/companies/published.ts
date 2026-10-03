/**
 * Items a connection publishes into a space's ledger: a project tracker's open
 * matters, a CRM's commitments, a shared inbox's promises with dates on them.
 *
 * A published item is held to the rule a scanned one is. The connection is
 * operator-installed, but what it publishes is often text someone outside
 * wrote, so nothing it says is believed on its own: every quote must sit at
 * exactly its span in a source the same feed sent, checked with
 * `evidenceHolds`, or the whole item is dropped and counted. An action survives
 * only when it names a tool the installation declared as a ledger action, so a
 * feed can offer a next step but never grant itself a new one.
 *
 * This module is pure. It decides what is admitted; `feeds.ts` reads the feed
 * and writes what this returns.
 */

import { createHash } from 'node:crypto';
import {
  canonicalizePayload,
  evidenceHolds,
  type LedgerEvidence,
  type LedgerFeedItem,
  type LedgerFeedSource,
  type LedgerItemAction,
  type LedgerShownAction,
  ledgerFeed,
  ledgerFeedItem,
  ledgerFeedSource,
  ledgerSourceRef,
} from '@melete/contracts';
import { oneLine } from './handle.ts';
import type { StoredMessage } from './repository.ts';

/** The largest input one published action may carry, in canonical bytes. */
export const ACTION_INPUT_LIMIT = 4096;

/**
 * How large one source or one item may be before it is read at all: how deeply
 * its values nest, how many values it holds, and how many characters of text.
 * Third-party text reaches a feed, so these are checked one source and one item
 * at a time, and whatever is past them is dropped on its own.
 */
export const FEED_ENTRY_LIMITS = { depth: 24, values: 4000, characters: 64_000 } as const;

/**
 * Whether a value from a feed can be read safely: nested no deeper than the
 * limit, no larger, and with no NUL character in any key or string, which
 * Postgres refuses to store. Walked without recursion, so a value nested past
 * any stack is answered rather than thrown on.
 */
export function feedEntryFits(value: unknown, limits = FEED_ENTRY_LIMITS): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let characters = 0;
  const text = (entry: string) => {
    characters += entry.length;
    return !entry.includes('\u0000') && characters <= limits.characters;
  };
  while (pending.length) {
    const next = pending.pop() as { value: unknown; depth: number };
    values += 1;
    if (values > limits.values || next.depth > limits.depth) return false;
    if (typeof next.value === 'string') {
      if (!text(next.value)) return false;
    } else if (Array.isArray(next.value)) {
      for (const entry of next.value) pending.push({ value: entry, depth: next.depth + 1 });
    } else if (next.value !== null && typeof next.value === 'object') {
      for (const [key, entry] of Object.entries(next.value)) {
        if (!text(key)) return false;
        pending.push({ value: entry, depth: next.depth + 1 });
      }
    }
  }
  return true;
}

/**
 * The id a published source is stored under. It names the connection, the
 * source and the exact text, so two connections cannot share a source, and a
 * source whose text changed is a new stored message rather than an edit to the
 * one an earlier quote was checked against.
 */
export function publishedMessageId(connectionId: string, source: LedgerFeedSource): string {
  const digest = createHash('sha256').update(source.text).digest('hex').slice(0, 16);
  return `${connectionId}/${source.ref}#${digest}`;
}

/** One connection's claim on one item, so publishing the same `ref` again updates it. */
export const publishedDedupeKey = (connectionId: string, ref: string) =>
  `published:${connectionId}:${ref}`;

export type AdmittedItem = Omit<LedgerFeedItem, 'evidence' | 'actions'> & {
  evidence: LedgerEvidence[];
  actions: LedgerItemAction[];
};

export type Admission = {
  /** Items the feed returned, admitted or not. */
  seen: number;
  /**
   * Every well-formed `ref` the feed returned, admitted or not: what the
   * connection still tracks, so an item it no longer lists can be let go.
   */
  refs: string[];
  items: AdmittedItem[];
  /** The sources the admitted items quote, under their stored ids. */
  messages: StoredMessage[];
  /** What was left out, by reason: whole items, and actions on kept items. */
  dropped: Record<string, number>;
};

/**
 * What a feed tool answered, as the feed itself: structured content when the
 * server sent it, otherwise a single text block holding the JSON. Anything else
 * is not a feed.
 */
export function feedBody(answer: Record<string, unknown>): unknown {
  if (answer.structuredContent && typeof answer.structuredContent === 'object')
    return answer.structuredContent;
  const content = Array.isArray(answer.content) ? answer.content : [];
  const texts = content.filter(
    (block): block is { type: 'text'; text: string } =>
      Boolean(block) &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  if (texts.length !== 1) return null;
  try {
    return JSON.parse(texts[0]?.text ?? '');
  } catch {
    return null;
  }
}

/**
 * Decide what a feed adds. Returns null when the answer is not a feed at all,
 * so the caller can say so instead of reporting an empty one.
 */
export function admitFeed(
  body: unknown,
  options: {
    connectionId: string;
    /** The tool aliases the installation declared as ledger actions. */
    declaredActions: readonly string[];
    now: Date;
  },
): Admission | null {
  const parsed = ledgerFeed.safeParse(body);
  if (!parsed.success) return null;
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  const sources = new Map<string, LedgerFeedSource>();
  for (const raw of parsed.data.sources) {
    const read = feedEntryFits(raw) ? ledgerFeedSource.safeParse(raw) : null;
    if (!read?.success) drop('invalid_source');
    else if (sources.has(read.data.ref)) drop('duplicate_source');
    else sources.set(read.data.ref, read.data);
  }

  const declared = new Set(options.declaredActions);
  const seenRefs = new Set<string>();
  const items: AdmittedItem[] = [];
  const quoted = new Map<string, StoredMessage>();
  const refs = new Set<string>();
  for (const raw of parsed.data.items) {
    const ref = (raw as { ref?: unknown } | null)?.ref;
    if (typeof ref === 'string' && ledgerSourceRef.safeParse(ref).success) refs.add(ref);
    // An entry too deep, too large or holding a NUL is dropped before it is
    // parsed at all; parsing is also caught, so one entry can never stop a read.
    let read: ReturnType<typeof ledgerFeedItem.safeParse> | null = null;
    try {
      read = feedEntryFits(raw) ? ledgerFeedItem.safeParse(raw) : null;
    } catch {
      read = null;
    }
    if (!read?.success) {
      drop('invalid');
      continue;
    }
    const item = read.data;
    if (seenRefs.has(item.ref)) {
      drop('duplicate_item');
      continue;
    }
    seenRefs.add(item.ref);

    // Every quote must hold, or the item goes: one that does not is a claim
    // nobody can open back to the words it rests on.
    const evidence: LedgerEvidence[] = [];
    const cited: StoredMessage[] = [];
    let failure: string | null = null;
    for (const entry of item.evidence) {
      const source = sources.get(entry.source);
      if (!source) {
        failure = 'source_missing';
        break;
      }
      if (!evidenceHolds(source.text, entry)) {
        failure = 'evidence_failed';
        break;
      }
      const messageId = publishedMessageId(options.connectionId, source);
      evidence.push({
        message_id: messageId,
        quote: entry.quote,
        start: entry.start,
        end: entry.end,
      });
      cited.push({
        messageId,
        subject: source.title,
        from: source.from,
        receivedAt: source.at ?? options.now.toISOString(),
        text: source.text,
      });
    }
    if (failure) {
      drop(failure);
      continue;
    }

    // An action is offered only through a tool the installation named for it.
    const actions: LedgerItemAction[] = [];
    for (const action of item.actions) {
      if (!declared.has(action.tool)) drop('action_undeclared');
      else if (Buffer.byteLength(canonicalizePayload(action.input).json) > ACTION_INPUT_LIMIT)
        drop('action_too_large');
      else actions.push(action);
    }

    for (const message of cited) quoted.set(message.messageId, message);
    items.push({ ...item, evidence, actions });
  }
  return {
    seen: parsed.data.items.length,
    refs: [...refs],
    items,
    messages: [...quoted.values()],
    dropped,
  };
}

/** The tool an action runs, by its brokered name, given the installation's server id. */
export const actionToolName = (serverId: string, action: Pick<LedgerItemAction, 'tool'>) =>
  `mcp_${serverId}.${action.tool}`;

/**
 * The digest of an action exactly as it is shown: its id, label, tool and
 * input. The ledger serves it with each action, and acting sends it back, so a
 * feed that changes an action between the person seeing it and pressing it
 * changes the digest, and the press is refused rather than running the new one.
 */
export function publishedActionDigest(action: LedgerItemAction): string {
  return canonicalizePayload({
    id: action.id,
    label: action.label,
    tool: action.tool,
    input: action.input,
  }).hash;
}

/** A published item's actions as the ledger serves them, each with its digest. */
export const shownActions = (actions: readonly LedgerItemAction[]): LedgerShownAction[] =>
  actions.map((action) => ({ ...action, digest: publishedActionDigest(action) }));

/**
 * What the job that carries out one published action is called and told. It is
 * written by the service from the installation alone, the connection's label
 * and the declared tool's alias, never from anything the feed sent, so nothing
 * that reads it, such as the auto-reviewer, takes a feed's words for the person's.
 */
export const publishedStepObjective = (connectionLabel: string, tool: string) =>
  oneLine(
    `Run ${tool} on ${connectionLabel}, as the person chose from an item it added to their ledger, with the input shown to them.`,
    500,
  );
