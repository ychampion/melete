/**
 * Noticing what a person is still waiting to hear back about.
 *
 * The companies map finds what companies owe the person. This finds the other
 * half of "waiting on": messages the person sent that asked for something, to
 * somebody who could answer, that nobody has answered yet. It reads the Sent
 * folder beside the inbox and decides with rules, not a model, so the same
 * mailbox always gives the same list and every entry can be explained:
 *
 * 1. **It asked.** The person's own words, with the quoted history cut away,
 *    hold a question or a request ("could you", "please confirm", "let me
 *    know"). The sentence that asked is kept as evidence, at a span that is
 *    checked the way the map checks its figures.
 * 2. **Somebody could answer.** Not the person themselves, not a no-reply or
 *    robot address, not a newsletter sender, and not an automatic reply the
 *    person's own mail client sent.
 * 3. **Nobody has.** No threaded reply, nothing from the recipient since, and
 *    for a company, nothing from a colleague of theirs on the same subject.
 *    Mail from a stranger at the same personal mail provider does not count.
 * 4. **Long enough, not too long.** At least three days, at most thirty.
 *
 * A thread the person wrote to twice is one wait, dated from the latest.
 */

import { messageText, registrableDomain, type ScanMessage } from './messages.ts';
import { fromAddresses } from './replies.ts';

/** How long a message waits before it counts as waiting on a reply. */
export const AWAITED_AFTER_DAYS = 3;
/** Older than this, a message is history rather than something to chase. */
export const AWAITED_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** One sent message still waiting on a reply, and the sentence that asked. */
export type AwaitedFinding = {
  messageId: string;
  /** The recipient it waits on. */
  to: string;
  toName: string | null;
  subject: string;
  sentAt: string;
  /** The asking sentence, at `[start, end)` in `messageText(message)`. */
  quote: string;
  start: number;
  end: number;
  /** The stored text the span indexes into. */
  text: string;
};

export type AwaitedScan = {
  awaited: AwaitedFinding[];
  /** Sent messages that asked and have since been answered. */
  answered: string[];
  counts: Record<string, number>;
};

/**
 * Personal mail providers. At one of these a shared domain says nothing about
 * who someone is, so only the address itself can answer.
 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'fastmail.com',
  'hey.com',
]);

/** Whether a domain is a personal mail provider rather than an organisation. */
export const isPersonalDomain = (domain: string): boolean => PERSONAL_DOMAINS.has(domain);

/** A mailbox nobody reads: its local part says it is a robot's. */
const ROBOT_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|marketing|automated)(?:$|[-_.+])|noreply/;

/** Where the quoted history starts: everything from here on is somebody else's. */
const QUOTED_HISTORY = [
  /^On .+wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^From: .+$/m,
  /^_{8,}\s*$/m,
];

/** A request that expects an answer, in the sentence that makes it. */
const REQUEST =
  /\b(?:(?:could|can|would|will) you|please (?:let me know|confirm|advise|send|reply|respond|get back|update|call|share|check|tell)|let me know|get back to me|(?:look|looking) forward to (?:hearing|your (?:reply|response|answer))|i(?:'d| would) (?:appreciate|be grateful)|any (?:update|news))\b/i;

/** A question that is only a greeting. */
const PLEASANTRY =
  /^(?:(?:hi|hello|hey|dear)\b[^,?]*,\s*)?(?:how are (?:you|things)|how's it going|how have you been|hope (?:you're|you are) (?:well|good))\b/i;

const lower = (value: string) => value.trim().toLowerCase();

/** The address a message was sent to, parsed; `to` is only read, guarded, as a fallback. */
function recipientsOf(message: ScanMessage): string[] {
  return (message.toAddresses ?? fromAddresses(message.to)).map(lower);
}

function sendersOf(message: ScanMessage): string[] {
  return (message.fromAddresses ?? fromAddresses(message.from)).map(lower);
}

/** `Deverill IT <service@deverill.example>` gives `Deverill IT` for that address. */
function nameFor(header: string, address: string): string | null {
  for (const part of header.split(',')) {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
    if (match?.[2] && lower(match[2]) === address) return match[1]?.trim() || null;
  }
  return null;
}

/** The subject with every `Re:` and `Fwd:` taken off, for matching a thread. */
export function baseSubject(subject: string): string {
  let text = subject.trim();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/^(?:re|fw|fwd|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i, '').trim();
  }
  return text.toLowerCase();
}

/** The person's own words: the body up to the quoted history, without quoted lines. */
export function ownWords(text: string): string {
  let end = text.length;
  for (const marker of QUOTED_HISTORY) {
    const match = marker.exec(text);
    if (match && match.index < end) end = match.index;
  }
  return text
    .slice(0, end)
    .split('\n')
    .map((line) => (line.trimStart().startsWith('>') ? '' : line))
    .join('\n');
}

/**
 * The first sentence of the person's own words that asks for something, and
 * where it sits in the stored text, or null when they asked nothing.
 */
