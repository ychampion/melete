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
  actionSummaryListResponse,
  approvalDecisionResponse,
  approvalListResponse,
  attemptListResponse,
  attemptResponse,
  cancelJobRequest,
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
  setupRequest,
  setupStatusResponse,
  skillListResponse,
  spaceListResponse,
  triggerResponse,
} from './api.ts';
import { appsPaths } from './apps-openapi.ts';
import { attachmentContentQuery, attachmentLimits, attachmentResponse } from './attachments.ts';
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
  accountSignInAvailability,
  accountSignInRequest,
  accountSignInStart,
  accountSignInStatus,
  connectionCheckResponse,
  connectionKindListResponse,
  connectionListResponse,
  connectionResponse,
  createConnectionRequest,
  managedSignInRequest,
  managedSignInStart,
  mcpSignInInstall,
  mcpSignInRequest,
  mcpSignInStart,
  mcpSignInStatus,
  mcpToolDiscovery,
  mcpToolDiscoveryRequest,
  smsTextListResponse,
} from './connections.ts';
import {
  deviceHelloRequest,
  deviceHelloResponse,
  deviceListResponse,
  devicePairingRequest,
  devicePairingResponse,
  devicePairRequest,
  devicePairResponse,
  devicePollResponse,
  deviceResponse,
  deviceResult,
  deviceUpdateRequest,
} from './devices.ts';
import { space, triggerSpec } from './entities.ts';
import { eventPage, eventQuery } from './events.ts';
import { executionSettlement, executionStartResponse } from './execution-admission.ts';
import { experiencePaths } from './experience-openapi.ts';
import {
  createFeedbackRequest,
  feedbackListQuery,
  feedbackListResponse,
  feedbackResponse,
  updateFeedbackRequest,
} from './feedback.ts';
import {
  handoffDecision,
  handoffList,
  handoffResponse,
  handoffResultDecision,
} from './handoffs.ts';
import { hookObservation } from './hooks.ts';
import { intentCancelResponse, intentEdit, intentList, intentResponse } from './intents.ts';
import {
  engineSkillApprovalRequest,
  engineSkillEditRequest,
  engineSkillListResponse,
  engineSkillProhibitionListResponse,
  engineSkillProhibitionResponse,
  engineSkillResponse,
  episodeListResponse,
  interventionRequest,
  interventionResponse,
  jobLearningScope,
  keepAnswerRequest,
  keepAnswerResponse,
  learnedItemResponse,
  learnedList,
  learnedTryRequest,
  learnedUndoRequest,
  learningDeletionResponse,
  learningNoticeList,
  learningNoticeResponse,
  learningScopeResponse,
  learningSpaceQuery,
  learningSpaceRequest,
  ownSkillDeleteRequest,
  ownSkillDeleteResponse,
  ownSkillEditRequest,
  ownSkillListResponse,
  ownSkillName,
  ownSkillResponse,
  procedureActivationRequest,
  procedureInspection,
  procedureListResponse,
  procedureReasonRequest,
  procedureResponse,
  procedureTrialRequest,
} from './learning.ts';
import {
  mcpConnectedClientList,
  mcpRpcMessage,
  mcpRpcResponse,
  oauthAuthorizeQuery,
  oauthClientRegistered,
  oauthClientRegistration,
  oauthConsentForm,
  oauthErrorResponse,
  oauthProtectedResource,
  oauthServerMetadata,
  oauthTokenRequest,
  oauthTokenResponse,
} from './mcp-server.ts';
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
  keyedModelProvider,
  modelSettingsResponse,
  saveModelKeyRequest,
  setDefaultModelRequest,
  setModelVisionRequest,
  setSecondaryModelRequest,
  setSecondaryUsesRequest,
  testModelConnectionRequest,
  testModelConnectionResponse,
} from './model-settings.ts';
import { installPluginRequest, installPluginResponse, pluginListResponse } from './plugins.ts';
import {
  createPrincipalRequest,
  createSharedSpaceRequest,
  grantMembershipRequest,
  principal,
  spaceMembership,
} from './principals.ts';
import { processPreviewPaths } from './process-preview-openapi.ts';
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
import {
  completeSignInPending,
  completeSignInRequest,
  providerSignInList,
  providerSignInStatus,
  signInProvider,
  startSignInRequest,
  startSignInResponse,
} from './provider-signin.ts';
import {
  pushPublicKeyResponse,
  pushSettingsResponse,
  pushSettingsUpdate,
  pushSubscriptionList,
  pushSubscriptionRequest,
  pushSubscriptionResponse,
} from './push.ts';
import {
  reachConsentRequest,
  reachNumberRequest,
  reachStateResponse,
  reachVerifyRequest,
} from './reach.ts';
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
import {
  acceptInviteRequest,
  acceptInviteResponse,
  addRoomMemberRequest,
  createRoomInviteRequest,
  createRoomRequest,
  createRoomThreadRequest,
  inviteView,
  inviteViewRequest,
  linkedAccountList,
  linkedAccountRemoval,
  meResponse,
  peopleList,
  peopleQuery,
  postRoomMessageRequest,
  roomConnectionList,
  roomConnectionResponse,
  roomConnectionUpdate,
  roomDetail,
  roomInviteCreated,
  roomInviteList,
  roomInviteResponse,
  roomLeaveResponse,
  roomList,
  roomMembershipResponse,
  roomMemoryForgotten,
  roomMemoryView,
  roomMessageDeleted,
  roomMessageResponse,
  roomPermissionDecision,
  roomPermissionOutcome,
  roomPolicyResponse,
  roomPolicyUpdate,
  roomPresenceResponse,
  roomShareResponse,
  roomShareWithdrawn,
  roomStopResponse,
  roomStreamFrame,
  roomThreadList,
  roomThreadView,
  shareToRoomRequest,
  updateMeRequest,
} from './rooms.ts';
import { runtimeEvent } from './runtime.ts';
import {
  sandboxComputerList,
  sandboxComputerQuery,
  sandboxControlRequest,
  sandboxControlResponse,
} from './sandbox-computer.ts';
import {
  deadlineResponse,
  documentDeadlineRequest,
  situationList,
  situationResponse,
} from './situations.ts';
import {
  deleteSpaceRequest,
  spaceRemoval,
  spaceRemovalPreview,
  spaceRemovalReport,
} from './spaces.ts';
import { needsYouItemResponse, needsYouList } from './triage.ts';
import { healthDetailResponse, usageResponse } from './usage.ts';
import {
  voiceAside,
  voiceAsideRequest,
  voiceContextQuery,
  voiceSession,
  voiceSpeechRequest,
  voiceStatus,
  voiceTranscription,
  voiceTranscriptionQuery,
} from './voice.ts';
import { awaitedReply, waitingOn } from './waiting.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});

const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});

const problem = (description: string) => jsonResponse(description, errorResponse);

/** The four routes of signing in with one account provider. */
const accountSignInPaths = (
  name: 'google' | 'microsoft',
  text: { title: string; what: string; consent: string },
) => ({
  [`/${name}-sign-ins`]: {
    get: {
      tags: ['connections'],
      summary: `Whether signing in with ${text.title} is offered here`,
      description:
        `Available once the operator has set a ${text.title} OAuth client and an https:// or ` +
        'localhost public address. `redirect_uri` is the address to register with that client.',
      responses: {
        '200': jsonResponse('Availability', accountSignInAvailability),
      },
    },
    post: {
      tags: ['connections'],
      summary: `Start connecting ${text.what} by signing in with ${text.title}`,
      description:
        `Answers with the ${text.title} address to open in the browser. ${text.consent} When ` +
        'the browser returns, each part the person allowed becomes a connection with the same ' +
        'tools, approvals and receipts as a mailbox or calendar connected with a password. ' +
        'Signing in again with the same account renews those connections instead of adding more.',
      requestBody: json(accountSignInRequest),
      responses: {
        '201': jsonResponse('Open `authorize_url` in the browser', accountSignInStart),
        '400': problem('Invalid request'),
        '403': problem('Space owner and matching audience required'),
        '409': problem('No OAuth client, no public address to return to, or no master key'),
      },
    },
  },
  [`/${name}-sign-ins/{id}`]: {
    get: {
      tags: ['connections'],
      summary: `Read how a ${text.title} sign-in is going`,
      requestParams: idParam('id', 'Sign-in id'),
      responses: {
        '200': jsonResponse(
          'Pending, connected with its connections, or failed with a code',
          accountSignInStatus,
        ),
        '404': problem('No sign-in by that id for this person'),
      },
    },
  },
  [`/oauth/${name}/callback`]: {
    get: {
      tags: ['connections'],
      summary: `Where ${text.title} returns the browser after signing in`,
      description:
        'Checks the state before the code is spent, then connects what was granted. Answers ' +
        'with a short page for the browser; the outcome is also available from the sign-in status.',
      requestParams: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          scope: z.string().optional(),
        }),
      },
      responses: {
        '200': { description: 'Connected', content: { 'text/html': { schema: z.string() } } },
        '400': {
          description: 'The response was refused, or nothing was granted',
          content: { 'text/html': { schema: z.string() } },
        },
        '404': {
          description: 'No such sign-in for this person',
          content: { 'text/html': { schema: z.string() } },
        },
      },
    },
  },
});

const idParam = (name: string, description: string) => ({
  path: z.object({ [name]: z.string().meta({ description }) }),
});

/** Whether a stored file is asked to be shown in place rather than downloaded. */
const fileDisposition = z.object({
  disposition: z
    .enum(['inline'])
    .optional()
    .meta({ description: 'Show a PDF, a picture or text in place instead of downloading it' }),
});

const html = (description: string) => ({
  description,
  content: { 'text/html': { schema: z.string() } },
});
const oauthProblem = (description: string) => jsonResponse(description, oauthErrorResponse);
const redirect = (description: string) => ({
  description,
  headers: z.object({ Location: z.string() }),
});

/**
 * Melete as an MCP server for other assistants, and Melete as the OAuth
 * authorization server they connect through. Served when the service has a
 * public address. The discovery documents sit at the root of the public origin.
 */
