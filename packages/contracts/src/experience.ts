/** Outcome vocabulary for personal interfaces. Never pass an internal record through here. */

import { z } from 'zod';
import { ATTACHMENT_LIMITS, attachmentView } from './attachments.ts';
import {
  becauseLink,
  beliefBlockList,
  beliefExport,
  beliefExportQuery,
  beliefHistory,
  beliefImport,
  beliefImportResult,
  beliefList,
  memoryDigestResponse,
  memoryRewindResponse,
  memoryTimeline,
  memoryTimelineQuery,
  rewindPreview,
  rewindTarget,
} from './beliefs.ts';
import { PROCESS_STATES } from './execution.ts';
import { roomHandoff } from './handoffs.ts';
import { memoryKey } from './memory.ts';
import { privacyOperations } from './privacy.ts';
import { MESSAGE_SPAN_LIMIT, messageId, messageSpan } from './reactions.ts';
import {
  runCreateRequest,
  runExportResponse,
  runLimitRequest,
  runListQuery,
  runListResponse,
  runMessageRequest,
  runRecordQuery,
  runRecordResponse,
  runResponse,
} from './runs.ts';

const id = z.string().min(1).max(240);
const text = z.string().min(1).max(4000);
const date = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const url = z.url().refine((value) => /^https?:\/\//i.test(value), 'Use a web address.');

export const notAvailable = z.strictObject({
  status: z.literal('not_available'),
  reason: text,
});
export type NotAvailable = z.infer<typeof notAvailable>;
export const unavailable = (reason: string): NotAvailable =>
  notAvailable.parse({ status: 'not_available', reason });
export const experienceOk = z.strictObject({ status: z.literal('ok') });
export const experienceResult = <T extends z.ZodType>(shape: T) => z.union([shape, notAvailable]);

export const deliveryState = z.enum(['sending', 'queued_offline', 'failed_retry']);
export const turnStatus = z.enum([
  'idle',
  'queued',
  'working',
  'streaming',
  'needs_you',
  'paused',
  'done',
  'failed',
  'stopped',
]);
export const agentFaceState = z.enum([
  'idle',
  'observing',
  'thinking',
  'deep',
  'working',
  'done',
  'failed',
  'invalid',
  'inactive',
]);
export const composerState = z.enum(['send', 'pause', 'resume', 'stop']);
export const experienceSource = z.strictObject({
  app: text,
  title: text,
  url: url.optional(),
  kind: z.enum(['event', 'message', 'draft', 'file', 'page', 'task']),
  connection_id: id,
});
export type ExperienceSource = z.infer<typeof experienceSource>;
export const cardAction = z.strictObject({
  label: text,
  kind: z.enum(['open', 'download', 'send', 'undo']),
  handle: id,
  url: url.optional(),
});
export const resultCard = z.strictObject({
  id,
  title: text,
  meta: z.string().max(4000),
  image: url.optional(),
  facts: z.array(z.strictObject({ label: text, value: text })).max(20),
  primary_action: cardAction.nullable(),
  secondary_actions: z.array(cardAction).max(8),
  source_connection: id.nullable(),
});
export type ResultCard = z.infer<typeof resultCard>;
/**
 * What auto-review decided about one action, in the service's words.
 * `policy` is the fixed rule (work inside the agent's own sandbox, or a limit
 * that sent the action to the person); `reviewer` is the independent model
 * review. `risk` is the reviewer's own rating, absent when none was given.
 */
export const actionReview = z.strictObject({
  outcome: z.enum(['auto_approved', 'escalated']),
  by: z.enum(['policy', 'reviewer']),
  reason: text,
  risk: z.enum(['low', 'medium', 'high']).nullable(),
  reviewed_at: date,
});
export type ActionReview = z.infer<typeof actionReview>;
export const experienceReceipt = z.strictObject({
  id,
  what: text,
  where: text,
  when: date,
  undo: z.strictObject({ handle: id, valid_until: date }).optional(),
  /**
   * Set while a message waits before it is sent: until then Undo cancels it
   * and nothing leaves. Gone once it is sent.
   */
  sending_until: date.optional(),
  /** The receipt of the change this one took back, when it is an undo. */
  reverses: id.optional(),
  /** Present when nobody was asked because auto-review approved it. */
  review: actionReview.optional(),
  /** The beliefs or rule the action rested on, recorded when it was proposed. */
  because: z.array(becauseLink).max(20).optional(),
});
export type ExperienceReceipt = z.infer<typeof experienceReceipt>;
export const experienceDraft = z.strictObject({
  id,
  recipient: text,
  cc: z.array(text).max(50).optional(),
  bcc: z.array(text).max(50).optional(),
  channel: z.enum(['email', 'message']),
  body: z.string().max(100000),
  subject: z.string().max(1000).optional(),
  connection_id: id,
  status: z.enum(['draft', 'awaiting_permission', 'denied', 'sent', 'discarded']),
});
export type ExperienceDraft = z.infer<typeof experienceDraft>;

export const quickOption = z.strictObject({ id, label: text });
export const quickOptions = z
  .array(quickOption)
  .max(4)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'Choices must have different ids.',
  );
export const experienceQuestion = z.strictObject({
  id,
  conversation_id: id.nullable(),
  text,
  why: z.array(text),
  if_ignored: text,
  options: quickOptions,
  /**
   * Whether an answer in the person's own words is accepted beside the
   * options. A question about which revision of a fact to keep, or whether a
   * conversation may leave the device, takes one of its options only.
   */
  free_text: z.boolean(),
  /** When it was asked; the queue is oldest first. */
  created_at: date,
});
/** One of the offered answers by its id, or an answer in the person's own words. */
export const quickAnswerRequest = z.union([
  z.strictObject({ option_id: id }),
  z.strictObject({ text: z.string().trim().min(1).max(2000) }),
]);
export type QuickAnswerRequest = z.infer<typeof quickAnswerRequest>;

