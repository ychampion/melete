import type { ConnectorManifest, JsonObject, JsonValue } from '@melete/contracts';
import { jsonObject, jsonValue } from '@melete/contracts';
import { z } from 'zod';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import type { BrowserArtifactSink } from '../workers/browser/artifacts.ts';
import { planBrowserRecipe, recipePlanDetail } from '../workers/browser/planning.ts';
import type { BrowserRecipeStore } from '../workers/browser/recipes.ts';
import { type BrowserSessionService, browserInputReasons } from '../workers/browser/routes.ts';
import { BrowserFault } from '../workers/browser/sessions.ts';
import type { Connector } from './types.ts';

const text = { type: 'string', minLength: 1, maxLength: 8000 };
/**
 * A job's browser tools act on that job's current browser session, opened on first use. The id
 * and epoch are optional: they come back in every result, for a caller that wants to name them.
 */
const sessionProperties = {
  session_id: {
    type: 'string',
    minLength: 1,
    description:
      "Optional. Leave it out to use this job's current browser session; pass one only as returned by an earlier browser result.",
  },
  control_epoch: {
    type: 'integer',
    minimum: 0,
    description: 'Optional. The control_epoch returned with session_id.',
  },
};
const observationProperty = {
  ...text,
  description:
    'Optional. The id of the latest observation; pass it to repeat an earlier identical step.',
};
const schema = (properties: Record<string, JsonValue>, required: string[]) => ({
  type: 'object',
  properties: { ...sessionProperties, ...properties },
  required,
  additionalProperties: false,
});
const intentSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri' },
    method: { type: 'string', enum: ['POST'] },
    role: text,
    name: text,
    form_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    body_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['url', 'method', 'role', 'name', 'form_hash', 'body_sha256', 'fields'],
  additionalProperties: false,
};

const definitions: Array<{
  name: string;
  description: string;
  effect: 'read' | 'write_reversible' | 'write_external';
  properties: Record<string, JsonValue>;
  required: string[];
}> = [
  {
    name: 'open',
    description:
      "Open an allowed HTTP(S) URL in this job's browser, starting the browser if needed. Returns an observation of the page.",
    effect: 'read',
    properties: { url: { type: 'string', format: 'uri' }, after_observation: observationProperty },
    required: ['url'],
  },
  {
    name: 'observe',
    description:
      "Look at the current page in this job's browser; {} is enough. To look again after a change, pass after_observation equal to the previous observation id. Optional recipe_id and recipe_version check a stored recipe against the visible schema. Returns artifact handles and submit intents.",
    effect: 'read',
    properties: {
      after_observation: observationProperty,
      recipe_id: { type: 'string', minLength: 1, maxLength: 120 },
      recipe_version: { type: 'integer', minimum: 1 },
    },
    required: [],
  },
  {
    name: 'fill',
    description:
      'Fill one visible field by exact accessible label. To repeat an earlier edit, observe again and pass that observation id as after_observation. Authentication fields require human control. Returns an observation of the page after it, with its submit intents.',
    effect: 'write_reversible',
    properties: {
      label: text,
      value: { type: 'string', maxLength: 8000 },
      after_observation: observationProperty,
    },
    required: ['label', 'value'],
  },
  {
    name: 'click',
    description:
      'Click one reversible control by exact role and name. To repeat an earlier click, observe again and pass that observation id as after_observation. Consequential controls require browser.submit. Returns an observation of the page after it.',
    effect: 'write_reversible',
    properties: { role: text, name: text, after_observation: observationProperty },
    required: ['role', 'name'],
  },
  {
    name: 'select',
    description:
      'Select a visible choice by exact accessible label. To repeat an earlier choice, observe again and pass that observation id as after_observation. Returns an observation of the page after it.',
    effect: 'write_reversible',
    properties: { label: text, value: text, after_observation: observationProperty },
    required: ['label', 'value'],
  },
  {
    name: 'read',
    description:
      'Read a visible element by selector or accessible role and name. Pass the latest observation id as after_observation to refresh an earlier read.',
    effect: 'read',
    properties: { selector: text, role: text, name: text, after_observation: observationProperty },
    required: [],
  },
  {
    name: 'submit',
    description:
      'Submit exactly one intent from the latest observation, copied whole, including its destination and complete field values. Approval is required.',
    effect: 'write_external',
    properties: { intent: intentSchema },
    required: ['intent'],
  },
];

