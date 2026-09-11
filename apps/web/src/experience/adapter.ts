/**
 * The one place the interface talks to a backend. Everything a surface needs
 * is a method here, typed by ./types.ts. The mock serves these routes under
 * /surfaces; the experience contract in packages/contracts/src/experience.ts is
 * the target, and this file is where its shapes are adopted.
 *
 * Requests never throw on a non-2xx status: every call resolves to
 * { data, error }, and `error` is the sentence the service gave.
 */
import { readSse } from '@melete/client';
import type {
  Agent,
  AgentTemplate,
  Automation,
  Capabilities,
  ConnectionData,
  Conversation,
  ConversationEvent,
  ConversationSummary,
  DayPanel,
  HomeData,
  MemoryItem,
  OnboardingAnswer,
  PaletteHit,
  Plan,
  PlanTemplate,
  Profile,
  Reaction,
  Rule,
  Session,
  StreamItem,
} from './types.ts';

export type Result<T> = { data: T; error: null } | { data: null; error: string };

export const API_BASE_URL: string =
  (import.meta.env.VITE_MELETE_API as string | undefined) ?? 'http://localhost:3210';

const base = API_BASE_URL.replace(/\/+$/, '');

async function call<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Result<T>> {
  try {
    const response = await fetch(`${base}/surfaces${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message =
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error: { message?: unknown } }).error?.message === 'string'
          ? (parsed as { error: { message: string } }).error.message
          : `The request failed (${response.status}).`;
      return { data: null, error: message };
    }
    return { data: parsed as T, error: null };
  } catch {
    return { data: null, error: 'Couldn’t reach Melete. Check that the service is running.' };
  }
}

const get = <T>(path: string) => call<T>('GET', path);
const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {});
const del = <T>(path: string) => call<T>('DELETE', path);

export const adapter = {
  capabilities: () => get<Capabilities>('/capabilities'),
  session: () => get<Session>('/session'),
  signIn: (email: string) => post<{ sent: true }>('/session/sign-in', { email }),
  oauth: (provider: 'google' | 'apple') => post<Session>('/session/oauth', { provider }),
  signOut: () => post<Session>('/session/sign-out'),
  /** The magic link the mock answers with. A real service sends mail. */
  completeSignIn: (email: string) => post<Session>('/session/complete', { email }),
  saveProfile: (profile: Partial<Profile>) => post<Session>('/session/profile', profile),
  saveAnswers: (answers: OnboardingAnswer[]) =>
    post<{ items: MemoryItem[] }>('/onboarding/answers', { answers }),
  completeOnboarding: (body: { agent_id: string | null; first_message: string | null }) =>
    post<{ session: Session; conversation_id: string | null }>('/onboarding/complete', body),

  home: () => get<HomeData>('/home'),
  day: () => get<DayPanel>('/day'),
  toggleTask: (id: string, done: boolean) => post<DayPanel>(`/day/tasks/${id}`, { done }),
  addTask: (text: string) => post<DayPanel>('/day/tasks', { text }),

  conversations: () => get<{ conversations: ConversationSummary[] }>('/conversations'),
  conversation: (id: string) => get<Conversation>(`/conversations/${id}`),
  startConversation: (body: { text: string; agent_id: string | null; plan_id?: string }) =>
    post<{ conversation: Conversation }>('/conversations', body),
  send: (id: string, text: string) =>
    post<{ conversation: Conversation }>(`/conversations/${id}/messages`, { text }),
  pause: (id: string) => post<{ ok: true }>(`/conversations/${id}/pause`),
  resume: (id: string) => post<{ ok: true }>(`/conversations/${id}/resume`),
  stop: (id: string) => post<{ ok: true }>(`/conversations/${id}/stop`),
  setAgent: (id: string, agent_id: string | null) =>
    post<{ conversation: Conversation }>(`/conversations/${id}/agent`, { agent_id }),
  react: (id: string, turn_id: string, reaction: Reaction) =>
    post<{ ok: true }>(`/conversations/${id}/reactions`, { turn_id, reaction }),
  rename: (id: string, title: string) =>
    post<{ conversation: Conversation }>(`/conversations/${id}/rename`, { title }),
  pin: (id: string, pinned: boolean) =>
    post<{ conversation: Conversation }>(`/conversations/${id}/pin`, { pinned }),
  deleteConversation: (id: string) => del<{ ok: true }>(`/conversations/${id}`),

  decide: (
    permission_id: string,
    decision: 'allow_once' | 'always' | 'deny',
    payload_hash: string,
  ) => post<{ ok: true }>(`/permissions/${permission_id}`, { decision, payload_hash }),
  undo: (receipt_id: string) => post<{ ok: true }>(`/receipts/${receipt_id}/undo`),
  sendDraft: (draft_id: string) => post<{ ok: true }>(`/drafts/${draft_id}/send`),
  editDraft: (draft_id: string, body: string) =>
    post<{ ok: true }>(`/drafts/${draft_id}`, { body }),
  answer: (question_id: string, text: string) =>
    post<{ ok: true }>(`/questions/${question_id}/answer`, { text }),
  resolveUnknown: (id: string, resolution: 'succeeded' | 'failed' | 'unresolved', note: string) =>
    post<{ ok: true }>(`/unknown/${id}/resolve`, { resolution, note }),

  browserTakeControl: (id: string) => post<{ ok: true }>(`/browser/${id}/take-control`),
  browserHandBack: (id: string) => post<{ ok: true }>(`/browser/${id}/hand-back`),
  browserStop: (id: string) => post<{ ok: true }>(`/browser/${id}/stop`),

  plans: () => get<{ plans: Plan[]; templates: PlanTemplate[] }>('/plans'),
  plan: (id: string) => get<Plan>(`/plans/${id}`),
  createPlan: (body: { title: string; category: string; why: string }) =>
    post<{ plan: Plan }>('/plans', body),
  toggleMilestone: (plan_id: string, id: string, done: boolean) =>
    post<Plan>(`/plans/${plan_id}/milestones/${id}`, { done }),
  addMilestone: (plan_id: string, text: string) =>
    post<Plan>(`/plans/${plan_id}/milestones`, { text }),
  completePlan: (plan_id: string) => post<Plan>(`/plans/${plan_id}/complete`),

  agents: () => get<{ agents: Agent[]; templates: AgentTemplate[] }>('/agents'),
  saveAgent: (agent: Omit<Agent, 'stats' | 'id'> & { id: string | null }) =>
    post<{ agent: Agent }>('/agents', agent),
  deleteAgent: (id: string) => del<{ ok: true }>(`/agents/${id}`),

  automations: () => get<{ automations: Automation[] }>('/automations'),
  toggleAutomation: (id: string, enabled: boolean) =>
    post<Automation>(`/automations/${id}`, { enabled }),
  testRun: (id: string) => post<Automation>(`/automations/${id}/test-run`),
  retryRun: (id: string, run_id: string) =>
    post<Automation>(`/automations/${id}/runs/${run_id}/retry`),

  memory: () => get<{ items: MemoryItem[] }>('/memory'),
  updateMemory: (id: string, value: string) => post<MemoryItem>(`/memory/${id}`, { value }),
  deleteMemory: (id: string) => del<{ ok: true }>(`/memory/${id}`),

  connections: () => get<{ connections: ConnectionData[] }>('/connections'),
  connect: (id: string) => post<ConnectionData>(`/connections/${id}/connect`),
  disconnect: (id: string) => post<ConnectionData>(`/connections/${id}/disconnect`),

  rules: () => get<{ rules: Rule[] }>('/rules'),
  revokeRule: (id: string) => del<{ ok: true }>(`/rules/${id}`),

  search: (q: string) => get<{ hits: PaletteHit[] }>(`/search?q=${encodeURIComponent(q)}`),
};

export type Adapter = typeof adapter;

/**
 * Follow one conversation. Durable events are replayed on reconnect from the
 * `after` cursor; a break yields a gap so the transcript can say text may be
 * missing rather than stitching two halves together.
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
      const response = await fetch(
        `${base}/surfaces/conversations/${encodeURIComponent(id)}/events?after=${cursor}`,
        {
          headers: {
            accept: 'text/event-stream',
            ...(cursor > 0 ? { 'last-event-id': String(cursor) } : {}),
          },
          credentials: 'include',
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
        let event: ConversationEvent;
        try {
          event = JSON.parse(frame.data) as ConversationEvent;
        } catch {
          continue;
        }
        if (typeof event.seq !== 'number') continue;
        if (event.seq <= cursor) continue;
        if (cursor > 0 && event.seq > cursor + 1) {
          yield { type: 'gap', gap: { after: cursor, next: event.seq, reason: 'sequence_skip' } };
        }
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
