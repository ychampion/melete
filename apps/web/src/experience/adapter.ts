/**
 * The one place the interface talks to a backend: the experience contract in
 * packages/contracts/src/experience.ts, through the typed client generated
 * from openapi.json. The same calls reach apps/mock-api and a real service.
 *
 * Requests never throw on a non-2xx status: every call resolves to
 * { data, error, unavailable }. `error` is the sentence the service gave;
 * `unavailable` is the reason a capability is not connected, and a surface
 * that gets one is not drawn.
 */
import { createMeleteClient, errorMessage, readSse, subscribeEvents } from '@melete/client';
import { recordingFetch } from '../feedback/diagnostics.ts';
import { plainError } from './plain.ts';
import { markValueMoment } from './push.ts';
import { readTextPrefix } from './text-prefix.ts';
import type { Seen } from './together.ts';
import type {
  AccountSignInStart,
  AccountSignInStatus,
  ActionResolution,
  ActivityList,
  Agent,
  AgentComputer,
  AgentDeleted,
  AgentInput,
  AgentNote,
  AgentTemplate,
  ApprovalSettings,
  ApprovalSettingsView,
  Automation,
  AutomationCreate,
  Belief,
  BeliefBlock,
  BeliefExport,
  BeliefHistory,
  BeliefImport,
  BeliefImportResult,
  BrowserControl,
  BrowserSession,
  CatalogEntry,
  ConnectedAssistant,
  ConnectionChecked,
  ConnectionCreate,
  ConnectionInstalled,
  ConnectionKind,
  Conversation,
  ConversationCreate,
  ConversationDeleted,
  ConversationPrivacy,
  Device,
  DeviceCapabilities,
  DevicePairing,
  DiscoveredMcpTool,
  Draft,
  EngineSkill,
  ExperienceEvent,
  FeedbackCreate,
  FeedbackList,
  FeedbackReport,
  FeedbackStatus,
  Home,
  LearnedItemResult,
  LearnedList,
  LedgerAction,
  LiveOpen,
  LiveUp,
  LocalModelCheck,
  LocalModelCheckRequest,
  ManagedSignInStart,
  McpSignInStart,
  McpSignInStatus,
  McpToolDiscovery,
  MemoryDigestResponse,
  MemoryExplanation,
  MemoryItem,
  MemoryItemCreate,
  MemoryRewind,
  MemoryTimeline,
  MessageAcceptance,
  OwnSkill,
  OwnSkillEdit,
  Permission,
  PermissionOutcome,
  Plan,
  PlanCreate,
  PrivacyPreview,
  PrivacyReveal,
  PrivacySettings,
  PrivacySettingsUpdate,
  ProcessOutput,
  ProcessPreview,
  ProcessStopped,
  Profile,
  ProfileInput,
  PushDevice,
  PushSettings,
  PushSettingsUpdate,
  PushSubscriptionInput,
  Question,
  ReachState,
  Reaction,
  Receipt,
  ResultCard,
  RewindPreview,
  RewindTarget,
  RoomHandoff,
  Rule,
  RuleBounds,
  Run,
  RunCreate,
  RunLimit,
  RunRecordPage,
  SandboxComputer,
  SandboxControl,
  SearchResult,
  SendOutcome,
  SensitiveTopic,
  SpaceMembers,
  StreamGap,
  Task,
  TaskInput,
  Turn,
  VoiceAside,
  VoiceAsideRequest,
  VoiceSession,
  VoiceStatus,
  VoiceTranscription,
} from './types.ts';
import { isNotAvailable } from './types.ts';

/** The account a sign-in or first setup answers with. */
type SignedInOwner = { id: string; email: string; created_at: string };

export type Result<T> =
  | { data: T; error: null; unavailable: null }
  | { data: null; error: string; unavailable: null; unauthorized?: boolean }
  | { data: null; error: null; unavailable: string };

/**
 * Where the API is when the build was not told. Development runs against the
 * local mock on its own port; any other build is served beside the service,
 * so it uses the same origin's /api. Vite fixes `DEV` at build time, so the
 * mock's address is left out of a production bundle.
 */
const DEVELOPMENT_API = 'http://localhost:3210';

export const API_BASE_URL: string = new URL(
  (import.meta.env.VITE_MELETE_API as string | undefined) ??
    (import.meta.env.DEV ? DEVELOPMENT_API : '/api'),
  typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
)
  .toString()
  .replace(/\/+$/, '');

// Failed requests are remembered, without their bodies, for a problem report.
export const client = createMeleteClient({
  baseUrl: API_BASE_URL,
  fetch: recordingFetch(globalThis.fetch.bind(globalThis)),
});

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

const artifactUrl = (id: string): string =>
  `${client.options.baseUrl}/artifacts/${encodeURIComponent(id)}/content`;

/**
 * Where a card's file is read: an artifact from its own route, a file a files
 * action saved (`act_…`) from that action's. `inline` asks for it to be shown
 * in place, which the service allows only for a PDF, a picture or text.
 */
const fileUrl = (handle: string, inline = false): string =>
  `${client.options.baseUrl}/${handle.startsWith('act_') ? 'files' : 'artifacts'}/${encodeURIComponent(handle)}/content${inline ? '?disposition=inline' : ''}`;

/** Pictures the app shows in place, by the type the service sent. Never an SVG. */
const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type SavedFilePreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'pdf'; url: string };

/** The picture a screenshot took, for the person's own trail. */
const screenshotUrl = (id: string): string =>
  `${client.options.baseUrl}/screenshots/${encodeURIComponent(id)}`;

/** Turn an openapi-fetch result into a Result, reading not_available as a reason. */
function settle<T>(outcome: { data?: unknown; error?: unknown; response?: Response }): Result<T> {
  if (outcome.data !== undefined) {
    if (isNotAvailable(outcome.data))
      return { data: null, error: null, unavailable: outcome.data.reason };
    return { data: outcome.data as T, error: null, unavailable: null };
  }
  return {
    data: null,
    error: plainError(errorMessage(outcome.error, OFFLINE)),
    unavailable: null,
    unauthorized: outcome.response?.status === 401,
  };
}

