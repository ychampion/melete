/**
 * The OpenAPI 3.1 document for the v0.1 HTTP surface, generated from the same
 * Zod schemas the service validates with. `bun run openapi` writes it to
 * openapi.json and a test fails if the committed file drifts.
 */
import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import {
  actionListQuery,
  actionListResponse,
  actionResponse,
  approvalDecisionResponse,
  approvalListResponse,
  attemptListResponse,
  attemptResponse,
  cancelJobRequest,
  createSpaceRequest,
  credentialsRequest,
  errorResponse,
  eventDeliveryRequest,
  eventDeliveryResponse,
  healthResponse,
  jobListQuery,
  jobListResponse,
  jobResponse,
  knowledgeListQuery,
  knowledgeListResponse,
  knowledgeRecordResponse,
  knowledgeSearchQuery,
  knowledgeSearchResponse,
  ownerResponse,
  postMessageRequest,
  proposeKnowledgeRequest,
  proposeKnowledgeResponse,
  resolveActionRequest,
  retractKnowledgeRequest,
  skillListResponse,
  spaceListResponse,
  triggerResponse,
} from './api.ts';
import { approvalDecisionRequest } from './broker.ts';
import { browserControlResponse, browserSiteForgotten, browserSiteList } from './browser.ts';
import {
  liveClose,
  liveClosed,
  liveId,
  liveInputResponse,
  liveOpen,
  liveScope,
  liveScopeResponse,
  liveUp,
} from './browser-live.ts';
import { company, companyMap, ledgerItem } from './companies.ts';
import {
  connectionCheckResponse,
  connectionKindListResponse,
  connectionListResponse,
  connectionResponse,
  createConnectionRequest,
} from './connections.ts';
import { space, triggerSpec } from './entities.ts';
import { eventPage, eventQuery } from './events.ts';
import { executionSettlement, executionStartResponse } from './execution-admission.ts';
import { experiencePaths } from './experience-openapi.ts';
import { hookObservation } from './hooks.ts';
import {
  episodeListResponse,
  interventionRequest,
  interventionResponse,
  jobLearningScope,
  learningDeletionResponse,
  learningScopeResponse,
  learningSpaceQuery,
  learningSpaceRequest,
  procedureActivationRequest,
  procedureInspection,
  procedureListResponse,
  procedureReasonRequest,
  procedureResponse,
  procedureTrialRequest,
} from './learning.ts';
import {
  claimHistoryResponse,
  claimListResponse,
  claimRevision,
  correctionRequest,
  forgetRequest,
  ingestSourceRequest,
  ingestSourceResponse,
  knowledgeProposalList,
  knowledgeProposalView,
  memoryOperationResponse,
  ownerKnowledgeEdit,
  recallRequest,
  recallResult,
  sourceEvidenceResponse,
} from './memory.ts';
import {
  createPrincipalRequest,
  createSharedSpaceRequest,
  grantMembershipRequest,
  principal,
  spaceMembership,
} from './principals.ts';
import {
  attributionReport,
  attributionRequest,
  contradictionList,
  memoryOwnerQuestionList,
  outputAttribution,
  outputAttributionResponse,
  rejectedProposalList,
  repairBriefList,
  trustRequest,
  trustResolution,
} from './provenance.ts';
import { personReactionRequest, reactionListResponse, reactionResponse } from './reactions.ts';
import { jobRepairsResponse } from './repair.ts';
import {
  backgroundOperation,
  connectionGeneration,
  connectionLifecycle,
  createResponsibilityRequest,
  jobScheduling,
  notification,
  notificationDelivery,
  notificationList,
  operationList,
  operationRearm,
  operationRegistration,
  operationSettlement,
  operationVersion,
  policyChange,
  policyGeneration,
  questionAnswerRequest,
  questionAnswerResponse,
  questionList,
  replyObligation,
  replyObligationList,
  responsibilityJob,
  responsibilitySnapshot,
  responsibilitySubmissionResponse,
  submissionId,
  submissionResponse,
} from './responsibility.ts';
import { runtimeEvent } from './runtime.ts';
import {
  deleteSpaceRequest,
  spaceRemoval,
  spaceRemovalPreview,
  spaceRemovalReport,
} from './spaces.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});

const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});

const problem = (description: string) => jsonResponse(description, errorResponse);

const idParam = (name: string, description: string) => ({
  path: z.object({ [name]: z.string().meta({ description }) }),
});

/** A refusal that says when to try again. */
const rateLimited = (description: string) => ({
  ...problem(description),
  headers: z.object({
    'Retry-After': z.string().meta({ description: 'Seconds to wait before the next attempt' }),
  }),
});

/**
 * How a job or an input is admitted. The answer is a durable receipt, and a
 * request retried with the same Idempotency-Key gets the first answer again
 * instead of a second job or input.
 */
const admission = <T extends z.ZodType>(
  accepted: '200' | '201',
  schema: T,
  missing: string,
  path?: z.ZodObject,
) => ({
  requestParams: {
    ...(path ? { path } : {}),
    header: z.object({
      'Idempotency-Key': submissionId.optional().meta({
        description:
          'The submission id. The same key with the same input returns the first answer; with ' +
          'different input it is refused with 409. Left out, the service chooses one, returned in ' +
          'the receipt.',
      }),
    }),
  },
  responses: {
    [accepted]: jsonResponse('Accepted, or the same key and input submitted again', schema),
    ...(accepted === '201'
      ? { '200': jsonResponse('A retried submission whose first status was not recorded', schema) }
      : {}),
    '400': jsonResponse(
      'The input or the Idempotency-Key is invalid; a rejected input still has a receipt',
      z.union([schema, errorResponse]),
    ),
    '403': jsonResponse(
      'The space or job is not accessible, recorded as a rejected submission; a retried key ' +
        'whose history belongs to another account answers with an error body alone',
      z.union([schema, errorResponse]),
    ),
    '404': jsonResponse(missing, schema),
    '409': jsonResponse(
      'The key was used for different input, or the job cannot take this now',
      schema,
    ),
    '503': jsonResponse(
      'The acceptance history of this key cannot be verified; reusing it admits nothing new',
      schema,
    ),
  },
});

export const OPENAPI_VERSION = '0.1.0-pre';