export const browserManifest: ConnectorManifest = {
  name: 'browser',
  version: '0.1.0',
  provider: 'web',
  description:
    'Semantic Chromium actions in a separate worker, fenced by service-owned browser control.',
  credentials: [],
  health: true,
  tools: definitions.map((tool) => ({
    name: `browser.${tool.name}`,
    description: tool.description,
    input_schema: {
      ...schema(tool.properties, tool.required),
      ...(tool.name === 'observe'
        ? { dependencies: { recipe_id: ['recipe_version'], recipe_version: ['recipe_id'] } }
        : {}),
    },
    effect_class: tool.effect,
    required_scopes: [`browser.${tool.name}`],
    requires_approval: tool.effect === 'write_external',
    verify: false,
  })),
};

const output = z.strictObject({
  session_id: z.string().min(1),
  control_epoch: z.number().int().nonnegative(),
  observation: z
    .strictObject({
      id: z.string().min(1),
      url: z.string(),
      title: z.string().max(1000).optional(),
      tree: z.string().max(4 * 1024 * 1024),
      screenshot: z.string().max(6 * 1024 * 1024),
      schema: jsonValue,
    })
    .optional(),
  result: jsonObject.optional(),
});

const LEAVE_OUT =
  "Leave session_id and control_epoch out to use this job's current browser session.";

/** The sessions this job has held, newest first. Scoped to the job and its space, never wider. */
async function jobSessions(
  tx: Query,
  scope: { space_id: string; job_id: string },
): Promise<Array<{ id: string; control_epoch: number }>> {
  return (await tx`select id, control_epoch from browser_session_binding
    where space_id = ${scope.space_id} and job_id = ${scope.job_id}
    order by updated_at desc, id limit 5`) as unknown as Array<{
    id: string;
    control_epoch: number;
  }>;
}