async function guard<T>(
  call: () => Promise<{ data?: unknown; error?: unknown }>,
): Promise<Result<T>> {
  try {
    return settle<T>(await call());
  } catch {
    return { data: null, error: OFFLINE, unavailable: null };
  }
}

const api = client.api;

/** A decision made is the first moment Melete was worth hearing from. */
function worthHearing<T>(result: Result<T>): Result<T> {
  if (result.data !== null) markValueMoment();
  return result;
}
const path = (id: string) => ({ params: { path: { id } } });

export const adapter = {
  /* ---------- session ---------- */
  profile: () => guard<{ profile: Profile }>(() => api.GET('/profile')),
  saveProfile: (profile: ProfileInput) =>
    guard<{ profile: Profile }>(() => api.PATCH('/profile', { body: profile })),
  /** Whether this installation still needs its first account. Public. */
  setupStatus: () => guard<{ needed: boolean; multiplayer?: boolean }>(() => api.GET('/setup')),
  /** Creates the first account and signs this browser in. */
  createAccount: (email: string, password: string) =>
    guard<{ owner: SignedInOwner }>(() => api.POST('/setup', { body: { email, password } })),
  logIn: (email: string, password: string) =>
    guard<{ owner: SignedInOwner }>(() => api.POST('/login', { body: { email, password } })),
  magicLink: (email: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/signin/magic-link', { body: { email } })),
  consumeMagicLink: (token: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/signin/magic-link/consume', { body: { token } })),
  signInGoogle: () => guard<{ status: 'ok' }>(() => api.POST('/signin/google')),
  signInApple: () => guard<{ status: 'ok' }>(() => api.POST('/signin/apple')),
  signInChatGPT: () => guard<{ status: 'ok' }>(() => api.POST('/signin/chatgpt')),
  /** Ends the session; the next request needs a new sign-in. */
  signOut: () => guard<{ status: 'ok' }>(() => api.POST('/signout')),
  /** Sets a new password; every other session and connected app is signed out. */
  changePassword: (current_password: string, new_password: string) =>
    guard<{ status: 'ok' }>(() =>
      api.POST('/account/password', { body: { current_password, new_password } }),
    ),
  /** Mails a reset link when this install can send mail; otherwise says why not. */
  requestPasswordReset: (email: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/password-reset', { body: { email } })),
  consumePasswordReset: (token: string, new_password: string) =>
    guard<{ status: 'ok' }>(() =>
      api.POST('/password-reset/consume', { body: { token, new_password } }),
    ),

  /* ---------- home, tasks ---------- */
  home: () => guard<Home>(() => api.GET('/home')),
  tasks: () => guard<{ tasks: Task[] }>(() => api.GET('/tasks')),
  addTask: (title: string) =>
    guard<{ task: Task }>(() => api.POST('/tasks', { body: { title, due_at: null, done: false } })),
  setTask: (task: Task, patch: Partial<TaskInput>) =>
    guard<{ task: Task }>(() =>
      api.PATCH('/tasks/{id}', {
        ...path(task.id),
        body: { title: task.title, due_at: task.due_at, done: task.done, ...patch },
      }),
    ),
  deleteTask: (id: string) => guard<{ status: 'ok' }>(() => api.DELETE('/tasks/{id}', path(id))),

  /* ---------- conversations ---------- */
  conversations: () => guard<{ conversations: Conversation[] }>(() => api.GET('/conversations')),
  /** One page of chats, most recently active first; `next_cursor` is null on the last page. */
  conversationsPage: (limit: number, cursor: string | null) =>
    guard<{ conversations: Conversation[]; next_cursor: string | null }>(() =>
      api.GET('/conversations', {
        params: { query: cursor ? { limit, cursor } : { limit } },
      }),
    ),
  conversation: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.GET('/conversations/{id}', path(id))),
  createConversation: (body: ConversationCreate) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations', { body })),
  turns: (id: string) =>
    guard<{ turns: Turn[] }>(() => api.GET('/conversations/{id}/messages', path(id))),
  /**
   * `attachments` names files uploaded for this message, in the order they show;
   * `pasted` says which stretches of `text` the person pasted rather than typed.
   */
  send: (
    id: string,
    text: string,
    key: string,
    attachments: readonly string[] = [],
    pasted: readonly { start: number; end: number }[] = [],
  ) =>
    guard<MessageAcceptance>(() =>
      api.POST('/conversations/{id}/messages', {
        ...path(id),
        headers: { 'Idempotency-Key': key },
        body: {
          text,
          ...(attachments.length ? { attachments: [...attachments] } : {}),
          ...(pasted.length ? { pasted: pasted.map(({ start, end }) => ({ start, end })) } : {}),
        },
      }),
    ),
  pause: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/pause', path(id))),
  resume: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/resume', path(id))),
  stop: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/stop', path(id))),
  rename: (id: string, title: string) =>
    guard<{ conversation: Conversation }>(() =>
      api.PATCH('/conversations/{id}', { ...path(id), body: { title } }),
    ),
  /** Stops the chat's work and deletes it; what Melete learned stays unless `forget` is set. */
  deleteConversation: (id: string, forget: boolean) =>
    guard<ConversationDeleted>(() =>
      api.DELETE('/conversations/{id}', {
        params: { path: { id }, query: { forget_memory: forget ? 'true' : 'false' } },
      }),
    ),
  setAgent: (id: string, agent_id: string) =>
    guard<{ conversation: Conversation }>(() =>
      api.PATCH('/conversations/{id}/agent', { ...path(id), body: { agent_id } }),
    ),
  cards: (id: string) =>
    guard<{ cards: ResultCard[] }>(() => api.GET('/conversations/{id}/cards', path(id))),
  receipts: (id: string) =>
    guard<{ receipts: Receipt[] }>(() => api.GET('/conversations/{id}/receipts', path(id))),
  drafts: (id: string) =>
    guard<{ drafts: Draft[] }>(() => api.GET('/conversations/{id}/drafts', path(id))),
  eventsSince: (id: string, since: number) =>
    guard<{ events: ExperienceEvent[]; next_cursor: number; has_more: boolean }>(() =>
      api.GET('/conversations/{id}/events', {
        params: { path: { id }, query: { since, limit: 200 } },
      }),
    ),

  /* ---------- decisions ---------- */
  /** With `together`, the other asks shown on the same card get the same answer. */
  decide: (id: string, option: 'allow_once' | 'deny', version: string, together: Seen[] = []) =>
    guard<PermissionOutcome>(() =>
      api.POST('/permissions/{id}', {
        ...path(id),
        body: { option, version, ...(together.length ? { together } : {}) },
      }),
    ).then(worthHearing),
  decideAlways: (id: string, version: string, bounds: RuleBounds) =>
    guard<PermissionOutcome>(() =>
      api.POST('/permissions/{id}', { ...path(id), body: { option: 'always', version, bounds } }),
    ).then(worthHearing),
  permissions: () =>
    guard<{ permissions: Permission[]; handoffs?: RoomHandoff[] }>(() => api.GET('/permissions')),
  undo: (id: string) =>
    guard<{ receipt: Receipt }>(() => api.POST('/receipts/{id}/undo', path(id))),
  sendDraft: (id: string) => guard<SendOutcome>(() => api.POST('/drafts/{id}/send', path(id))),

  /**
   * A card's file, ready to show in the app: a PDF or a picture as a local
   * object address of its exact type, anything else as text (its start, when
   * it is very large). A page or an SVG is never given an address, so it is
   * read as text, never run. The caller revokes an object address when done.
   */
  filePreview: async (handle: string): Promise<Result<SavedFilePreview>> => {
    try {
      const response = await client.options.fetch(fileUrl(handle, true), {
        headers: client.options.headers,
        credentials: client.options.credentials,
      });
      if (!response.ok)
        return {
          data: null,
          error:
            response.status === 404 ? 'This file is no longer the one that was saved.' : OFFLINE,
          unavailable: null,
        };
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (PICTURES.has(type) || type === 'application/pdf') {
        const blob = new Blob([await response.arrayBuffer()], { type });
        return {
          data: {
            kind: type === 'application/pdf' ? 'pdf' : 'image',
            url: URL.createObjectURL(blob),
          },
          error: null,
          unavailable: null,
        };
      }
      return {
        data: { kind: 'text', ...(await readTextPrefix(response)) },
        error: null,
        unavailable: null,
      };
    } catch {
      return { data: null, error: OFFLINE, unavailable: null };
    }
  },
  questions: () => guard<{ questions: Question[] }>(() => api.GET('/quick-answers')),
  /** One of the offered answers by its id, or `{ text }` for an answer in the person's words. */
  answer: (id: string, answer: string | { text: string }) =>
    guard<{ status: 'ok' }>(() =>
      api.POST('/quick-answers/{id}', {
        ...path(id),
        body: typeof answer === 'string' ? { option_id: answer } : { text: answer.text },
      }),
    ).then(worthHearing),
  /** Stop waiting for an answer to a question the person no longer wants to answer. */
  dismissQuestion: (id: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/quick-answers/{id}/dismiss', path(id))),

  /* ---------- phone presence ---------- */
  pushPublicKey: () => guard<{ public_key: string | null }>(() => api.GET('/push/public-key')),
  pushDevices: () => guard<{ subscriptions: PushDevice[] }>(() => api.GET('/push/subscriptions')),
  subscribePush: (input: PushSubscriptionInput) =>
    guard<{ subscription: PushDevice }>(() => api.POST('/push/subscriptions', { body: input })),
  removePushDevice: (id: string) =>
    guard<{ subscription: PushDevice }>(() => api.DELETE('/push/subscriptions/{id}', path(id))),
  pushSettings: () => guard<{ settings: PushSettings }>(() => api.GET('/push/settings')),
  savePushSettings: (patch: PushSettingsUpdate) =>
    guard<{ settings: PushSettings }>(() => api.PATCH('/push/settings', { body: patch })),
  /* ---------- texts and calls to the person's own number ---------- */
  reach: () => guard<{ reach: ReachState }>(() => api.GET('/reach')),
  reachSendCode: (number: string) =>
    guard<{ reach: ReachState }>(() => api.POST('/reach/number', { body: { number } })),
  reachVerify: (code: string) =>
    guard<{ reach: ReachState }>(() => api.POST('/reach/number/verify', { body: { code } })),
  reachForget: () => guard<{ reach: ReachState }>(() => api.DELETE('/reach/number')),
  reachAgree: (choice: { calls: boolean; nights: boolean }) =>
    guard<{ reach: ReachState }>(() => api.POST('/reach/consent', { body: choice })),
  reachWithdraw: () => guard<{ reach: ReachState }>(() => api.DELETE('/reach/consent')),
  rules: () => guard<{ rules: Rule[] }>(() => api.GET('/rules')),
  approvalSettings: () => guard<ApprovalSettingsView>(() => api.GET('/approval-settings')),
  saveApprovalSettings: (body: ApprovalSettings) =>
    guard<ApprovalSettingsView>(() => api.PUT('/approval-settings', { body })),
  /* ---------- reactions: a glyph on a message, either direction ---------- */
  messageEvents: (conversationId: string, signal: AbortSignal) =>
    subscribeEvents(client, { jobId: conversationId, signal }),
  reactions: (conversationId: string) =>
    guard<{ reactions: Reaction[] }>(() =>
      api.GET('/jobs/{jobId}/reactions', { params: { path: { jobId: conversationId } } }),
    ),
  react: (messageSeq: number, emoji: string) =>
    guard<{ reaction: Reaction }>(() =>
      api.POST('/messages/{messageId}/reactions', {
        params: { path: { messageId: String(messageSeq) } },
        body: { emoji },
      }),
    ),

  /* ---------- the broker's ledger: effects the connector never confirmed ---------- */
  unknownActions: (jobId: string) =>
    guard<{ actions: LedgerAction[] }>(() =>
      api.GET('/actions', { params: { query: { job_id: jobId, view: 'summary' } } }),
    ),
  resolveAction: (id: string, resolution: ActionResolution, note?: string) =>
    guard<{ action: LedgerAction }>(() =>
      api.POST('/actions/{actionId}/resolve', {
        params: { path: { actionId: id } },
        body: note ? { resolution, note } : { resolution },
      }),
    ),
  revokeRule: (id: string) => guard<{ status: 'ok' }>(() => api.DELETE('/rules/{id}', path(id))),

  /* ---------- the person's own computers ---------- */
  devices: () => guard<{ devices: Device[] }>(() => api.GET('/devices')),
  pairDevice: (capabilities: DeviceCapabilities) =>
    guard<DevicePairing>(() => api.POST('/devices/pairings', { body: { capabilities } })),
  changeDevice: (id: string, capabilities: Partial<DeviceCapabilities>) =>
    guard<{ device: Device }>(() =>
      api.PATCH('/devices/{id}', { ...path(id), body: { capabilities } }),
    ),
  /** Let cloud models see this computer's screen, or not; null follows Settings → Privacy. */
  changeDeviceScreens: (id: string, cloud_screenshots: boolean | null) =>
    guard<{ device: Device }>(() =>
      api.PATCH('/devices/{id}', { ...path(id), body: { cloud_screenshots } }),
    ),
  revokeDevice: (id: string) =>
    guard<{ device: Device }>(() => api.POST('/devices/{id}/revoke', path(id))),
  /** Take a disconnected computer off the list. */
  removeDevice: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/devices/{id}', path(id))),
  /* ---------- other assistants connected over MCP ---------- */
  assistants: () => guard<{ clients: ConnectedAssistant[] }>(() => api.GET('/mcp/clients')),
  /** Ends every token the assistant holds for this person; answered with 204 and no body. */
  disconnectAssistant: async (clientId: string): Promise<Result<{ status: 'ok' }>> => {
    try {
      const outcome = await api.DELETE('/mcp/clients/{clientId}', {
        params: { path: { clientId } },
      });
      return outcome.response.ok
        ? { data: { status: 'ok' }, error: null, unavailable: null }
        : settle(outcome);
    } catch {
      return { data: null, error: OFFLINE, unavailable: null };
    }
  },

  /* ---------- what Melete learned ---------- */
  learned: (spaceId: string) =>
    guard<LearnedList>(() => api.GET('/learned', { params: { query: { space_id: spaceId } } })),
  engineSkills: (spaceId: string) =>
    guard<{ skills: EngineSkill[] }>(() =>
      api.GET('/engine-skills', { params: { query: { space_id: spaceId } } }),
    ),
  /** Pause, resume, remove or share: the changes that come back with an id to undo. */
  changeLearned: (id: string, action: 'pause' | 'resume' | 'remove' | 'share', spaceId: string) => {
    const init = { ...path(id), body: { space_id: spaceId } };
    return guard<LearnedItemResult>(() =>
      action === 'pause'
        ? api.POST('/learned/{id}/pause', init)
        : action === 'resume'
          ? api.POST('/learned/{id}/resume', init)
          : action === 'remove'
            ? api.POST('/learned/{id}/remove', init)
            : api.POST('/learned/{id}/share', init),
    );
  },
  /** Trying it approves the exact definition the person was shown. */
  tryLearned: (id: string, spaceId: string, definitionHash: string) =>
    guard<LearnedItemResult>(() =>
      api.POST('/learned/{id}/try', {
        ...path(id),
        body: { space_id: spaceId, definition_hash: definitionHash },
      }),
    ),
  undoLearned: (spaceId: string, changeId: string) =>
    guard<LearnedItemResult>(() =>
      api.POST('/learned/undo', { body: { space_id: spaceId, change_id: changeId } }),
    ),
  approveSkill: (id: string, spaceId: string, definitionHash: string) =>
    guard<{ skill: EngineSkill }>(() =>
      api.POST('/engine-skills/{id}/approve', {
        ...path(id),
        body: { space_id: spaceId, definition_hash: definitionHash },
      }),
    ),
  /** The person's own text replaces the engine's, against the version they were shown. */
  editSkill: (id: string, spaceId: string, definitionHash: string, body: string) =>
    guard<{ skill: EngineSkill }>(() =>
      api.POST('/engine-skills/{id}/edit', {
        ...path(id),
        body: { space_id: spaceId, definition_hash: definitionHash, body },
      }),
    ),
  stopSkill: (id: string, spaceId: string, reason: string) =>
    guard<{ skill: EngineSkill }>(() =>
      api.POST('/engine-skills/{id}/stop', { ...path(id), body: { space_id: spaceId, reason } }),
    ),
  /** The person's own skills, each read whole. */
  ownSkills: (spaceId: string) =>
    guard<{ skills: OwnSkill[] }>(() =>
      api.GET('/own-skills', { params: { query: { space_id: spaceId } } }),
    ),
  /** Their words replace what changed, against the version they were shown. */
  editOwnSkill: (name: string, body: OwnSkillEdit) =>
    guard<{ skill: OwnSkill }>(() =>
      api.POST('/own-skills/{name}/edit', { params: { path: { name } }, body }),
    ),
  deleteOwnSkill: (name: string, spaceId: string, version: string) =>
    guard<{ deleted: string }>(() =>
      api.POST('/own-skills/{name}/delete', {
        params: { path: { name } },
        body: { space_id: spaceId, version },
      }),
    ),

  /* ---------- agents, memory ---------- */
  agents: () => guard<{ agents: Agent[]; removed?: Agent[] }>(() => api.GET('/agents')),
  agentTemplates: () => guard<{ templates: AgentTemplate[] }>(() => api.GET('/agents/templates')),
  createAgent: (body: AgentInput) => guard<{ agent: Agent }>(() => api.POST('/agents', { body })),
  updateAgent: (id: string, body: AgentInput) =>
    guard<{ agent: Agent }>(() => api.PATCH('/agents/{id}', { ...path(id), body })),
  /** Melete can't be deleted; another agent's chats and routines move to Melete. */
  deleteAgent: (id: string) => guard<AgentDeleted>(() => api.DELETE('/agents/{id}', path(id))),
  memory: () => guard<{ items: MemoryItem[] }>(() => api.GET('/memory/items')),
  /** A detail the person states outright; the same key again replaces the value. */
  createMemoryItem: (body: MemoryItemCreate) =>
    guard<{ item: MemoryItem }>(() => api.POST('/memory/items', { body })),
  editMemory: (id: string, value: string, version: string) =>
    guard<{ status: 'ok' }>(() =>
      api.PATCH('/memory/items/{id}', { ...path(id), body: { value, version } }),
    ),
  deleteMemory: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/memory/items/{id}', path(id))),
  memoryWhy: (id: string) =>
    guard<MemoryExplanation>(() => api.GET('/memory/items/{id}/why', path(id))),
  beliefs: () => guard<{ beliefs: Belief[]; time_zone: string }>(() => api.GET('/memory/beliefs')),
  beliefHistory: (id: string) =>
    guard<BeliefHistory>(() => api.GET('/memory/beliefs/{id}/history', path(id))),
  /** Forget a belief and never learn its subject again. */
  blockBelief: (id: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/memory/beliefs/{id}/block', path(id))),
  beliefBlocks: () => guard<{ blocks: BeliefBlock[] }>(() => api.GET('/memory/blocks')),
  unblockBelief: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/memory/blocks/{id}', path(id))),
  /** Notes Melete kept for itself; they can be deleted, never edited. */
  agentNotes: () => guard<{ notes: AgentNote[] }>(() => api.GET('/memory/notes')),
  deleteAgentNote: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/memory/notes/{id}', path(id))),
  memoryTimeline: (days = 30) =>
    guard<MemoryTimeline>(() =>
      api.GET('/memory/timeline', { params: { query: { days: String(days) } } }),
    ),
  previewRewind: (body: RewindTarget) =>
    guard<RewindPreview>(() => api.POST('/memory/rewind/preview', { body })),
  rewind: (body: RewindTarget) =>
    guard<{ rewind: MemoryRewind }>(() => api.POST('/memory/rewind', { body })),
  undoRewind: (id: string) =>
    guard<{ rewind: MemoryRewind }>(() => api.POST('/memory/rewinds/{id}/undo', path(id))),
  memoryDigest: () => guard<MemoryDigestResponse>(() => api.GET('/memory/digest')),
  digestSeen: (id: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/memory/digest/{id}/seen', path(id))),
  exportBeliefs: (format: 'json' | 'markdown') =>
    guard<BeliefExport>(() => api.GET('/memory/export', { params: { query: { format } } })),
  importBeliefs: (body: BeliefImport) =>
    guard<BeliefImportResult>(() => api.POST('/memory/import', { body })),

  /* ---------- privacy ---------- */
  privacySettings: () => guard<PrivacySettings>(() => api.GET('/privacy/settings')),
  savePrivacy: (body: PrivacySettingsUpdate) =>
    guard<PrivacySettings>(() => api.PUT('/privacy/settings', { body })),
  previewPrivacy: (text: string) =>
    guard<PrivacyPreview>(() => api.POST('/privacy/preview', { body: { text } })),
  checkLocalModel: (body: LocalModelCheckRequest) =>
    guard<LocalModelCheck>(() => api.POST('/privacy/local-model/check', { body })),
  conversationPrivacy: (id: string) =>
    guard<ConversationPrivacy>(() => api.GET('/conversations/{id}/privacy', path(id))),
  /** The person's own word on a conversation: a topic marks it private, null clears it. */
  markConversationPrivacy: (id: string, sensitive: SensitiveTopic | null) =>
    guard<ConversationPrivacy>(() =>
      api.PUT('/conversations/{id}/privacy', { ...path(id), body: { sensitive } }),
    ),
  /** The real values behind one answer's placeholders, for this screen only. */
  revealPrivacy: (id: string, turnId: string) =>
    guard<PrivacyReveal>(() =>
      api.POST('/conversations/{id}/privacy/reveal', { ...path(id), body: { turn_id: turnId } }),
    ),

  /* ---------- plans ---------- */
  plans: () => guard<{ plans: Plan[] }>(() => api.GET('/plans')),
  plan: (id: string) => guard<{ plan: Plan }>(() => api.GET('/plans/{id}', path(id))),
  createPlan: (body: PlanCreate) => guard<{ plan: Plan }>(() => api.POST('/plans', { body })),
  setMilestone: (planId: string, milestoneId: string, done: boolean) =>
    guard<{ plan: Plan }>(() =>
      api.PATCH('/plans/{id}/milestones/{milestoneId}', {
        params: { path: { id: planId, milestoneId } },
        body: { done },
      }),
    ),
  planConversation: (id: string, agent_id: string) =>
    guard<{ conversation: Conversation }>(() =>
      api.POST('/plans/{id}/conversation', { ...path(id), body: { agent_id } }),
    ),
  /** Deletes the plan and its steps; chats started from it stay. */
  deletePlan: (id: string) => guard<{ status: 'ok' }>(() => api.DELETE('/plans/{id}', path(id))),
  /** What deleted chats and plans did in the person's name. */
  activity: () => guard<ActivityList>(() => api.GET('/activity')),
  /** Take back something a deleted chat did, while its Undo is offered. */
  undoActivity: (id: string) =>
    guard<{ entry: ActivityList['activity'][number] }>(() =>
      api.POST('/activity/{id}/undo', path(id)),
    ),
  /** Who is in the space this session uses. */
  spaceMembers: () => guard<SpaceMembers>(() => api.GET('/space/members')),
  /** The space's owner removes someone from a shared space. */
  removeMember: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/space/members/{id}', path(id))),
  sharePlan: (id: string) => guard<never>(() => api.POST('/plans/{id}/share', path(id))),

  /* ---------- long work in the background ---------- */
  runs: (conversationId?: string) =>
    guard<{ runs: Run[] }>(() =>
      api.GET('/runs', {
        params: { query: conversationId ? { conversation_id: conversationId } : {} },
      }),
    ),
  run: (id: string) => guard<{ run: Run }>(() => api.GET('/runs/{id}', path(id))),
  createRun: (body: RunCreate) => guard<{ run: Run }>(() => api.POST('/runs', { body })),
  runRecord: (id: string, after: string | null) =>
    guard<RunRecordPage>(() =>
      api.GET('/runs/{id}/record', {
        params: { path: { id }, query: after ? { after } : {} },
      }),
    ),
  exportRun: (id: string) =>
    guard<{ markdown: string }>(() => api.GET('/runs/{id}/export', path(id))),
  messageRun: (id: string, text: string) =>
    guard<{ run: Run }>(() => api.POST('/runs/{id}/message', { ...path(id), body: { text } })),
  pauseRun: (id: string) => guard<{ run: Run }>(() => api.POST('/runs/{id}/pause', path(id))),
  resumeRun: (id: string) => guard<{ run: Run }>(() => api.POST('/runs/{id}/resume', path(id))),
  stopRun: (id: string) => guard<{ run: Run }>(() => api.POST('/runs/{id}/stop', path(id))),
  setRunLimit: (id: string, limit: RunLimit | null) =>
    guard<{ run: Run }>(() => api.PUT('/runs/{id}/limit', { ...path(id), body: { limit } })),

  /* ---------- routines, connections, browser, search ---------- */
  automations: () => guard<{ automations: Automation[] }>(() => api.GET('/automations')),
  createAutomation: (body: AutomationCreate) =>
    guard<{ automation: Automation }>(() => api.POST('/automations', { body })),
  testAutomation: (id: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/automations/{id}/test', path(id))),
  pauseAutomation: (id: string) =>
    guard<{ automation: Automation }>(() => api.POST('/automations/{id}/pause', path(id))),
  resumeAutomation: (id: string) =>
    guard<{ automation: Automation }>(() => api.POST('/automations/{id}/resume', path(id))),
  restartAutomation: (id: string) =>
    guard<{ automation: Automation }>(() => api.POST('/automations/{id}/restart', path(id))),
  deleteAutomation: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/automations/{id}', path(id))),
  /** Sets up the daily brief at `at` (HH:MM, the person's time zone); left out, it runs as Melete. */
  morningBrief: (brief: { at: string; topics?: string[]; agent_id?: string }) =>
    guard<{ automation: Automation }>(() =>
      api.POST('/automations/morning-brief', { body: brief }),
    ),
  connections: () =>
    guard<{ connections: import('./types.ts').Connection[] }>(() =>
      api.GET('/experience/connections'),
    ),
  /** Turns watching a mailbox or calendar for changes on or off; answers with the list. */
  watchConnection: (id: string, on: boolean) =>
    guard<{ connections: import('./types.ts').Connection[] }>(() =>
      api.PUT('/experience/connections/{id}/watching', { ...path(id), body: { on } }),
    ),
  /** Whether conversations in this space read public web pages; on unless turned off. */
  webReads: () => guard<{ enabled: boolean; available: boolean }>(() => api.GET('/web/settings')),
  saveWebReads: (enabled: boolean) =>
    guard<{ enabled: boolean; available: boolean }>(() =>
      api.PUT('/web/settings', { body: { enabled } }),
    ),
  /** The kinds that can be installed, each with the fields its form needs. */
  connectionKinds: () =>
    guard<{ kinds: ConnectionKind[]; catalog?: CatalogEntry[] }>(() =>
      api.GET('/connection-kinds'),
    ),
  /** Starts signing in to an account; the answer names where, what it asks for, and the page to open. */
  startAccountSignIn: (provider: 'google' | 'microsoft', spaceId?: string) =>
    guard<AccountSignInStart>(() => {
      const body = spaceId ? { space_id: spaceId } : {};
      return provider === 'google'
        ? api.POST('/google-sign-ins', { body })
        : api.POST('/microsoft-sign-ins', { body });
    }),
  /** Starts signing in to Google through Composio; the answer is the first consent page to open. */
  startManagedSignIn: (spaceId?: string) =>
    guard<ManagedSignInStart>(() =>
      api.POST('/managed-sign-ins', {
        body: { provider: 'google', ...(spaceId ? { space_id: spaceId } : {}) },
      }),
    ),
  managedSignInStatus: (id: string) =>
    guard<AccountSignInStatus>(() => api.GET('/managed-sign-ins/{id}', path(id))),
  accountSignInStatus: (provider: 'google' | 'microsoft', id: string) =>
    guard<AccountSignInStatus>(() =>
      provider === 'google'
        ? api.GET('/google-sign-ins/{id}', path(id))
        : api.GET('/microsoft-sign-ins/{id}', path(id)),
    ),
  /**
   * Starts signing in to the MCP server behind an installed connection; with a
   * client, as the OAuth app the person registered with that server themselves.
   */
  startMcpSignIn: (connectionId: string, client?: { client_id: string; client_secret?: string }) =>
    guard<McpSignInStart>(() =>
      api.POST('/mcp-sign-ins', {
        body: { connection_id: connectionId, ...(client ? { client } : {}) },
      }),
    ),
  /** Starts connecting an app from the catalog: one sign-in, and its tools come from the catalog. */
  startCatalogSignIn: (catalogId: string, spaceId?: string) =>
    guard<McpSignInStart>(() =>
      api.POST('/mcp-sign-ins', {
        body: { catalog_id: catalogId, ...(spaceId ? { space_id: spaceId } : {}) },
      }),
    ),
  mcpSignInStatus: (id: string) =>
    guard<McpSignInStatus>(() => api.GET('/mcp-sign-ins/{id}', path(id))),
  /** Reads the tools of a server added by its address; nothing is installed. */
  discoverMcpTools: (url: string, accessToken?: string, spaceId?: string) =>
    guard<McpToolDiscovery>(() =>
      api.POST('/mcp-servers/discover', {
        body: {
          url,
          ...(accessToken ? { access_token: accessToken } : {}),
          ...(spaceId ? { space_id: spaceId } : {}),
        },
      }),
    ),
  /** Signs in to a server added by its address; its tools are read once that is done. */
  startDiscoverySignIn: (label: string, id: string, url: string, spaceId?: string) =>
    guard<McpSignInStart>(() =>
      api.POST('/mcp-sign-ins', {
        body: { label, discover: { id, url }, ...(spaceId ? { space_id: spaceId } : {}) },
      }),
    ),
  /** Installs a signed-in server with the tools the person kept. */
  installSignedIn: (
    id: string,
    tools: { name: string; effect_class: DiscoveredMcpTool['effect_class'] }[],
  ) =>
    guard<ConnectionInstalled>(() =>
      api.POST('/mcp-sign-ins/{id}/install', { ...path(id), body: { tools } }),
    ),
  /** The body is built from a kind's descriptor; the service validates it per kind. */
  installConnection: (body: Record<string, unknown>) =>
    guard<ConnectionInstalled>(() =>
      api.POST('/connections', { body: body as unknown as ConnectionCreate }),
    ),
  testConnection: (id: string) =>
    guard<ConnectionChecked>(() =>
      api.POST('/connections/{connectionId}/health', {
        params: { path: { connectionId: id } },
      }),
    ),
  /** Removal names the generation it read, so a change made elsewhere is not overwritten. */
  removeConnection: async (id: string): Promise<Result<{ status: string }>> => {
    const current = await guard<ConnectionInstalled>(() =>
      api.GET('/connections/{connectionId}', { params: { path: { connectionId: id } } }),
    );
    if (current.data === null) return current;
    return guard<{ status: string }>(() =>
      api.POST('/connections/{id}/lifecycle', {
        ...path(id),
        body: { kind: 'revoke', expected_generation: current.data.connection.generation ?? 0 },
      }),
    );
  },
  browserSession: (id: string) =>
    guard<{ session: BrowserSession }>(() => api.GET('/browser/sessions/{id}', path(id))),
  browserControl: (id: string, control: 'take_control' | 'resume' | 'stop') =>
    guard<{ session: BrowserSession }>(() =>
      api.POST('/browser/sessions/{id}/control', { ...path(id), body: { control } }),
    ),
  /* ---------- the agent's computer ---------- */
  computer: (id: string) =>
    guard<AgentComputer>(() => api.GET('/conversations/{id}/computer', path(id))),
  takeOver: (sessionId: string) =>
    guard<BrowserControl>(() => api.POST('/browser/sessions/{id}/takeover', path(sessionId))),
  handBack: (sessionId: string) =>
    guard<BrowserControl>(() => api.POST('/browser/sessions/{id}/handback', path(sessionId))),
  liveOpen: (sessionId: string) =>
    guard<LiveOpen>(() => api.POST('/browser/sessions/{id}/live', path(sessionId))),
  liveInput: (sessionId: string, body: LiveUp) =>
    guard<{ accepted: number }>(() =>
      api.POST('/browser/sessions/{id}/live/input', { ...path(sessionId), body }),
    ),
  liveScope: (sessionId: string, liveId: string, host: string) =>
    guard<{ site_scope: string[] }>(() =>
      api.POST('/browser/sessions/{id}/live/scope', {
        ...path(sessionId),
        body: { live_id: liveId, host },
      }),
    ),
  liveClose: (sessionId: string, liveId: string) =>
    guard<{ closed: true }>(() =>
      api.POST('/browser/sessions/{id}/live/close', {
        ...path(sessionId),
        body: { live_id: liveId },
      }),
    ),
  /* ---------- the desktop in the agent's sandbox: the same live wire shapes ---------- */
  sandboxComputers: (jobId: string) =>
    guard<{ computers: SandboxComputer[] }>(() =>
      api.GET('/sandbox/computers', { params: { query: { job_id: jobId } } }),
    ),
  sandboxTakeOver: (sessionId: string) =>
    guard<SandboxControl>(() => api.POST('/sandbox/sessions/{id}/takeover', path(sessionId))),
  sandboxHandBack: (sessionId: string) =>
    guard<SandboxControl>(() => api.POST('/sandbox/sessions/{id}/handback', path(sessionId))),
  sandboxLiveOpen: (sessionId: string) =>
    guard<LiveOpen>(() => api.POST('/sandbox/sessions/{id}/live', path(sessionId))),
  sandboxLiveInput: (sessionId: string, body: LiveUp) =>
    guard<{ accepted: number }>(() =>
      api.POST('/sandbox/sessions/{id}/live/input', { ...path(sessionId), body }),
    ),
  sandboxLiveClose: (sessionId: string, liveId: string) =>
    guard<{ closed: true }>(() =>
      api.POST('/sandbox/sessions/{id}/live/close', {
        ...path(sessionId),
        body: { live_id: liveId },
      }),
    ),
  /* ---------- background processes in the agent's computer ---------- */
  processPreview: (processId: string) =>
    guard<ProcessPreview>(() => api.POST('/sandbox/processes/{id}/previews', path(processId))),
  processOutput: (processId: string) =>
    guard<ProcessOutput>(() => api.GET('/sandbox/processes/{id}/output', path(processId))),
  processStop: (processId: string) =>
    guard<ProcessStopped>(() => api.POST('/sandbox/processes/{id}/stop', path(processId))),
  /** Where a preview's page loads: the API's own address, then the preview's path. */
  previewSource: (preview: ProcessPreview) => `${API_BASE_URL}${preview.path}`,
  /** Where a file or picture the service keeps is served, with the session's cookie. */
  artifactUrl,
  fileUrl,
  screenshotUrl,
  search: (q: string) =>
    guard<{ results: SearchResult[] }>(() => api.GET('/search', { params: { query: { q } } })),

  /* ---------- voice: push-to-talk and voice mode ---------- */
  /** Which voice features the installation has. The mic and voice mode appear only when true. */
  voice: (place?: { conversationId: string | null; agentId: string | null }) =>
    guard<VoiceStatus>(() => api.GET('/voice', { params: { query: voicePlace(place) } })),
  /** A recorded clip in, the words out. Nothing is sent to the conversation. */
  transcribe: (
    clip: Blob,
    durationMs: number,
    place?: { conversationId: string | null; agentId: string | null },
  ) =>
    binary(
      `/voice/transcriptions?${new URLSearchParams({
        duration_ms: String(Math.max(1, Math.round(durationMs))),
        ...voicePlace(place),
      })}`,
      { method: 'POST', headers: { 'Content-Type': clip.type || 'audio/webm' }, body: clip },
      async (response) => (await response.json()) as VoiceTranscription,
    ),
  /** A realtime transcription address with a single-use token, for voice mode. */
  voiceSession: (id: string) =>
    guard<VoiceSession>(() => api.POST('/conversations/{id}/voice/session', path(id))),
  /**
   * A word with Melete while the turn runs: an answer, a progress word, or a
   * note that what was heard is meant for the work. It never acts.
   */
  voiceAside: (id: string, body: VoiceAsideRequest) =>
    guard<VoiceAside>(() => api.POST('/conversations/{id}/voice/aside', { ...path(id), body })),
  /** Part of a reply, read aloud. The audio arrives whole and is played from memory. */
  speak: (id: string, text: string, signal?: AbortSignal) =>
    binary(
      `/conversations/${encodeURIComponent(id)}/voice/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        ...(signal ? { signal } : {}),
      },
      (response) => response.blob(),
    ),
  /* ---------- problem reports ---------- */
  sendFeedback: (report: FeedbackCreate) =>
    guard<{ report: FeedbackReport }>(() => api.POST('/feedback', { body: report })),
  feedback: (status?: FeedbackStatus) =>
    guard<FeedbackList>(() =>
      api.GET('/feedback', { params: { query: status ? { status } : {} } }),
    ),
  feedbackReport: (id: string) =>
    guard<{ report: FeedbackReport }>(() => api.GET('/feedback/{id}', path(id))),
  setFeedbackStatus: (id: string, status: FeedbackStatus, note?: string | null) =>
    guard<{ report: FeedbackReport }>(() =>
      api.PATCH('/feedback/{id}', {
        ...path(id),
        body: { status, ...(note !== undefined ? { note } : {}) },
      }),
    ),
};

/** The conversation, or the agent a new chat will have, as the voice routes read it. */
function voicePlace(place?: { conversationId: string | null; agentId: string | null }): {
  conversation_id?: string;
  agent_id?: string;
} {
  if (place?.conversationId) return { conversation_id: place.conversationId };
  if (place?.agentId) return { agent_id: place.agentId };
  return {};
}

/**
 * A request whose body or answer is not JSON: a recording going up, or speech
 * coming down. It settles to a Result like every other call.
 */
async function binary<T>(
  route: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<Result<T>> {
  try {
    const response = await client.options.fetch(`${client.options.baseUrl}${route}`, {
      ...init,
      headers: { ...client.options.headers, ...(init.headers as Record<string, string>) },
      credentials: client.options.credentials,
    });
    if (!response.ok)
      return {
        data: null,
        error: errorMessage(await response.json().catch(() => null), OFFLINE),
        unavailable: null,
        unauthorized: response.status === 401,
      };
    return { data: await read(response), error: null, unavailable: null };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { data: null, error: OFFLINE, unavailable: null };
  }
}

export type StreamItem =
  | { type: 'open' }
  | { type: 'event'; event: ExperienceEvent }
  | { type: 'gap'; gap: StreamGap };

/**
 * Follow one conversation's events. Durable items replay on reconnect from
 * the cursor; a break yields a gap so the transcript can say streamed text may
 * be missing rather than stitching two halves together.
 */
export async function* subscribeConversation(
  id: string,
  options: { after?: number; signal?: AbortSignal } = {},
): AsyncGenerator<StreamItem, void, void> {
  let cursor = options.after ?? 0;
  let attempt = 0;
  while (true) {
    attempt += 1;
    if (options.signal?.aborted) return;
    if (attempt > 1) {
      yield { type: 'gap', gap: { after: cursor, next: null, reason: 'reconnect' } };
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 2), 8000)));
      if (options.signal?.aborted) return;
    }
    let body: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await client.options.fetch(
        `${client.options.baseUrl}/conversations/${encodeURIComponent(id)}/events?since=${cursor}`,
        {
          headers: {
            ...client.options.headers,
            Accept: 'text/event-stream',
            ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
          },
          credentials: client.options.credentials,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (!response.ok || !response.body) throw new Error(`stream returned ${response.status}`);
      body = response.body;
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
        return;
      continue;
    }
    yield { type: 'open' };
    try {
      for await (const frame of readSse(body)) {
        if (frame.comment) continue;
        let event: ExperienceEvent;
        try {
          event = JSON.parse(frame.data) as ExperienceEvent;
        } catch {
          continue;
        }
        if (typeof event.seq !== 'number' || event.seq <= cursor) continue;
        cursor = event.seq;
        yield { type: 'event', event };
      }
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
        return;
    }
    if (options.signal?.aborted) return;
  }
}

/** One event of a live browser view. Frames are painted and dropped, never kept. */
export type LiveDown =
  | { type: 'frame'; seq: number; data: string }
  | { type: 'where'; url: string; title: string; in_scope: boolean }
  | { type: 'notice'; code: string; host?: string }
  | { type: 'ended'; code: string };

/**
 * Follow a live view of the browser or of the sandbox desktop, which share
 * their wire shapes. It ends when the service ends it or the stream drops; the
 * view is then opened again rather than resumed, since nothing is replayed.
 */
export async function* followLive(
  sessionId: string,
  liveId: string,
  signal: AbortSignal,
  surface: 'browser' | 'sandbox' = 'browser',
): AsyncGenerator<LiveDown, void, void> {
  const response = await client.options.fetch(
    `${client.options.baseUrl}/${surface}/sessions/${encodeURIComponent(sessionId)}/live/frames?live_id=${encodeURIComponent(liveId)}`,
    {
      headers: { ...client.options.headers, Accept: 'text/event-stream' },
      credentials: client.options.credentials,
      signal,
    },
  );
  if (!response.ok || !response.body) return;
  for await (const frame of readSse(response.body)) {
    if (frame.comment) continue;
    try {
      yield JSON.parse(frame.data) as LiveDown;
    } catch {
      // A frame that does not parse is skipped; the next one repaints.
    }
  }
}