/** Every bound is required. The recipient is resolved from trusted evidence by the service. */
export const standingRuleBounds = z.strictObject({
  count_cap: z.number().int().positive().max(100),
  expires_at: date,
  reconsent_after_days: z.number().int().positive().max(30),
});
export const standingRule = z.strictObject({
  id,
  text,
  kind: z.enum([
    'send_message',
    'create_event',
    'change_event',
    'delete_event',
    'save_file',
    'restore_file',
    'discard_draft',
    /** Pushes from the agent's computer to `melete/` branches of one repository. */
    'push_branch',
  ]),
  connection_id: id,
  recipient_class: text,
  bounds: standingRuleBounds,
  used: count,
  created_at: date,
});
export type StandingRule = z.infer<typeof standingRule>;
/** How much of a proposed file a permission card carries. */
export const PERMISSION_FILE_PREVIEW_CHARS = 20_000;
/** A person a room's permission names: their id, and their name with their email. */
export const permissionPerson = z.strictObject({ principal_id: id, display_name: z.string() });
export const permissionCard = z.strictObject({
  id,
  conversation_id: id,
  what: text,
  why: z.array(text).min(1),
  options: z.array(z.enum(['allow_once', 'always', 'deny'])).min(1),
  version: id,
  preview: resultCard.nullable(),
  draft: experienceDraft.optional(),
  /**
   * A file this request would save: where it goes and what it says, so it is
   * never approved unseen. `truncated` marks content cut at the preview limit.
   */
  file: z
    .strictObject({
      path: text,
      bytes: count,
      content: z.string().max(PERMISSION_FILE_PREVIEW_CHARS),
      truncated: z.boolean(),
    })
    .optional(),
  /** Present when auto-review looked at this first and sent it to the person. */
  review: actionReview.optional(),
  /** When permission was asked for; the queue is oldest first. */
  created_at: date,
  /** The beliefs the action rested on, recorded when it was proposed. */
  because: z.array(becauseLink).max(20).optional(),
  /** In a room: the person whose request this is. */
  requested_by: permissionPerson.optional(),
  /**
   * In a room: everyone who may answer this, under the room's rule. Anyone
   * else in the room sees the card and cannot answer it.
   */
  eligible_approvers: z.array(permissionPerson).optional(),
  /**
   * In a room: the hash of exactly what this would do. An answer names it, so
   * nobody answers for content they did not see.
   */
  payload_hash: id.optional(),
});
export type PermissionCard = z.infer<typeof permissionCard>;

/**
 * The action classes a person can let auto-review decide. Anything that
 * spends, sends, deletes, carries credentials, or rests on a value the person
 * never confirmed is not a class here: it always asks.
 */
export const AUTO_REVIEW_CLASSES = [
  'sandbox',
  'calendar',
  'own_calendar',
  'app_changes',
  'apps',
] as const;
export const autoReviewClass = z.enum(AUTO_REVIEW_CLASSES);
export type AutoReviewClass = z.infer<typeof autoReviewClass>;
export const approvalSettings = z.strictObject({
  /** `ask`: every change waits for the person. `auto_review`: the classes switched on below do not. */
  mode: z.enum(['ask', 'auto_review']),
  classes: z.strictObject({
    /** Work in the agent's own workspace: commands, files, its own browser. */
    sandbox: z.boolean(),
    /** Events on the person's own calendar, after the reviewer approves. */
    calendar: z.boolean(),
    /**
     * Events on the person's own calendar with no guests, and removing ones
     * Melete made, decided by a fixed rule: they go ahead only when they can
     * be undone and touch nothing important (anything in the next few hours,
     * a repeating meeting, an event with guests or marked important, or one of
     * the person's own events that blocks the time). Anything important, or a
     * calendar that cannot be read for it, asks, with the reason.
     */
    own_calendar: z.boolean(),
    /** Reversible changes in connected apps, after the reviewer approves. */
    app_changes: z.boolean(),
    /**
     * Publishing an app, a new version of one, or going back to an earlier
     * version, decided by a fixed rule: it goes ahead when nobody new can open
     * the app, its code opens no direct connections, and it shows its viewers
     * no data they do not see now. Anything else asks, with the reason.
     */
    apps: z.boolean(),
  }),
});
export type ApprovalSettings = z.infer<typeof approvalSettings>;
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  mode: 'auto_review',
  classes: { sandbox: true, calendar: false, own_calendar: true, app_changes: false, apps: true },
};
export const approvalSettingsResponse = z.strictObject({
  settings: approvalSettings,
  /** Whether an independent reviewer is configured; without one, reviewed classes ask. */
  reviewer_available: z.boolean(),
});
export const permissionDecision = z.discriminatedUnion('option', [
  z.strictObject({ option: z.literal('allow_once'), version: id }),
  z.strictObject({ option: z.literal('always'), version: id, bounds: standingRuleBounds }),
  z.strictObject({ option: z.literal('deny'), version: id }),
]);
export const permissionOutcome = z.strictObject({
  status: z.literal('ok'),
  option: z.enum(['allow_once', 'always', 'deny']),
  rule: standingRule.nullable(),
});

/**
 * What kind of work a tool entry stands for. It picks an icon, never a code
 * path: every kind has the same fields and the same status rules.
 */
export const TOOL_KINDS = [
  'connector',
  'web',
  'file',
  'artifact',
  'browser',
  'sandbox',
  'skill',
  'memory_recall',
  'memory_write',
  'memory_correct',
  'memory_forget',
  'model',
  'retry',
  'tool',
] as const;
export const toolKind = z.enum(TOOL_KINDS);
export type ToolKind = z.infer<typeof toolKind>;
/**
 * `needs_approval` waits on the person; `unknown` means the destination never
 * said whether it happened, and nothing is retried blindly.
 */
export const toolStatus = z.enum(['running', 'done', 'failed', 'needs_approval', 'unknown']);
export type ToolStatus = z.infer<typeof toolStatus>;
export const TOOL_TITLE_LIMIT = 120;
export const TOOL_SUMMARY_LIMIT = 160;
export const TOOL_QUOTE_LIMIT = 200;
/**
 * Text that came from somewhere other than the service: a page, a message, a
 * file, or what was asked of a tool. A client shows it as a quotation from
 * `from`, never in the assistant's voice.
 */
export const toolQuote = z.strictObject({
  text: z.string().min(1).max(TOOL_QUOTE_LIMIT),
  from: z.enum(['page', 'message', 'file', 'event', 'app', 'request']),
});
export type ToolQuote = z.infer<typeof toolQuote>;
/** `text` is the service's own words; anything taken from outside is in `quote`. */
export const toolSummary = z.strictObject({
  text: z.string().min(1).max(TOOL_SUMMARY_LIMIT),
  quote: toolQuote.optional(),
});
export type ToolSummary = z.infer<typeof toolSummary>;
/**
 * A longer stretch of what went in or came out, for a row the person opens: a
 * whole command, the first lines it printed, the words of a search. It is
 * filtered like an answer, a secret hidden where it stands, and `more` says it was cut.
 * Draw it as plain monospace text, never as Markdown or HTML.
 */
export const TOOL_EXCERPT_LIMIT = 2000;
export const toolExcerpt = z.strictObject({
  text: z.string().min(1).max(TOOL_EXCERPT_LIMIT),
  from: toolQuote.shape.from,
  more: z.boolean(),
});
export type ToolExcerpt = z.infer<typeof toolExcerpt>;
/**
 * Why a failed entry did not happen: it went wrong (`error`), a rule or the
 * destination would not allow it (`refused`), or the person said no
 * (`declined`). `output_summary` says it in plain words.
 */
export const toolFailure = z.enum(['error', 'refused', 'declined']);
export type ToolFailure = z.infer<typeof toolFailure>;
/**
 * Something the person can open for more: a file, the pending permission, a
 * page. A `screenshot` names the action that took one; its picture is at
 * `GET /screenshots/{id}`, for the person only.
 */
