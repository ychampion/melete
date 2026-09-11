/**
 * What the designed surfaces need from the backend, shaped exactly as
 * docs/design/INTEGRATION.md describes. This is the seam: the experience
 * contract replaces these types when it lands, and nothing above the adapter
 * has to change.
 *
 * The interface shows outcomes, receipts and the one decision only the person
 * can make. Nothing here carries a tool name, a model name, a token count or a
 * log line.
 */
import type { FaceLook } from '../design/face.tsx';

export type Capability = 'available' | 'unavailable';

export type TourStage = 'calendar' | 'drafting' | 'browser' | 'plans' | 'memory';

export type Capabilities = {
  browser: Capability;
  oauth_google: Capability;
  oauth_apple: Capability;
  magic_link: Capability;
  voice: Capability;
  attachments: Capability;
  tour_stages: TourStage[];
};

export type Session = {
  signed_in: boolean;
  onboarded: boolean;
  profile: Profile | null;
};

export type Profile = {
  name: string;
  short_name: string;
  email: string;
  timezone: string;
  day_start: string;
  day_end: string;
  morning_brief: boolean;
  space: string;
};

/* ---------- agents ---------- */

export type AgentTone = 'warm' | 'direct' | 'playful';

export type Agent = {
  id: string;
  name: string;
  role: string;
  blurb: string;
  look: FaceLook;
  tone: AgentTone;
  standing_instruction: string;
  /** Connection ids this agent may use. */
  allowed_connections: string[];
  asks_before_acting: boolean;
  /** Human words for what it reaches for: "calendar", "places", "messages". */
  reaches: string[];
  stats: { chats: number; last_used: string | null };
};

export type AgentTemplate = {
  id: string;
  title: string;
  description: string;
  agent: Omit<Agent, 'id' | 'stats'>;
};

/* ---------- chat ---------- */

export type Source = {
  /** A connection or a place a source came from: a logo name, or "web". */
  app: string;
  label: string;
  url?: string;
};

export type TrailStep =
  | { kind: 'say'; id: string; text: string }
  | {
      kind: 'action';
      id: string;
      label: string;
      meta: string;
      sources: Source[];
      status: 'running' | 'done';
    }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'done'; id: string; summary: string };

export type CardAction = {
  label: string;
  icon?: string;
  /** What pressing it does: decide a pending permission, open a link, or nothing yet. */
  effect:
    | { kind: 'permission'; permission_id: string }
    | { kind: 'link'; url: string }
    | { kind: 'none' };
  done_label?: string;
};

export type ResultCardData = {
  id: string;
  overline: string;
  title: string;
  rating: string | null;
  facts: string[];
  description: string;
  chips: string[];
  image: { src: string; alt: string } | null;
  primary: CardAction;
  example: boolean;
};

export type ReceiptData = {
  id: string;
  /** The card this receipt confirms, when a card's button was the decision. */
  attaches_to?: string | null;
  what: string;
  where: string;
  when: string;
  undo: { until: string } | null;
  undone: boolean;
};

export type DraftData = {
  id: string;
  recipient: { name: string; initials: string };
  channel: string;
  channel_label: string;
  body: string;
  status: 'draft' | 'sending' | 'sent' | 'failed';
};

export type PermissionData = {
  id: string;
  /** "Nova wants to add an event to Google Calendar" */
  title: string;
  detail: string;
  connection: { app: string; label: string };
  rule_text: string;
  /** The canonical bytes the connector will be handed, one row per field. */
  fields: Record<string, unknown>;
  payload_hash: string;
  status: 'pending' | 'allowed_once' | 'allowed_always' | 'denied' | 'changed';
};

export type QuestionData = {
  id: string;
  title: string;
  options: { label: string; description: string }[];
  answered: string | null;
};

export type UnknownOutcomeData = {
  id: string;
  what: string;
  resolution: 'succeeded' | 'failed' | 'unresolved' | null;
};

export type BrowserSessionData = {
  id: string;
  status: 'working' | 'needs-you' | 'done' | 'stopped';
  url: string;
  task: string;
  preview: { title: string; sub: string; chips: string[]; slots: string[]; chosen: string };
  attention: string | null;
};

export type Block =
  | { kind: 'card'; card: ResultCardData }
  | { kind: 'receipt'; receipt: ReceiptData }
  | { kind: 'draft'; draft: DraftData }
  | { kind: 'permission'; permission: PermissionData }
  | { kind: 'question'; question: QuestionData }
  | { kind: 'unknown'; unknown: UnknownOutcomeData }
  | { kind: 'browser'; browser: BrowserSessionData }
  | { kind: 'notice'; level: 'info' | 'attention' | 'problem'; title: string; body: string }
  | { kind: 'error'; what: string; done_about_it: string };

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'paused'
  /** Parked on a decision or an answer only the person can give. */
  | 'waiting'
  | 'done'
  | 'failed'
  | 'stopped';

