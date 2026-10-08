/**
 * A long conversation's earlier messages, summarised.
 *
 * The engine keeps no session between attempts, so every attempt is handed the
 * conversation so far, held to a share of the engine's compaction trigger.
 * What does not fit is replaced by a running summary, kept in the job's own
 * event log (a `history_summary` notice; the newest one counts) and extended
 * from where it stopped, so no message is summarised twice and per-turn cost
 * stays flat however long the conversation grows.
 *
 * The cut is sticky. When the messages after the summary no longer fit, the
 * oldest of them are summarised until what stays takes at most half the room,
 * and the cut stays there until they outgrow it again. Between extensions the
 * summary and the messages after it only grow at the end, so a provider's
 * cached prompt prefix holds from one turn to the next.
 *
 * Everything here is pure; `history-extend.ts` performs the extension.
 */
import {
  type CanonicalMessage,
  type ContextGenerations,
  contextGenerations,
  EARLIER_SUMMARY_CHARACTERS,
} from '@melete/contracts';
import { z } from 'zod';
import { estimateInputTokens } from '../gateway/metering.ts';

/** The notice kind a summary is kept under, in the job's events. */
export const HISTORY_SUMMARY_KIND = 'history_summary';

/** Of the room for the earlier conversation, how much stays as messages after an extension. */
export const KEEP_SHARE = 0.5;

/** What one summary keeps. Each list item is one line; the story is a short account in order. */
export const conversationSummary = z.object({
  facts: z.array(z.string()),
  decisions: z.array(z.string()),
  open_tasks: z.array(z.string()),
  names: z.array(z.string()),
  story: z.string(),
});
export type ConversationSummary = z.infer<typeof conversationSummary>;

export const EMPTY_SUMMARY: ConversationSummary = {
  facts: [],
  decisions: [],
  open_tasks: [],
  names: [],
  story: '',
};

/** A stored summary: the messages up to `through` are in it, `messages` of them in all. */
export type StoredSummary = {
  through: string;
  summary: ConversationSummary;
  messages: number;
  /**
   * The policy and connection generations it was made under. What a revoked
   * context gave is not read again, so a summary made before the revocation
   * is set aside and the messages are summarised again from what remains.
   */
  generations: ContextGenerations;
};

const storedPayload = z.object({
  kind: z.literal(HISTORY_SUMMARY_KIND),
  through: z.iso.datetime({ offset: true }),
  summary: conversationSummary,
  messages: z.number().int().nonnegative(),
  generations: contextGenerations,
});

/** Whether a summary was made under exactly these generations. */
export function madeUnder(stored: StoredSummary, current: ContextGenerations): boolean {
  const made = stored.generations;
  const ids = new Set([
    ...Object.keys(made.connection_generations),
    ...Object.keys(current.connection_generations),
  ]);
  return (
    made.policy_generation === current.policy_generation &&
    [...ids].every((id) => made.connection_generations[id] === current.connection_generations[id])
  );
}

/** A notice's payload read as a stored summary, or null when it is not one. */
export function storedSummary(payload: unknown): StoredSummary | null {
  const parsed = storedPayload.safeParse(payload);
  return parsed.success
    ? {
        through: parsed.data.through,
        summary: parsed.data.summary,
        messages: parsed.data.messages,
        generations: parsed.data.generations,
      }
    : null;
}

/** The payload a summary is stored with. */
export const summaryPayload = (stored: StoredSummary) => ({
  kind: HISTORY_SUMMARY_KIND,
  through: stored.through,
  summary: stored.summary,
  messages: stored.messages,
  generations: stored.generations,
});

const line = (text: string) => text.replace(/\s+/g, ' ').trim();

/** What a summary that kept nothing says, so the messages it covers are never a silent gap. */
export const EMPTY_SUMMARY_TEXT = 'Nothing in those messages needed keeping.';

/**
 * The summary as the attempt reads it, held to the contract's size. Facts,
 * decisions, open tasks and names come before the story, so a summary that has
 * to be cut loses the narrative first.
 */
export function renderSummary(summary: ConversationSummary): string {
  const section = (title: string, items: string[]) => {
    const kept = items.map(line).filter(Boolean);
    return kept.length ? [`${title}:`, ...kept.map((item) => `- ${item}`)] : [];
  };
  const sections = [
    section('What the person said, with the details they gave', summary.facts),
    section('Decided', summary.decisions),
    section('Still open', summary.open_tasks),
    section('Names', summary.names),
  ].filter((lines) => lines.length);
  const story = line(summary.story);
  const text = [
    ...sections.map((lines) => lines.join('\n')),
    ...(story ? [`What happened: ${story}`] : []),
  ].join('\n\n');
  if (text.length <= EARLIER_SUMMARY_CHARACTERS) return text;
  return `${text.slice(0, EARLIER_SUMMARY_CHARACTERS - 1).trimEnd()}…`;
}

