/**
 * What a scan reads, and the exact text every evidence span indexes into.
 *
 * A figure on the map opens back to one sentence in one email. That only works
 * if the text the extractor read and the text the store kept are the same
 * string, character for character, so the composition lives here and both sides
 * call it rather than each building their own.
 */

import { sensitiveInboxMessage } from '../connectors/email.ts';
import type { MailMessage } from '../connectors/mail-transport.ts';

/** One message as the scan sees it: headers it groups by, and the body it reads. */
export type ScanMessage = {
  /** The RFC 5322 Message-ID. The scan keys stored text by it, so it must exist. */
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
  /** Present when the message carried List-Unsubscribe; a marketing signal, not content. */
  unsubscribe?: boolean;
};

/**
 * The stored text, and the only string spans are counted against. The subject
 * leads because a price rise or a renewal date is often stated there and
 * nowhere else, and a quote must be able to reach it.
 */
export function messageText(message: Pick<ScanMessage, 'subject' | 'text'>): string {
  return `Subject: ${message.subject}\n\n${message.text}`;
}

/** The address inside `Display Name <someone@example.com>`, lowercased. */
export function senderAddress(from: string): string | null {
  const angled = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  const bare = angled?.[1] ?? (/^[^<>@\s]+@[^<>@\s]+$/.test(from.trim()) ? from.trim() : null);
  return bare ? bare.toLowerCase() : null;
}

/** `Acme Billing <billing@acme.com>` becomes `Acme Billing`, or nothing. */
export function displayName(from: string): string | null {
  const match = /^\s*"?([^"<]*?)"?\s*</.exec(from);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/**
 * Suffixes under which registrations happen, so `mail.acme.co.uk` and
 * `billing.acme.co.uk` are one company rather than two. This is a short list
 * rather than the public suffix list: a name it does not know is cut to its
 * last two labels, which is right for every single-label suffix.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'co.in',
  'net.in',
  'org.in',
  'co.jp',
  'or.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.sg',
  'com.mx',
  'co.za',
]);

/** The registrable domain of an address: the company's identity for this scan. */
export function registrableDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  const host = (at < 0 ? address : address.slice(at + 1)).trim().toLowerCase().replace(/\.$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..'))
    return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * A readable name for a domain nobody signed their mail with: `beacon-fibre.example`
 * becomes `Beacon Fibre`. The display name is preferred wherever a message had one.
 */
export function nameFromDomain(domain: string): string {
  const [first = domain] = domain.split('.');
  return first
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Inbox hygiene, applied to the scan exactly as the connector's own tools apply
 * it. A one-time code or a sign-in link is withheld from a person's agent, so it
 * is withheld from the company map too; there is one filter, not two.
 */
export function withheldFromScan(message: ScanMessage): boolean {
  return sensitiveInboxMessage({
    uid: 0,
    message_id: message.messageId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: '',
  });
}

/** A connector message, as the scan reads it. A message without an id cannot be cited. */
export function fromMailMessage(
  message: MailMessage,
  receivedAt: string,
  unsubscribe?: boolean,
): ScanMessage | null {
  if (!message.message_id) return null;
  return {
    messageId: message.message_id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    receivedAt,
    ...(unsubscribe === undefined ? {} : { unsubscribe }),
  };
}