export function buildOpenApiDocument() {
  return createDocument(
    {
      openapi: '3.1.0',
      info: {
        title: 'Melete',
        version: OPENAPI_VERSION,
        summary: 'An open-source, self-hosted, model-agnostic personal assistant.',
        description:
          'Give Melete a responsibility, close the tab, come back to progress, a result, or one precise question. ' +
          'This document describes the v0.1 HTTP surface. Nothing here is stable yet: the release is pre-release ' +
          'and endpoints may change until v0.1.0 is tagged.',
        license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      },
      servers: [{ url: 'http://localhost:8787', description: 'Default self-hosted address' }],
      components: {
        securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'melete_session' } },
        schemas: { RuntimeEvent: runtimeEvent, HookObservation: hookObservation },
      },
      tags: [
        { name: 'health' },
        { name: 'account' },
        { name: 'spaces' },
        { name: 'jobs' },
        { name: 'attempts' },
        { name: 'events' },
        { name: 'reactions' },
        { name: 'actions' },
        { name: 'artifacts' },
        { name: 'approvals' },
        { name: 'connections' },
        { name: 'knowledge' },
        { name: 'skills' },
        { name: 'memory' },
        { name: 'browser' },
        { name: 'learning' },
        { name: 'companies' },
      ],
      paths: {
        '/episodes': {
          get: {
            tags: ['learning'],
            summary: 'List unexpired episode evidence in one owned space',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Episodes', episodeListResponse) },
          },
        },
        '/episodes/{id}': {
          delete: {
            tags: ['learning'],
            summary: 'Remove episode evidence and dependent procedures',
            requestParams: { ...idParam('id', 'Episode id'), query: learningSpaceQuery },
            responses: { '200': jsonResponse('Deleted', learningDeletionResponse) },
          },
        },
        '/jobs/{id}/learning-scope': {
          put: {
            tags: ['learning'],
            summary: 'Register procedure scope before a job attempt begins',
            requestParams: idParam('id', 'Job id'),
            requestBody: json(jobLearningScope),
            responses: { '200': jsonResponse('Scope', learningScopeResponse) },
          },
        },
        '/jobs/{id}/interventions': {
          post: {
            tags: ['learning'],
            summary: 'Record and apply an owner correction or demonstration',
            requestParams: idParam('id', 'Job id'),
            requestBody: json(interventionRequest),
            responses: { '201': jsonResponse('Intervention episode', interventionResponse) },
          },
        },
        '/episodes/{id}/propose': {
          post: {
            tags: ['learning'],
            summary: 'Generate one bounded candidate from corrected evidence',
            requestParams: idParam('id', 'Episode id'),
            requestBody: json(learningSpaceRequest),
            responses: { '201': jsonResponse('Candidate', procedureResponse) },
          },
        },
        '/procedures': {
          get: {
            tags: ['learning'],
            summary: 'List scoped procedures including qualified rejection history',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Procedures', procedureListResponse) },
          },
        },
        '/procedures/{id}': {
          get: {
            tags: ['learning'],
            summary: 'Inspect procedure history and evaluation costs',
            requestParams: { ...idParam('id', 'Procedure id'), query: learningSpaceQuery },
            responses: { '200': jsonResponse('Procedure evidence summary', procedureInspection) },
          },
        },
        '/procedures/{id}/evaluate': {
          post: {
            tags: ['learning'],
            summary: 'Run bounded validation and then sealed final evaluation',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Evaluation result', procedureInspection) },
          },
        },
        '/procedures/{id}/canary': {
          post: {
            tags: ['learning'],
            summary: 'Enable a passing procedure in its origin space',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Canary procedure', procedureResponse) },
          },
        },
        '/procedures/{id}/trial': {
          post: {
            tags: ['learning'],
            summary: 'Try a procedure privately after approving its exact definition',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(procedureTrialRequest),
            responses: { '200': jsonResponse('Procedure on owner trial', procedureResponse) },
          },
        },
        '/procedures/{id}/activate': {
          post: {
            tags: ['learning'],
            summary:
              'Activate after a private canary with explicit private or shared-space delivery',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(procedureActivationRequest),
            responses: { '200': jsonResponse('Active procedure', procedureResponse) },
          },
        },
        '/procedures/{id}/reject': {
          post: {
            tags: ['learning'],
            summary: 'Keep a candidate as rejected history with an owner reason',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(procedureReasonRequest),
            responses: { '200': jsonResponse('Rejected history', procedureResponse) },
          },
        },
        '/procedures/{id}/rollback': {
          post: {
            tags: ['learning'],
            summary: 'Revert delivery of a canary or active procedure',
            requestParams: idParam('id', 'Procedure id'),
            requestBody: json(procedureReasonRequest),
            responses: { '200': jsonResponse('Reverted procedure', procedureResponse) },
          },
        },
        '/principals': {
          post: {
            tags: ['spaces'],
            summary: 'Provision an additional account as the setup owner',
            requestBody: json(createPrincipalRequest),
            responses: {
              '201': jsonResponse('Principal created', z.object({ principal })),
              '403': problem('Setup owner required'),
              '409': problem('Email already registered'),
            },
          },
        },
        '/spaces/shared': {
          post: {
            tags: ['spaces'],
            summary: 'Create a shared space owned by the authenticated principal',
            requestBody: json(createSharedSpaceRequest),
            responses: { '201': jsonResponse('Shared space created', z.object({ space })) },
          },
        },
        '/spaces/{id}/memberships': {
          post: {
            tags: ['spaces'],
            summary: 'Grant membership or regrant with a fresh generation',
            requestParams: idParam('id', 'Shared space id'),
            requestBody: json(grantMembershipRequest),
            responses: {
              '201': jsonResponse('Membership', z.object({ membership: spaceMembership })),
              '403': problem('Space owner required'),
            },
          },
        },
        '/spaces/{id}/memberships/{principalId}': {
          delete: {
            tags: ['spaces'],
            summary: 'Revoke membership, advance context generation and fence work',
            requestParams: { path: z.object({ id: z.string(), principalId: z.string() }) },
            responses: {
              '200': jsonResponse(
                'Membership revoked',
                z.object({
                  membership: spaceMembership,
                  policy_generation: z.number().int().nonnegative(),
                }),
              ),
              '403': problem('Space owner required'),
            },
          },
        },
        '/spaces/{id}': {
          delete: {
            tags: ['spaces'],
            summary: 'Remove a space, or empty a personal one',
            description:
              'The name must be typed exactly as it is shown. The space is closed at once, in ' +
              'this request; everything in it is then cleared in the background, and the removal ' +
              'is complete only after a final count finds nothing left. A personal space keeps ' +
              'its id and is emptied. Asking again while a removal runs returns that removal.',
            requestParams: idParam('id', 'Space id'),
            requestBody: json(deleteSpaceRequest),
            responses: {
              '202': jsonResponse('Removal started', z.object({ removal: spaceRemoval })),
              '400': problem('The name does not match the space'),
              '403': problem('Space owner required'),
              '404': problem('No such space'),
            },
          },
        },
        '/spaces/{id}/removal/preview': {
          get: {
            tags: ['spaces'],
            summary: 'What removing a space clears, what it does not reach, and the name to type',
            requestParams: idParam('id', 'Space id'),
            responses: {
              '200': jsonResponse('Preview', z.object({ preview: spaceRemovalPreview })),
              '403': problem('Space owner required'),
              '404': problem('No such space'),
            },
          },
        },
        '/spaces/{id}/removal': {
          get: {
            tags: ['spaces'],
            summary: 'How far the removal of a space has got',
            requestParams: idParam('id', 'Space id'),
            responses: {
              '200': jsonResponse(
                'Removal and its account so far',
                z.object({ removal: spaceRemoval, report: spaceRemovalReport }),
              ),
              '403': problem('Space owner required'),
              '404': problem('This space is not being removed'),
            },
          },
        },
        '/removals/{id}': {
          get: {
            tags: ['spaces'],
            summary: 'A removal, including one whose space is gone',
            description: 'Answered only to the person who asked for the removal.',
            requestParams: idParam('id', 'Removal id'),
            responses: {
              '200': jsonResponse(
                'Removal and its account',
                z.object({ removal: spaceRemoval, report: spaceRemovalReport }),
              ),
              '404': problem('Removal not found'),
            },
          },
        },
        ...experiencePaths(),
        '/responsibilities': {
          post: {
            tags: ['jobs'],
            summary: 'Accept a responsibility with scheduling and attention preferences',
            requestBody: json(createResponsibilityRequest),
            ...admission('201', responsibilitySubmissionResponse, 'No such space'),
          },
        },
        '/jobs/{id}/responsibility': {
          get: {
            tags: ['jobs'],
            summary: 'Read visible responsibility status and attention',
            requestParams: idParam('id', 'Job id'),
            responses: { '200': jsonResponse('Responsibility', responsibilityJob) },
          },
        },
        '/jobs/{id}/scheduling': {
          post: {
            tags: ['jobs'],
            summary: 'Choose scheduling class, importance and unread threshold',
            requestParams: idParam('id', 'Job id'),
            requestBody: json(jobScheduling),
            responses: { '200': jsonResponse('Updated responsibility', responsibilityJob) },
          },
        },
        '/jobs/{id}/read': {
          post: {
            tags: ['jobs'],
            summary: 'Mark results read and restore the normal checking frequency',
            requestParams: idParam('id', 'Job id'),
            responses: { '200': jsonResponse('Read', responsibilityJob) },
          },
        },
        '/questions': {
          get: {
            tags: ['jobs'],
            summary: 'Read the one owner question queue across every responsibility',
            description:
              'One entry per responsibility, ordered by what blocks an external effect, then ' +
              'the nearest deadline, then the oldest. Each entry carries why it is being asked ' +
              'and what happens if it is ignored.',
            responses: { '200': jsonResponse('Open questions', questionList) },
          },
        },
        '/questions/{id}/answer': {
          post: {
            tags: ['jobs'],
            summary: 'Answer one question and wake the responsibility that asked it',
            requestParams: idParam('id', 'Question id'),
            requestBody: json(questionAnswerRequest),
            responses: {
              '200': jsonResponse('Answer delivered as input', questionAnswerResponse),
              '409': problem('The question is no longer open'),
            },
          },
        },
        '/connections/{id}/lifecycle': {
          post: {
            tags: ['connections'],
            summary: 'Switch or revoke credentials and fence previous context generations',
            requestParams: idParam('id', 'Connection id'),
            requestBody: json(connectionLifecycle),
            responses: {
              '200': jsonResponse('New generation', connectionGeneration),
              '409': problem('Generation changed'),
            },
          },
        },
        '/spaces/{id}/policy-generation': {
          post: {
            tags: ['spaces'],
            summary: 'Advance policy and restart attempts with fresh context',
            requestParams: idParam('id', 'Space id'),
            requestBody: json(policyChange),
            responses: {
              '200': jsonResponse('Policy generation', policyGeneration),
              '409': problem('Generation changed'),
            },
          },
        },
        '/jobs/{id}/snapshot': {
          get: {
            tags: ['events'],
            summary: 'Current job and external-effect truth at one event cursor',
            requestParams: idParam('id', 'Job id'),
            responses: { '200': jsonResponse('Snapshot', responsibilitySnapshot) },
          },
        },
        '/snapshot': {
          get: {
            tags: ['events'],
            summary: 'Current state for an explicit event-stream resync',
            responses: { '200': jsonResponse('Snapshot', responsibilitySnapshot) },
          },
        },
        '/operations': {
          get: {
            tags: ['jobs'],
            summary: 'List durable background operations and their recovery dispositions',
            responses: { '200': jsonResponse('Operations', operationList) },
          },
        },
        '/jobs/{id}/operations': {
          post: {
            tags: ['jobs'],
            summary: 'Register a durable timer, remote reference or local process',
            requestParams: idParam('id', 'Job id'),
            requestBody: json(operationRegistration),
            responses: {
              '201': jsonResponse('Registered', backgroundOperation),
              '409': problem('Operation key conflict'),
            },
          },
        },
        '/operations/{id}/claim': {
          post: {
            tags: ['jobs'],
            summary: 'Claim ready operation work',
            requestParams: idParam('id', 'Operation id'),
            requestBody: json(operationVersion),
            responses: {
              '200': jsonResponse('Claimed', backgroundOperation),
              '409': problem('Stale operation'),
            },
          },
        },
        '/operations/{id}/rearm': {
          post: {
            tags: ['jobs'],
            summary: 'Rearm a currently owned live operation',
            requestParams: idParam('id', 'Operation id'),
            requestBody: json(operationRearm),
            responses: {
              '200': jsonResponse('Registered', backgroundOperation),
              '409': problem('Stale operation'),
            },
          },
        },
        '/operations/{id}/settle': {
          post: {
            tags: ['jobs'],
            summary: 'Persist an operation result',
            requestParams: idParam('id', 'Operation id'),
            requestBody: json(operationSettlement),
            responses: {
              '200': jsonResponse('Settled', backgroundOperation),
              '409': problem('Stale operation'),
            },
          },
        },
        '/reply-obligations': {
          get: {
            tags: ['jobs'],
            summary: 'List replies still owed to the owner',
            responses: {
              '200': jsonResponse('Outstanding reply obligations', replyObligationList),
            },
          },
        },
        '/reply-obligations/{id}/acknowledge': {
          post: {
            tags: ['jobs'],
            summary: 'Acknowledge acceptance without claiming reply delivery',
            requestParams: idParam('id', 'Reply obligation ID'),
            responses: { '200': jsonResponse('Acknowledged obligation', replyObligation) },
          },
        },
        '/notifications': {
          get: {
            tags: ['events'],
            summary: 'Read the pending notification outbox',
            responses: { '200': jsonResponse('Pending deliveries', notificationList) },
          },
        },
        '/notifications/{id}/attempt': {
          post: {
            tags: ['events'],
            summary: 'Record a notification delivery attempt',
            requestParams: idParam('id', 'Notification ID'),
            responses: { '200': jsonResponse('Delivery attempt', notification) },
          },
        },
        '/notifications/{id}/delivered': {
          post: {
            tags: ['events'],
            summary: 'Acknowledge delivery of the exact notification content',
            requestParams: idParam('id', 'Notification ID'),
            requestBody: json(notificationDelivery),
            responses: { '200': jsonResponse('Delivered notification', notification) },
          },
        },
        '/submissions/{id}': {
          get: {
            tags: ['jobs'],
            summary: 'Look up a durable submission receipt after losing a reply',
            requestParams: idParam('id', 'Client idempotency key or server ULID'),
            responses: {
              '200': jsonResponse(
                'Acceptance, rejection, or unknown durability',
                submissionResponse,
              ),
            },
          },
        },
        '/jobs/{id}/input': {
          post: {
            tags: ['jobs'],
            summary: 'Submit an input once and receive its durable receipt',
            requestBody: json(postMessageRequest),
            ...admission(
              '200',
              responsibilitySubmissionResponse,
              'No such job',
              idParam('id', 'Job ID').path,
            ),
          },
        },
        '/memory/sources': {
          post: {
            tags: ['memory'],
            summary: 'Persist authenticated evidence and durable extraction work',
            requestBody: json(ingestSourceRequest),
            responses: {
              '201': jsonResponse('Committed stream sequence', ingestSourceResponse),
              '400': problem('Invalid evidence'),
              '403': problem('Scope denied'),
            },
          },
        },
        '/memory/recall': {
          post: {
            tags: ['memory'],
            summary: 'Recall current or historical evidence in the authenticated audience',
            requestBody: json(recallRequest),
            responses: {
              '200': jsonResponse('Recall and coverage', recallResult),
              '403': problem('Scope denied'),
            },
          },
        },
        '/memory/corrections': {
          post: {
            tags: ['memory'],
            summary: 'Immediately publish a protected owner correction',
            requestBody: json(correctionRequest),
            responses: {
              '200': jsonResponse('Protected revision', claimRevision),
              '409': problem('Stale revision'),
            },
          },
        },
        '/memory/forget': {
          post: {
            tags: ['memory'],
            summary: 'Suppress memory use and automatic reconstruction from covered evidence',
            requestBody: json(forgetRequest),
            responses: {
              '200': jsonResponse('Restriction and cleanup state', memoryOperationResponse),
            },
          },
        },
        '/memory/sources/{id}': {
          get: {
            tags: ['memory'],
            summary: 'Inspect accessible source evidence with suppressed spans masked',
            requestParams: idParam('id', 'Source id'),
            responses: {
              '200': jsonResponse('Source evidence', sourceEvidenceResponse),
              '404': problem('No accessible source'),
            },
          },
          delete: {
            tags: ['memory'],
            summary: 'Delete an imported source and invalidate its descendants',
            requestParams: idParam('id', 'Source id'),
            responses: {
              '200': jsonResponse('Restriction and cleanup state', memoryOperationResponse),
              '404': problem('No such source'),
            },
          },
        },
        '/memory/claims': {
          get: {
            tags: ['memory'],
            summary: 'Inspect current claims and their support',
            responses: { '200': jsonResponse('Claims', claimListResponse) },
          },
        },
        '/memory/claims/{id}/history': {
          get: {
            tags: ['memory'],
            summary: 'Inspect dated claim revisions and their support',
            requestParams: idParam('id', 'Claim id'),
            responses: {
              '200': jsonResponse('Claim history', claimHistoryResponse),
              '404': problem('No such claim'),
            },
          },
        },
        '/memory/outputs': {
          post: {
            tags: ['memory'],
            summary: 'Declare which recalled revisions an output used',
            description:
              'A draft, a plan step or a proposed action names the handles it used. A correction then ' +
              'invalidates exactly the outputs that cited the superseded revision, and an output with an ' +
              'empty manifest is recorded as unattributed and keeps the conservative rule.',
            requestBody: json(outputAttribution),
            responses: {
              '201': jsonResponse('Recorded attribution', outputAttributionResponse),
              '403': problem('Scope denied'),
            },
          },
        },
        '/memory/attribution': {
          post: {
            tags: ['memory'],
            summary: 'Report payload values that came from an uncited delivered item',
            description:
              'The check the broker runs before admitting a write_external or spend: any recipient, date, ' +
              'amount or identifier in the payload that appears in a delivered item whose handle is not in ' +
              'the manifest is reported.',
            requestBody: json(attributionRequest),
            responses: { '200': jsonResponse('Attribution findings', attributionReport) },
          },
        },
        '/memory/trust': {
          post: {
            tags: ['memory'],
            summary: 'Resolve the origin trust of each field of a canonical payload',
            requestBody: json(trustRequest),
            responses: { '200': jsonResponse('Per-field origin', trustResolution) },
          },
        },
        '/memory/questions': {
          get: {
            tags: ['memory'],
            summary: 'List queued owner questions about contradicted keys',
            responses: { '200': jsonResponse('Questions', memoryOwnerQuestionList) },
          },
        },
        '/memory/contradictions': {
          get: {
            tags: ['memory'],
            summary: 'List keys with more than one candidate head',
            responses: { '200': jsonResponse('Contradictions', contradictionList) },
          },
        },
        '/memory/rejections': {
          get: {
            tags: ['memory'],
            summary: 'List extraction proposals rejected by structural validation, with reasons',
            responses: { '200': jsonResponse('Rejected proposals', rejectedProposalList) },
          },
        },
        '/memory/jobs/{id}/repair-briefs': {
          get: {
            tags: ['memory'],
            summary: 'Read the repair briefs a correction wrote on a responsibility',
            requestParams: idParam('id', 'Job id'),
            responses: { '200': jsonResponse('Repair briefs', repairBriefList) },
          },
        },
        '/knowledge/proposals/{id}/apply': {
          post: {
            tags: ['knowledge'],
            summary: 'Validate and apply an owner-reviewed memory proposal',
            requestParams: idParam('id', 'Proposal id'),
            responses: {
              '200': jsonResponse('Applied proposal', knowledgeProposalView),
              '409': problem('Proposal is stale'),
            },
          },
        },
        '/knowledge/proposals/{id}': {
          delete: {
            tags: ['knowledge'],
            summary: 'Discard a pending proposal',
            requestParams: idParam('id', 'Proposal id'),
            responses: { '200': jsonResponse('Discarded proposal', knowledgeProposalView) },
          },
        },
        '/knowledge/{recordId}/edit': {
          post: {
            tags: ['knowledge'],
            summary: 'Ingest an owner edit as a protected correction',
            requestParams: idParam('recordId', 'Claim id'),
            requestBody: json(ownerKnowledgeEdit),
            responses: {
              '200': jsonResponse('Protected revision', claimRevision),
              '409': problem('Stale revision'),
            },
          },
        },
        '/health': {
          get: {
            tags: ['health'],
            summary: 'Liveness and dependency check',
            responses: { '200': jsonResponse('Service is up', healthResponse) },
          },
        },

        '/setup': {
          post: {
            tags: ['account'],
            summary: 'Create the owner, their personal space and a session, once',
            description:
              'Sets the melete_session cookie, and the melete_device cookie that marks this browser ' +
              'as known for sign-in limits. Once an owner exists the answer is 409 before anything ' +
              'is parsed.',
            requestBody: json(credentialsRequest),
            responses: {
              '201': jsonResponse('The owner, signed in', ownerResponse),
              '400': problem('An email and a password of 8 to 1024 characters are required'),
              '403': problem('The request came from another origin'),
              '409': problem('The owner is already set up'),
              '429': rateLimited('Too many setup attempts from this address'),
              '503': problem('No database is configured'),
            },
          },
        },

        '/login': {
          post: {
            tags: ['account'],
            summary: 'Sign in with an email and a password',
            description:
              'Sets a new melete_session cookie and the melete_device cookie. Attempts are limited ' +
              'per client address, per account and per known device; an unknown email gets the ' +
              'same 401 as a wrong password.',
            requestBody: json(credentialsRequest),
            responses: {
              '200': jsonResponse('Signed in', ownerResponse),
              '400': problem('An email and a password of 8 to 1024 characters are required'),
              '401': problem('The email or the password is wrong'),
              '403': problem('The request came from another origin'),
              '429': rateLimited('Too many sign-in attempts'),
              '503': problem('No database is configured'),
            },
          },
        },

        '/me': {
          get: {
            tags: ['account'],
            summary: 'The account this session belongs to',
            security: [{ session: [] }],
            responses: {
              '200': jsonResponse('The signed-in account', ownerResponse),
              '401': problem('No session, or the session has expired'),
            },
          },
        },

        '/spaces': {
          get: {
            tags: ['spaces'],
            summary: 'List spaces',
            responses: { '200': jsonResponse('Spaces', spaceListResponse) },
          },
          post: {
            tags: ['spaces'],
            summary: 'Create a space',
            requestBody: json(createSpaceRequest),
            responses: {
              '201': jsonResponse('Created', spaceListResponse),
              '400': problem('Invalid request'),
            },
          },
        },

        '/jobs': {
          get: {
            tags: ['jobs'],
            summary: 'List jobs',
            requestParams: { query: jobListQuery },
            responses: { '200': jsonResponse('Jobs', jobListResponse) },
          },
          post: {
            tags: ['jobs'],
            summary: 'Delegate a responsibility',
            description: 'The same admission as POST /responsibilities.',
            requestBody: json(createResponsibilityRequest),
            ...admission('201', responsibilitySubmissionResponse, 'No such space'),
          },
        },

        '/jobs/{jobId}': {
          get: {
            tags: ['jobs'],
            summary: 'Read one job',
            requestParams: idParam('jobId', 'Job id'),
            responses: {
              '200': jsonResponse('Job', jobResponse),
              '404': problem('No such job'),
            },
          },
        },

        '/jobs/{id}/triggers': {
          post: {
            tags: ['jobs'],
            summary: 'Wake a job on a schedule, a connection event, or a watched condition',
            requestParams: idParam('id', 'Job id'),
            requestBody: json(triggerSpec),
            responses: {
              '201': jsonResponse('Created', triggerResponse),
              '400': problem('Invalid schedule, pattern or connection'),
              '404': problem('No such job'),
              '409': problem('The job has finished'),
            },
          },
        },

        '/internal/events/deliver': {
          post: {
            tags: ['jobs'],
            summary: 'Offer one connection event to the triggers that watch it',
            description:
              'Recorded once per dedup_key; delivering the same key again returns the first ' +
              'sequence number with duplicate set.',
            requestBody: json(eventDeliveryRequest),
            responses: {
              '202': jsonResponse('Recorded', eventDeliveryResponse),
              '400': problem('Invalid request'),
              '404': problem('The connection is not active'),
            },
          },
        },

        '/jobs/{jobId}/cancel': {
          post: {
            tags: ['jobs'],
            summary: 'Cancel a job',
            description:
              'Sets the job to cancelled and bumps the lease epoch. Actions already admitted may still ' +
              'finish; their disposition is recorded honestly and an unknown action is never hidden.',
            requestParams: idParam('jobId', 'Job id'),
            requestBody: json(cancelJobRequest),
            responses: {
              '200': jsonResponse('Cancelled', jobResponse),
              '409': problem('Job is already finished'),
            },
          },
        },

        '/jobs/{jobId}/messages': {
          post: {
            tags: ['jobs'],
            summary: 'Answer a question the job is waiting on',
            description: 'The same admission as POST /jobs/{id}/input.',
            requestBody: json(postMessageRequest),
            ...admission(
              '200',
              responsibilitySubmissionResponse,
              'No such job',
              idParam('jobId', 'Job id').path,
            ),
          },
        },

        '/messages/{messageId}/reactions': {
          post: {
            tags: ['reactions'],
            summary: 'React to a message with one emoji',
            description:
              'A message is an event, and its id is that event seq. The reaction is persisted and streamed ' +
              'like any other event, and a client draws it on the message bubble rather than as a row of its ' +
              'own. A thumbs-down from a person counts the result it lands on as two unread ones; a thumbs-up ' +
              'clears the unread streak. Reacting twice with the same emoji records one reaction.',
            requestParams: idParam('messageId', 'Message id: the event seq'),
            requestBody: json(personReactionRequest),
            responses: {
              '201': jsonResponse('Recorded', reactionResponse),
              '404': problem('No such message'),
              '409': problem('That event is not a message'),
            },
          },
          get: {
            tags: ['reactions'],
            summary: 'The reactions drawn on one message',
            requestParams: idParam('messageId', 'Message id: the event seq'),
            responses: { '200': jsonResponse('Reactions', reactionListResponse) },
          },
        },

        '/jobs/{jobId}/reactions': {
          get: {
            tags: ['reactions'],
            summary: 'Every reaction on one job stream, for a client rendering a transcript',
            requestParams: idParam('jobId', 'Job id'),
            responses: { '200': jsonResponse('Reactions', reactionListResponse) },
          },
        },

        '/jobs/{jobId}/attempts': {
          get: {
            tags: ['attempts'],
            summary: 'List the attempts of a job',
            requestParams: idParam('jobId', 'Job id'),
            responses: { '200': jsonResponse('Attempts', attemptListResponse) },
          },
        },

        '/attempts/{attemptId}': {
          get: {
            tags: ['attempts'],
            summary: 'Read one attempt, including the provider and model actually used',
            requestParams: idParam('attemptId', 'Attempt id'),
            responses: {
              '200': jsonResponse('Attempt', attemptResponse),
              '404': problem('No such attempt'),
            },
          },
        },

        '/jobs/{jobId}/events': {
          get: {
            tags: ['events'],
            summary: 'Replay and follow one job event stream',
            description:
              'Returns JSON when Accept is application/json and a Server-Sent Events stream when it is ' +
              'text/event-stream. Both start after the `after` cursor; `Last-Event-ID` overrides it.',
            requestParams: { path: z.object({ jobId: z.string() }), query: eventQuery },
            responses: { '200': jsonResponse('Events', eventPage) },
          },
        },

        '/events': {
          get: {
            tags: ['events'],
            summary: 'The global feed that drives the inbox',
            requestParams: { query: eventQuery },
            responses: { '200': jsonResponse('Events', eventPage) },
          },
        },

        '/jobs/{id}/repairs': {
          get: {
            tags: ['actions'],
            summary: 'What was repaired on this responsibility, and what stopped safely',
            description:
              'One entry per action that met a typed connector fault: the classes it met, the ' +
              'decisions the repair policy took, and where it came to rest. `completed` is the ' +
              'only disposition that means the effect happened; every other one is a safe stop ' +
              'and `safe_stop` is true. A schema-drift mapping appears as the proposal it is, ' +
              'with the test it had to pass before anything could use it.',
            requestParams: idParam('id', 'Job id'),
            responses: {
              '200': jsonResponse('Repairs', jobRepairsResponse),
              '404': problem('No such responsibility'),
            },
          },
        },

        '/actions': {
          get: {
            tags: ['actions'],
            summary: 'The action ledger',
            requestParams: { query: actionListQuery },
            responses: { '200': jsonResponse('Actions', actionListResponse) },
          },
        },

        '/actions/{actionId}': {
          get: {
            tags: ['actions'],
            summary: 'Read one action with its receipt and reconciliation record',
            requestParams: idParam('actionId', 'Action id'),
            responses: {
              '200': jsonResponse('Action', actionResponse),
              '404': problem('No such action'),
            },
          },
        },

        '/actions/{actionId}/resolve': {
          post: {
            tags: ['actions'],
            summary: 'Settle an action Melete could not confirm',
            description:
              'Used when verify cannot decide. The owner says what really happened; the answer is recorded ' +
              'as a reconciliation, and the action is never re-dispatched.',
            requestParams: idParam('actionId', 'Action id'),
            requestBody: json(resolveActionRequest),
            responses: {
              '200': jsonResponse('Resolved', actionResponse),
              '409': problem('Action is not awaiting reconciliation'),
            },
          },
        },

        '/actions/{actionId}/execution/start': {
          post: {
            tags: ['actions'],
            summary: 'Claim an admitted in-cell command once using its attempt capability',
            requestParams: idParam('actionId', 'Action id'),
            responses: { '200': jsonResponse('Dispatch claim', executionStartResponse) },
          },
        },
        '/actions/{actionId}/execution/settle': {
          post: {
            tags: ['actions'],
            summary: 'Settle an in-cell command using the capability of its dispatching attempt',
            requestParams: idParam('actionId', 'Action id'),
            requestBody: json(executionSettlement),
            responses: { '200': jsonResponse('Recorded result', actionResponse) },
          },
        },

        '/approvals': {
          get: {
            tags: ['approvals'],
            summary: 'Approvals waiting on the owner',
            responses: { '200': jsonResponse('Approvals', approvalListResponse) },
          },
        },

        '/approvals/{approvalId}': {
          post: {
            tags: ['approvals'],
            summary: 'Approve or deny one action',
            description:
              'The decision binds to the payload hash the person was shown. Editing the draft creates a ' +
              'new action, so an approval can never be spent on different content.',
            requestParams: idParam('approvalId', 'Approval id'),
            requestBody: json(approvalDecisionRequest),
            responses: {
              '200': jsonResponse('Decided', approvalDecisionResponse),
              '409': problem('The payload changed since this approval was requested'),
            },
          },
        },

        '/connections': {
          get: {
            tags: ['connections'],
            summary: 'List connections (never includes secrets)',
            responses: { '200': jsonResponse('Connections', connectionListResponse) },
          },
          post: {
            tags: ['connections'],
            summary:
              'Install a mail, CalDAV, calendar feed or HTTP MCP connection without restarting',
            description:
              'The request carries exactly one configuration block. Secrets are sealed on arrival and ' +
              'never returned. The new connection is tested once; the result is in `check`, and a ' +
              'connection that failed its test stays out of every catalog until a later test passes.',
            requestBody: json(createConnectionRequest),
            responses: {
              '201': jsonResponse('Created', connectionResponse),
              '400': problem('Invalid request'),
              '403': problem('Space owner and matching audience required'),
              '409': problem('MCP installation name already exists'),
            },
          },
        },

        '/connection-kinds': {
          get: {
            tags: ['connections'],
            summary: 'List the kinds of connection that can be installed and the fields each needs',
            responses: { '200': jsonResponse('Kinds', connectionKindListResponse) },
          },
        },

        '/connections/{connectionId}': {
          get: {
            tags: ['connections'],
            summary: 'Read one connection',
            requestParams: idParam('connectionId', 'Connection id'),
            responses: {
              '200': jsonResponse('Connection', connectionResponse),
              '404': problem('No such connection'),
            },
          },
        },

        '/connections/{connectionId}/health': {
          post: {
            tags: ['connections'],
            summary: 'Test a connection now',
            description:
              'Asks the connector whether its destination answers. The result is a fixed code and ' +
              'sentence; it never carries a transport message, an address or a credential.',
            requestParams: idParam('connectionId', 'Connection id'),
            responses: {
              '200': jsonResponse('Connection and check', connectionCheckResponse),
              '403': problem('Space owner required'),
            },
          },
        },

        '/knowledge': {
          get: {
            tags: ['knowledge'],
            summary: 'List the records of one space',
            description:
              'The catalog of the space the caller is bound to. A space id may be repeated as a query ' +
              'argument and must match; it never selects a different space.',
            requestParams: { query: knowledgeListQuery },
            responses: {
              '200': jsonResponse('Records', knowledgeListResponse),
              '403': problem('Wrong space'),
            },
          },
        },

        '/knowledge/search': {
          get: {
            tags: ['knowledge'],
            summary: 'Search one space',
            description:
              'Retrieval is scoped to exactly one space by the handle the caller holds, not by a filter ' +
              'argument. Retracted records are never returned.',
            requestParams: { query: knowledgeSearchQuery },
            responses: { '200': jsonResponse('Hits', knowledgeSearchResponse) },
          },
        },

        '/knowledge/{recordId}': {
          get: {
            tags: ['knowledge'],
            summary: 'Read one record with its provenance',
            requestParams: idParam('recordId', 'Knowledge record id'),
            responses: {
              '200': jsonResponse('Record', knowledgeRecordResponse),
              '404': problem('No such record'),
            },
          },
          delete: {
            tags: ['knowledge'],
            summary: 'Retract or delete a record',
            requestParams: idParam('recordId', 'Knowledge record id'),
            requestBody: json(retractKnowledgeRequest),
            responses: {
              '200': jsonResponse('Record', knowledgeRecordResponse),
              '404': problem('No such record'),
            },
          },
        },

        '/knowledge/proposals': {
          get: {
            tags: ['knowledge'],
            summary: 'List pending memory proposal diffs',
            responses: { '200': jsonResponse('Proposals', knowledgeProposalList) },
          },
          post: {
            tags: ['knowledge'],
            summary: 'Propose a knowledge write',
            description:
              'The only write path an agent has. The proposal is validated and rendered as a diff the ' +
              'owner applies or discards; applying is a git commit.',
            requestBody: json(proposeKnowledgeRequest),
            responses: {
              '201': jsonResponse('Proposal', proposeKnowledgeResponse),
              '400': problem('The record failed lint'),
            },
          },
        },

        '/skills': {
          get: {
            tags: ['skills'],
            summary: 'List built-in and space skills',
            responses: { '200': jsonResponse('Skills', skillListResponse) },
          },
        },
        '/artifacts/{id}/content': {
          get: {
            tags: ['artifacts'],
            summary: 'Retrieve an artifact in the authenticated space',
            description:
              'Returns the recorded bytes only while their hash matches the artifact receipt. Audio can be played directly; a single byte range can be requested for seeking.',
            security: [{ session: [] }],
            requestParams: {
              ...idParam('id', 'Artifact id from the action receipt'),
              header: z.object({ Range: z.string().optional() }),
            },
            responses: {
              '200': {
                description: 'Artifact bytes',
                content: {
                  'audio/wav': { schema: z.string().meta({ format: 'binary' }) },
                  'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
                },
              },
              '206': {
                description: 'Requested byte range',
                content: {
                  'audio/wav': { schema: z.string().meta({ format: 'binary' }) },
                  'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
                },
              },
              '401': problem('A session is required'),
              '404': problem('No matching artifact in this space'),
              '416': { description: 'Requested range is outside the artifact' },
            },
          },
        },
        '/browser/sessions/{id}/takeover': {
          post: {
            tags: ['browser'],
            summary: 'Take human control of a browser session',
            description:
              'Requires the owner session and same-origin protection. The controller increments ' +
              'its epoch before the service parks the job. Already planned inputs are refused.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            responses: {
              '200': jsonResponse(
                'Human control fenced against automation',
                browserControlResponse,
              ),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such browser session'),
              '409': problem('Browser control could not change'),
            },
          },
        },
        '/browser/sites': {
          get: {
            tags: ['browser'],
            summary: "List the sites this space's browser is signed in to",
            description:
              "One record per registrable domain whose cookies the space's browser profile " +
              'holds, with when it was last used. The owner of the space alone may read this.',
            responses: {
              '200': jsonResponse('Signed-in sites', browserSiteList),
              '401': problem('Owner authentication required'),
              '404': problem('Not the owner of this space'),
            },
          },
        },
        '/browser/sites/{domain}': {
          delete: {
            tags: ['browser'],
            summary: 'Sign out of one site',
            description:
              "The worker closes the browser, removes that domain's cookies and its origins' " +
              'storage from the profile, and the record goes with them. The owner of the space ' +
              'alone may do this.',
            requestParams: idParam('domain', 'Registrable domain as listed'),
            responses: {
              '200': jsonResponse('The site is forgotten', browserSiteForgotten),
              '400': problem('Not a registrable domain'),
              '401': problem('Owner authentication required'),
              '404': problem('Not the owner of this space'),
              '409': problem('The browser could not be cleared'),
            },
          },
        },
        '/browser/sessions/{id}/live': {
          post: {
            tags: ['browser'],
            summary: 'Open a live view of a browser session the person controls',
            description:
              'Requires the owner session, same-origin protection and human control. The live id ' +
              'is held in memory and bound to this principal, session, control epoch and address. ' +
              'One view per session: a second opener is refused while the first may still return.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            responses: {
              '200': jsonResponse('The live view is open', liveOpen),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such browser session'),
              '409': problem('The live view could not open'),
            },
          },
        },
        '/browser/sessions/{id}/live/frames': {
          get: {
            tags: ['browser'],
            summary: 'Follow one live view as Server-Sent Events',
            description:
              'One event per live message: a JPEG frame, where the page is, a notice, or the end ' +
              'of the view. Only frames carry an id. Nothing is buffered, so a reconnect with ' +
              '`Last-Event-ID` replays nothing and is repainted from the page as it is now.',
            requestParams: {
              ...idParam('id', 'Browser session id returned by browser.observe'),
              query: z.object({
                live_id: liveId.meta({ description: 'The live id this view was opened with' }),
                after: z.string().optional().meta({
                  description: 'Frame sequence to resume after, for clients without Last-Event-ID',
                }),
              }),
            },
            responses: {
              '200': {
                description: 'The live event stream',
                content: { 'text/event-stream': { schema: z.string() } },
              },
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such browser session'),
              '410': problem('The live view is closed'),
            },
          },
        },
        '/browser/sessions/{id}/live/input': {
          post: {
            tags: ['browser'],
            summary: "Send a person's input to the live page",
            description:
              'Page-level mouse, wheel, key, text and touch events only, never a browser ' +
              'protocol method, script or selector. Every event is checked against the control ' +
              'epoch immediately before it reaches the page.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            requestBody: json(liveUp),
            responses: {
              '200': jsonResponse('Events accepted in order', liveInputResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such browser session'),
              '410': problem('The live view is closed'),
              '429': problem('Input above the rate cap; the view closes'),
            },
          },
        },
        '/browser/sessions/{id}/live/scope': {
          post: {
            tags: ['browser'],
            summary: 'Allow one more site for this takeover',
            description:
              'The person allows a host they navigated to. It holds for this takeover only and is ' +
              'never persisted.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            requestBody: json(liveScope),
            responses: {
              '200': jsonResponse('The sites this takeover may reach', liveScopeResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such browser session'),
              '409': problem('The host was refused or the scope is full'),
              '410': problem('The live view is closed'),
            },
          },
        },
        '/browser/sessions/{id}/live/close': {
          post: {
            tags: ['browser'],
            summary: 'Close the live view',
            description:
              'Ends the view. Control stays with the person until they hand it back, and a view ' +
              'can be opened again.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            requestBody: json(liveClose),
            responses: {
              '200': jsonResponse('The live view is closed', liveClosed),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such browser session'),
              '410': problem('The live view was already closed'),
            },
          },
        },
        '/browser/sessions/{id}/handback': {
          post: {
            tags: ['browser'],
            summary: 'Return browser control to automation',
            description:
              'Requires the owner session and same-origin protection. Increments the control ' +
              'epoch and requires a fresh observation. The job stays parked until owner input.',
            requestParams: idParam('id', 'Browser session id returned by browser.observe'),
            responses: {
              '200': jsonResponse('Automation requires fresh observation', browserControlResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such browser session'),
              '409': problem('Browser control could not change'),
            },
          },
        },
        '/spaces/{spaceId}/companies/scan': {
          post: {
            tags: ['companies'],
            summary: 'Read the connected mailbox and rebuild the company map',
            description:
              'Idempotent while a scan is running: a second request returns the scan already ' +
              'under way rather than reading the mailbox twice.',
            requestParams: idParam('spaceId', 'Space id'),
            responses: {
              '200': jsonResponse(
                'A scan was already running',
                z.object({ scan_id: z.string(), status: z.literal('running') }),
              ),
              '202': jsonResponse(
                'Scan started',
                z.object({ scan_id: z.string(), status: z.literal('running') }),
              ),
              '403': problem('This space is not accessible to the signed-in account'),
              '409': problem('No mailbox is connected to this space'),
            },
          },
        },
        '/spaces/{spaceId}/companies/scan/{scanId}': {
          get: {
            tags: ['companies'],
            summary: 'How far one scan has got',
            requestParams: {
              path: z.object({
                spaceId: z.string().meta({ description: 'Space id' }),
                scanId: z.string().meta({ description: 'Scan id' }),
              }),
            },
            responses: {
              '200': jsonResponse(
                'Scan progress',
                z.object({
                  status: z.enum(['running', 'done', 'failed']),
                  messages_seen: z.number().int().nonnegative(),
                  items_found: z.number().int().nonnegative(),
                  error: z.string().optional(),
                }),
              ),
              '403': problem('This space is not accessible to the signed-in account'),
              '404': problem('No such scan in this space'),
            },
          },
        },
        '/spaces/{spaceId}/companies': {
          get: {
            tags: ['companies'],
            summary: 'Every company in this person’s life, with the ledger behind each figure',
            requestParams: idParam('spaceId', 'Space id'),
            responses: {
              '200': jsonResponse('The company map', companyMap),
              '403': problem('This space is not accessible to the signed-in account'),
            },
          },
        },
        '/ledger/{id}': {
          get: {
            tags: ['companies'],
            summary: 'One item, its company, and the message text its quotes index into',
            requestParams: {
              ...idParam('id', 'Ledger item id'),
              query: z.object({
                space_id: z
                  .string()
                  .optional()
                  .meta({ description: 'Narrows the lookup to one space' }),
              }),
            },
            responses: {
              '200': jsonResponse(
                'Item and evidence',
                z.object({
                  item: ledgerItem,
                  company,
                  message: z
                    .object({
                      id: z.string(),
                      subject: z.string(),
                      from: z.string(),
                      received_at: z.string(),
                      text: z.string(),
                    })
                    .nullable(),
                }),
              ),
              '404': problem('No such item for this person'),
            },
          },
          patch: {
            tags: ['companies'],
            summary: 'Drop an item, or mark it settled',
            requestParams: {
              ...idParam('id', 'Ledger item id'),
              query: z.object({ space_id: z.string().optional() }),
            },
            requestBody: json(z.object({ status: z.enum(['dropped', 'settled']) })),
            responses: {
              '200': jsonResponse('The item as it now stands', ledgerItem),
              '404': problem('No such item for this person'),
            },
          },
        },
        '/ledger/{id}/handle': {
          post: {
            tags: ['companies'],
            summary: 'Start the job that handles this item',
            description:
              'Creates the job that runs the item’s playbook. Any message it sends goes ' +
              'through the existing approval path; this route starts the work, it does not send.',
            requestParams: {
              ...idParam('id', 'Ledger item id'),
              query: z.object({ space_id: z.string().optional() }),
            },
            responses: {
              '200': jsonResponse(
                'Already being handled, by the job named here',
                z.object({ job_id: z.string() }),
              ),
              '201': jsonResponse('The job now handling it', z.object({ job_id: z.string() })),
              '400': problem('Nothing ships yet that handles this kind of item on its own'),
              '404': problem('No such item for this person'),
              '409': problem('Already finished, or no longer quotable'),
              '503': problem('Handling is not connected yet'),
            },
          },
        },
      },
    },
    // Shared shapes such as `job` appear on many paths; emitting them once under
    // components keeps the document readable and small enough to review in a PR.
    { reused: 'ref' },
  );
}

/** The exact bytes written to openapi.json, so the sync test compares strings. */
export function openApiJson(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
