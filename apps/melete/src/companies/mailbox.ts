/**
 * How the scan reads a space's mailbox.
 *
 * There is one route to a person's mail and this is not a second one. The
 * connector the owner installed is already registered, holds the sealed
 * credential, and applies inbox hygiene inside its own read tool; the scan asks
 * it the same question the agent would, through the same `execute` entry point,
 * with a service-minted read action. Nothing here opens an IMAP connection, and
 * nothing here can send.
 *
 * The connector's search tool caps a read at fifty messages, so a scan sees the
 * most recent fifty of the space's mail rather than ninety days of it. That is
 * the tool's own limit and raising it is a change to the connector, not to this.
 */

import { canonicalizePayload, jobConstraints } from '@melete/contracts';
import { EmailConnector } from '../connectors/email.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { newId } from '../ids.ts';
import { fromMailMessage, type ScanMessage } from './messages.ts';

/** What a scan reads from. A fixture and a real inbox answer the same question. */
export interface ScanMailbox {
  /** Newest first, hygiene already applied. */
  recent(limit: number): Promise<ScanMessage[]>;
}

/**
 * A mailbox that could not be read is a failed scan, never an empty inbox. The
 * reason is the scan's own words: the person reads it, and a transport's error
 * can carry an address or a server's reply.
 */
const unreadable = (reason: string) => new Error(`I couldn't read your mailbox: ${reason}`);

/** The connector's own ceiling on one read; `email.search` refuses more. */
export const MAILBOX_READ_LIMIT = 50;

/** A fixed set of messages, for tests, the demo seed and the screens. */
export function fixtureMailbox(messages: readonly ScanMessage[]): ScanMailbox {
  return {
    async recent(limit: number) {
      return [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    },
  };
}

/**
 * The installed mailbox, read through the registered connector. The action is
 * minted here and is a read: its effect class is `read`, it needs no approval,
 * and it is never recorded as an effect, because a scan looking at mail is not
 * something that happened to the world.
 */
export function connectorMailbox(options: {
  registry: ConnectorRegistry;
  connectionId: string;
  spaceId: string;
  /** When the transport gives a message no date, this stands in for one. */
  undatedAt: string;
}): ScanMailbox {
  return {
    async recent(limit: number) {
      const connector = options.registry.get(options.connectionId);
      if (!(connector instanceof EmailConnector))
        throw unreadable('the mail connection is not open.');
      const id = newId('act');
      const payload = canonicalizePayload({
        query: '',
        limit: Math.min(limit, MAILBOX_READ_LIMIT),
      });
      const result = await connector.execute(
        {
          id,
          job_id: id,
          attempt_id: id,
          connection_id: options.connectionId,
          kind: 'email.search',
          effect_class: 'read',
          canonical_payload: payload.canonical,
          payload_hash: payload.hash,
          intent_key: null,
          status: 'dispatched',
          authorization_ref: null,
          budget_reservation: null,
          idempotency_key: id,
          dispatched_at: options.undatedAt,
          receipt: null,
          resolved_at: null,
          reconciliation: null,
          repair_trace: [],
          repair_counters: {},
          repair_disposition: null,
          retry_after_at: null,
          created_at: options.undatedAt,
        },
        {
          job_id: id,
          space_id: options.spaceId,
          idempotency_key: id,
          constraints: jobConstraints.parse({}),
        },
      );
      if (result.outcome !== 'succeeded')
        throw unreadable('the mail connection did not answer. Check it and scan again.');
      const messages = result.receipt.detail.messages;
      if (!Array.isArray(messages)) throw unreadable('the mail connection sent back no messages.');
      const read: ScanMessage[] = [];
      for (const entry of messages) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const message = fromMailMessage(
          {
            uid: Number(record.uid ?? 0),
            message_id: typeof record.message_id === 'string' ? record.message_id : null,
            from: String(record.from ?? ''),
            ...(Array.isArray(record.from_addresses)
              ? {
                  from_addresses: record.from_addresses.filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
            to: String(record.to ?? ''),
            subject: String(record.subject ?? ''),
            text: String(record.text ?? ''),
            html: '',
          },
          typeof record.date === 'string' ? record.date : options.undatedAt,
        );
        if (message) read.push(message);
      }
      return read.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    },
  };
}
