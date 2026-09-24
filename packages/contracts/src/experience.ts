/** Outcome vocabulary for personal interfaces. Never pass an internal record through here. */
import { z } from 'zod';
import { memoryKey } from './memory.ts';
import { messageId } from './reactions.ts';

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
export const experienceReceipt = z.strictObject({
  id,
  what: text,
  where: text,
  when: date,
  undo: z.strictObject({ handle: id, valid_until: date }).optional(),
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
  /** When it was asked; the queue is oldest first. */
  created_at: date,
});

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
  ]),
  connection_id: id,
  recipient_class: text,
  bounds: standingRuleBounds,
  used: count,
  created_at: date,
});
export type StandingRule = z.infer<typeof standingRule>;
export const permissionCard = z.strictObject({
  id,
  conversation_id: id,
  what: text,
  why: z.array(text).min(1),
  options: z.array(z.enum(['allow_once', 'always', 'deny'])).min(1),
  version: id,
  preview: resultCard.nullable(),
  draft: experienceDraft.optional(),
  /** When permission was asked for; the queue is oldest first. */
  created_at: date,
});
export type PermissionCard = z.infer<typeof permissionCard>;
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
/** Something the person can open for more: a file, the pending permission, a page. */
export const toolDetail = z.strictObject({
  type: z.enum(['artifact', 'permission', 'receipt', 'memory', 'page']),
  id,
  url: url.optional(),
});
export type ToolDetail = z.infer<typeof toolDetail>;
/**
 * One piece of work done for the person, shown in the conversation. Each
 * change arrives as a whole new copy under the same `id`; a client keeps the
 * latest. `parent` names the entry this one belongs under.
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
  outcome: z.enum(['allow_once', 'always', 'deny', 'answered', 'withdrawn']),
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
    z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
    z.strictObject({ type: z.literal('card'), card: resultCard }),
    z.strictObject({ type: z.literal('receipt'), receipt: experienceReceipt }),
    z.strictObject({ type: z.literal('permission'), permission: permissionCard }),
    z.strictObject({ type: z.literal('question'), question: experienceQuestion }),
    z.strictObject({ type: z.literal('decision'), decision: experienceDecision }),
    z.strictObject({ type: z.literal('status'), status: turnStatus, composer: composerState }),
    z.strictObject({ type: z.literal('tool'), tool: toolCall }),
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
});
export const conversationCreate = z.strictObject({
  title: text,
  agent_id: id,
  plan_id: id.optional(),
});
export const conversationSwitchAgent = z.strictObject({ agent_id: id });
export const conversationMessage = z.strictObject({
  text: z.string().min(1).max(100000),
  /** The answer this message corrects, when the person replies to it as a correction. */
  corrects: messageId.optional(),
});
export const messageAcceptance = z.strictObject({
  turn_id: id,
  receipt: z.strictObject({ id, status: z.enum(['accepted', 'failed_retry']), received_at: date }),
});
export const conversationResponse = z.strictObject({ conversation });
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
  standing_instruction: z.string().max(200),
  /** Null means every connection in the space, including ones connected later. */
  allowed_connection_ids: z.array(id).max(50).nullable(),
  asks_before_acting: z.boolean(),
  face_image: url.optional(),
});
export const experienceAgent = agentInput.extend({
  id,
  space_id: id,
  usage: z.strictObject({ conversations: count, last_used: date.nullable() }),
});
export type ExperienceAgent = z.infer<typeof experienceAgent>;
export const agentTemplate = z.strictObject({ id, title: text, agent: agentInput });
export const agentList = z.strictObject({ agents: z.array(experienceAgent) });
export const agentResponse = z.strictObject({ agent: experienceAgent });
export const agentTemplateList = z.strictObject({ templates: z.array(agentTemplate) });

