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
  backgroundOperation,
  connectionGeneration,
  connectionLifecycle,
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
  replyObligation,
  replyObligationList,
  responsibilitySnapshot,
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
      tags: [
        { name: 'health' },
        { name: 'spaces' },
        { name: 'jobs' },
        { name: 'attempts' },
        { name: 'events' },
        { name: 'actions' },
        { name: 'approvals' },
        { name: 'connections' },
        { name: 'knowledge' },
        { name: 'skills' },
      ],
      paths: {
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