/** A completed tool call, whose identity always stays in the transcript. */
export const isToolIdentity = (message: CanonicalMessage) =>
  message.role === 'tool' && Boolean(message.tool_call_id);

const tokensOf = (message: CanonicalMessage) => estimateInputTokens(JSON.stringify(message));

/** What to summarise next, and the time of the last message it takes. */
export type ExtensionPlan = { summarise: CanonicalMessage[]; through: string };

/**
 * The oldest of `prior` to summarise so that what stays takes at most
 * `KEEP_SHARE` of the room, or null when everything fits already.
 *
 * `prior` is the conversation after the current summary, in order, without
 * this turn's new messages or tool results; `room` is what it may take. Messages
 * that share the time of the last one summarised go with it, since the cut is
 * kept as a time.
 */
export function planExtension(
  prior: readonly CanonicalMessage[],
  room: { tokens: number; messages: number },
  /**
   * The earliest time the cut may not reach: this turn's own messages. One the
   * person sent while the last reply was still being written is older than
   * that reply, and a cut past it would drop it next turn unsummarised.
   */
  before = Number.POSITIVE_INFINITY,
): ExtensionPlan | null {
  const sizes = prior.map(tokensOf);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= room.tokens && prior.length <= room.messages) return null;
  const keepTokens = Math.floor(Math.max(0, room.tokens) * KEEP_SHARE);
  const keepMessages = Math.floor(Math.max(0, room.messages) * KEEP_SHARE);
  let start = prior.length;
  let kept = 0;
  while (start > 0) {
    const size = sizes[start - 1] ?? 0;
    if (prior.length - start + 1 > keepMessages || kept + size > keepTokens) break;
    start -= 1;
    kept += size;
  }
  if (start === 0) return null;
  const last = prior[start - 1];
  if (!last) return null;
  const through = Date.parse(last.at);
  while (start < prior.length && Date.parse(prior[start]?.at ?? '') <= through) start += 1;
  // Back off to the last message wholly before this turn's own.
  while (start > 0 && Date.parse(prior[start - 1]?.at ?? '') >= before) start -= 1;
  while (
    start > 0 &&
    start < prior.length &&
    Date.parse(prior[start]?.at ?? '') <= Date.parse(prior[start - 1]?.at ?? '')
  )
    start -= 1;
  if (start === 0) return null;
  const summarise = prior.slice(0, start);
  return { summarise, through: summarise.at(-1)?.at ?? last.at };
}

/** One call's worth of messages, as text, and how many messages it completes. */
export type SummaryChunk = { text: string; completes: number };

/** A message as the summariser reads it. */
function messageText(message: CanonicalMessage): string {
  const who =
    message.role === 'user'
      ? message.name
        ? `${message.name} (a person)`
        : 'The person'
      : message.role === 'assistant'
        ? 'The assistant'
        : message.role;
  return `[${who}, ${message.at}]\n${message.content}`;
}

/** A message's text, split into parts that each fit one call. */
function partsOf(message: CanonicalMessage, maxTokens: number): string[] {
  const whole = messageText(message);
  const size = estimateInputTokens(whole);
  if (size <= maxTokens) return [whole];
  // Characters per part in proportion to what they cost, with a margin.
  const span = Math.max(1, Math.floor((whole.length * maxTokens * 0.9) / size));
  const count = Math.ceil(whole.length / span);
  return Array.from(
    { length: count },
    (_, part) => `(part ${part + 1} of ${count})\n${whole.slice(part * span, (part + 1) * span)}`,
  );
}

/**
 * Messages packed into calls of at most about `maxTokens` each, in order. A
 * message too long for one call is split into parts across calls. `completes`
 * counts the messages whose last part is in that chunk or an earlier one, so a
 * run of calls stopped early says exactly which messages it covered.
 */
export function chunkMessages(
  messages: readonly CanonicalMessage[],
  maxTokens: number,
): SummaryChunk[] {
  const chunks: SummaryChunk[] = [];
  let text: string[] = [];
  let used = 0;
  let completed = 0;
  const flush = () => {
    if (text.length) chunks.push({ text: text.join('\n\n'), completes: completed });
    text = [];
    used = 0;
  };
  for (const [index, message] of messages.entries()) {
    const parts = partsOf(message, maxTokens);
    for (const [number, part] of parts.entries()) {
      const cost = estimateInputTokens(part);
      if (used > 0 && used + cost > maxTokens) flush();
      text.push(part);
      used += cost;
      if (number === parts.length - 1) completed = index + 1;
    }
  }
  flush();
  return chunks;
}