export const memoryItem = z.strictObject({
  id,
  key: text,
  value: z.string().max(16000),
  source: z.enum(['onboarding', 'conversation', 'inferred']),
  created: date,
  last_used: date.nullable(),
  editable: z.boolean(),
  version: id,
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
 * A person's own memory settings. Memory is on unless they turn it off; off,
 * nothing new they say in chat is kept, and "forget ..." still works.
 */
export const memorySettings = z.strictObject({ capture: z.boolean() });
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
export const planMilestone = milestoneInput.extend({ id, done: z.boolean(), status: turnStatus });
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
export const profileInput = z.strictObject({
  name: z.string().min(1).max(80),
  time_zone: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Choose a time zone.'),
  day_hours: z.strictObject({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
});
export const profileView = profileInput.extend({
  /**
   * The address messages leave from: the connected mailbox that can send, when
   * there is one. It is read from the connection, not set here.
   */
  sending_address: z.string().max(4000).nullable(),
});
export const profileResponse = z.strictObject({ profile: profileView });
export const homeResponse = z.strictObject({
  greeting: text,
  date: text,
  time_zone: text,
  within_day_hours: z.boolean(),
  upcoming: experienceResult(z.array(experienceCalendarEvent)),
  tasks: z.array(experienceTask),
  open_task_count: count,
});
export const automationRun = z.strictObject({
  id,
  status: turnStatus,
  started_at: date,
  finished_at: date.nullable(),
});
export const experienceAutomation = z.strictObject({
  id,
  title: text,
  schedule: text,
  enabled: z.boolean(),
  runs: z.array(automationRun),
});
export const automationList = z.strictObject({ automations: z.array(experienceAutomation) });
export const automationCreate = z.strictObject({
  title: text,
  instruction: text,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  agent_id: id,
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
});
export const experienceConnectionList = z.strictObject({
  connections: z.array(experienceConnection),
});
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

/** Shared operation table makes the mock and OpenAPI cover precisely the same surface. */
export const experienceOperations = {
  'GET /conversations': { query: conversationListQuery, response: conversationList },
  'POST /conversations': { request: conversationCreate, response: conversationResponse },
  'GET /conversations/{id}': { response: conversationResponse },
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
  'GET /permissions': { response: z.strictObject({ permissions: z.array(permissionCard) }) },
  'POST /permissions/{id}': { request: permissionDecision, response: permissionOutcome },
  'GET /rules': { response: z.strictObject({ rules: z.array(standingRule) }) },
  'DELETE /rules/{id}': { response: experienceOk },
  'GET /quick-answers': { response: z.strictObject({ questions: z.array(experienceQuestion) }) },
  'POST /quick-answers/{id}': {
    request: z.strictObject({ option_id: id }),
    response: experienceOk,
  },
  'GET /agents': { response: agentList },
  'POST /agents': { request: agentInput, response: agentResponse },
  'GET /agents/templates': { response: agentTemplateList },
  'PATCH /agents/{id}': { request: agentInput, response: agentResponse },
  'GET /memory/items': {
    query: z.strictObject({ after: id.optional() }),
    response: memoryItemList,
  },
  'POST /memory/items': { request: memoryItemCreate, response: memoryItemResponse },
  'PATCH /memory/items/{id}': { request: memoryItemEdit, response: experienceOk },
  'DELETE /memory/items/{id}': { response: experienceOk },
  'GET /memory/items/{id}/why': { response: memoryExplanation },
  'GET /memory/settings': { response: memorySettings },
  'PUT /memory/settings': { request: memorySettings, response: memorySettings },
  'GET /plans': { response: planList },
  'POST /plans': { request: planCreate, response: planResponse },
  'GET /plans/{id}': { response: planResponse },
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
  'POST /automations/morning-brief': {
    request: z.strictObject({ agent_id: id, at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
    response: automationResponse,
  },
  'GET /experience/connections': { response: experienceConnectionList },
  'POST /signin/magic-link': { request: magicLinkRequest, response: experienceOk },
  'POST /signin/magic-link/consume': { request: magicLinkConsume, response: experienceOk },
  'POST /signin/google': { response: notAvailable },
  'POST /signin/apple': { response: notAvailable },
  /** Ends the session behind the cookie; the next request needs a new sign-in. */
  'POST /signout': { response: experienceOk },
  'GET /browser/sessions/{id}': { response: browserResponse },
  'POST /browser/sessions/{id}/control': { request: browserControl, response: browserResponse },
  'GET /experience/now-playing': { response: nowPlaying },
  'GET /experience/live-data': { response: liveData },
  'GET /search': {
    query: z.strictObject({ q: z.string().min(1).max(200) }),
    response: experienceSearch,
  },
} satisfies Record<
  string,
  { request?: z.ZodType; query?: z.ZodType; response: z.ZodType; stream?: boolean }
>;