const assistantPaths = {
  '/.well-known/oauth-authorization-server': {
    get: {
      tags: ['assistants'],
      summary: 'OAuth authorization server metadata (RFC 8414)',
      description: 'Public, at the root of the web origin. No session is needed.',
      responses: { '200': jsonResponse('The metadata', oauthServerMetadata) },
    },
  },
  '/.well-known/oauth-protected-resource': {
    get: {
      tags: ['assistants'],
      summary: 'Protected resource metadata for the MCP endpoint (RFC 9728)',
      responses: { '200': jsonResponse('The metadata', oauthProtectedResource) },
    },
  },
  '/.well-known/oauth-protected-resource/api/mcp': {
    get: {
      tags: ['assistants'],
      summary: 'Protected resource metadata at the path-specific address the endpoint names',
      responses: { '200': jsonResponse('The metadata', oauthProtectedResource) },
    },
  },
  '/oauth/register': {
    post: {
      tags: ['assistants'],
      summary: 'Register an assistant as a public OAuth client (RFC 7591)',
      description:
        'Public clients only, with PKCE. A client may instead use an https:// client ID metadata document.',
      requestBody: json(oauthClientRegistration),
      responses: {
        '201': jsonResponse('Registered', oauthClientRegistered),
        '400': oauthProblem('The metadata was refused'),
        '429': oauthProblem(
          'Too many registrations from this address, or too many waiting for a person to allow them',
        ),
      },
    },
  },
  '/oauth/authorize': {
    get: {
      tags: ['assistants'],
      summary: 'The consent page an assistant sends a person to',
      description:
        'Shows the signed-in person who is asking (a checked host, or a self-given name marked ' +
        'unverified), the space the access would act in, and what it could do. An error about ' +
        'the request goes back with the state and issuer only to a trusted redirect address: ' +
        'loopback, the metadata document host, or one a person here already allowed. Anywhere ' +
        'else it is shown on this page.',
      requestParams: { query: oauthAuthorizeQuery },
      responses: {
        '200': html('The consent page, or a prompt to sign in first'),
        '302': redirect('An error returned to the assistant'),
        '400': html('The client or its redirect address is unknown, or the request was refused'),
        '429': html('Too many authorization requests from this address'),
      },
    },
    post: {
      tags: ['assistants'],
      summary: "The person's answer on the consent page",
      description:
        'Accepted only from the page shown to this session for this exact request. Allowing ' +
        'returns a single-use code bound to the PKCE challenge.',
      security: [{ session: [] }],
      requestBody: {
        content: { 'application/x-www-form-urlencoded': { schema: oauthConsentForm } },
      },
      responses: {
        '302': redirect('Back to the assistant with a code, or with access_denied'),
        '400': html('The client or its redirect address is unknown, or the request was refused'),
        '403': html('The page expired or was not shown to this session'),
        '429': html('Too many authorization requests from this address'),
      },
    },
  },
  '/oauth/token': {
    post: {
      tags: ['assistants'],
      summary: 'Exchange a code, or rotate a refresh token',
      description:
        'A code is used once, with its PKCE verifier. Each refresh returns a new refresh token; ' +
        'presenting a used one ends every token of that connection. No token outlives 90 days ' +
        'from the consent, however often it is refreshed.',
      requestBody: {
        content: { 'application/x-www-form-urlencoded': { schema: oauthTokenRequest } },
      },
      responses: {
        '200': jsonResponse('Tokens', oauthTokenResponse),
        '400': oauthProblem('The grant was refused'),
        '401': oauthProblem('The client is not registered'),
        '429': oauthProblem('Too many requests from this address'),
      },
    },
  },
  '/oauth/revoke': {
    post: {
      tags: ['assistants'],
      summary: 'Revoke a token and every token of its connection (RFC 7009)',
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': { schema: z.object({ token: z.string() }) },
        },
      },
      responses: { '200': { description: 'Revoked, or never valid' } },
    },
  },
  '/mcp': {
    post: {
      tags: ['assistants'],
      summary: 'The MCP endpoint (streamable HTTP, one JSON response per message)',
      description:
        'Tools: waiting_on, handle, safe_send, remember, recall and status, each acting as the ' +
        'person the token names, in the space they agreed from. safe_send only proposes: the ' +
        'person approves the exact text in Melete. A token whose person can no longer use that ' +
        'space is refused with 401 and its connection ends. Tool calls are limited per connection.',
      security: [{ assistant: [] }],
      requestParams: {
        header: z.object({ 'MCP-Protocol-Version': z.string().optional() }),
      },
      requestBody: json(mcpRpcMessage),
      responses: {
        '200': jsonResponse('The JSON-RPC response', mcpRpcResponse),
        '202': { description: 'A notification was accepted' },
        '400': jsonResponse('Not one JSON-RPC 2.0 message, or an unknown version', mcpRpcResponse),
        '429': jsonResponse('Too many tool calls from this connection', mcpRpcResponse),
        '401': {
          ...problem('No valid access token'),
          headers: z.object({
            'WWW-Authenticate': z.string().meta({
              description: 'Bearer, with resource_metadata naming the protected resource metadata',
            }),
          }),
        },
      },
    },
    get: {
      tags: ['assistants'],
      summary: 'Not offered: the endpoint holds no stream',
      responses: { '405': jsonResponse('POST only', mcpRpcResponse) },
    },
    delete: {
      tags: ['assistants'],
      summary: 'Not offered: the endpoint holds no session',
      responses: { '405': jsonResponse('POST only', mcpRpcResponse) },
    },
  },
  '/mcp/clients': {
    get: {
      tags: ['assistants'],
      summary: 'The assistants this person has connected',
      responses: { '200': jsonResponse('Connected assistants', mcpConnectedClientList) },
    },
  },
  '/mcp/clients/{clientId}': {
    delete: {
      tags: ['assistants'],
      summary: 'Disconnect an assistant: every token it holds for this person ends',
      requestParams: idParam('clientId', 'The client ID'),
      responses: {
        '204': { description: 'Disconnected' },
        '404': problem('No connection from that assistant'),
      },
    },
  },
};

/** A refusal that says when to try again. */
const rateLimited = (description: string) => ({
  ...problem(description),
  headers: z.object({
    'Retry-After': z.string().meta({ description: 'Seconds to wait before the next attempt' }),
  }),
});

