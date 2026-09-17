/**
 * The HTTP surface. Melete is API-first: every capability the web client has,
 * a script has too, and the OpenAPI document is generated from exactly these
 * schemas so the two can never drift.
 */
import { z } from 'zod';
import { actionStatus, approvalRequestView, effectClass, payloadHash } from './broker.ts';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import { originWarnings } from './effects.ts';
import { action, attempt, job, jobBudget, jobConstraints, space } from './entities.ts';
import {
  knowledgeFrontmatter,
  knowledgeRecordStatus,
  knowledgeType,
  proposedWrite,
} from './knowledge.ts';
import { jobLearningScope } from './learning.ts';
import { skillFrontmatter } from './skills.ts';

export const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  /** Present once the service has a database; absent in the skeleton. */
  database: z.enum(['ok', 'unreachable', 'not_configured']),
  runtime_adapter: z.string().optional(),
  runtime_supervisor: z.enum(['process', 'docker']).nullable().optional(),
  time: timestamp,
});
export type HealthResponse = z.infer<typeof healthResponse>;

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

// --------------------------------------------------------------------------
// spaces
// --------------------------------------------------------------------------

export const createSpaceRequest = z.object({
  name: z.string().min(1).max(120),
});
export const spaceListResponse = z.object({ spaces: z.array(space) });

// --------------------------------------------------------------------------
// jobs
// --------------------------------------------------------------------------

export const createJobRequest = z.object({
  space_id: prefixedId(ID_PREFIXES.space),
  title: z.string().min(1).max(200),
  objective: z.string().min(1),
  constraints: jobConstraints.partial().optional(),
  budget: jobBudget.partial().optional(),
  /** Optional procedure scope is registered atomically before any attempt can claim the job. */
  learning: jobLearningScope.optional(),
});
export type CreateJobRequest = z.infer<typeof createJobRequest>;

export const jobListQuery = z.object({
  space_id: prefixedId(ID_PREFIXES.space).optional(),
  state: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const jobListResponse = z.object({ jobs: z.array(job) });
export const jobResponse = z.object({ job });

export const postMessageRequest = z.object({
  text: z.string().min(1),
});

export const cancelJobRequest = z.object({
  reason: z.string().max(500).optional(),
});

// --------------------------------------------------------------------------
// attempts, actions
// --------------------------------------------------------------------------

export const attemptListResponse = z.object({ attempts: z.array(attempt) });
export const attemptResponse = z.object({ attempt });

export const actionListQuery = z.object({
  job_id: prefixedId(ID_PREFIXES.job).optional(),
  status: actionStatus.optional(),
  effect_class: effectClass.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export const actionListResponse = z.object({ actions: z.array(action) });
export const actionResponse = z.object({ action });

/** Used when an action came back `unknown` and a person settles it by hand. */
export const resolveActionRequest = z.object({
  resolution: z.enum(['succeeded', 'failed', 'unresolved']),
  note: z.string().max(2000).optional(),
});

// --------------------------------------------------------------------------
// approvals
// --------------------------------------------------------------------------

/**
 * The approval request as the client renders it, plus the doubts that made it
 * worth asking. A screen that shows an address without saying it came from a
 * web page is asking the person to approve something they cannot see.
 */
export const approvalRequestWithOrigin = approvalRequestView.extend({
  origin_warnings: originWarnings.default([]),
});
export type ApprovalRequestWithOrigin = z.infer<typeof approvalRequestWithOrigin>;

export const approvalListResponse = z.object({ approvals: z.array(approvalRequestWithOrigin) });
export const approvalDecisionResponse = z.object({
  approval_id: prefixedId(ID_PREFIXES.approval),
  action_id: prefixedId(ID_PREFIXES.action),
  decision: z.enum(['approved', 'denied']),
  payload_hash: payloadHash,
  decided_at: timestamp,
});

// --------------------------------------------------------------------------
// knowledge
// --------------------------------------------------------------------------

export const knowledgeSearchQuery = z.object({
  space_id: prefixedId(ID_PREFIXES.space),
  q: z.string().min(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
  include_retracted: z.coerce.boolean().default(false),
});

export const knowledgeHit = z.object({
  id: prefixedId(ID_PREFIXES.knowledge),
  path: z.string(),
  title: z.string(),
  excerpt: z.string(),
  status: knowledgeRecordStatus,
  score: z.number(),
});
export const knowledgeSearchResponse = z.object({ hits: z.array(knowledgeHit) });

/**
 * The catalog of one space. Search answers a question; nothing else could show a
 * caller what is actually in the space, which is why listing is its own
 * operation rather than a search with an empty query.
 */
export const knowledgeListEntry = z.object({
  id: prefixedId(ID_PREFIXES.knowledge),
  path: z.string(),
  title: z.string(),
  type: knowledgeType,
  status: knowledgeRecordStatus,
  tags: z.array(z.string()),
  updated: z.string(),
});
export const knowledgeListQuery = z.object({
  space_id: prefixedId(ID_PREFIXES.space).optional(),
});
export const knowledgeListResponse = z.object({ records: z.array(knowledgeListEntry) });

export const knowledgeRecordResponse = z.object({
  id: prefixedId(ID_PREFIXES.knowledge),
  path: z.string(),
  frontmatter: knowledgeFrontmatter,
  body: z.string(),
});

export const proposeKnowledgeRequest = proposedWrite;
export const proposeKnowledgeResponse = z.object({
  proposal_id: z.string(),
  path: z.string(),
  diff: z.string(),
});

export const retractKnowledgeRequest = z.object({
  reason: z.string().min(1).max(500),
  /** Hard delete removes the file and rebuilds the index in the same operation. */
  hard_delete: z.boolean().default(false),
});

// --------------------------------------------------------------------------
// skills
// --------------------------------------------------------------------------

export const skillListResponse = z.object({
  skills: z.array(
    z.object({
      id: prefixedId(ID_PREFIXES.skill),
      space_id: prefixedId(ID_PREFIXES.space).nullable(),
      path: z.string(),
      enabled: z.boolean(),
      frontmatter: skillFrontmatter,
    }),
  ),
});
