/**
 * Friendly names for the shapes the API returns.
 *
 * The entities a client handles most carry real component names now, but most
 * other shared shapes are still hoisted anonymously (`__schema0`), and those
 * names are positional: adding a path renumbers shapes that did not change. So
 * every alias here is derived from the path that returns it rather than from a
 * component name. That keeps the names readable without hand-writing a second
 * copy of the contract: change the document and these aliases change with it,
 * or stop compiling.
 */
import type { components, paths } from './schema.d.ts';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

type Ok<P, M extends keyof P> = P[M] extends { responses: infer R }
  ? R extends Record<200 | 201 | 202, unknown>
    ? Json<R[200] | R[201] | R[202]>
    : R extends Record<200 | 201, unknown>
      ? Json<R[200] | R[201]>
      : R extends Record<200, unknown>
        ? Json<R[200]>
        : R extends Record<201, unknown>
          ? Json<R[201]>
          : never
  : never;

type Body<P, M extends keyof P> = P[M] extends { requestBody?: infer B }
  ? Json<NonNullable<B>>
  : never;

export type Health = Ok<paths['/health'], 'get'>;

export type Space = Ok<paths['/spaces'], 'get'>['spaces'][number];

export type Job = Ok<paths['/jobs/{jobId}'], 'get'>['job'];
export type JobState = Job['state'];
export type JobWait = Job['wait'];
export type CreateJobBody = Body<paths['/jobs'], 'post'>;
export type JobListQuery = NonNullable<paths['/jobs']['get']['parameters']['query']>;

export type Attempt = Ok<paths['/attempts/{attemptId}'], 'get'>['attempt'];

export type Action = Ok<paths['/actions/{actionId}'], 'get'>['action'];
export type ActionStatus = Action['status'];
export type EffectClass = Action['effect_class'];
export type ActionListQuery = NonNullable<paths['/actions']['get']['parameters']['query']>;
export type ResolveActionBody = Body<paths['/actions/{actionId}/resolve'], 'post'>;

export type Approval = Ok<paths['/approvals'], 'get'>['approvals'][number];
export type ApprovalDecisionBody = Body<paths['/approvals/{approvalId}'], 'post'>;
export type ApprovalDecisionResult = Ok<paths['/approvals/{approvalId}'], 'post'>;

export type Connection = Ok<paths['/connections/{connectionId}'], 'get'>['connection'];

export type KnowledgeHit = Ok<paths['/knowledge/search'], 'get'>['hits'][number];
export type KnowledgeRecord = Ok<paths['/knowledge/{recordId}'], 'get'>;
export type RetractKnowledgeBody = Body<paths['/knowledge/{recordId}'], 'delete'>;
export type ProposeKnowledgeBody = Body<paths['/knowledge/proposals'], 'post'>;
export type ProposeKnowledgeResult = Ok<paths['/knowledge/proposals'], 'post'>;

export type Skill = Ok<paths['/skills'], 'get'>['skills'][number];

export type EventPage = Ok<paths['/events'], 'get'>;
/** One row of the persisted event table, as the JSON endpoints return it. */
export type StoredEvent = EventPage['events'][number];
export type EventType = StoredEvent['type'];

export type ApiError = {
  error: { code: string; message: string; detail?: Record<string, unknown> };
};

export type { components, paths };
