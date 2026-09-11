import type { ConnectorManifest, JsonObject, JsonValue } from '@melete/contracts';
import { jsonObject, jsonValue } from '@melete/contracts';
import { z } from 'zod';
import type { BrowserArtifactSink } from '../workers/browser/artifacts.ts';
import { planBrowserRecipe, recipePlanDetail } from '../workers/browser/planning.ts';
import type { BrowserRecipeStore } from '../workers/browser/recipes.ts';
import { type BrowserSessionService, browserInputReasons } from '../workers/browser/routes.ts';
import { BrowserFault } from '../workers/browser/sessions.ts';
import type { Connector } from './types.ts';

const text = { type: 'string', minLength: 1, maxLength: 8000 };
const sessionProperties = {
  session_id: { type: 'string', minLength: 1 },
  control_epoch: { type: 'integer', minimum: 0 },
};
const schema = (properties: Record<string, JsonValue>, required: string[]) => ({
  type: 'object',
  properties: { ...sessionProperties, ...properties },
  required,
  additionalProperties: false,
});
const inputRequired = ['session_id', 'control_epoch'];
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
      'Open an allowed HTTP(S) URL. Pass the latest observation id as after_observation. First observe to obtain the session and control epoch.',
    effect: 'read',
    properties: { url: { type: 'string', format: 'uri' }, after_observation: text },
    required: [...inputRequired, 'url', 'after_observation'],
  },
  {
    name: 'observe',
    description:
      'Initially call with {}. To refresh, pass session_id, control_epoch and after_observation equal to the previous observation id. Optional recipe_id and recipe_version check a stored recipe against the visible schema. Returns artifact handles.',
    effect: 'read',
    properties: {
      after_observation: text,
      recipe_id: { type: 'string', minLength: 1, maxLength: 120 },
      recipe_version: { type: 'integer', minimum: 1 },
    },
    required: [],
  },
  {
    name: 'fill',
    description:
      'Fill one visible field by exact accessible label. Pass the latest observation id as after_observation; observe again before repeating an earlier edit. Authentication fields require human control.',
    effect: 'write_reversible',
    properties: {
      label: text,
      value: { type: 'string', maxLength: 8000 },
      after_observation: text,
    },
    required: [...inputRequired, 'label', 'value', 'after_observation'],
  },
  {
    name: 'click',
    description:
      'Click one reversible control by exact role and name. Pass the latest observation id as after_observation; observe before repeating an earlier click. Consequential controls require browser.submit.',
    effect: 'write_reversible',
    properties: { role: text, name: text, after_observation: text },
    required: [...inputRequired, 'role', 'name', 'after_observation'],
  },
  {
    name: 'select',
    description:
      'Select a visible choice by exact accessible label. Pass the latest observation id as after_observation; observe before repeating an earlier choice.',
    effect: 'write_reversible',
    properties: { label: text, value: text, after_observation: text },
    required: [...inputRequired, 'label', 'value', 'after_observation'],
  },
  {
    name: 'read',
    description:
      'Read a visible element by selector or accessible role and name. Pass the latest observation id as after_observation to refresh an earlier read.',
    effect: 'read',
    properties: { selector: text, role: text, name: text, after_observation: text },
    required: [...inputRequired],
  },
  {
    name: 'submit',
    description:
      'Submit exactly one observed intent, including its destination and complete field values. Approval is required.',
    effect: 'write_external',
    properties: { intent: intentSchema },
    required: [...inputRequired, 'intent'],
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
      tree: z.string().max(4 * 1024 * 1024),
      screenshot: z.string().max(6 * 1024 * 1024),
      schema: jsonValue,
    })
    .optional(),
  result: jsonObject.optional(),
});

export function createBrowserConnector(options: {
  sessions: Pick<BrowserSessionService, 'lease' | 'park'>;
  artifacts: BrowserArtifactSink;
  recipes?: BrowserRecipeStore;
  spaceId?: string;
}): Connector {
  return {
    manifest: browserManifest,
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
      if (kind !== 'observe' && (!sessionId || !Number.isSafeInteger(payload.control_epoch)))
        throw new Error('A planned browser session and control epoch are required');
      if (
        ['open', 'fill', 'click', 'select'].includes(kind) &&
        (typeof payload.after_observation !== 'string' || !payload.after_observation)
      )
        throw new Error('The latest browser observation id is required');
      try {
        ctx.signal?.throwIfAborted();
        const { session, worker } = await options.sessions.lease(ctx, sessionId);
        activeSessionId = session.id;
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
          if (activeSessionId && browserInputReasons.has(error.reason))
            await options.sessions.park(ctx, activeSessionId, error.reason, action.attempt_id);
          return { outcome: 'failed', reason: error.reason, retryable: false };
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
