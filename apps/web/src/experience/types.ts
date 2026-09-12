/**
 * The shapes the interface renders, derived from the generated client types
 * for the experience contract (packages/contracts/src/experience.ts, through
 * packages/client/src/schema.d.ts). Nothing here is hand-written: change the
 * contract, regenerate the client, and these names follow or stop compiling.
 *
 * The interface shows outcomes, receipts and the one decision only the person
 * can make. Nothing in the contract carries a tool name, a model name, a token
 * count or a log line, and nothing here adds one.
 */
import type { paths } from '@melete/client';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<P, M extends keyof P> = P[M] extends { responses: infer R }
  ? R extends Record<200, unknown>
    ? Json<R[200]>
    : R extends Record<201, unknown>
      ? Json<R[201]>
      : never
  : never;
type Body<P, M extends keyof P> = P[M] extends { requestBody?: infer B }
  ? Json<NonNullable<B>>
  : never;

/** A response that says the capability is not connected, with a plain reason. */
export type NotAvailable = { status: 'not_available'; reason: string };
export type Success<T> = Exclude<T, NotAvailable>;
export const isNotAvailable = (value: unknown): value is NotAvailable =>
  typeof value === 'object' &&
  value !== null &&
  (value as { status?: unknown }).status === 'not_available';

/* ---------- conversations ---------- */

export type Conversation = Success<Ok<paths['/conversations/{id}'], 'get'>>['conversation'];
export type TurnStatus = Conversation['status'];
export type ComposerState = Conversation['composer'];
export type ConversationCreate = Body<paths['/conversations'], 'post'>;
export type Turn = Success<Ok<paths['/conversations/{id}/messages'], 'get'>>['turns'][number];
export type DeliveryState = NonNullable<Turn['delivery']>;
export type MessageAcceptance = Success<Ok<paths['/conversations/{id}/messages'], 'post'>>;
export type ExperienceEvent = Success<
  Ok<paths['/conversations/{id}/events'], 'get'>
>['events'][number];
export type EventItem = ExperienceEvent['item'];
export type TrailStep = Extract<EventItem, { type: 'say' | 'action' | 'note' | 'done' }>;
export type Source = Extract<EventItem, { type: 'action' }>['sources'][number];
export type ResultCard = Success<Ok<paths['/conversations/{id}/cards'], 'get'>>['cards'][number];
export type CardAction = NonNullable<ResultCard['primary_action']>;
export type Receipt = Success<Ok<paths['/conversations/{id}/receipts'], 'get'>>['receipts'][number];
export type Draft = Success<Ok<paths['/conversations/{id}/drafts'], 'get'>>['drafts'][number];
export type SendOutcome = Success<Ok<paths['/drafts/{id}/send'], 'post'>>;
export type Permission = Success<Ok<paths['/permissions'], 'get'>>['permissions'][number];
export type PermissionOption = Permission['options'][number];
export type PermissionDecision = Body<paths['/permissions/{id}'], 'post'>;
export type RuleBounds = Extract<PermissionDecision, { option: 'always' }>['bounds'];
export type PermissionOutcome = Success<Ok<paths['/permissions/{id}'], 'post'>>;
export type Rule = Success<Ok<paths['/rules'], 'get'>>['rules'][number];
export type Question = Success<Ok<paths['/quick-answers'], 'get'>>['questions'][number];

/* ---------- agents, memory ---------- */

export type Agent = Success<Ok<paths['/agents'], 'get'>>['agents'][number];
export type AgentInput = Body<paths['/agents'], 'post'>;
export type AgentTemplate = Success<Ok<paths['/agents/templates'], 'get'>>['templates'][number];
export type MemoryItem = Success<Ok<paths['/memory/items'], 'get'>>['items'][number];
export type MemoryExplanation = Success<Ok<paths['/memory/items/{id}/why'], 'get'>>;

/* ---------- plans, tasks, home, routines ---------- */

export type Plan = Success<Ok<paths['/plans/{id}'], 'get'>>['plan'];
export type Milestone = Plan['milestones'][number];
export type PlanCreate = Body<paths['/plans'], 'post'>;
export type Task = Success<Ok<paths['/tasks'], 'get'>>['tasks'][number];
export type TaskInput = Body<paths['/tasks'], 'post'>;
export type Home = Success<Ok<paths['/home'], 'get'>>;
export type CalendarEvent = Success<Home['upcoming']>[number];
export type Profile = Success<Ok<paths['/profile'], 'get'>>['profile'];
export type Automation = Success<Ok<paths['/automations'], 'get'>>['automations'][number];
export type AutomationRun = Automation['runs'][number];
export type AutomationCreate = Body<paths['/automations'], 'post'>;
export type Connection = Success<
  Ok<paths['/experience/connections'], 'get'>
>['connections'][number];
export type BrowserSession = Success<Ok<paths['/browser/sessions/{id}'], 'get'>>['session'];
export type SearchResult = Success<Ok<paths['/search'], 'get'>>['results'][number];
/**
 * An entry in the broker's action ledger. The interface reads it only for
 * effects resting at `unknown` or `unresolved`, and never shows its `kind`.
 */
export type LedgerAction = Ok<paths['/actions'], 'get'>['actions'][number];
export type ActionResolution = Body<paths['/actions/{actionId}/resolve'], 'post'>['resolution'];

/* ---------- what the interface decides on its own ---------- */

/**
 * Which surfaces exist on this instance. Nothing in the contract lists them;
 * each is learned from the one call that would serve it answering
 * not_available, and a surface whose call is unavailable is not drawn.
 */
export type Capabilities = {
  calendar: boolean;
  browser: boolean;
  google_sign_in: boolean;
  apple_sign_in: boolean;
  magic_link: boolean;
};

export type TourStage = 'calendar' | 'drafting' | 'browser' | 'plans' | 'memory';