export function createBrowserConnector(options: {
  sessions: Pick<BrowserSessionService, 'lease' | 'park'>;
  artifacts: BrowserArtifactSink;
  recipes?: BrowserRecipeStore;
  spaceId?: string;
}): Connector {
  return {
    manifest: browserManifest,
    /**
     * A named session must be one this job holds; anything else is refused with the job's own
     * sessions listed, never another job's. A submit with no session is bound here, at proposal,
     * to the job's current session and the epoch it was observed under, so an approval waits on
     * exactly what was seen.
     */
    async prepare(payload, ctx, tx) {
      const named = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      if (!named && payload.intent === undefined) return payload;
      const held = await jobSessions(tx, ctx);
      const bound = named ? held.find((session) => session.id === named) : held[0];
      if (!bound) {
        if (!named)
          throw new BrokerFault(
            'payload_invalid',
            'This job has no browser page to submit from yet. Open the page, fill it, then submit an intent from the latest observation.',
          );
        throw new BrokerFault(
          'payload_invalid',
          `There is no browser session ${named} in this job. ${LEAVE_OUT}${
            held.length
              ? ` This job's sessions: ${held.map((session) => session.id).join(', ')}.`
              : ''
          }`,
        );
      }
      if (payload.intent === undefined || Number.isSafeInteger(payload.control_epoch))
        return { ...payload, session_id: bound.id };
      return { ...payload, session_id: bound.id, control_epoch: bound.control_epoch };
    },
    async execute(action, ctx) {
      if (
        action.job_id !== ctx.job_id ||
        action.id !== ctx.idempotency_key ||
        action.id !== action.idempotency_key ||
        (options.spaceId && ctx.space_id !== options.spaceId)
      )
        throw new Error('connector action identity mismatch');
      const kind = action.kind.replace(/^browser\./, '');
      if (!browserManifest.tools.some((tool) => tool.name === action.kind))
        throw new Error('unknown browser tool');
      const payload = action.canonical_payload;
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      let activeSessionId = sessionId;
      // A commit is bound at proposal to the session and epoch it was planned under (see prepare).
      if (kind === 'submit' && (!sessionId || !Number.isSafeInteger(payload.control_epoch)))
        throw new Error('A planned browser session and control epoch are required');
      try {
        ctx.signal?.throwIfAborted();
        const { session, worker, opened } = await options.sessions.lease(ctx, sessionId);
        activeSessionId = session.id;
        // A browser this call just started shows a blank page. Looking at it once lets the first
        // step act; every later epoch still needs an observation the model asked for.
        if (opened && kind !== 'observe') {
          const first = output.parse(
            await worker.request('/command', {
              session_id: session.id,
              job_id: ctx.job_id,
              control_epoch: session.control_epoch,
              operation: { kind: 'observe' },
            }),
          );
          if (first.session_id !== session.id) throw new Error('worker session identity mismatch');
        }
        const operation: JsonObject = { kind };
        for (const [key, value] of Object.entries(payload))
          if (
            key !== 'session_id' &&
            key !== 'control_epoch' &&
            key !== 'after_observation' &&
            key !== 'recipe_id' &&
            key !== 'recipe_version'
          )
            operation[key] = value;
        const plannedEpoch = payload.control_epoch ?? session.control_epoch;
        const result = output.parse(
          await worker.request('/command', {
            session_id: session.id,
            job_id: ctx.job_id,
            control_epoch: plannedEpoch,
            operation,
          }),
        );
        if (result.session_id !== session.id) throw new Error('worker session identity mismatch');
        const detail: JsonObject = {
          session_id: result.session_id,
          control_epoch: result.control_epoch,
          ...(result.result ? { result: result.result } : {}),
        };
        // Durable receipts contain handles and schema, never screenshot bytes or full page captures.
        if (result.observation)
          detail.observation = await options.artifacts(ctx, result.observation);
        if (
          kind === 'observe' &&
          (payload.recipe_id !== undefined || payload.recipe_version !== undefined)
        ) {
          if (
            !options.recipes ||
            !result.observation ||
            typeof payload.recipe_id !== 'string' ||
            typeof payload.recipe_version !== 'number'
          )
            throw new BrowserFault('recipe_unavailable');
          const plan = await planBrowserRecipe(
            options.recipes,
            ctx.space_id,
            payload.recipe_id,
            payload.recipe_version,
            result.observation.schema,
          );
          detail.result = { ...result.result, recipe: recipePlanDetail(plan) };
          if (plan.disposition === 'stop')
            await options.sessions.park(ctx, session.id, plan.reason, action.attempt_id);
        }
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: session.id,
            received_at: new Date().toISOString(),
            late: false,
            detail,
          },
        };
      } catch (error) {
        if (error instanceof BrowserFault) {
          let reason = error.reason;
          if (activeSessionId && browserInputReasons.has(error.reason)) {
            try {
              await options.sessions.park(ctx, activeSessionId, error.reason, action.attempt_id);
            } catch {
              // The durable failure records both outcomes without exposing a database error's contents.
              reason += '; browser_park_failed';
            }
          }
          // A named session that has closed since: the job's current one is a call away.
          if (sessionId && error.reason === 'session_not_found')
            reason = `session_not_found: browser session ${sessionId} is no longer open. ${LEAVE_OUT}`;
          return { outcome: 'failed', reason, retryable: false };
        }
        // A transport loss after an approved commit has an unknown effect and must never be retried.
        if (kind === 'submit')
          return {
            outcome: 'unknown',
            reason: 'Browser commit ended without a confirmed receipt.',
          };
        return {
          outcome: 'failed',
          reason: 'Browser operation could not be completed.',
          retryable: false,
        };
      }
    },
    async verify() {
      return {
        decision: 'unsupported',
        reason: 'A site receipt must be checked by the person after an uncertain browser commit.',
      };
    },
    async health() {
      return {
        status: 'ok',
        detail: 'Broker transport and browser control fencing configured.',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
