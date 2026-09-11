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
  connectionListResponse,
  connectionResponse,
  createConnectionRequest,
  createJobRequest,
  createSpaceRequest,
  errorResponse,
  healthResponse,
  jobListQuery,
  jobListResponse,
  jobResponse,
  knowledgeListQuery,
  knowledgeListResponse,
  knowledgeRecordResponse,
  knowledgeSearchQuery,
  knowledgeSearchResponse,
  postMessageRequest,
  proposeKnowledgeRequest,
  proposeKnowledgeResponse,
  resolveActionRequest,
  retractKnowledgeRequest,
  skillListResponse,
  spaceListResponse,
} from './api.ts';
import { approvalDecisionRequest } from './broker.ts';
import { eventPage, eventQuery } from './events.ts';
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
import {
  backgroundOperation,
  connectionGeneration,
  connectionLifecycle,
  createResponsibilityRequest,
  jobScheduling,
  jobSubmissionResponse,
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
  submissionResponse,
} from './responsibility.ts';

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
      },
      tags: [
        { name: 'health' },
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
      ],
      paths: {
        '/responsibilities': {
          post: {
            tags: ['jobs'],
            summary: 'Accept a responsibility with scheduling and attention preferences',
            requestBody: json(createResponsibilityRequest),
            responses: {
              '201': jsonResponse('Accepted responsibility', responsibilitySubmissionResponse),
              '409': problem('Submission conflict'),
            },
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
            requestParams: idParam('id', 'Job ID'),
            requestBody: json(postMessageRequest),
            responses: {
              '200': jsonResponse('Input submission receipt', jobSubmissionResponse),
              '409': jsonResponse(
                'Submission conflict or rejected transition',
                jobSubmissionResponse,
              ),
            },
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
            requestBody: json(createJobRequest),
            responses: {
              '201': jsonResponse('Created', jobResponse),
              '400': problem('Invalid request'),
            },
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
            requestParams: idParam('jobId', 'Job id'),
            requestBody: json(postMessageRequest),
            responses: {
              '202': jsonResponse('Accepted; the job is queued for its next attempt', jobResponse),
              '409': problem('The job is not waiting for input'),
            },
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
            summary: 'Add a connection',
            requestBody: json(createConnectionRequest),
            responses: {
              '201': jsonResponse('Created', connectionResponse),
              '400': problem('Invalid request'),
            },
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
            summary: 'Check a connection now',
            requestParams: idParam('connectionId', 'Connection id'),
            responses: { '200': jsonResponse('Connection', connectionResponse) },
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