export function askingSentence(
  message: Pick<ScanMessage, 'subject' | 'text'>,
): { quote: string; start: number; end: number } | null {
  const own = ownWords(message.text);
  const offset = messageText(message).length - message.text.length;
  const sentence = /[^.!?\n]+[.!?]*/g;
  for (let match = sentence.exec(own); match; match = sentence.exec(own)) {
    const quote = match[0].trim();
    if (!quote) continue;
    const asks = (quote.endsWith('?') && !PLEASANTRY.test(quote)) || REQUEST.test(quote);
    if (!asks) continue;
    const start = offset + match.index + match[0].indexOf(quote);
    return { quote, start, end: start + quote.length };
  }
  return null;
}

/** Everyone who has sent the person a newsletter or other automated mail. */
function automatedSenders(inbox: readonly ScanMessage[]): Set<string> {
  const senders = new Set<string>();
  for (const message of inbox)
    if (message.unsubscribe || message.automated)
      for (const address of sendersOf(message)) senders.add(address);
  return senders;
}

/** Whether anything in the inbox answers this sent message to these recipients. */
function answeredBy(
  message: ScanMessage,
  recipients: readonly string[],
  inbox: readonly ScanMessage[],
): boolean {
  const sentAt = Date.parse(message.receivedAt);
  const subject = baseSubject(message.subject);
  const companies = new Set(
    recipients
      .map((address) => registrableDomain(address))
      .filter((domain): domain is string => domain !== null && !PERSONAL_DOMAINS.has(domain)),
  );
  return inbox.some((reply) => {
    if (!(Date.parse(reply.receivedAt) > sentAt)) return false;
    if (reply.inReplyTo === message.messageId) return true;
    if (reply.references?.includes(message.messageId)) return true;
    const from = sendersOf(reply);
    if (from.some((address) => recipients.includes(address))) return true;
    return (
      baseSubject(reply.subject) === subject &&
      from.some((address) => {
        const domain = registrableDomain(address);
        return domain !== null && companies.has(domain);
      })
    );
  });
}

/**
 * Of the messages the person sent, the ones still waiting on a reply. Pure:
 * the same folders at the same instant give the same answer.
 */
export function findAwaitedReplies(input: {
  sent: readonly ScanMessage[];
  inbox: readonly ScanMessage[];
  now: Date;
  afterDays?: number;
  windowDays?: number;
}): AwaitedScan {
  const now = input.now.getTime();
  const after = (input.afterDays ?? AWAITED_AFTER_DAYS) * DAY_MS;
  const window = (input.windowDays ?? AWAITED_WINDOW_DAYS) * DAY_MS;
  const counts: Record<string, number> = {
    sent_read: input.sent.length,
    automatic: 0,
    asks_nothing: 0,
    nobody_to_answer: 0,
    superseded: 0,
    answered: 0,
    too_recent: 0,
    too_old: 0,
  };
  const self = new Set(input.sent.flatMap(sendersOf));
  const robots = automatedSenders(input.inbox);

  // Newest first, so the latest message in a thread is the one that is kept.
  const ordered = [...input.sent].sort(
    (a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.messageId.localeCompare(b.messageId),
  );
  const threads = new Set<string>();
  const awaited: AwaitedFinding[] = [];
  const answered: string[] = [];
  for (const message of ordered) {
    const sentAt = Date.parse(message.receivedAt);
    if (!Number.isFinite(sentAt) || now - sentAt > window) {
      counts.too_old = (counts.too_old ?? 0) + 1;
      continue;
    }
    if (message.automated) {
      counts.automatic = (counts.automatic ?? 0) + 1;
      continue;
    }
    const recipients = recipientsOf(message).filter(
      (address) =>
        !self.has(address) &&
        !robots.has(address) &&
        !ROBOT_LOCAL.test(address.slice(0, address.lastIndexOf('@'))),
    );
    if (!recipients.length) {
      counts.nobody_to_answer = (counts.nobody_to_answer ?? 0) + 1;
      continue;
    }
    const thread = `${[...recipients].sort().join(',')}|${baseSubject(message.subject)}`;
    if (threads.has(thread)) {
      counts.superseded = (counts.superseded ?? 0) + 1;
      continue;
    }
    threads.add(thread);
    const asked = askingSentence(message);
    if (!asked) {
      counts.asks_nothing = (counts.asks_nothing ?? 0) + 1;
      continue;
    }
    if (answeredBy(message, recipients, input.inbox)) {
      counts.answered = (counts.answered ?? 0) + 1;
      answered.push(message.messageId);
      continue;
    }
    if (now - sentAt < after) {
      counts.too_recent = (counts.too_recent ?? 0) + 1;
      continue;
    }
    const to = recipients[0] as string;
    awaited.push({
      messageId: message.messageId,
      to,
      toName: nameFor(message.to, to),
      subject: message.subject,
      sentAt: new Date(sentAt).toISOString(),
      ...asked,
      text: messageText(message),
    });
  }
  return { awaited, answered, counts };
}