export const toolDetail = z.strictObject({
  type: z.enum(['artifact', 'permission', 'receipt', 'memory', 'page', 'screenshot']),
  id,
  url: url.optional(),
});
export type ToolDetail = z.infer<typeof toolDetail>;
/**
 * One piece of work done for the person, shown in the conversation. Each
 * change arrives as a whole new copy under the same `id`; a client keeps the
 * latest. `parent` names the entry this one belongs under.
 *
 * The title says what was done with what: "Searched the web for “…”", "Read
 * page example.com/…". A name, a query or a command in it is scrubbed like a
 * quote and set off in quotation marks or backticks.
 *
 * Model entries (`kind: "model"`) mark the steps of a turn: each one is the
 * model deciding what to do next, and the entries after it, up to the next
 * one, are what it decided.
 */
export const toolCall = z.strictObject({
  id,
  kind: toolKind,
  title: z.string().min(1).max(TOOL_TITLE_LIMIT),
  status: toolStatus,
  started_at: date,
  ended_at: date.nullable(),
  input_summary: toolSummary.nullable(),
  output_summary: toolSummary.nullable(),
  detail: toolDetail.nullable(),
  parent: id.nullable(),
  /** The fuller input, when there is more to it than the summary holds. */
  input_excerpt: toolExcerpt.optional(),
  /** The fuller output, likewise. */
  output_excerpt: toolExcerpt.optional(),
  /** Set on a failed entry when the reason is known. */
  failure: toolFailure.optional(),
});
export type ToolCall = z.infer<typeof toolCall>;

/**
 * What memory did during a turn. A memory writer appends this as a `notice`
 * on the job, right after the work commits, and the conversation
 * shows it as a tool entry: "Used what you told me: …", "Remembered: …",
 * "Updated: …", "Forgot: …".
 *
 * `labels` name the details touched in plain words (a key label such as
 * "Home city", never a key or claim id). `value` is the saved wording, shown
 * as a quotation. Both may only describe details the conversation's own
 * person told the service or may already see; a detail another person in a
 * shared space said is counted, never named or quoted.
 */
export const MEMORY_TOOL_OPS = ['recall', 'write', 'correct', 'forget'] as const;
export const memoryToolOp = z.enum(MEMORY_TOOL_OPS);
export type MemoryToolOp = z.infer<typeof memoryToolOp>;
export const MEMORY_TOOL_NOTICE = 'memory_tool';
export const memoryToolNotice = z.strictObject({
  kind: z.literal(MEMORY_TOOL_NOTICE),
  op: memoryToolOp,
  /** Stable per piece of work, for example `recall:<attempt id>` or `write:<claim id>@<revision>`. */
  id,
  status: toolStatus,
  started_at: date,
  ended_at: date.nullable(),
  /** How many details the work touched, named or not. */
  count,
  labels: z.array(z.string().min(1).max(80)).max(20),
  value: z.string().min(1).max(TOOL_QUOTE_LIMIT).nullable(),
  /** The saved item the person can open, when there is one. */
  memory_item_id: id.nullable(),
  parent: id.nullable(),
});
export type MemoryToolNotice = z.infer<typeof memoryToolNotice>;
/**
 * Any other work, already described. The service scrubs every string again
 * before showing it, so a writer cannot leak outside text through a title.
 */
export const TOOL_TRACE_NOTICE = 'tool_trace';
export const toolTraceNotice = z.strictObject({
  kind: z.literal(TOOL_TRACE_NOTICE),
  call: toolCall,
});
export type ToolTraceNotice = z.infer<typeof toolTraceNotice>;

/**
 * How far a running conversation has got: finished steps and the one under
 * way. There is no total, so there is no percentage.
 */
export const conversationProgress = z.strictObject({
  steps_done: count,
  current: z.string().min(1).max(TOOL_TITLE_LIMIT).nullable(),
});
export type ConversationProgress = z.infer<typeof conversationProgress>;

export const trailStep = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('say'), text: z.string().min(1).max(600) }),
  z.strictObject({
    type: z.literal('action'),
    label: text,
    meta: z.string().max(4000),
    sources: z.array(experienceSource),
    /** Present when the step is one tool entry: the same copy the `tool` item carries. */
    tool: toolCall.optional(),
  }),
  z.strictObject({ type: z.literal('note'), text }),
  z.strictObject({
    type: z.literal('done'),
    summary: text,
    elapsed_ms: count,
    apps: z.array(text),
    source_count: count,
  }),
]);
export type TrailStep = z.infer<typeof trailStep>;

/**
 * How a permission or a question in the conversation was decided. It follows
 * the item it decides on the same stream, so a reloaded conversation shows the
 * decision rather than an open card.
 */
export const experienceDecision = z.strictObject({
  kind: z.enum(['permission', 'question']),
  /** The permission's or the question's id. */
  id,
  /**
   * `replaced` is a permission a later message in the same conversation made
   * stale: it can no longer be allowed, and nothing it covered is sent. On a
   * permission, `withdrawn` means the person stopped the turn while it waited,
   * with the same effect, and `outdated` means something it relied on (a fact
   * it rested on, or the request itself) changed before anyone answered.
   */
  outcome: z.enum([
    'allow_once',
    'always',
    'deny',
    'replaced',
    'answered',
    'withdrawn',
    'outdated',
  ]),
  /** The chosen answer, for an answered question. */
  answer: z.string().max(4000).nullable(),
  decided_at: date,
});
export type ExperienceDecision = z.infer<typeof experienceDecision>;

