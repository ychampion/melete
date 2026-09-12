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
import { createMeleteClient, errorMessage, readSse } from '@melete/client';
import type {
  ActionResolution,
  Agent,
  AgentInput,
  AgentTemplate,
  Automation,
  AutomationCreate,
  BrowserSession,
  Conversation,
  ConversationCreate,
  Draft,
  ExperienceEvent,
  Home,
  LedgerAction,
  MemoryExplanation,
  MemoryItem,
  MessageAcceptance,
  Permission,
  PermissionOutcome,
  Plan,
  PlanCreate,
  Profile,
  Question,
  Receipt,
  ResultCard,
  Rule,
  RuleBounds,
  SearchResult,
  SendOutcome,
  Task,
  TaskInput,
  Turn,
} from './types.ts';
import { isNotAvailable } from './types.ts';

export type Result<T> =
  | { data: T; error: null; unavailable: null }
  | { data: null; error: string; unavailable: null }
  | { data: null; error: null; unavailable: string };

export const API_BASE_URL: string =
  (import.meta.env.VITE_MELETE_API as string | undefined) ?? 'http://localhost:3210';

export const client = createMeleteClient({ baseUrl: API_BASE_URL });

const OFFLINE = 'Couldn’t reach Melete. Check that the service is running.';

/** Turn an openapi-fetch result into a Result, reading not_available as a reason. */
function settle<T>(outcome: { data?: unknown; error?: unknown; response?: Response }): Result<T> {
  if (outcome.data !== undefined) {
    if (isNotAvailable(outcome.data))
      return { data: null, error: null, unavailable: outcome.data.reason };
    return { data: outcome.data as T, error: null, unavailable: null };
  }
  return { data: null, error: errorMessage(outcome.error, OFFLINE), unavailable: null };
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
const path = (id: string) => ({ params: { path: { id } } });

export const adapter = {
  /* ---------- session ---------- */
  profile: () => guard<{ profile: Profile }>(() => api.GET('/profile')),
  saveProfile: (profile: Profile) =>
    guard<{ profile: Profile }>(() => api.PATCH('/profile', { body: profile })),
  magicLink: (email: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/signin/magic-link', { body: { email } })),
  consumeMagicLink: (token: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/signin/magic-link/consume', { body: { token } })),
  signInGoogle: () => guard<{ status: 'ok' }>(() => api.POST('/signin/google')),
  signInApple: () => guard<{ status: 'ok' }>(() => api.POST('/signin/apple')),

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
  conversation: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.GET('/conversations/{id}', path(id))),
  createConversation: (body: ConversationCreate) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations', { body })),
  turns: (id: string) =>
    guard<{ turns: Turn[] }>(() => api.GET('/conversations/{id}/messages', path(id))),
  send: (id: string, text: string, key: string) =>
    guard<MessageAcceptance>(() =>
      api.POST('/conversations/{id}/messages', {
        ...path(id),
        headers: { 'Idempotency-Key': key },
        body: { text },
      }),
    ),
  pause: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/pause', path(id))),
  resume: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/resume', path(id))),
  stop: (id: string) =>
    guard<{ conversation: Conversation }>(() => api.POST('/conversations/{id}/stop', path(id))),
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
  decide: (id: string, option: 'allow_once' | 'deny', version: string) =>
    guard<PermissionOutcome>(() =>
      api.POST('/permissions/{id}', { ...path(id), body: { option, version } }),
    ),
  decideAlways: (id: string, version: string, bounds: RuleBounds) =>
    guard<PermissionOutcome>(() =>
      api.POST('/permissions/{id}', { ...path(id), body: { option: 'always', version, bounds } }),
    ),
  permissions: () => guard<{ permissions: Permission[] }>(() => api.GET('/permissions')),
  undo: (id: string) =>
    guard<{ receipt: Receipt }>(() => api.POST('/receipts/{id}/undo', path(id))),
  sendDraft: (id: string) => guard<SendOutcome>(() => api.POST('/drafts/{id}/send', path(id))),
  questions: () => guard<{ questions: Question[] }>(() => api.GET('/quick-answers')),
  answer: (id: string, option_id: string) =>
    guard<{ status: 'ok' }>(() =>
      api.POST('/quick-answers/{id}', { ...path(id), body: { option_id } }),
    ),
  rules: () => guard<{ rules: Rule[] }>(() => api.GET('/rules')),
  /* ---------- the broker's ledger: effects the connector never confirmed ---------- */
  unknownActions: (jobId: string) =>
    guard<{ actions: LedgerAction[] }>(() =>
      api.GET('/actions', { params: { query: { job_id: jobId } } }),
    ),
  resolveAction: (id: string, resolution: ActionResolution, note?: string) =>
    guard<{ action: LedgerAction }>(() =>
      api.POST('/actions/{actionId}/resolve', {
        params: { path: { actionId: id } },
        body: note ? { resolution, note } : { resolution },
      }),
    ),
  revokeRule: (id: string) => guard<{ status: 'ok' }>(() => api.DELETE('/rules/{id}', path(id))),

  /* ---------- agents, memory ---------- */
  agents: () => guard<{ agents: Agent[] }>(() => api.GET('/agents')),
  agentTemplates: () => guard<{ templates: AgentTemplate[] }>(() => api.GET('/agents/templates')),
  createAgent: (body: AgentInput) => guard<{ agent: Agent }>(() => api.POST('/agents', { body })),
  updateAgent: (id: string, body: AgentInput) =>
    guard<{ agent: Agent }>(() => api.PATCH('/agents/{id}', { ...path(id), body })),
  memory: () => guard<{ items: MemoryItem[] }>(() => api.GET('/memory/items')),
  editMemory: (id: string, value: string, version: string) =>
    guard<{ status: 'ok' }>(() =>
      api.PATCH('/memory/items/{id}', { ...path(id), body: { value, version } }),
    ),
  deleteMemory: (id: string) =>
    guard<{ status: 'ok' }>(() => api.DELETE('/memory/items/{id}', path(id))),
  memoryWhy: (id: string) =>
    guard<MemoryExplanation>(() => api.GET('/memory/items/{id}/why', path(id))),

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
  sharePlan: (id: string) => guard<never>(() => api.POST('/plans/{id}/share', path(id))),

  /* ---------- routines, connections, browser, search ---------- */
  automations: () => guard<{ automations: Automation[] }>(() => api.GET('/automations')),
  createAutomation: (body: AutomationCreate) =>
    guard<{ automation: Automation }>(() => api.POST('/automations', { body })),
  testAutomation: (id: string) =>
    guard<{ status: 'ok' }>(() => api.POST('/automations/{id}/test', path(id))),
  morningBrief: (agent_id: string, at: string) =>
    guard<{ automation: Automation }>(() =>
      api.POST('/automations/morning-brief', { body: { agent_id, at } }),
    ),
  connections: () =>
    guard<{ connections: import('./types.ts').Connection[] }>(() =>
      api.GET('/experience/connections'),
    ),
  browserSession: (id: string) =>
    guard<{ session: BrowserSession }>(() => api.GET('/browser/sessions/{id}', path(id))),
  browserControl: (id: string, control: 'take_control' | 'resume' | 'stop') =>
    guard<{ session: BrowserSession }>(() =>
      api.POST('/browser/sessions/{id}/control', { ...path(id), body: { control } }),
    ),
  search: (q: string) =>
    guard<{ results: SearchResult[] }>(() => api.GET('/search', { params: { query: { q } } })),
};

export type Adapter = typeof adapter;

export type StreamGap = {
  after: number;
  next: number | null;
  reason: 'reconnect' | 'sequence_skip';
};
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