export type Reaction = 'up' | 'down' | null;

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  at: string;
  delivery: 'sent' | 'sending' | 'queued' | 'failed';
  attachments: { name: string; kind: 'image' | 'doc' }[];
};

export type Turn = {
  id: string;
  role: 'assistant';
  agent_id: string | null;
  status: TurnStatus;
  text: string;
  /** True while the text is arriving; false once the turn has its final text. */
  text_streaming: boolean;
  trail: TrailStep[];
  started_at: string;
  ended_at: string | null;
  blocks: Block[];
  reaction: Reaction;
  at: string;
};

export type Message = UserMessage | Turn;

export type ConversationSummary = {
  id: string;
  title: string;
  agent_id: string | null;
  preview: string;
  updated_at: string;
  pinned: boolean;
};

export type Conversation = ConversationSummary & {
  messages: Message[];
};

/**
 * One item from a conversation's live stream. Durable items are replayed on
 * reconnect; text deltas are not, and the client draws a gap where they were
 * lost rather than pretending the transcript is whole.
 */
export type ConversationEvent = {
  seq: number;
  conversation_id: string;
  type:
    | 'user_message'
    | 'turn_started'
    | 'turn_status'
    | 'trail_step'
    | 'trail_step_updated'
    | 'text_delta'
    | 'text_final'
    | 'block'
    | 'block_updated'
    | 'reaction';
  payload: Record<string, unknown>;
  created_at: string;
};

export type StreamGap = {
  after: number;
  next: number | null;
  reason: 'reconnect' | 'sequence_skip';
};

export type StreamItem =
  | { type: 'open' }
  | { type: 'event'; event: ConversationEvent }
  | { type: 'gap'; gap: StreamGap };

/* ---------- home, day ---------- */

export type DayEvent = {
  id: string;
  day: string;
  time: string;
  title: string;
  duration: string;
  place: string | null;
  tint: 'primary' | 'sage' | 'sand' | 'lilac';
  date: string;
};

export type DayTask = { id: string; text: string; done: boolean };

export type DayPanel = {
  today: string;
  month: string;
  week: { label: string; num: number; date: string; has_events: boolean; today: boolean }[];
  events: DayEvent[];
  tasks: DayTask[];
  connections_synced: number;
};

export type HomeData = {
  greeting: string;
  date_line: string;
  prompts: { label: string; icon: string; text: string }[];
  recent: ConversationSummary[];
  files: { id: string; name: string; size: string; updated_at: string }[];
};

/* ---------- plans ---------- */

export type PlanCategory = 'travel' | 'wellbeing' | 'learning' | 'finance';

export type Milestone = {
  id: string;
  text: string;
  done: boolean;
  assignee: { kind: 'person'; name: string } | { kind: 'agent'; agent_id: string } | null;
};

export type Plan = {
  id: string;
  title: string;
  description: string;
  category: PlanCategory;
  next_step: string;
  progress: number;
  status: 'in_progress' | 'completed';
  milestones: Milestone[];
  linked: { kind: 'chat' | 'file'; id: string; title: string; sub: string }[];
  updated_at: string;
  needs_you: string | null;
};

export type PlanTemplate = {
  id: string;
  category: PlanCategory;
  title: string;
  description: string;
};

/* ---------- automations ---------- */

export type AutomationRun = {
  id: string;
  status: 'running' | 'ok' | 'failed';
  when: string;
  note: string;
};

export type Automation = {
  id: string;
  name: string;
  /** "Every weekday at 8:30 AM" */
  trigger: string;
  cron: string;
  description: string;
  enabled: boolean;
  runs: AutomationRun[];
  next_run: string;
};

/* ---------- settings ---------- */

export type MemoryItem = {
  id: string;
  key: string;
  value: string;
  source: 'onboarding' | 'conversation' | 'inferred';
  created: string;
  last_used: string | null;
  why: string;
};

export type ConnectionState = 'available' | 'connecting' | 'connected' | 'error';

export type ConnectionData = {
  id: string;
  app: string;
  name: string;
  what: string;
  state: ConnectionState;
  access: 'read' | 'write' | 'draft';
  error: string | null;
};

export type Rule = {
  id: string;
  text: string;
  connection: { app: string; label: string };
  agent_id: string | null;
  created: string;
};

/* ---------- command palette ---------- */

export type PaletteHit = {
  kind: 'chat' | 'plan' | 'task' | 'event' | 'connection' | 'action';
  id: string;
  title: string;
  meta: string;
  href: string;
};

/* ---------- onboarding ---------- */

export type OnboardingAnswer = { key: string; value: string };