export const experienceEvent = z.strictObject({
  seq: count,
  conversation_id: id,
  turn_id: id.nullable(),
  created_at: date,
  item: z.union([
    trailStep,
    z.strictObject({
      type: z.literal('text_delta'),
      text: z.string(),
      /**
       * The turn's answer so far is replaced by this text rather than added
       * to: the attempt that wrote it was lost and the turn is running again.
       */
      restart: z.literal(true).optional(),
    }),
    /** The model's reasoning as it writes it, for the trail; never part of the answer. */
    z.strictObject({ type: z.literal('reasoning'), text: z.string() }),
    z.strictObject({ type: z.literal('card'), card: resultCard }),
    z.strictObject({ type: z.literal('receipt'), receipt: experienceReceipt }),
    z.strictObject({ type: z.literal('permission'), permission: permissionCard }),
    z.strictObject({ type: z.literal('question'), question: experienceQuestion }),
    z.strictObject({ type: z.literal('decision'), decision: experienceDecision }),
    z.strictObject({ type: z.literal('status'), status: turnStatus, composer: composerState }),
    z.strictObject({ type: z.literal('tool'), tool: toolCall }),
    /**
     * The agent's working copy of the conversation before this point was
     * summarised to make room. Every message is still saved and shown; the
     * agent now works from the summary. It carries no words of the summary.
     */
    z.strictObject({ type: z.literal('compacted') }),
  ]),
});
export type ExperienceEvent = z.infer<typeof experienceEvent>;
export const experienceEventPage = z.strictObject({
  events: z.array(experienceEvent),
  next_cursor: count,
  has_more: z.boolean(),
});
export const experienceEventQuery = z.strictObject({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export const conversation = z.strictObject({
  id,
  title: text,
  agent_id: id,
  status: turnStatus,
  composer: composerState,
  created_at: date,
  updated_at: date,
  plan_id: id.nullable(),
  /** Present while a turn is under way, or when it finished with steps. */
  progress: conversationProgress.optional(),
  /**
   * Set when this is the thread a routine writes each run into. The routine's
   * schedule adds to it; a message from the person starts a chat instead.
   */
  automation_id: id.optional(),
});
export type Conversation = z.infer<typeof conversation>;
export const conversationTurn = z.strictObject({
  id,
  conversation_id: id,
  agent_id: id,
  text: z.string(),
  answer: z.string(),
  status: turnStatus,
  delivery: deliveryState.nullable(),
  created_at: date,
  /** The files the person sent with this message. */
  attachments: z.array(attachmentView).max(ATTACHMENT_LIMITS.per_message_ceiling).optional(),
});
export const conversationCreate = z.strictObject({
  title: text,
  /** Left out, the chat goes to Melete, the agent every space has. */
  agent_id: id.optional(),
  plan_id: id.optional(),
});
export const conversationSwitchAgent = z.strictObject({ agent_id: id });
export const conversationMessage = z
  .strictObject({
    /** May be empty when the message carries files. */
    text: z.string().max(100000),
    /** The answer this message corrects, when the person replies to it as a correction. */
    corrects: messageId.optional(),
    /** Files uploaded with `POST /attachments` and not yet sent, in the order shown. */
    attachments: z.array(id).max(ATTACHMENT_LIMITS.per_message_ceiling).optional(),
    /** Stretches of `text` the person pasted rather than typed, when the composer can tell. */
    pasted: z.array(messageSpan).max(MESSAGE_SPAN_LIMIT).optional(),
  })
  .refine((value) => value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0, {
    message: 'A message needs words or a file.',
    path: ['text'],
  });
export const messageAcceptance = z.strictObject({
  turn_id: id,
  receipt: z.strictObject({ id, status: z.enum(['accepted', 'failed_retry']), received_at: date }),
});
export const conversationResponse = z.strictObject({ conversation });
/** A new name for a chat. It changes only the title, not when the chat was last active. */
export const conversationRename = z.strictObject({ title: z.string().trim().min(1).max(200) });
/**
 * Deleting a chat. What Melete learned from the chat stays unless
 * `forget_memory` is `true`; then it is forgotten the same way "forget that"
 * removes it, source and all.
 */
export const conversationDeleteQuery = z.strictObject({
  forget_memory: z.enum(['true', 'false']).optional(),
});
export const conversationDeleted = z.strictObject({
  id,
  /** A turn was under way and was stopped first. */
  stopped: z.boolean(),
  /** Permissions still waiting in the chat, withdrawn before it went. */
  withdrawn: count,
  /** Things Melete had learned from the chat that were forgotten with it. */
  forgotten: count,
});
export type ConversationDeleted = z.infer<typeof conversationDeleted>;
/** A person in the space the session is using. */
export const spaceMember = z.strictObject({
  principal_id: id,
  email: z.string().max(320),
  role: z.enum(['owner', 'member']),
  /** True for the person asking. */
  you: z.boolean(),
});
export type SpaceMember = z.infer<typeof spaceMember>;
export const spaceMembers = z.strictObject({
  space: z.strictObject({
    id,
    name: text,
    kind: z.enum(['personal', 'shared']),
    /** The asking person's place in it; only an owner removes people. */
    role: z.enum(['owner', 'member']),
  }),
  members: z.array(spaceMember),
});
export type SpaceMembers = z.infer<typeof spaceMembers>;
/**
 * Something done in the person's name whose chat or plan was later deleted:
 * what it was, where it went and when. Never what it said.
 */
export const activityEntry = z.strictObject({
  id,
  what: text,
  /** The connection it went through. */
  where: text,
  /** The recipient or place, where the effect has one. */
  destination: z.string().max(500).nullable(),
  /** The destination's own reference for it. */
  reference: z.string().max(500).nullable(),
  outcome: z.enum(['succeeded']),
  /** The title of the chat or plan it came from. */
  source: z.string().max(200),
  happened_at: date,
  /** Present while it can still be taken back; `POST /activity/{id}/undo` does it. */
  undo: z.strictObject({ valid_until: date }).optional(),
  /** Set once it was taken back. */
  undone_at: date.optional(),
});
export type ActivityEntry = z.infer<typeof activityEntry>;
export const activityList = z.strictObject({ activity: z.array(activityEntry) });
/**
 * The chats list, most recently active first. `next_cursor` continues after the
 * last one returned, and is null when there are no more.
 */
export const conversationList = z.strictObject({
  conversations: z.array(conversation),
  next_cursor: z.string().max(200).nullable(),
});
export const conversationListQuery = z.strictObject({
  limit: z.coerce.number().int().positive().max(200).default(200),
  cursor: z.string().max(200).optional(),
});

/** Where a page of chats ends: the last one's activity time and id, opaque to a client. */
export type ConversationCursor = { updated_at: string; id: string };
export function encodeConversationCursor(position: ConversationCursor): string {
  return Buffer.from(`${position.updated_at}|${position.id}`, 'utf8').toString('base64url');
}
/** Null for anything that is not a cursor this list handed out. */
export function decodeConversationCursor(cursor: string): ConversationCursor | null {
  const [updatedAt, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !updatedAt || !id || !date.safeParse(updatedAt).success) return null;
  return { updated_at: updatedAt, id };
}
export const turnList = z.strictObject({ turns: z.array(conversationTurn) });

export const agentInput = z.strictObject({
  name: z.string().min(1).max(40),
  role: z.string().min(1).max(120),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surface: z.enum(['rounded', 'blob', 'diamond', 'octagon', 'gear']),
  eye_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  tone: z.string().max(80),
  /**
   * A short brief the agent follows in every chat it handles. Sized so the
   * whole persona, with the longest name, tone and memory note, stays within
   * the 250-token identity cap.
   */
  standing_instruction: z.string().max(500),
  /** Null means every connection in the space, including ones connected later. */
  allowed_connection_ids: z.array(id).max(50).nullable(),
  asks_before_acting: z.boolean(),
  /** Whether it may use the computer: the browser, the terminal and code in the workspace. */
  uses_computer: z.boolean().default(true),
  /** Whether what Melete remembers about the person is brought into its work. */
  reads_memory: z.boolean().default(true),
  /** Whether what the person tells it is kept in memory. */
  writes_memory: z.boolean().default(true),
  face_image: url.optional(),
});
export const experienceAgent = agentInput.extend({
  id,
  space_id: id,
  /**
   * True for Melete, the agent every space has. It keeps its name and cannot
   * be removed.
   */
  is_default: z.boolean(),
  /**
   * True for Melete in a personal space, where it reaches every connection,
   * the computer and memory, and that cannot be narrowed. In a shared space
   * Melete starts with no connections and its owner chooses what it may use.
   */
  fixed_reach: z.boolean(),
  /** Its chats, when it last answered one, and the routines that run as it. */
  usage: z.strictObject({ conversations: count, last_used: date.nullable(), routines: count }),
});
export type ExperienceAgent = z.infer<typeof experienceAgent>;
/** The shelves of the agent library, in the order a client shows them. */
export const AGENT_CATEGORIES = [
  'Personal',
  'Home & family',
  'Money',
  'Work & email',
  'Research',
  'Writing',
  'Travel',
  'Health & routines',
  'Learning',
  'Code & projects',
  'Small business',
  'Shopping & subscriptions',
] as const;
export const agentCategory = z.enum(AGENT_CATEGORIES);
/**
 * The kinds of thing an agent works best with. They are shown, never granted:
 * the person chooses an agent's connections and switches themselves.
 * `computer` is the agent's own computer; `devices` are the person's paired
 * computers; `browser` is the browser the agent drives with takeover; `web`
 * is reading public pages.
 */
export const AGENT_WORKS_WITH = [
  'mail',
  'calendar',
  'files',
  'web',
  'browser',
  'computer',
  'devices',
  'mcp',
] as const;
export const agentWorksWith = z.enum(AGENT_WORKS_WITH);
/** A routine the library offers after an agent is added. Nothing runs until the person sets it up. */
export const starterRoutine = z.strictObject({
  title: z.string().min(1).max(80),
  instruction: z.string().min(1).max(600),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
/**
 * A question asked once after an agent is added. The answer is saved as the
 * person's own statement on `memory_key`, a `pref.<purpose>.<name>` key, so it
 * stays tied to what the agent is for.
 */
export const templateQuestion = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  question: z.string().min(1).max(160),
  placeholder: z.string().max(120),
  memory_key: memoryKey.refine((key) => key.startsWith('pref.'), 'Use a pref. key.'),
});
/** Where a piece of work in a template's example day reaches, drawn as a chat's work row. */
export const TEMPLATE_DAY_REACH = [
  'mail',
  'calendar',
  'files',
  'web',
  'browser',
  'computer',
  'memory',
] as const;
/**
 * An example of one exchange with a library agent, shown before it is added so
 * the person sees how it works in a chat: what they ask, its first message,
 * the work it does, the one question it asks, and what it says at the end. It
 * is an illustration, never something that ran.
 */
export const templateDay = z.strictObject({
  ask: z.string().min(1).max(200),
  opening: z.string().min(1).max(240),
  work: z
    .array(z.strictObject({ reach: z.enum(TEMPLATE_DAY_REACH), title: z.string().min(1).max(100) }))
    .min(2)
    .max(4),
  question: z.strictObject({
    text: z.string().min(1).max(160),
    /** The first is the answer the example goes on with. */
    options: z.array(z.string().min(1).max(60)).length(2),
  }),
  answer: z.string().min(1).max(480),
});
export const agentTemplate = z.strictObject({
  id,
  title: text,
  category: agentCategory,
  /** One line on what it does for the person. */
  benefit: z.string().min(1).max(120),
  /** What it does, in a few plain lines. */
  does: z.array(z.string().min(1).max(160)).min(1).max(5),
  /** What it never does, in plain words. */
  wont: z.array(z.string().min(1).max(160)).min(1).max(4),
  works_best_with: z.array(agentWorksWith).max(5),
  /**
   * The connections its job rests on, each with what it can do without one,
   * in plain words. The draft says it when the person leaves one unticked.
   */
  relies_on: z
    .array(z.strictObject({ kind: agentWorksWith, without: z.string().min(1).max(200) }))
    .max(2),
  starter_routine: starterRoutine.nullable(),
  questions: z.array(templateQuestion).max(4),
  /** Built-in skills that fit its work. Skills are chosen per request; this only names them. */
  skills: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(4),
  /** Offered during setup as well as in the library. */
  featured: z.boolean(),
  day: templateDay,
  agent: agentInput,
});
export type AgentTemplate = z.infer<typeof agentTemplate>;
export const agentList = z.strictObject({
  agents: z.array(experienceAgent),
  /**
   * Agents deleted from the space, only to name the turns they answered. They
   * are never offered to pick or to @mention.
   */
  removed: z.array(experienceAgent).optional(),
});
export const agentResponse = z.strictObject({ agent: experienceAgent });
export const agentTemplateList = z.strictObject({ templates: z.array(agentTemplate) });
/** What deleting an agent did: its chats and routines now belong to Melete. */
export const agentDeleted = z.strictObject({
  id,
  /** Melete, which now answers where the deleted agent did. */
  moved_to: id,
  conversations: z.number().int().nonnegative(),
  routines: z.number().int().nonnegative(),
  /**
   * Routines paused on the move, because Melete can reach more than the
   * deleted agent could. The person turns each back on themselves.
   */
  routines_paused: z.number().int().nonnegative(),
});

export const memoryItem = z.strictObject({
  id,
  key: text,
  value: z.string().max(16000),
  source: z.enum(['onboarding', 'conversation', 'inferred']),
  created: date,
  last_used: date.nullable(),
  editable: z.boolean(),
  version: id,
  /** The assistant that saved this detail through Melete's MCP endpoint, by the name it registered. */
  saved_by: z.string().max(120).optional(),
});
export const memoryItemEdit = z.strictObject({ value: z.string().min(1).max(16000), version: id });
/**
 * A detail the person states directly, during setup or later. It becomes an
 * owner-trusted claim on a registered key; stating the same key again replaces
 * the value, so one key has one current answer. `statement` is the sentence
 * that was said, kept as the claim's evidence; it defaults to the value.
 * Event and contact keys belong to deterministic extractors and receive a
 * 409 `extractor_owned_key` error; their existing items can be corrected.
 */
export const memoryItemCreate = z.strictObject({
  key: memoryKey,
  value: z.string().min(1).max(16000),
  statement: z.string().min(1).max(16000).optional(),
});
export const memoryItemResponse = z.strictObject({ item: memoryItem });
/** `next`, when present and not null, is the `after` value for the following page. */
export const memoryItemList = z.strictObject({
  items: z.array(memoryItem),
  next: id.nullable().optional(),
});
/**
 * A note Melete kept for itself in a chat with the person: something it found
 * out or worked out, in its own words. It is never the person's statement and
 * is recalled to Melete labelled as its own note. The person can delete it.
 */
export const agentNote = z.strictObject({
  id,
  text: z.string().max(2000),
  created: date,
  /** The chat it was written in, while that chat still exists. */
  chat: z.strictObject({ id, title: z.string().max(400) }).nullable(),
});
export type AgentNote = z.infer<typeof agentNote>;
export const agentNoteList = z.strictObject({ notes: z.array(agentNote) });
/**
 * A person's own memory settings. Memory is on unless they turn it off; off,
 * nothing new they say in chat is kept, and "forget ..." still works.
 */
export const memorySettings = z.strictObject({ capture: z.boolean() });
/**
 * Whether conversations in this space read public web pages: GET and HEAD
 * only, public addresses only, never signed in. On unless it is turned
 * off; a private space or agent stays offline whatever this says.
 */
export const webReadSettings = z.strictObject({ enabled: z.boolean() });
export const webReadStatus = z
  .strictObject({
    enabled: z.boolean(),
    /** False when the space has no web connection for the setting to apply to. */
    available: z.boolean(),
  })
  .meta({ id: 'WebReadStatus' });
export const memoryExplanation = z.strictObject({
  reasons: z.array(text),
  output: z.string().nullable(),
  used_at: date.nullable(),
});

export const milestoneInput = z.strictObject({
  title: text,
  assignee: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person') }),
    z.strictObject({ kind: z.literal('agent'), agent_id: id }),
  ]),
  schedule_at: date.optional(),
});
export const planMilestone = milestoneInput.extend({
  id,
  done: z.boolean(),
  status: turnStatus,
  /** What the assistant doing this step last said: its result, or what it asked. */
  output: z.string().max(2000).nullable().optional(),
});
export const experiencePlan = z.strictObject({
  id,
  title: text,
  category: text,
  milestones: z.array(planMilestone),
  next_step: text.nullable(),
  progress_percent: z.number().min(0).max(100),
  conversation_ids: z.array(id),
  file_ids: z.array(id),
  updated_at: date,
});
export const planCreate = z.strictObject({
  title: text,
  category: text,
  milestones: z.array(milestoneInput).max(100),
});
export const planList = z.strictObject({ plans: z.array(experiencePlan) });
export const planResponse = z.strictObject({ plan: experiencePlan });
export const milestoneUpdate = z.strictObject({ done: z.boolean() });