/** Settings manages computers; the companion on each computer uses the `/device` routes. */
const devicePaths = () => ({
  '/devices': {
    get: {
      tags: ['devices'],
      summary: 'The computers connected to this space, with what each may do',
      responses: { '200': jsonResponse('Devices', deviceListResponse) },
    },
  },
  '/devices/pairings': {
    post: {
      tags: ['devices'],
      summary: 'Make a one-time code that connects a computer',
      description:
        'The code works once, for ten minutes. The capabilities chosen here are what the ' +
        'computer may do once paired; running commands is off unless it is chosen.',
      requestBody: json(devicePairingRequest),
      responses: {
        '201': jsonResponse('Code to type into the companion', devicePairingResponse),
        '403': problem('Space owner required'),
      },
    },
  },
  '/devices/{id}': {
    patch: {
      tags: ['devices'],
      summary: 'Change what a connected computer may do',
      requestParams: idParam('id', 'Device id'),
      requestBody: json(deviceUpdateRequest),
      responses: {
        '200': jsonResponse('Device', deviceResponse),
        '404': problem('Device not found'),
        '409': problem('Device revoked'),
      },
    },
  },
  '/devices/{id}/revoke': {
    post: {
      tags: ['devices'],
      summary: 'Disconnect a computer for good',
      description:
        'The computer loses access at once: its token stops working, work waiting for it is ' +
        'refused, and its connection is revoked. Pair again to reconnect it.',
      requestParams: idParam('id', 'Device id'),
      responses: {
        '200': jsonResponse('Revoked device', deviceResponse),
        '404': problem('Device not found'),
      },
    },
  },
  '/device/pair': {
    post: {
      tags: ['devices'],
      summary: 'Pair a computer with a one-time code (companion)',
      security: [],
      requestBody: json(devicePairRequest),
      responses: {
        '201': jsonResponse('The device token, shown once', devicePairResponse),
        '400': problem('The code is wrong, used or expired'),
        '429': rateLimited('Too many wrong codes'),
      },
    },
  },
  '/device/hello': {
    post: {
      tags: ['devices'],
      summary: 'Say what this computer allows, on start and after a change (companion)',
      security: [{ device: [] }],
      requestBody: json(deviceHelloRequest),
      responses: {
        '200': jsonResponse('What Settings allows', deviceHelloResponse),
        '401': problem('Token unknown or revoked'),
      },
    },
  },
  '/device/requests': {
    get: {
      tags: ['devices'],
      summary: 'Wait for work for this computer (companion)',
      description:
        'Answers as soon as there is work, or empty after about 25 seconds. `channel=browser` ' +
        'is the browser bridge, which collects only browser work.',
      security: [{ device: [] }],
      requestParams: {
        query: z.object({ channel: z.enum(['main', 'browser']).optional() }),
      },
      responses: {
        '200': jsonResponse('Work to do', devicePollResponse),
        '401': problem('Token unknown or revoked'),
        '403': problem('Using the browser is turned off for this computer'),
      },
    },
  },
  '/device/browser/leave': {
    post: {
      tags: ['devices'],
      summary: 'The browser extension was switched off (companion)',
      security: [{ device: [] }],
      responses: {
        '200': jsonResponse('Received', z.strictObject({ status: z.literal('ok') })),
        '401': problem('Token unknown or revoked'),
      },
    },
  },
  '/device/requests/{id}/result': {
    post: {
      tags: ['devices'],
      summary: 'Answer one request (companion)',
      security: [{ device: [] }],
      requestParams: idParam('id', 'Request id'),
      requestBody: json(deviceResult),
      responses: {
        '200': jsonResponse('Received', z.strictObject({ status: z.literal('ok') })),
        '401': problem('Token unknown or revoked'),
        '404': problem('No request by that id is waiting'),
      },
    },
  },
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

/** The rooms routes. Each names its room in the path and checks the caller's membership itself. */
function roomsPaths() {
  const room = idParam('id', 'Room id');
  const thread = { path: z.object({ id: z.string(), threadId: z.string() }) };
  const notIn = problem('Not in this room, or no such room');
  return {
    '/rooms': {
      get: {
        tags: ['rooms'],
        summary: 'The rooms the signed-in person is in',
        responses: { '200': jsonResponse('Rooms', roomList) },
      },
      post: {
        tags: ['rooms'],
        summary: 'Make a room; its maker owns it',
        description:
          'A room is a shared space where several people talk to one agent. The agent acts as ' +
          'the room, never as any one person, and reads only what the room has.',
        requestBody: json(createRoomRequest),
        responses: {
          '201': jsonResponse('The new room', roomDetail),
          '403': problem('Only a person can make a room'),
        },
      },
    },
    '/rooms/{id}': {
      get: {
        tags: ['rooms'],
        summary: 'A room, its people and how it works',
        requestParams: room,
        responses: { '200': jsonResponse('The room', roomDetail), '404': notIn },
      },
    },
    '/rooms/{id}/members': {
      post: {
        tags: ['rooms'],
        summary: 'Add a person to a room',
        description:
          'Who can read the room changes, so work under way in it starts again with the new people.',
        requestParams: room,
        requestBody: json(addRoomMemberRequest),
        responses: {
          '201': jsonResponse('The new member', roomMembershipResponse),
          '403': problem('Only an owner of the room adds people'),
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/members/{principalId}': {
      delete: {
        tags: ['rooms'],
        summary: 'Remove someone from a room, or leave it',
        description:
          'Their access ends at once, including any thread they have open. What they said stays in the room.',
        requestParams: { path: z.object({ id: z.string(), principalId: z.string() }) },
        responses: {
          '200': jsonResponse('Removed', roomLeaveResponse),
          '403': problem('Only an owner removes someone else; the owner cannot be removed'),
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/invites': {
      get: {
        tags: ['rooms'],
        summary: "A room's guest invites, open and used",
        requestParams: room,
        responses: {
          '200': jsonResponse('Invites', roomInviteList),
          '403': problem('Only an owner of the room'),
          '404': notIn,
        },
      },
      post: {
        tags: ['rooms'],
        summary: 'Invite a guest into a room',
        description:
          'Makes a link that works once, for the number of days given (30 by default), which is ' +
          "also how long the guest stays. The owner sends it themselves. It uses the installation's " +
          'public address (`MELETE_PUBLIC_URL`) when one is set; the path works on its sign-in page ' +
          'either way. A guest reads and posts only in the rooms they were invited to, asks the ' +
          'agent where the room allows it, never answers a permission, and has no people list and ' +
          'no work of their own.',
        requestParams: room,
        requestBody: json(createRoomInviteRequest),
        responses: {
          '201': jsonResponse('The invite, with its link shown once', roomInviteCreated),
          '403': problem('Only an owner of the room'),
          '404': notIn,
          '409': problem('That email belongs to someone with a full account, or is in the room'),
        },
      },
    },
    '/rooms/{id}/invites/{inviteId}': {
      delete: {
        tags: ['rooms'],
        summary: 'Withdraw an invite before it is used',
        requestParams: { path: z.object({ id: z.string(), inviteId: z.string() }) },
        responses: {
          '200': jsonResponse('Withdrawn', roomInviteResponse),
          '403': problem('Only an owner of the room'),
          '404': problem('No such invite in this room'),
          '409': problem('The invite was already used'),
        },
      },
    },
    '/invites/view': {
      post: {
        tags: ['rooms'],
        summary: 'What an invite link is for',
        description: "Public. It names the room and nothing about the room's people.",
        security: [],
        requestBody: json(inviteViewRequest),
        responses: {
          '200': jsonResponse('The invite', inviteView),
          '404': problem('The link is wrong, used, withdrawn or out of date'),
        },
      },
    },
    '/invites/accept': {
      post: {
        tags: ['rooms'],
        summary: 'Accept an invite',
        description:
          'For someone not signed in it makes the guest account with the password given and signs it in. ' +
          'When the email already has a guest account, sign in as it first. The link works once.',
        security: [],
        requestBody: json(acceptInviteRequest),
        responses: {
          '200': jsonResponse('In the room, signed in', acceptInviteResponse),
          '400': problem('A new account needs a password'),
          '404': problem('The link is wrong, used, withdrawn or out of date'),
          '409': problem(
            'The email has an account: sign in as it first, or it is a full account an owner adds',
          ),
        },
      },
    },
    '/people': {
      get: {
        tags: ['rooms'],
        summary: 'People on this installation who can be added to a room',
        requestParams: { query: peopleQuery },
        responses: {
          '200': jsonResponse('People', peopleList),
          '403': problem('Only a person can look up people'),
        },
      },
    },
    '/rooms/{id}/threads': {
      get: {
        tags: ['rooms'],
        summary: "A room's threads, most recently active first",
        requestParams: room,
        responses: { '200': jsonResponse('Threads', roomThreadList), '404': notIn },
      },
      post: {
        tags: ['rooms'],
        summary: 'Start a thread with its first message',
        description:
          'With `ask_agent`, or a message that names the agent, the first message asks the agent.',
        requestParams: room,
        requestBody: json(createRoomThreadRequest),
        responses: {
          '201': jsonResponse('The thread and its first message', roomMessageResponse),
          '404': notIn,
          '409': problem('The submission ID belongs to a different message'),
        },
      },
    },
    '/rooms/{id}/threads/{threadId}': {
      get: {
        tags: ['rooms'],
        summary: 'A thread: every message with its author, and each request the agent was asked',
        requestParams: thread,
        responses: { '200': jsonResponse('The thread', roomThreadView), '404': notIn },
      },
    },
    '/rooms/{id}/threads/{threadId}/messages': {
      post: {
        tags: ['rooms'],
        summary: 'Post a message in a thread',
        description:
          'A message asks the agent when it names the agent, or follows straight on from the ' +
          "agent's answer to its author. An ask reaches the asker's own request, never anyone " +
          "else's; while another request in the thread is under way, it waits its turn. A message " +
          'that does not ask starts nothing.',
        requestParams: thread,
        requestBody: json(postRoomMessageRequest),
        responses: {
          '200': jsonResponse('The message', roomMessageResponse),
          '404': notIn,
          '409': problem(
            'The thread is closed, or the submission ID belongs to a different message',
          ),
        },
      },
    },
    '/rooms/{id}/threads/{threadId}/events': {
      get: {
        tags: ['rooms'],
        summary: "A thread's live frames: messages and the agent's work, in order",
        description:
          'With `Accept: text/event-stream`, a stream of frames; otherwise one page. Each frame ' +
          'carries `seq`; resume with `Last-Event-ID`. The stream closes once the reader is no ' +
          'longer in the room.',
        requestParams: {
          path: z.object({ id: z.string(), threadId: z.string() }),
          query: z.object({ after: z.string().optional() }),
          header: z.object({ 'Last-Event-ID': z.string().optional() }),
        },
        responses: {
          '200': {
            description: 'Frames',
            content: {
              'application/json': {
                schema: z.object({
                  frames: z.array(roomStreamFrame),
                  next_cursor: z.number().int().nonnegative(),
                }),
              },
              'text/event-stream': {
                schema: z.string(),
                example: 'id: 42\nevent: message\ndata: {"seq":42,"kind":"message"}\n\n',
              },
            },
          },
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/requests/{jobId}/stop': {
      post: {
        tags: ['rooms'],
        summary: 'Stop what the agent is doing for one request',
        requestParams: { path: z.object({ id: z.string(), jobId: z.string() }) },
        responses: {
          '200': jsonResponse('The request', roomStopResponse),
          '403': problem('Only the person who asked, or an owner of the room'),
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/requests/{jobId}/computers': {
      get: {
        tags: ['rooms'],
        summary: "The computers one of the room's requests is using",
        description:
          'Everyone in the room may watch them through `/sandbox/sessions/{id}/live`; only the ' +
          "room's owners take one over.",
        requestParams: { path: z.object({ id: z.string(), jobId: z.string() }) },
        responses: {
          '200': jsonResponse('Computers', sandboxComputerList),
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/policy': {
      get: {
        tags: ['rooms'],
        summary: 'How a room works',
        description:
          "Who decides the permissions its requests ask for, when its agent answers, whether guests may ask, and the room's hourly limits.",
        requestParams: room,
        responses: { '200': jsonResponse('The settings', roomPolicyResponse), '404': notIn },
      },
      put: {
        tags: ['rooms'],
        summary: 'Change how a room works',
        description:
          'Owners only. Settings left out stay as they are. Who may answer a permission is checked when the answer is given, so a new rule covers the permissions already waiting.',
        requestParams: room,
        requestBody: json(roomPolicyUpdate),
        responses: {
          '200': jsonResponse('The settings', roomPolicyResponse),
          '400': problem('A person cannot ask more often than the whole room'),
          '403': problem('Only an owner of the room changes how it works'),
          '404': notIn,
        },
      },
    },
    '/rooms/{id}/approvals/{approvalId}': {
      post: {
        tags: ['rooms'],
        summary: "Answer one of a room's permissions",
        description:
          "Only the people the room's rule names may answer: the person who asked (the default), any member who is not a guest, or the room's owners. The answer names the exact content and the card it answers; if either changed, it is refused. The answer is recorded as the person's.",
        requestParams: { path: z.object({ id: z.string(), approvalId: z.string() }) },
        requestBody: json(roomPermissionDecision),
        responses: {
          '200': jsonResponse('Answered', roomPermissionOutcome),
          '403': problem("The room's rule does not name this person"),
          '404': notIn,
          '409': problem(
            'What it asks for changed, it was withdrawn, or someone already answered it (the message says who, and how)',
          ),
        },
      },
    },
    '/rooms/{id}/connections': {
      get: {
        tags: ['rooms'],
        summary: "The connections in a room's space",
        description:
          "A connection marked `room` serves the room's requests; one marked `owner` serves only the owner's own work there.",
        requestParams: room,
        responses: { '200': jsonResponse('Connections', roomConnectionList), '404': notIn },
      },
    },
    '/rooms/{id}/connections/{connectionId}': {
      put: {
        tags: ['rooms'],
        summary: "Let a connection serve the room's requests, or keep it to the owner",
        description:
          'Owners only. Work under way in the room starts again, and permissions waiting in it are withdrawn.',
        requestParams: { path: z.object({ id: z.string(), connectionId: z.string() }) },
        requestBody: json(roomConnectionUpdate),
        responses: {
          '200': jsonResponse('The connection', roomConnectionResponse),
          '403': problem('Only an owner of the room changes this'),
          '404': notIn,
        },
      },
    },
    '/handoffs': {
      get: {
        tags: ['rooms'],
        summary: 'Work rooms asked the signed-in person to run with their own setup',
        description:
          "Each handoff carries the whole task, exactly as it would run, and, once it has run, the exact result. Nothing from the person's own space reaches the room until they share that result.",
        responses: { '200': jsonResponse('Handoffs, newest first', handoffList) },
      },
    },
    '/handoffs/{id}': {
      post: {
        tags: ['rooms'],
        summary: 'Run a handoff with my setup, or decline it',
        description:
          "Accepting names the task's hash, so only the task the person read runs. It runs in the person's own space with their own connections, and anything it sends asks them as usual. Declining tells the room.",
        requestParams: idParam('id', 'Handoff id'),
        requestBody: json(handoffDecision),
        responses: {
          '200': jsonResponse('The handoff', handoffResponse),
          '404': problem('No such handoff for this person'),
          '409': problem(
            'Already answered or expired, the task changed, or the person is no longer in the room',
          ),
        },
      },
    },
    '/handoffs/{id}/result': {
      post: {
        tags: ['rooms'],
        summary: 'Share the result with the room, or keep it',
        description:
          "Sharing names the result's hash and posts that exact text to the thread as the person, through their agent. Keeping tells the room only that the person kept it.",
        requestParams: idParam('id', 'Handoff id'),
        requestBody: json(handoffResultDecision),
        responses: {
          '200': jsonResponse('The handoff', handoffResponse),
          '404': problem('No such handoff for this person'),
          '409': problem(
            'No result yet, already shared or kept, the result changed, or the person is no longer in the room',
          ),
        },
      },
    },
    '/me/linked-accounts': {
      get: {
        tags: ['rooms'],
        summary: 'The chat platform accounts linked to the signed-in person',
        description:
          'A linked account speaks, answers permissions and hears threads in the rooms the ' +
          'person is in, as them. A chat platform links an account after its own sign-in proves ' +
          'who holds it.',
        responses: { '200': jsonResponse('Linked accounts', linkedAccountList) },
      },
    },
    '/me/linked-accounts/{provider}/{externalId}': {
      delete: {
        tags: ['rooms'],
        summary: "Unlink one of the signed-in person's chat platform accounts",
        description:
          'From then on the account can no longer post, answer or hear anything as the person. ' +
          'Changing or resetting the password unlinks every account too.',
        requestParams: { path: z.object({ provider: z.string(), externalId: z.string() }) },
        responses: {
          '200': jsonResponse('Whether a link of this person was removed', linkedAccountRemoval),
        },
      },
    },
    '/rooms/{id}/presence': {
      post: {
        tags: ['rooms'],
        summary: 'Say the signed-in person is looking at the room',
        description: 'Display only: who may read a room is decided by membership, not presence.',
        requestParams: room,
        responses: { '200': jsonResponse('Who is here now', roomPresenceResponse), '404': notIn },
      },
    },
    '/rooms/{id}/memory': {
      get: {
        tags: ['rooms'],
        summary: "What the room's agent remembers, with whose words each detail rests on",
        description:
          'Details people said in the room, and details people shared into it from their own ' +
          "memory. The agent reads nothing else of anyone's memory.",
        requestParams: room,
        responses: {
          '200': jsonResponse('Room memory', roomMemoryView),
          '404': notIn,
          '503': problem('Memory is not running on this installation'),
        },
      },
    },
    '/rooms/{id}/memory/{claimId}/forget': {
      post: {
        tags: ['rooms'],
        summary: "Forget a detail from the room's memory",
        description:
          'An owner of the room forgets any detail; anyone else only a detail from their own ' +
          'words. Forgetting holds across a restore from an older backup.',
        requestParams: { path: z.object({ id: z.string(), claimId: z.string() }) },
        responses: {
          '200': jsonResponse('Forgotten', roomMemoryForgotten),
          '403': problem('Only an owner of the room, or the person whose words it rests on'),
          '404': notIn,
          '503': problem('Memory is not running on this installation'),
        },
      },
    },
    '/rooms/{id}/shares': {
      post: {
        tags: ['rooms'],
        summary: 'Share a detail from your own memory into a room',
        description:
          'A reference, not a copy: the room reads the current value, and forgetting it in your ' +
          'own memory takes it out of the room at once. Members-only shares stay out of the ' +
          "agent's work while a guest is in the room.",
        requestParams: room,
        requestBody: json(shareToRoomRequest),
        responses: {
          '200': jsonResponse('Already shared', roomShareResponse),
          '201': jsonResponse('Shared', roomShareResponse),
          '403': problem('Guests share nothing into a room'),
          '404': problem('Not in this room, or no such detail in your own memory'),
          '409': problem('The detail came from a private conversation and stays yours'),
          '503': problem('Memory is not running on this installation'),
        },
      },
    },
    '/rooms/{id}/shares/{shareId}': {
      delete: {
        tags: ['rooms'],
        summary: 'Withdraw a shared detail from a room',
        description: 'The person who shared it, or an owner of the room.',
        requestParams: { path: z.object({ id: z.string(), shareId: z.string() }) },
        responses: {
          '200': jsonResponse('Withdrawn', roomShareWithdrawn),
          '403': problem('Only the person who shared it, or an owner of the room'),
          '404': notIn,
          '503': problem('Memory is not running on this installation'),
        },
      },
    },
    '/rooms/{id}/messages/{messageId}': {
      delete: {
        tags: ['rooms'],
        summary: 'Delete your own message',
        description:
          "Its words leave the thread, the request it asked, and the room's memory, and stay " +
          'gone after a restore from an older backup. Work under way in the thread starts again ' +
          'without them.',
        requestParams: { path: z.object({ id: z.string(), messageId: z.string() }) },
        responses: {
          '200': jsonResponse('The message, with no words', roomMessageDeleted),
          '403': problem('Only the person who wrote it'),
          '404': notIn,
          '503': problem('Memory is not running on this installation'),
        },
      },
    },
  };
}

export const OPENAPI_VERSION = '0.2.1';

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
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'melete_session' },
          device: { type: 'http', scheme: 'bearer' },
          operator: {
            type: 'http',
            scheme: 'bearer',
            description: 'MELETE_OPERATOR_TOKEN, for the operator’s health detail only.',
          },
          assistant: {
            type: 'http',
            scheme: 'bearer',
            description: 'An access token from the OAuth flow, for the MCP endpoint only.',
          },
        },
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
        { name: 'apps' },
        { name: 'approvals' },
        { name: 'connections' },
        { name: 'devices' },
        { name: 'model-providers' },
        { name: 'knowledge' },
        { name: 'skills' },
        { name: 'memory' },
        { name: 'browser' },
        { name: 'sandbox' },
        { name: 'learning' },
        { name: 'companies' },
        { name: 'voice' },
        { name: 'push' },
        { name: 'situations' },
        { name: 'intents' },
        { name: 'reach' },
        { name: 'assistants' },
        { name: 'feedback' },
      ],
      paths: {
        '/push/public-key': {
          get: {
            tags: ['push'],
            summary: 'The key a browser subscribes with, or null when push is not configured',
            responses: { '200': jsonResponse('Public key', pushPublicKeyResponse) },
          },
        },
        '/push/subscriptions': {
          get: {
            tags: ['push'],
            summary: 'This person’s devices that receive pushes',
            responses: { '200': jsonResponse('Subscriptions', pushSubscriptionList) },
          },
          post: {
            tags: ['push'],
            summary: 'Subscribe this device; the same endpoint again updates it',
            description:
              'Only endpoints on a known browser push service, or an origin the operator added, are accepted, with a P-256 public key and a 16-byte secret.',
            requestBody: json(pushSubscriptionRequest),
            responses: {
              '201': jsonResponse('Subscribed', pushSubscriptionResponse),
              '400': problem(
                'Not a push service this installation sends to, or keys a browser does not subscribe with',
              ),
              '503': problem('Push is not configured'),
            },
          },
        },
        '/push/subscriptions/{id}': {
          delete: {
            tags: ['push'],
            summary: 'Stop pushes to one of this person’s devices',
            requestParams: idParam('id', 'Subscription id'),
            responses: {
              '200': jsonResponse('Removed', pushSubscriptionResponse),
              '404': problem('No such subscription for this person'),
            },
          },
        },
        '/push/settings': {
          get: {
            tags: ['push'],
            summary: 'What Melete pushes, how often, and the quiet hours read from the profile',
            responses: { '200': jsonResponse('Settings', pushSettingsResponse) },
          },
          patch: {
            tags: ['push'],
            summary: 'Change what Melete pushes and how often',
            requestBody: json(pushSettingsUpdate),
            responses: { '200': jsonResponse('Settings', pushSettingsResponse) },
          },
        },
        '/situations': {
          get: {
            tags: ['situations'],
            summary: 'What Melete noticed that may need this person, still live, newest first',
            responses: { '200': jsonResponse('Situations', situationList) },
          },
        },
        '/situations/deadlines': {
          post: {
            tags: ['situations'],
            summary:
              'Keep a deadline on a Google Drive file: if it is still untouched shortly before it is due, Melete raises it',
            requestBody: json(documentDeadlineRequest),
            responses: {
              '201': jsonResponse('Kept', deadlineResponse),
              '400': problem('Not a file or an account this person can keep a deadline on'),
            },
          },
        },
        '/situations/{id}/ack': {
          post: {
            tags: ['situations'],
            summary: 'Say the person saw it; nothing more is pushed about it',
            requestParams: idParam('id', 'Situation id'),
            responses: {
              '200': jsonResponse('Seen', situationResponse),
              '404': problem('No such situation for this person'),
            },
          },
        },
        '/situations/{id}/dismiss': {
          post: {
            tags: ['situations'],
            summary: 'Say it was not useful; it is closed',
            requestParams: idParam('id', 'Situation id'),
            responses: {
              '200': jsonResponse('Dismissed', situationResponse),
              '404': problem('No such situation for this person'),
            },
          },
        },
        '/intents': {
          get: {
            tags: ['intents'],
            summary:
              'What this person asked Melete to see through: open ones, and those that ended in the last day',
            description:
              'Each carries the person’s own words, Melete’s one-line reading with every detail it chose marked as its guess, where it stands, what happens next and its deadline.',
            responses: { '200': jsonResponse('Intents', intentList) },
          },
        },
        '/intents/{id}': {
          patch: {
            tags: ['intents'],
            summary: 'Correct a detail; what the person types becomes theirs',
            requestParams: idParam('id', 'Intent id'),
            requestBody: json(intentEdit),
            responses: {
              '200': jsonResponse('Corrected', intentResponse),
              '400': problem('Not a detail Melete can keep, or a time already passed'),
              '404': problem('No such intent for this person'),
              '409': problem('It ended, or changed since it was read'),
            },
          },
        },
        '/intents/{id}/cancel': {
          post: {
            tags: ['intents'],
            summary:
              'Stop it: its work stops, and what it changed is taken back newest first where it can be',
            requestParams: idParam('id', 'Intent id'),
            responses: {
              '200': jsonResponse('Cancelled', intentCancelResponse),
              '404': problem('No such intent for this person'),
            },
          },
        },
        '/reach': {
          get: {
            tags: ['reach'],
            summary:
              'Whether Melete may text and call this person’s own verified number about deadlines they set, and what it did',
            responses: { '200': jsonResponse('Reach', reachStateResponse) },
          },
        },
        '/reach/number': {
          post: {
            tags: ['reach'],
            summary: 'Text a six-digit code to a number the person says is theirs',
            requestBody: json(reachNumberRequest),
            responses: {
              '200': jsonResponse('Code sent', reachStateResponse),
              '429': problem('Too many codes were asked for'),
              '503': problem('Texts are not set up on this installation'),
            },
          },
          delete: {
            tags: ['reach'],
            summary: 'Forget the number and end the agreement',
            responses: { '200': jsonResponse('Forgotten', reachStateResponse) },
          },
        },
        '/reach/number/verify': {
          post: {
            tags: ['reach'],
            summary: 'Prove the number with the code that was texted to it',
            requestBody: json(reachVerifyRequest),
            responses: {
              '200': jsonResponse('Verified', reachStateResponse),
              '400': problem('The code is wrong or has run out'),
            },
          },
        },
        '/reach/consent': {
          post: {
            tags: ['reach'],
            summary:
              'Agree, once, that Melete may text and optionally call the verified number about deadlines the person set; recorded with the time, the number and the wording',
            requestBody: json(reachConsentRequest),
            responses: {
              '200': jsonResponse('Agreed', reachStateResponse),
              '409': problem('No verified number, or the person replied STOP since'),
            },
          },
          delete: {
            tags: ['reach'],
            summary: 'Withdraw the agreement; nothing more is texted or called',
            responses: { '200': jsonResponse('Withdrawn', reachStateResponse) },
          },
        },
        '/reach/twilio/sms': {
          post: {
            tags: ['reach'],
            summary:
              'Twilio’s incoming-text webhook: a form POST, believed only with a valid X-Twilio-Signature for this address. STOP ends texts and calls, START undoes it, any other reply from a verified number acknowledges what Melete was escalating',
            responses: {
              '200': { description: 'An empty TwiML document' },
              '403': { description: 'Not signed by this installation’s Twilio account' },
            },
          },
        },
        '/reach/twilio/status/{id}': {
          post: {
            tags: ['reach'],
            summary: 'Twilio’s delivery receipt for one text or call, signed as above',
            requestParams: idParam('id', 'Contact id'),
            responses: {
              '204': { description: 'Recorded' },
              '403': { description: 'Not signed by this installation’s Twilio account' },
            },
          },
        },
        '/reach/twilio/key/{id}': {
          post: {
            tags: ['reach'],
            summary:
              'A key pressed on a call, signed as above: 1 acknowledges, 9 ends texts and calls',
            requestParams: idParam('id', 'Contact id'),
            responses: {
              '200': { description: 'TwiML with what the call says next' },
              '403': { description: 'Not signed by this installation’s Twilio account' },
            },
          },
        },
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
        '/learned': {
          get: {
            tags: ['learning'],
            summary: 'List what the signed-in person taught, in their own words',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('What was learned', learnedList) },
          },
        },
        '/learned/{id}/try': {
          post: {
            tags: ['learning'],
            summary: 'Try something learned on your own work, approving the exact definition shown',
            requestParams: idParam('id', 'Learned item id'),
            requestBody: json(learnedTryRequest),
            responses: { '200': jsonResponse('On trial', learnedItemResponse) },
          },
        },
        '/learned/{id}/share': {
          post: {
            tags: ['learning'],
            summary: 'Share something you kept with your shared space, when sealed evidence exists',
            requestParams: idParam('id', 'Learned item id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Shared', learnedItemResponse) },
          },
        },
        '/learned/{id}/pause': {
          post: {
            tags: ['learning'],
            summary: 'Stop using it until resumed',
            requestParams: idParam('id', 'Learned item id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Paused', learnedItemResponse) },
          },
        },
        '/learned/{id}/resume': {
          post: {
            tags: ['learning'],
            summary: 'Use it again',
            requestParams: idParam('id', 'Learned item id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Resumed', learnedItemResponse) },
          },
        },
        '/learned/{id}/remove': {
          post: {
            tags: ['learning'],
            summary: 'Remove it from the list and stop using it',
            requestParams: idParam('id', 'Learned item id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Removed', learnedItemResponse) },
          },
        },
        '/learned/undo': {
          post: {
            tags: ['learning'],
            summary: 'Undo your latest change, named by the id you were shown',
            requestBody: json(learnedUndoRequest),
            responses: { '200': jsonResponse('Undone', learnedItemResponse) },
          },
        },
        '/learning/notices': {
          get: {
            tags: ['learning'],
            summary: 'Open "keep doing this?" questions and unread notices that something stopped',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Notices', learningNoticeList) },
          },
        },
        '/learning/notices/{id}/answer': {
          post: {
            tags: ['learning'],
            summary: 'Answer yes, no or change to a "keep doing this?" question',
            requestParams: idParam('id', 'Notice id'),
            requestBody: json(keepAnswerRequest),
            responses: { '200': jsonResponse('Answered', keepAnswerResponse) },
          },
        },
        '/learning/notices/{id}/read': {
          post: {
            tags: ['learning'],
            summary: 'Dismiss a notice that something stopped',
            requestParams: idParam('id', 'Notice id'),
            requestBody: json(learningSpaceRequest),
            responses: { '200': jsonResponse('Read', learningNoticeResponse) },
          },
        },
        '/engine-skills': {
          get: {
            tags: ['learning'],
            summary: 'List the skills the engine wrote for itself in this space',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Engine skills', engineSkillListResponse) },
          },
        },
        '/own-skills': {
          get: {
            tags: ['learning'],
            summary: "List the person's own skills in their personal space",
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Own skills', ownSkillListResponse) },
          },
        },
        '/own-skills/{name}/edit': {
          post: {
            tags: ['learning'],
            summary: "Change one of the person's own skills, against the version they were shown",
            requestParams: { path: z.object({ name: ownSkillName() }) },
            requestBody: json(ownSkillEditRequest),
            responses: { '200': jsonResponse('Changed skill', ownSkillResponse) },
          },
        },
        '/own-skills/{name}/delete': {
          post: {
            tags: ['learning'],
            summary: "Delete one of the person's own skills, against the version they were shown",
            requestParams: { path: z.object({ name: ownSkillName() }) },
            requestBody: json(ownSkillDeleteRequest),
            responses: { '200': jsonResponse('Deleted skill', ownSkillDeleteResponse) },
          },
        },
        '/engine-skills/held': {
          get: {
            tags: ['learning'],
            summary: 'List engine-written skills waiting for the owner to read them',
            requestParams: { query: learningSpaceQuery },
            responses: { '200': jsonResponse('Held engine skills', engineSkillListResponse) },
          },
        },
        '/engine-skills/prohibitions': {
          get: {
            tags: ['learning'],
            summary:
              'List the standing prohibitions this person placed on engine skills, in any space',
            requestParams: { query: learningSpaceQuery },
            responses: {
              '200': jsonResponse('Prohibitions', engineSkillProhibitionListResponse),
            },
          },
        },
        '/engine-skills/prohibitions/{id}/lift': {
          post: {
            tags: ['learning'],
            summary: 'Lift a standing prohibition on an engine skill',
            requestParams: idParam('id', 'Prohibition id'),
            requestBody: json(learningSpaceRequest),
            responses: {
              '200': jsonResponse('Lifted prohibition', engineSkillProhibitionResponse),
            },
          },
        },
        '/engine-skills/{id}/approve': {
          post: {
            tags: ['learning'],
            summary: 'Approve the exact bytes of a held engine-written skill',
            requestParams: idParam('id', 'Skill id'),
            requestBody: json(engineSkillApprovalRequest),
            responses: { '200': jsonResponse('Live engine skill', engineSkillResponse) },
          },
        },
        '/engine-skills/{id}/edit': {
          post: {
            tags: ['learning'],
            summary: 'Replace an engine-written skill with the owner’s own text',
            requestParams: idParam('id', 'Skill id'),
            requestBody: json(engineSkillEditRequest),
            responses: { '200': jsonResponse('Edited engine skill', engineSkillResponse) },
          },
        },
        '/engine-skills/{id}/stop': {
          post: {
            tags: ['learning'],
            summary:
              'Stop an engine-written skill and prohibit its name and body in every space until lifted',
            requestParams: idParam('id', 'Skill id'),
            requestBody: json(procedureReasonRequest),
            responses: { '200': jsonResponse('Stopped engine skill', engineSkillResponse) },
          },
        },
        ...Object.fromEntries(
          (
            [
              ['decline', 'Decline a held engine-written skill and erase its body'],
              ['delete', 'Delete an engine-written skill and erase its body'],
              ['pause', 'Stop delivering an engine-written skill from the next attempt'],
              ['resume', 'Deliver a paused engine-written skill again'],
            ] as const
          ).map(([action, summary]) => [
            `/engine-skills/{id}/${action}`,
            {
              post: {
                tags: ['learning'],
                summary,
                requestParams: idParam('id', 'Skill id'),
                requestBody: json(learningSpaceRequest),
                responses: { '200': jsonResponse('Engine skill', engineSkillResponse) },
              },
            },
          ]),
        ),
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
              '403': problem('Space owner required, or no such space'),
              '409': problem('The browser worker uses this space'),
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
              '403': problem('Space owner required, or no such space'),
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
              '404': problem('This space is not being removed, or not by the person asking'),
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
        ...roomsPaths(),
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

        '/health/detail': {
          get: {
            tags: ['health'],
            summary: 'Each health check the operator alerts on, with what it found',
            description:
              'The database, the runtime that runs attempts, the job queue (work due more than ' +
              'ten minutes ago that has not started) and the error rate over the last fifteen ' +
              'minutes. Takes MELETE_OPERATOR_TOKEN as a bearer token; without that setting the ' +
              'route answers 404. Answers 503 while any check fails, so an uptime monitor can watch it.',
            security: [{ operator: [] }],
            responses: {
              '200': jsonResponse('Every check passed', healthDetailResponse),
              '401': problem('The operator token is missing or wrong'),
              '404': problem('MELETE_OPERATOR_TOKEN is not set'),
              '503': jsonResponse('At least one check failed', healthDetailResponse),
            },
          },
        },

        '/setup': {
          get: {
            tags: ['account'],
            summary: 'Whether the first account still needs to be created',
            description:
              'Public, like setup itself, so a browser with no session can choose between ' +
              'creating the account and signing in. `needed` is true until an owner exists. ' +
              '`multiplayer` says whether rooms, shared spaces, guests and hand-offs are ' +
              'switched on (`MELETE_PREVIEW_MULTIPLAYER`); off, their routes answer 404 ' +
              '`not_available`. `code_required` says whether setup needs the one-time setup ' +
              'code, and `email_sign_in` whether this installation can email sign-in and ' +
              'password reset links.',
            responses: {
              '200': jsonResponse('Whether setup is needed', setupStatusResponse),
              '503': problem('No database is configured'),
            },
          },
          post: {
            tags: ['account'],
            summary: 'Create the owner, their personal space and a session, once',
            description:
              'Sets the melete_session cookie, and the melete_device cookie that marks this browser ' +
              'as known for sign-in limits. Once an owner exists the answer is 409 before anything ' +
              'is parsed. When the installation has a setup code (`MELETE_SETUP_CODE_HASH`, or ' +
              'one `melete account setup-code` issued), `setup_code` must be it; a missing or ' +
              'wrong code is 403 `setup_code_required` or `invalid_setup_code`, and counts ' +
              'against the setup limit.',
            requestBody: json(setupRequest),
            responses: {
              '201': jsonResponse('The owner, signed in', ownerResponse),
              '400': problem(
                'An email and a password of 10 to 1024 characters are required, and the password is not a common one',
              ),
              '403': problem(
                'The request came from another origin, or the setup code is missing or wrong',
              ),
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
          patch: {
            tags: ['account'],
            summary: 'Change the name other people in a room see',
            security: [{ session: [] }],
            requestBody: json(updateMeRequest),
            responses: {
              '200': jsonResponse('The signed-in account', meResponse),
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
            description:
              'Every field of each action, or with `view=summary` only what a person is shown of ' +
              'it. GET /actions/{actionId} always returns the full record.',
            requestParams: { query: actionListQuery },
            responses: {
              '200': jsonResponse(
                'Actions',
                z.union([actionListResponse, actionSummaryListResponse]),
              ),
            },
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
              'as a reconciliation, and the action is never re-dispatched. It settles only an action on ' +
              "one of the caller's own jobs whose status is unknown or unresolved.",
            requestParams: idParam('actionId', 'Action id'),
            requestBody: json(resolveActionRequest),
            responses: {
              '200': jsonResponse('Resolved', actionResponse),
              '403': problem('No signed-in person to record the answer for'),
              '404': problem("No such action among the caller's own"),
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

        '/plugins': {
          get: {
            tags: ['connections'],
            summary: 'List the plugins that can be added with one tap',
            description:
              'Each plugin is a tool server Melete runs in a container of its own, at a pinned ' +
              'version. `fields` are the few values a person supplies; `installed` names the ' +
              'connection already running it in the space. Empty when this service does not run ' +
              'plugin containers.',
            requestParams: {
              query: z.object({ space_id: z.string().optional() }),
            },
            responses: { '200': jsonResponse('Plugins', pluginListResponse) },
          },
        },

        '/plugins/{pluginId}': {
          post: {
            tags: ['connections'],
            summary: 'Add a plugin from the catalog',
            description:
              'Builds the installation from the catalog entry and the supplied values, then installs ' +
              'it exactly as `POST /connections` does. Secret values are sealed on arrival and given ' +
              'only to the plugin. The service starts it when a tool is first used, stops it when ' +
              'idle, and moves it to the pinned version of each release.',
            requestParams: idParam('pluginId', 'Catalog entry id'),
            requestBody: json(installPluginRequest),
            responses: {
              '201': jsonResponse('Added', installPluginResponse),
              '400': problem('A value is missing or invalid'),
              '403': problem('Space owner and matching audience required'),
              '404': problem('No such plugin'),
              '409': problem('The plugin is already added to this space'),
            },
          },
        },

        '/mcp-sign-ins': {
          post: {
            tags: ['connections'],
            summary: 'Start connecting a remote MCP server by signing in to it',
            description:
              "Reads the server's protected resource metadata (RFC 9728) and its authorization " +
              "server's metadata, registers a client (the one given, a Client ID Metadata Document, " +
              'or dynamic registration), and answers with the address to open in the browser. The ' +
              'request carries PKCE (S256), a state and the resource indicator (RFC 8707). When the ' +
              'browser returns, the credential is sealed and the server is installed with the grants ' +
              'in `mcp`, exactly as a connection with a pasted credential is. With `connection_id` ' +
              'instead, it signs in again for that connection, asking for everything granted before ' +
              'and any scopes it has needed since, and gives it the new credential.',
            requestBody: json(mcpSignInRequest),
            responses: {
              '201': jsonResponse('Open `authorize_url` in the browser', mcpSignInStart),
              '400': problem('Invalid request or server address'),
              '403': problem('Space owner and matching audience required'),
              '409': problem(
                'No public address to return to, no master key, a server that needs no sign-in, or one that needs a client registered by hand',
              ),
              '502': problem('The server or its authorization server did not answer as required'),
            },
          },
        },

        '/mcp-sign-ins/{id}': {
          get: {
            tags: ['connections'],
            summary: 'Read how a sign-in is going',
            requestParams: idParam('id', 'Sign-in id'),
            responses: {
              '200': jsonResponse('Pending, connected, or failed with a code', mcpSignInStatus),
              '404': problem('No sign-in by that id for this person'),
            },
          },
        },

        '/mcp-sign-ins/{id}/install': {
          post: {
            tags: ['connections'],
            summary: 'Install a server signed in to by its address, with the tools the person kept',
            description:
              'For a sign-in started with `discover`, once its status is `ready`: installs the ' +
              'server with the tools named here and how far each may act, one grant per tool, ' +
              'with the credential the sign-in earned. A tool the server did not list is refused.',
            requestParams: idParam('id', 'Sign-in id'),
            requestBody: json(mcpSignInInstall),
            responses: {
              '201': jsonResponse('Installed', connectionResponse),
              '400': problem('No tools, or a tool the server did not list'),
              '403': problem('Space owner and matching audience required'),
              '404': problem('No ready sign-in by that id for this person'),
            },
          },
        },

        '/mcp-servers/discover': {
          post: {
            tags: ['connections'],
            summary: 'Read the tools of an MCP server added by its address',
            description:
              'Asks the server for its tools (`tools/list`) and answers with each one and where ' +
              'Melete suggests it starts: a read, a change that can be undone, a change that asks ' +
              'first, or spending. Nothing is installed. A server that wants a sign-in answers ' +
              '`needs_sign_in`; start one with `discover` on `POST /mcp-sign-ins`.',
            requestBody: json(mcpToolDiscoveryRequest),
            responses: {
              '200': jsonResponse('Its tools, or that it wants a sign-in', mcpToolDiscovery),
              '400': problem('Not an MCP server, a refused token, or an address out of reach'),
              '403': problem('Space owner and matching audience required'),
              '502': problem('The server could not be reached'),
            },
          },
        },

        '/oauth/callback': {
          get: {
            tags: ['connections'],
            summary: 'Where the authorization server returns the browser after signing in',
            description:
              'Checks the state and the issuer (RFC 9207) before the code is spent, then installs ' +
              'the connection. Answers with a short page for the browser; the outcome is also ' +
              'available from the sign-in status.',
            requestParams: {
              query: z.object({
                code: z.string().optional(),
                state: z.string().optional(),
                iss: z.string().optional(),
                error: z.string().optional(),
              }),
            },
            responses: {
              '200': {
                description: 'Connected',
                content: { 'text/html': { schema: z.string() } },
              },
              '400': {
                description: 'The response was refused',
                content: { 'text/html': { schema: z.string() } },
              },
              '404': {
                description: 'No such sign-in for this person',
                content: { 'text/html': { schema: z.string() } },
              },
            },
          },
        },

        '/oauth/client-metadata.json': {
          get: {
            tags: ['connections'],
            summary: "This service's OAuth Client ID Metadata Document",
            description:
              'Published when the service has an https:// public address, so an authorization server ' +
              'that supports Client ID Metadata Documents can identify it without registration. No ' +
              'session is needed.',
            responses: {
              '200': jsonResponse(
                'The client metadata',
                z.object({
                  client_id: z.url(),
                  client_name: z.string(),
                  redirect_uris: z.array(z.url()),
                  grant_types: z.array(z.string()),
                  response_types: z.array(z.string()),
                  token_endpoint_auth_method: z.string(),
                }),
              ),
              '404': problem('No https:// public address is configured'),
            },
          },
        },

        ...assistantPaths,

        '/managed-sign-ins': {
          post: {
            tags: ['connections'],
            summary: 'Start connecting Google through Composio',
            description:
              "Offered when the operator has set a Composio key. Composio's own Google app asks for " +
              'consent and keeps the tokens; Melete keeps which Composio account each connection acts ' +
              'for. One sign-in connects Gmail and Google Calendar, one consent page each; with ' +
              '`documents`, Google Drive alone. Each account comes back as connections with the same ' +
              'tools, approvals and receipts as a native Google sign-in. An address already ' +
              'connected in the space through Composio is refused; one connected natively moves to ' +
              'Composio and keeps its connection.',
            requestBody: json(managedSignInRequest),
            responses: {
              '201': jsonResponse('Open `authorize_url` in the browser', managedSignInStart),
              '400': problem('Invalid request'),
              '403': problem('Space owner and matching audience required'),
              '409': problem('No Composio key, no public address to return to, or no master key'),
              '502': problem('Composio did not answer'),
            },
          },
        },

        '/managed-sign-ins/{id}': {
          get: {
            tags: ['connections'],
            summary: 'Read how a sign-in through Composio is going',
            requestParams: idParam('id', 'Sign-in id'),
            responses: {
              '200': jsonResponse(
                'Pending, connected with its connections, or failed with a code',
                accountSignInStatus,
              ),
              '404': problem('No sign-in by that id for this person'),
            },
          },
        },

        '/managed-sign-ins/callback': {
          get: {
            tags: ['connections'],
            summary: 'Where Composio returns the browser after each consent page',
            description:
              'Checks the single-use state, that the returned account is the one this step made, and ' +
              "reads the account again from Composio: this person's, of the toolkit asked for, and " +
              'active. Connects that part, then sends the browser on to the next consent page, or ' +
              'answers with a short page when the sign-in is done.',
            requestParams: {
              query: z.object({
                state: z.string().optional(),
                status: z.string().optional(),
                connected_account_id: z.string().optional(),
              }),
            },
            responses: {
              '200': {
                description: 'Connected',
                content: { 'text/html': { schema: z.string() } },
              },
              '302': { description: 'On to the next consent page' },
              '400': {
                description: 'The response was refused',
                content: { 'text/html': { schema: z.string() } },
              },
              '404': {
                description: 'No such sign-in for this person',
                content: { 'text/html': { schema: z.string() } },
              },
            },
          },
        },

        ...accountSignInPaths('google', {
          title: 'Google',
          what: 'Gmail and Google Calendar',
          consent:
            'One consent asks to read mail, send mail and manage calendar events; drafts stay in Melete.',
        }),

        ...accountSignInPaths('microsoft', {
          title: 'Microsoft',
          what: 'Outlook mail and calendar',
          consent:
            'One consent asks to read the profile, read mail, send mail and read and write calendars; drafts stay in Melete. Personal and work or school accounts can sign in.',
        }),

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

        '/connections/{connectionId}/texts': {
          get: {
            tags: ['connections'],
            summary: 'Read the texts that reached a Twilio number',
            description:
              'The latest hundred, newest first. A text from one of the numbers given as your own ' +
              'went to your texting conversation; a text from any other number is only kept here, ' +
              'to be read, and was never acted on.',
            requestParams: idParam('connectionId', 'Connection id'),
            responses: {
              '200': jsonResponse('Texts', smsTextListResponse),
              '403': problem('Space owner required'),
              '404': problem('No such text-message connection'),
            },
          },
        },

        '/sms/twilio/{connectionId}': {
          post: {
            tags: ['connections'],
            summary: 'Where Twilio delivers a text that reached the number',
            description:
              'Called by Twilio, not by a person, at `<MELETE_PUBLIC_URL>/api/sms/twilio/<connection>`. ' +
              'No session is needed: the request is believed only when its `X-Twilio-Signature` is ' +
              "Twilio's HMAC-SHA1 of that exact address and the posted parameters under the " +
              "connection's auth token, and it names the connection's own account and number. A " +
              'message Twilio delivers twice is handled once.',
            requestParams: {
              ...idParam('connectionId', 'Connection id'),
              header: z.object({ 'X-Twilio-Signature': z.string() }),
            },
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: z.object({
                    MessageSid: z.string(),
                    AccountSid: z.string(),
                    From: z.string(),
                    To: z.string(),
                    Body: z.string(),
                    NumMedia: z.string().optional(),
                  }),
                },
              },
            },
            responses: {
              '200': {
                description: 'Received; the answer, if any, follows by text',
                content: { 'text/xml': { schema: z.string() } },
              },
              '403': {
                description: 'Not a signed text for an active connection',
                content: { 'text/plain': { schema: z.string() } },
              },
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
              'Returns the recorded bytes only while their hash matches the artifact receipt. Audio can be played directly; a single byte range can be requested for seeking. Every other file is sent as an attachment unless `disposition=inline` is asked for and it is a PDF, a PNG, JPEG, GIF or WebP picture, or text (sent as plain text); a web page or an SVG is never shown in place.',
            security: [{ session: [] }],
            requestParams: {
              ...idParam('id', 'Artifact id from the action receipt'),
              query: fileDisposition,
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
        '/files/{id}/content': {
          get: {
            tags: ['artifacts'],
            summary: 'Retrieve the file a files action saved or moved, for its own conversation',
            description:
              'The file a succeeded files.write, files.move or files.save_attachment left in the person’s Files or the conversation’s workspace, for the person whose conversation it was. Served only while it is the content the receipt recorded. Sent as an attachment unless `disposition=inline` is asked for and it is a PDF, a PNG, JPEG, GIF or WebP picture, or text (sent as plain text); a web page or an SVG is never shown in place.',
            security: [{ session: [] }],
            requestParams: {
              ...idParam('id', 'The files action, from a result card'),
              query: fileDisposition,
              header: z.object({ Range: z.string().optional() }),
            },
            responses: {
              '200': {
                description: 'File bytes',
                content: {
                  'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
                },
              },
              '206': {
                description: 'Requested byte range',
                content: {
                  'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
                },
              },
              '401': problem('A session is required'),
              '404': problem('No such file for this person, or it has changed since it was saved'),
              '416': { description: 'Requested range is outside the file' },
            },
          },
        },
        '/screenshots/{id}': {
          get: {
            tags: ['artifacts'],
            summary: 'Retrieve the picture a screenshot took, for its own conversation',
            description:
              'A succeeded screenshot of the agent’s own computer or of a paired computer, for the ' +
              'person whose work it was. Served only while it is the picture the receipt recorded.',
            security: [{ session: [] }],
            requestParams: idParam('id', 'The screenshot action, from a trail entry'),
            responses: {
              '200': {
                description: 'The picture',
                content: { 'image/png': { schema: z.string().meta({ format: 'binary' }) } },
              },
              '401': problem('A session is required'),
              '404': problem('No such screenshot for this person'),
            },
          },
        },
        '/attachments': {
          post: {
            tags: ['experience'],
            summary: 'Upload a file to send with a message',
            description:
              'Multipart form data: the file in `file`, and for a picture optionally a small copy ' +
              'in `preview` (at most 1280 pixels on its longest side, small enough for a model ' +
              'request). Pictures, PDFs, Word documents, spreadsheets and text files are taken, up ' +
              'to the size `GET /attachments/limits` gives (20 MB unless the operator sets ' +
              'another). The file waits, visible only to whoever uploaded it, until a message ' +
              'names it in `attachments`; one never sent is deleted after a day. A sent file ' +
              'belongs to its chat and is deleted with it.',
            security: [{ session: [] }],
            requestBody: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: z.object({
                    file: z.string().meta({ format: 'binary' }),
                    preview: z.string().meta({ format: 'binary' }).optional(),
                  }),
                },
              },
            },
            responses: {
              '201': jsonResponse('The file, ready to send', attachmentResponse),
              '400': problem('Empty, unreadable, or not the kind of file it says it is'),
              '401': problem('A session is required'),
              '413': problem('Larger than the limit'),
              '415': problem('A kind of file Melete does not read'),
              '429': problem('More uploads at once, or in a while, than the operator allows'),
            },
          },
        },
        '/attachments/limits': {
          get: {
            tags: ['experience'],
            summary: 'What files this installation takes',
            description:
              'The largest file, the most files in one message, and how many uploads one ' +
              'person may have under way at once: half of what the whole service holds (8 by ' +
              "default), or the operator's lower limit. A client queues its uploads to that " +
              'number, so a person never meets the refusal past it.',
            security: [{ session: [] }],
            responses: {
              '200': jsonResponse('The limits', attachmentLimits),
              '401': problem('A session is required'),
            },
          },
        },
        '/attachments/{id}/content': {
          get: {
            tags: ['experience'],
            summary: 'Read back a file sent, or about to be sent, in chat',
            description:
              'For whoever uploaded it before it is sent, and for the person whose chat it is ' +
              'after. `variant=preview` reads the small copy a picture has.',
            security: [{ session: [] }],
            requestParams: {
              ...idParam('id', 'Attachment id'),
              query: attachmentContentQuery,
            },
            responses: {
              '200': {
                description: 'The bytes',
                content: {
                  'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
                },
              },
              '401': problem('A session is required'),
              '404': problem('No such file for this person'),
            },
          },
        },
        '/attachments/{id}': {
          delete: {
            tags: ['experience'],
            summary: 'Take back a file not sent yet',
            security: [{ session: [] }],
            requestParams: idParam('id', 'Attachment id'),
            responses: {
              '200': jsonResponse('Deleted', z.object({ ok: z.literal(true) })),
              '404': problem('No such file for this person'),
              '409': problem('Already sent; it is deleted with its chat'),
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
        '/sandbox/computers': {
          get: {
            tags: ['sandbox'],
            summary: "Find the computer in a job's sandbox",
            description:
              "The desktop of the sandbox the job's agent works in, with who is driving it. Only " +
              'the person who owns the job may ask. Empty when the job has used no sandbox with a desktop.',
            requestParams: { query: sandboxComputerQuery },
            responses: {
              '200': jsonResponse("The job's computers", sandboxComputerList),
              '401': problem('Owner authentication required'),
              '404': problem('No such job'),
            },
          },
        },
        '/sandbox/sessions/{id}/takeover': {
          post: {
            tags: ['sandbox'],
            summary: 'Take control of the computer from the agent',
            description:
              'Requires the owner session and same-origin protection. The control epoch is ' +
              'incremented and the job is parked waiting for input before this answers; every ' +
              'computer action the agent planned before is refused from then on. With ' +
              '`control_epoch`, control changes only from that epoch; otherwise 409. Control ' +
              'returns to the agent after 30 minutes with no live view open.',
            requestParams: idParam('id', 'Sandbox session id from GET /sandbox/computers'),
            requestBody: {
              required: false,
              content: { 'application/json': { schema: sandboxControlRequest } },
            },
            responses: {
              '200': jsonResponse('The person holds control', sandboxControlResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such computer'),
              '409': problem('Control could not change'),
            },
          },
        },
        '/sandbox/sessions/{id}/handback': {
          post: {
            tags: ['sandbox'],
            summary: 'Give the computer back to the agent',
            description:
              'Increments the control epoch again, and the work the takeover paused goes on. ' +
              'With `control_epoch`, control changes only from that epoch; otherwise 409.',
            requestParams: idParam('id', 'Sandbox session id from GET /sandbox/computers'),
            requestBody: {
              required: false,
              content: { 'application/json': { schema: sandboxControlRequest } },
            },
            responses: {
              '200': jsonResponse('The agent holds control', sandboxControlResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such computer'),
              '409': problem('Control could not change'),
            },
          },
        },
        '/sandbox/sessions/{id}/live': {
          post: {
            tags: ['sandbox'],
            summary: "Open a live view of the sandbox's desktop",
            description:
              'Watching is allowed while the agent drives; input only while the person holds ' +
              'control. The live id is held in memory and bound to this principal, session, ' +
              'control epoch and address. One view per computer.',
            requestParams: idParam('id', 'Sandbox session id from GET /sandbox/computers'),
            responses: {
              '200': jsonResponse('The live view is open', liveOpen),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused'),
              '404': problem('No such computer'),
              '409': problem('The live view could not open'),
            },
          },
        },
        '/sandbox/sessions/{id}/live/frames': {
          get: {
            tags: ['sandbox'],
            summary: 'Follow the desktop as Server-Sent Events',
            description:
              'JPEG frames of the whole desktop, paced and written through, never stored, and the ' +
              'end of the view. Only frames carry an id; a reconnect is repainted from the screen as it is now.',
            requestParams: {
              ...idParam('id', 'Sandbox session id from GET /sandbox/computers'),
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
              '404': problem('No such computer'),
              '410': problem('The live view is closed'),
            },
          },
        },
        '/sandbox/sessions/{id}/live/input': {
          post: {
            tags: ['sandbox'],
            summary: "Send a person's input to the desktop",
            description:
              'Pointer, wheel, key and text events at the live viewport, dispatched in order. ' +
              'Refused unless the person holds control under the epoch the view was opened with.',
            requestParams: idParam('id', 'Sandbox session id from GET /sandbox/computers'),
            requestBody: json(liveUp),
            responses: {
              '200': jsonResponse('Events accepted in order', liveInputResponse),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such computer'),
              '409': problem('The person does not hold control'),
              '410': problem('The live view is closed'),
            },
          },
        },
        '/sandbox/sessions/{id}/live/close': {
          post: {
            tags: ['sandbox'],
            summary: 'Close the live view of the desktop',
            description: 'Ends the view; control stays where it is.',
            requestParams: idParam('id', 'Sandbox session id from GET /sandbox/computers'),
            requestBody: json(liveClose),
            responses: {
              '200': jsonResponse('The live view is closed', liveClosed),
              '401': problem('Owner authentication required'),
              '403': problem('Request origin refused, or another person or address'),
              '404': problem('No such computer'),
              '410': problem('The live view was already closed'),
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
                  note: z.string().optional().meta({
                    description:
                      'Present when the scan stopped at the daily allowance; the rest are read on a later scan',
                  }),
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

        '/waiting-on': {
          get: {
            tags: ['companies'],
            summary: 'What this person is waiting on: money owed to them, and replies',
            description:
              'Combines the company map’s owed items with messages the person sent that ' +
              'asked for something and have not been answered after three days. The owed ' +
              'figure is the company map’s own. `top` holds up to three nothing is chasing ' +
              'yet. A reply nothing is chasing that went out more than thirty days ago is ' +
              'left out. Reads only; a scan is started with ' +
              '`POST /spaces/{spaceId}/companies/scan` in the space `scan.space_id` names.',
            requestParams: {
              query: z.object({
                space_id: z
                  .string()
                  .optional()
                  .meta({ description: 'One space; every space the person can see if absent' }),
              }),
            },
            responses: {
              '200': jsonResponse('What is waited on, and the latest scan', waitingOn),
              '403': problem('This space is not accessible to the signed-in account'),
            },
          },
        },
        '/waiting-on/replies/{id}/chase': {
          post: {
            tags: ['companies'],
            summary: 'Start the job that chases a reply the person is waiting on',
            description:
              'Creates the job that runs the chase-reply playbook for one sent message. The ' +
              'follow-up goes through the existing approval path, which shows the exact text; ' +
              'this route starts the work, it does not send.',
            requestParams: {
              ...idParam('id', 'Awaited reply id'),
              query: z.object({ space_id: z.string().optional() }),
            },
            responses: {
              '200': jsonResponse(
                'Already being chased, by the job named here',
                z.object({ job_id: z.string() }),
              ),
              '201': jsonResponse('The job now chasing it', z.object({ job_id: z.string() })),
              '404': problem('No such awaited reply for this person'),
              '409': problem('Already finished, or no longer quotable'),
              '503': problem('Chasing is not connected yet'),
            },
          },
        },
        '/waiting-on/replies/{id}/drop': {
          post: {
            tags: ['companies'],
            summary: 'Dismiss a reply the person is no longer waiting on',
            description:
              'Marks the awaited reply dropped, so it leaves the list and a later scan does ' +
              'not bring it back. A chase that has it is stopped first.',
            requestParams: {
              ...idParam('id', 'Awaited reply id'),
              query: z.object({ space_id: z.string().optional() }),
            },
            responses: {
              '200': jsonResponse('The reply, now dropped', awaitedReply),
              '404': problem('No such awaited reply for this person'),
              '503': problem('Stopping its chase is not connected yet'),
            },
          },
        },
        '/needs-you': {
          get: {
            tags: ['companies'],
            summary: 'What needs the signed-in person, ranked',
            description:
              'New mail and calendar changes from the accounts the person connected, as sorted ' +
              'by a small model into needs you, for your information, or ignore, together with ' +
              'what Melete noticed on its own. Only items that need the person are listed, most ' +
              'pressing first; ones the person dismissed are left out. Sorting only labels: it ' +
              'never makes anything urgent, starts work or sends anything. Reads only.',
            responses: {
              '200': jsonResponse(
                'What needs the person, and how many items went unsorted today',
                needsYouList,
              ),
            },
          },
        },
        '/needs-you/{id}/source': {
          post: {
            tags: ['companies'],
            summary: 'Attach a sorted item\u2019s source to a new chat',
            description:
              'Writes the message\u2019s headers, or the calendar change\u2019s fields, into a text ' +
              'file in the signed-in space, for "Handle it" to send with its message. The ' +
              'message itself names only the item\u2019s source handle; the file reaches the ' +
              'agent as untrusted data. An item from another space is refused.',
            requestParams: idParam('id', 'Sorted item id'),
            responses: {
              '201': jsonResponse('The attached file', attachmentResponse),
              '404': problem('No such item for this person'),
              '409': problem('The item came from another space'),
            },
          },
        },
        '/needs-you/{id}/ack': {
          post: {
            tags: ['companies'],
            summary: 'Mark a sorted item as seen',
            description:
              'For items whose `source` is `triage`. Something Melete noticed on its own is ' +
              'acknowledged through its own situation routes.',
            requestParams: idParam('id', 'Sorted item id'),
            responses: {
              '200': jsonResponse('The item, now seen', needsYouItemResponse),
              '404': problem('No such item for this person'),
            },
          },
        },
        '/needs-you/{id}/dismiss': {
          post: {
            tags: ['companies'],
            summary: 'Dismiss a sorted item: it leaves the list',
            description: 'For items whose `source` is `triage`. The item is not shown again.',
            requestParams: idParam('id', 'Sorted item id'),
            responses: {
              '200': jsonResponse('The item, now dismissed', needsYouItemResponse),
              '404': problem('No such item for this person'),
            },
          },
        },

        '/ledger/{id}/stop': {
          post: {
            tags: ['companies'],
            summary: 'Stop handling this item',
            description:
              'Cancels the job chasing the item, if one still runs, and returns the item to ' +
              'open so it can be handled again later.',
            requestParams: {
              ...idParam('id', 'Ledger item id'),
              query: z.object({ space_id: z.string().optional() }),
            },
            responses: {
              '200': jsonResponse('The item, open again', ledgerItem),
              '404': problem('No such item for this person'),
              '409': problem('The item is already settled or dropped'),
              '503': problem('Stopping is not connected yet'),
            },
          },
        },

        '/feedback': {
          post: {
            tags: ['feedback'],
            summary: 'Report a problem with the app',
            description:
              'Stores what the person wrote and what the page said about itself, and answers with a ' +
              'short id such as `FB-7K3Q` to quote when asking for a fix. Console lines, request ' +
              'addresses and the route are redacted again before they are stored. Each person may ' +
              'send a few reports in a short time; more are refused until the window passes.',
            requestBody: json(createFeedbackRequest),
            responses: {
              '201': jsonResponse('Stored', feedbackResponse),
              '400': problem('Invalid request'),
              '401': problem('A session is required'),
              '429': rateLimited('Too many reports from this person in a short time'),
            },
          },
          get: {
            tags: ['feedback'],
            summary: 'List problem reports, newest first',
            description:
              'The person who runs the installation sees every report and `can_manage` is true. ' +
              'Anyone else sees only the reports they sent.',
            requestParams: { query: feedbackListQuery },
            responses: {
              '200': jsonResponse('Reports', feedbackListResponse),
              '401': problem('A session is required'),
            },
          },
        },

        '/feedback/{id}': {
          get: {
            tags: ['feedback'],
            summary: 'Read one problem report with its page details',
            requestParams: idParam('id', 'Report id, such as FB-7K3Q'),
            responses: {
              '200': jsonResponse('Report', feedbackResponse),
              '404': problem('No such report, or not one this person sent'),
            },
          },
          patch: {
            tags: ['feedback'],
            summary: 'Change a report’s status, with an optional note',
            requestParams: idParam('id', 'Report id, such as FB-7K3Q'),
            requestBody: json(updateFeedbackRequest),
            responses: {
              '200': jsonResponse('Updated', feedbackResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the person who runs the installation changes a status'),
              '404': problem('No such report'),
            },
          },
        },

        '/usage': {
          get: {
            tags: ['model-providers'],
            summary: 'Model spending today and this month, the limits, and any notice',
            description:
              'Every model call counts: agent turns, routines and background work, memory reads, ' +
              'voice asides and reviews. Dollars are estimates from the price table. Past a ' +
              '`reached` notice, new model calls are refused until the period resets. Days and ' +
              'months are UTC.',
            responses: {
              '200': jsonResponse('Usage', usageResponse),
              '401': problem('Not signed in'),
            },
          },
        },

        '/model-settings': {
          get: {
            tags: ['model-providers'],
            summary: 'Which model new attempts use, and how each provider is connected',
            description:
              'Any signed-in account may read it; `can_edit` says whether this one may change it. ' +
              'No key is ever returned, only whether one is set and its last four characters. A key ' +
              'the server environment names wins over one entered here and is shown as `operator`.',
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '401': problem('Not signed in'),
            },
          },
        },

        '/model-settings/test': {
          post: {
            tags: ['model-providers'],
            summary: 'Try a provider key with one small call, and list the provider’s models',
            description:
              'Asks the provider for its model list with the given key, or with the key already set. ' +
              'A refusal answers 200 with `ok: false` and a plain sentence; nothing is saved.',
            requestBody: json(testModelConnectionRequest),
            responses: {
              '200': jsonResponse('What the provider answered', testModelConnectionResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the setup owner changes the model'),
            },
          },
        },

        '/model-settings/keys/{provider}': {
          put: {
            tags: ['model-providers'],
            summary: 'Store a provider key, sealed with the master key',
            requestParams: { path: z.object({ provider: keyedModelProvider }) },
            requestBody: json(saveModelKeyRequest),
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '400': problem('Invalid key or endpoint address'),
              '403': problem('Only the setup owner changes the model'),
              '409': problem('The server environment already sets this provider’s key'),
              '503': problem('MELETE_MASTER_KEY is not set, so the key cannot be sealed'),
            },
          },
          delete: {
            tags: ['model-providers'],
            summary: 'Remove a key entered in the app',
            requestParams: { path: z.object({ provider: keyedModelProvider }) },
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '403': problem('Only the setup owner changes the model'),
            },
          },
        },

        '/model-settings/default': {
          put: {
            tags: ['model-providers'],
            summary: 'Choose the model new attempts use',
            description:
              'Takes effect for the next attempt, without a restart. The provider must already have ' +
              'a key or a sign-in.',
            requestBody: json(setDefaultModelRequest),
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the setup owner changes the model'),
              '409': problem('The provider has no key or sign-in yet'),
            },
          },
          delete: {
            tags: ['model-providers'],
            summary: 'Go back to the server’s default model',
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '403': problem('Only the setup owner changes the model'),
            },
          },
        },

        '/model-settings/vision': {
          put: {
            tags: ['model-providers'],
            summary: 'Say whether the model in use reads images',
            description:
              'Applies to the model in use, for the next attempt. Null hands it back to Melete’s ' +
              'list. The model, and whether it was chosen here or is the server’s default, do not change.',
            requestBody: json(setModelVisionRequest),
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the setup owner changes the model'),
              '409': problem('The model in use has changed since the page loaded'),
            },
          },
        },

        '/model-settings/secondary': {
          put: {
            tags: ['model-providers'],
            summary: 'Choose this account’s secondary model',
            description:
              'A second model for cheaper work beside the primary. It applies to work in the ' +
              'owner’s spaces from the next call, as `secondary.uses` says. The person’s own ' +
              'messages stay on the primary, and the action reviewer never uses it. The provider ' +
              'must already have a key or a sign-in.',
            requestBody: json(setSecondaryModelRequest),
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the setup owner changes the model'),
              '409': problem('The provider has no key or sign-in yet'),
            },
          },
          delete: {
            tags: ['model-providers'],
            summary: 'Remove this account’s secondary model, so all its work uses the primary',
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '403': problem('Only the setup owner changes the model'),
            },
          },
        },

        '/model-settings/secondary/uses': {
          put: {
            tags: ['model-providers'],
            summary: 'Choose which of this account’s work runs on the secondary model',
            description:
              'Each kind left out keeps its setting. The choice is kept while no secondary model is ' +
              'set, and applies once one is.',
            requestBody: json(setSecondaryUsesRequest),
            responses: {
              '200': jsonResponse('Model settings', modelSettingsResponse),
              '400': problem('Invalid request'),
              '403': problem('Only the setup owner changes the model'),
            },
          },
        },

        '/model-providers/sign-in': {
          get: {
            tags: ['model-providers'],
            summary: 'List the model providers the owner can sign in to, and each one’s state',
            responses: {
              '200': jsonResponse('Sign-in states', providerSignInList),
              '403': problem('Only the setup owner manages model sign-in'),
              '503': problem('MELETE_MASTER_KEY is not set, so nothing can be sealed'),
            },
          },
        },

        '/model-providers/{provider}/sign-in': {
          get: {
            tags: ['model-providers'],
            summary: 'Read one provider’s sign-in state',
            requestParams: { path: z.object({ provider: signInProvider }) },
            responses: {
              '200': jsonResponse('Sign-in state', providerSignInStatus),
              '403': problem('Only the setup owner manages model sign-in'),
              '404': problem('This installation offers no sign-in for that provider'),
              '503': problem('MELETE_MASTER_KEY is not set'),
            },
          },
          post: {
            tags: ['model-providers'],
            summary: 'Start signing the installation in to a model provider',
            description:
              'A device sign-in answers with a code to enter at the provider’s verification page. ' +
              'A browser sign-in answers with an address to open; the provider then sends the ' +
              'browser to `redirect_uri`, and that whole address is passed to complete. A newer ' +
              'start for the same provider replaces an unfinished one; either expires after ' +
              'fifteen minutes.',
            requestParams: { path: z.object({ provider: signInProvider }) },
            requestBody: json(startSignInRequest),
            responses: {
              '201': jsonResponse('Started', startSignInResponse),
              '400': problem('Invalid request, or a method this provider does not offer'),
              '403': problem('Only the setup owner manages model sign-in'),
              '404': problem('This installation offers no sign-in for that provider'),
              '502': problem('The provider could not be reached or refused the request'),
              '503': problem('MELETE_MASTER_KEY is not set'),
            },
          },
          delete: {
            tags: ['model-providers'],
            summary: 'Sign out: remove the sealed tokens and ask the provider to revoke them',
            requestParams: { path: z.object({ provider: signInProvider }) },
            responses: {
              '200': jsonResponse('Signed out', providerSignInStatus),
              '403': problem('Only the setup owner manages model sign-in'),
              '404': problem('This installation offers no sign-in for that provider'),
              '503': problem('MELETE_MASTER_KEY is not set'),
            },
          },
        },

        '/model-providers/{provider}/sign-in/complete': {
          post: {
            tags: ['model-providers'],
            summary: 'Finish a sign-in',
            description:
              'A browser sign-in is finished once, with the address the browser was sent back to. ' +
              'A device sign-in is checked with the provider at most once per `interval` and ' +
              'answers 202 until the code has been entered.',
            requestParams: { path: z.object({ provider: signInProvider }) },
            requestBody: json(completeSignInRequest),
            responses: {
              '200': jsonResponse('Signed in', providerSignInStatus),
              '202': jsonResponse('The code has not been entered yet', completeSignInPending),
              '400': problem('The address is not the one sent, or its state does not match'),
              '403': problem('Only the setup owner manages model sign-in'),
              '404': problem('No unfinished sign-in by that id'),
              '502': problem('The provider could not be reached or refused the code'),
              '503': problem('MELETE_MASTER_KEY is not set'),
            },
          },
        },

        '/voice': {
          get: {
            tags: ['voice'],
            summary: 'Which voice features this installation has',
            description:
              'Both are false until the operator sets a speech provider key. Push-to-talk needs a ' +
              'provider that transcribes; voice mode needs ElevenLabs. Given a conversation, or the ' +
              'agent a new chat will have, `off_reason` says why voice is off there: the space or ' +
              'agent is marked private, or the conversation is about a sensitive topic.',
            requestParams: { query: voiceContextQuery },
            responses: { '200': jsonResponse('Voice features and their limits', voiceStatus) },
          },
        },
        '/voice/transcriptions': {
          post: {
            tags: ['voice'],
            summary: 'Transcribe a push-to-talk clip',
            description:
              'The body is the recording itself. The words come back for the person to review; ' +
              'nothing is sent, and the audio is not kept. A clip over two minutes or 5 MB is ' +
              'refused, and so is one past the person’s daily allowance.',
            requestParams: { query: voiceTranscriptionQuery },
            requestBody: {
              required: true,
              content: {
                'audio/webm': { schema: z.string().meta({ format: 'binary' }) },
                'audio/ogg': { schema: z.string().meta({ format: 'binary' }) },
                'audio/mp4': { schema: z.string().meta({ format: 'binary' }) },
                'audio/wav': { schema: z.string().meta({ format: 'binary' }) },
              },
            },
            responses: {
              '200': jsonResponse('What was heard', voiceTranscription),
              '400': problem('Not a recording this service reads'),
              '403': problem('Voice is off in a private space, agent or sensitive conversation'),
              '404': problem('Voice is not set up on this installation, or no such conversation'),
              '413': problem('The recording is longer or larger than the limit'),
              '429': problem('The daily allowance for transcription is used up'),
              '502': problem('The speech provider could not transcribe it'),
            },
          },
        },
        '/conversations/{id}/voice/session': {
          post: {
            tags: ['voice'],
            summary: 'Open a realtime transcription session for voice mode',
            description:
              'Answers with an address carrying a single-use token; the provider key never ' +
              'reaches the browser. Each finished utterance is sent as an ordinary message to ' +
              'this conversation.',
            requestParams: idParam('id', 'Conversation id'),
            responses: {
              '201': jsonResponse('Open `url` as a WebSocket', voiceSession),
              '403': problem('Voice is off in a private space, agent or sensitive conversation'),
              '404': problem('No such conversation, or voice mode is not set up'),
              '429': problem('The daily allowance of voice sessions is used up'),
              '502': problem('The speech provider could not open a session'),
            },
          },
        },
        '/conversations/{id}/voice/speech': {
          post: {
            tags: ['voice'],
            summary: 'Read part of a reply aloud',
            description:
              'Streams speech for the text as it is made. Nothing is kept. Each request counts ' +
              'its characters against the person’s daily allowance.',
            requestParams: idParam('id', 'Conversation id'),
            requestBody: json(voiceSpeechRequest),
            responses: {
              '200': {
                description: 'Speech, streamed',
                content: { 'audio/mpeg': { schema: z.string().meta({ format: 'binary' }) } },
              },
              '400': problem('Invalid request'),
              '403': problem('Voice is off in a private space, agent or sensitive conversation'),
              '404': problem('No such conversation, or voice mode is not set up'),
              '429': problem('The daily allowance for reading aloud is used up'),
              '502': problem('The speech provider could not speak it'),
            },
          },
        },
        '/conversations/{id}/voice/aside': {
          post: {
            tags: ['voice'],
            summary: 'Talk with Melete while the conversation’s turn runs',
            description:
              'A light model call alongside the running turn. It sees the conversation, the ' +
              'activity sent with the request and the agent’s name, and goes through the privacy ' +
              'router like every model call. It has no tools and acts on nothing: it answers, ' +
              'says how the work is going, or says that what was heard is an instruction for ' +
              'the work (`steer`) or a request to stop it (`stop`), which the caller carries ' +
              'out through the ordinary routes. The words are not kept; like every model call ' +
              'it leaves a privacy log entry and adds any redacted details to the ' +
              'conversation’s vault. Each aside counts against the person’s daily voice ' +
              'allowance.',
            requestParams: idParam('id', 'Conversation id'),
            requestBody: json(voiceAsideRequest),
            responses: {
              '200': jsonResponse('What to say, and what was meant', voiceAside),
              '400': problem('Invalid request'),
              '403': problem('Voice is off in a private space, agent or sensitive conversation'),
              '404': problem('No such conversation, or voice mode is not set up'),
              '429': problem('Too many asides in a short time, or the daily allowance is used up'),
            },
          },
        },
        ...devicePaths(),
        ...appsPaths(),
        ...processPreviewPaths(),
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