export const taskInput = z.strictObject({
  title: text,
  due_at: date.nullable(),
  done: z.boolean().default(false),
});
export const experienceTask = taskInput.extend({ id, created_at: date, updated_at: date });
export const taskList = z.strictObject({ tasks: z.array(experienceTask) });
export const taskResponse = z.strictObject({ task: experienceTask });
export const experienceCalendarEvent = z.strictObject({
  id,
  title: text,
  starts_at: date,
  ends_at: date,
  connection_id: id,
  url: url.optional(),
});
/**
 * A time zone as the engine and every date on the page read it: an IANA name
 * in its canonical spelling ('utc' becomes 'UTC'). An offset such as '+05:30'
 * names no place and follows no daylight rules, so it, and anything else that
 * is not a zone name, is UTC.
 */
export function canonicalTimeZone(zone: string | null | undefined): string {
  if (!zone || !/^[A-Za-z]/.test(zone)) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export const profileInput = z.strictObject({
  name: z.string().min(1).max(80),
  time_zone: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => {
      // A zone name, not an offset: '+05:30' is refused, 'Asia/Kolkata' is not.
      if (!/^[A-Za-z]/.test(value)) return false;
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Choose a time zone by its name, for example Europe/London.'),
  day_hours: z.strictObject({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  /** True once the person has finished or skipped setup. It is never unset. */
  onboarded: z.boolean().optional(),
  /** True when the person chose this time zone, or confirmed it. It is never unset. */
  time_zone_confirmed: z.boolean().optional(),
});
export const profileView = profileInput.extend({
  onboarded: z.boolean(),
  time_zone_confirmed: z.boolean(),
  /**
   * The address messages leave from: the connected mailbox that can send, when
   * there is one. It is read from the connection, not set here.
   */
  sending_address: z.string().max(4000).nullable(),
});
export const profileResponse = z.strictObject({ profile: profileView });
export const automationRun = z.strictObject({
  id,
  status: turnStatus,
  started_at: date,
  finished_at: date.nullable(),
  /** The thread this run wrote into, and the turn that holds its answer. */
  conversation_id: id.nullable(),
  turn_id: id.nullable(),
  /** The start of what the run said, when it said anything. */
  summary: z.string().max(600).nullable(),
  /** Why a run failed or stopped, or what it is waiting for, in a sentence. */
  reason: z.string().max(600).nullable(),
});
/** The newest run of a routine, for the place the person looks first. */
export const routineResult = z.strictObject({
  automation_id: id,
  title: text,
  conversation_id: id,
  run: automationRun,
});
export const homeResponse = z.strictObject({
  greeting: text,
  date: text,
  time_zone: text,
  within_day_hours: z.boolean(),
  upcoming: experienceResult(z.array(experienceCalendarEvent)),
  tasks: z.array(experienceTask),
  open_task_count: count,
  /** Routines that ran in the last day, newest first. */
  routine_results: z.array(routineResult),
  /** Work rooms asked the person to run with their own setup, work of theirs running for a room, and results waiting to be shared or kept. */
  handoffs: z.array(roomHandoff).optional(),
});
export const experienceAutomation = z.strictObject({
  id,
  title: text,
  schedule: text,
  enabled: z.boolean(),
  /** Stopped for good: it cannot be resumed, only started again or deleted. */
  ended: z.boolean(),
  /** The thread every run of this routine writes into. */
  conversation_id: id,
  runs: z.array(automationRun),
});
export const automationList = z.strictObject({ automations: z.array(experienceAutomation) });
export const automationCreate = z.strictObject({
  title: text,
  instruction: text,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Left out, the routine runs as Melete. */
  agent_id: id.optional(),
});
export const automationResponse = z.strictObject({ automation: experienceAutomation });

export const experienceConnection = z.strictObject({
  id,
  app: text,
  label: text,
  status: z.enum(['available', 'connecting', 'connected', 'error']),
  access: z.enum(['read_only', 'draft_only', 'asks_before_acting']),
  /** True for a connection the service keeps in every space; a client offers no removal for it. */
  builtin: z.boolean().optional(),
  /**
   * Present for a mailbox or a calendar: whether Melete watches it for
   * changes (new mail, meetings that move) without being asked.
   */
  watching: z.boolean().optional(),
  /**
   * Present when an installed connection is not working now, with `status`
   * `error`: `not_running` when nothing on this server runs it, `failing` when
   * its last check, or a real call, found its destination refusing or absent.
   * The detail is a plain sentence for the person.
   */
  problem: z.strictObject({ kind: z.enum(['not_running', 'failing']), detail: text }).optional(),
  /** The catalog entry it was connected from, when it was (`GET /connection-kinds`). */
  catalog_id: z.string().optional(),
  /** Signed in through Composio, which handles the sign-in and passes its requests on. */
  via: z.literal('composio').optional(),
  /**
   * Why a watched account is read less often than usual, or could not be
   * read, in plain words; left out when its reads are going as they should.
   */
  reading_note: z.string().max(400).optional(),
});
export type ExperienceConnectionProblem = NonNullable<
  z.infer<typeof experienceConnection>['problem']
>;
export const experienceConnectionList = z.strictObject({
  connections: z.array(experienceConnection),
});
/** Turns watching an account for changes on or off. */
export const connectionWatching = z.strictObject({ on: z.boolean() });
export const browserSession = z.strictObject({
  id,
  status: z.enum(['working', 'needs_you', 'done', 'stopped']),
  url,
  task_label: text,
  preview_frame: url.nullable(),
});
export const browserResponse = z.strictObject({ session: browserSession });
export const browserControl = z.strictObject({
  control: z.enum(['take_control', 'resume', 'stop']),
});
/** How many recent commands a conversation's computer view carries. */
export const COMPUTER_TERMINAL_LIMIT = 8;
/** One command the agent ran in its sandbox, with what it printed, scrubbed and clipped. */
export const computerCommand = z.strictObject({
  id,
  command: z.string().max(2000),
  /** The last lines it printed; empty while it runs or when the output was not text. */
  output: z.string().max(4000),
  status: z.enum(['running', 'done', 'failed', 'unknown']),
  exit_code: z.number().int().nullable(),
  started_at: date,
});
export type ComputerCommand = z.infer<typeof computerCommand>;
/** The page the agent's browser was last seen on, and who holds the browser now. */
export const computerBrowser = z.strictObject({
  session_id: id,
  control: z.enum(['agent', 'you']),
  /** Scheme, host and path only. */
  url: z.string().max(2048).nullable(),
  title: z.string().max(200).nullable(),
  /** A picture of the page as the agent last saw it; none while a handed-back page is shown. */
  screenshot: z.strictObject({ artifact_id: id }).nullable(),
  seen_at: date.nullable(),
});
export type ComputerBrowser = z.infer<typeof computerBrowser>;
/** How many processes a conversation's computer view carries: the live ones, then the latest ended. */
export const COMPUTER_PROCESS_LIMIT = 8;
/** One background process in the agent's computer, as the person may see it. */
export const computerProcess = z.strictObject({
  id,
  name: z.string().max(120),
  state: z.enum(PROCESS_STATES),
  started_at: date,
  /** The port the process said it serves, when it is a server. */
  port: z.number().int().min(1).max(65_535).nullable(),
  /** The last line it printed, scrubbed and clipped. */
  last_line: z.string().max(240).nullable(),
  /** Whether a preview of its port can be opened from here. */
  can_preview: z.boolean(),
});
export type ComputerProcess = z.infer<typeof computerProcess>;
/** What a conversation's agent is doing on its computer: its browser, its terminal and its processes. */
export const agentComputer = z.strictObject({
  browser: computerBrowser.nullable(),
  terminal: z.array(computerCommand).max(COMPUTER_TERMINAL_LIMIT),
  processes: z.array(computerProcess).max(COMPUTER_PROCESS_LIMIT).default([]),
  /** Which parts this service can run at all, so an empty view can say what to connect. */
  available: z.strictObject({ browser: z.boolean(), terminal: z.boolean() }),
});
export type AgentComputer = z.infer<typeof agentComputer>;
export const nowPlaying = z.strictObject({
  title: text,
  artist: text,
  image: url.optional(),
  playing: z.boolean(),
  source_connection: id,
});
export const liveData = z.strictObject({
  title: text,
  value: text,
  updated_at: date,
  source_connection: id,
});
export const experienceSearchResult = z.strictObject({
  id,
  kind: z.enum(['conversation', 'plan', 'task', 'event', 'connection', 'action']),
  title: text,
  meta: z.string().max(4000),
  conversation_id: id.nullable(),
});
export const experienceSearch = z.strictObject({ results: z.array(experienceSearchResult) });
export const magicLinkRequest = z.strictObject({ email: z.email() });
export const magicLinkConsume = z.strictObject({ token: z.string().min(32).max(200) });
const newPassword = z.string().min(8).max(1024);
export const passwordChange = z.strictObject({
  current_password: z.string().min(1).max(1024),
  new_password: newPassword,
});
export const passwordResetRequest = z.strictObject({ email: z.email().max(254) });
export const passwordResetConsume = z.strictObject({
  token: z.string().min(20).max(200),
  new_password: newPassword,
});

/** Shared operation table makes the mock and OpenAPI cover precisely the same surface. */
export const experienceOperations = {
  'GET /conversations': { query: conversationListQuery, response: conversationList },
  'POST /conversations': { request: conversationCreate, response: conversationResponse },
  'GET /conversations/{id}': { response: conversationResponse },
  /** Renames the chat. */
  'PATCH /conversations/{id}': { request: conversationRename, response: conversationResponse },
  /**
   * Deletes the chat: a turn under way is stopped, waiting permissions are
   * withdrawn, its work is cancelled and its messages are removed. Files on its
   * computer stay. Memory stays unless `forget_memory=true`.
   */
  'DELETE /conversations/{id}': { query: conversationDeleteQuery, response: conversationDeleted },
  'PATCH /conversations/{id}/agent': {
    request: conversationSwitchAgent,
    response: conversationResponse,
  },
  'GET /conversations/{id}/messages': { response: turnList },
  'POST /conversations/{id}/messages': {
    request: conversationMessage,
    response: messageAcceptance,
  },
  'GET /conversations/{id}/events': {
    query: experienceEventQuery,
    response: experienceEventPage,
    stream: true,
  },
  'POST /conversations/{id}/pause': { response: conversationResponse },
  'POST /conversations/{id}/resume': { response: conversationResponse },
  'POST /conversations/{id}/stop': { response: conversationResponse },
  'GET /conversations/{id}/cards': { response: z.strictObject({ cards: z.array(resultCard) }) },
  'GET /conversations/{id}/receipts': {
    response: z.strictObject({ receipts: z.array(experienceReceipt) }),
  },
  'POST /receipts/{id}/undo': { response: z.strictObject({ receipt: experienceReceipt }) },
  'GET /conversations/{id}/computer': { response: agentComputer },
  'GET /conversations/{id}/drafts': {
    response: z.strictObject({ drafts: z.array(experienceDraft) }),
  },
  'POST /drafts/{id}/send': {
    response: z.strictObject({
      draft: experienceDraft,
      permission: permissionCard.nullable(),
      receipt: experienceReceipt.nullable(),
    }),
  },
  'GET /permissions': {
    response: z.strictObject({
      permissions: z.array(permissionCard),
      /** Handoffs from rooms: to run, running with the person's setup, or a result to share or keep. */
      handoffs: z.array(roomHandoff).optional(),
    }),
  },
  'POST /permissions/{id}': { request: permissionDecision, response: permissionOutcome },
  'GET /approval-settings': { response: approvalSettingsResponse },
  'PUT /approval-settings': { request: approvalSettings, response: approvalSettingsResponse },
  'GET /rules': { response: z.strictObject({ rules: z.array(standingRule) }) },
  'DELETE /rules/{id}': { response: experienceOk },
  'GET /quick-answers': { response: z.strictObject({ questions: z.array(experienceQuestion) }) },
  'POST /quick-answers/{id}': {
    request: quickAnswerRequest,
    response: experienceOk,
  },
  'GET /agents': { response: agentList },
  'POST /agents': { request: agentInput, response: agentResponse },
  'GET /agents/templates': { response: agentTemplateList },
  'PATCH /agents/{id}': { request: agentInput, response: agentResponse },
  /**
   * Deletes an agent other than Melete. Its chats, routines and plan steps move
   * to Melete; the turns it answered keep its name. In a personal space its
   * routines are paused. Refused while any of its work is still running.
   */
  'DELETE /agents/{id}': { response: agentDeleted },
  'GET /memory/items': {
    query: z.strictObject({ after: id.optional() }),
    response: memoryItemList,
  },
  'POST /memory/items': { request: memoryItemCreate, response: memoryItemResponse },
  'PATCH /memory/items/{id}': { request: memoryItemEdit, response: experienceOk },
  'DELETE /memory/items/{id}': { response: experienceOk },
  'GET /memory/items/{id}/why': { response: memoryExplanation },
  /** Notes Melete kept for itself in chats with the person, newest first. */
  'GET /memory/notes': { response: agentNoteList },
  'DELETE /memory/notes/{id}': { response: experienceOk },
  'GET /memory/settings': { response: memorySettings },
  'PUT /memory/settings': { request: memorySettings, response: memorySettings },
  'GET /web/settings': { response: webReadStatus },
  'PUT /web/settings': { request: webReadSettings, response: webReadStatus },
  'GET /memory/beliefs': { response: beliefList },
  'GET /memory/beliefs/{id}/history': { response: beliefHistory },
  'POST /memory/beliefs/{id}/block': { response: experienceOk },
  'GET /memory/blocks': { response: beliefBlockList },
  'DELETE /memory/blocks/{id}': { response: experienceOk },
  'GET /memory/timeline': { query: memoryTimelineQuery, response: memoryTimeline },
  'POST /memory/rewind/preview': { request: rewindTarget, response: rewindPreview },
  'POST /memory/rewind': { request: rewindTarget, response: memoryRewindResponse },
  'POST /memory/rewinds/{id}/undo': { response: memoryRewindResponse },
  'GET /memory/digest': { response: memoryDigestResponse },
  'POST /memory/digest/{id}/seen': { response: experienceOk },
  'GET /memory/export': { query: beliefExportQuery, response: beliefExport },
  'POST /memory/import': { request: beliefImport, response: beliefImportResult },
  'GET /plans': { response: planList },
  'POST /plans': { request: planCreate, response: planResponse },
  'GET /plans/{id}': { response: planResponse },
  /**
   * Deletes the plan and its steps. Work on a step is stopped; chats started
   * from the plan stay, no longer linked to it.
   */
  'DELETE /plans/{id}': { response: experienceOk },
  'PATCH /plans/{id}/milestones/{milestoneId}': {
    request: milestoneUpdate,
    response: planResponse,
  },
  'POST /plans/{id}/conversation': {
    request: conversationSwitchAgent,
    response: conversationResponse,
  },
  'POST /plans/{id}/share': { response: notAvailable },
  'GET /profile': { response: profileResponse },
  'PATCH /profile': { request: profileInput, response: profileResponse },
  'GET /home': { response: homeResponse },
  'GET /tasks': { response: taskList },
  'POST /tasks': { request: taskInput, response: taskResponse },
  'PATCH /tasks/{id}': { request: taskInput, response: taskResponse },
  'DELETE /tasks/{id}': { response: experienceOk },
  'GET /automations': { response: automationList },
  'POST /automations': { request: automationCreate, response: automationResponse },
  'POST /automations/{id}/test': { response: experienceOk },
  /** Stops the schedule; nothing runs until it is resumed. */
  'POST /automations/{id}/pause': { response: automationResponse },
  'POST /automations/{id}/resume': { response: automationResponse },
  /**
   * Starts an ended routine again with the same settings. The new routine takes
   * the ended one's place on the list; one that has not ended is refused.
   */
  'POST /automations/{id}/restart': { response: automationResponse },
  /** Stops the routine for good and takes it off the list. */
  'DELETE /automations/{id}': { response: experienceOk },
  'POST /automations/morning-brief': {
    request: z.strictObject({
      agent_id: id.optional(),
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    }),
    response: automationResponse,
  },
  /** Long work going on in the background, newest first; one conversation's when asked. */
  'GET /runs': { query: runListQuery, response: runListResponse },
  'POST /runs': { request: runCreateRequest, response: runResponse },
  'GET /runs/{id}': { response: runResponse },
  /** The full record, oldest first, a page at a time. */
  'GET /runs/{id}/record': { query: runRecordQuery, response: runRecordResponse },
  /** The full record as one Markdown document. */
  'GET /runs/{id}/export': { response: runExportResponse },
  /** Words for the work: answers its question, or is read at its next shift. */
  'POST /runs/{id}/message': { request: runMessageRequest, response: runResponse },
  'POST /runs/{id}/pause': { response: runResponse },
  'POST /runs/{id}/resume': { response: runResponse },
  /** Stops the work and its helpers for good. */
  'POST /runs/{id}/stop': { response: runResponse },
  'PUT /runs/{id}/limit': { request: runLimitRequest, response: runResponse },
  'GET /experience/connections': { response: experienceConnectionList },
  'PUT /experience/connections/{id}/watching': {
    request: connectionWatching,
    response: experienceConnectionList,
  },
  /**
   * What was done in the person's name by chats and plans they have since
   * deleted, newest first.
   */
  'GET /activity': { response: activityList },
  /**
   * Take back something a deleted chat did, while its Undo is offered. It runs
   * as a change of its own, with a receipt, through the same checks as any other.
   */
  'POST /activity/{id}/undo': { response: z.strictObject({ entry: activityEntry }) },
  /** Who is in the space this session uses. */
  'GET /space/members': { response: spaceMembers },
  /**
   * The space's owner removes someone from a shared space. Their sessions in it
   * end and their work there is stopped; what they made stays with the space.
   */
  'DELETE /space/members/{id}': { response: experienceOk },
  'POST /signin/magic-link': { request: magicLinkRequest, response: experienceOk },
  'POST /signin/magic-link/consume': { request: magicLinkConsume, response: experienceOk },
  'POST /signin/google': { response: notAvailable },
  'POST /signin/apple': { response: notAvailable },
  'POST /signin/chatgpt': { response: notAvailable },
  /** Ends the session behind the cookie; the next request needs a new sign-in. */
  'POST /signout': { response: experienceOk },
  /** Checks the current password, sets the new one and signs out every other session. */
  'POST /account/password': { request: passwordChange, response: experienceOk },
  /**
   * Mails a one-time reset link when the account's own mailbox is connected.
   * Without one it answers not_available, and the person who runs the install
   * prints a link with `bun run reset-password`.
   */
  'POST /password-reset': { request: passwordResetRequest, response: experienceOk },
  /** Sets a new password from a one-time link and signs out every session. */
  'POST /password-reset/consume': { request: passwordResetConsume, response: experienceOk },
  'GET /browser/sessions/{id}': { response: browserResponse },
  'POST /browser/sessions/{id}/control': { request: browserControl, response: browserResponse },
  'GET /experience/now-playing': { response: nowPlaying },
  'GET /experience/live-data': { response: liveData },
  'GET /search': {
    query: z.strictObject({ q: z.string().min(1).max(200) }),
    response: experienceSearch,
  },
  ...privacyOperations,
} satisfies Record<
  string,
  { request?: z.ZodType; query?: z.ZodType; response: z.ZodType; stream?: boolean }
>;
